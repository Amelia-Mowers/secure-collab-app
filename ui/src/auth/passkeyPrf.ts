/**
 * WebAuthn-PRF helpers (passkey phase 2): register a discoverable passkey with
 * the PRF extension and re-derive a *stable secret string* from it. That string
 * is the SSSS passphrase the bridge's `enableRecoveryWithPassphrase` /
 * `recoverWithKey` consume — so a biometric tap unlocks the E2EE keys instead of
 * a saved recovery key.
 *
 * This module is crypto-agnostic plumbing: it knows nothing about Matrix — it
 * just turns "the user's passkey" into "a stable passphrase." Wiring it into
 * recovery setup / the verify gate is phase 3 (ADR 0001 addendum, Decision 2).
 *
 * Security: a fixed, domain-separated salt makes the PRF output stable per
 * credential, so the SAME passkey (synced via the platform keychain) derives the
 * SAME secret on every device. The PRF secret never leaves the client; the
 * platform authenticator holds only an opaque per-credential key it can't reveal.
 */

/**
 * Domain-separation label fed to the PRF as the salt. **Stable forever** —
 * changing it would orphan every existing passkey-derived secret (the SSSS key
 * would no longer match). v1.
 */
const PRF_SALT: Uint8Array = new TextEncoder().encode('io.tidework.ssss.prf.v1')

const RP_NAME = 'TideWork'

/**
 * Shown when a passkey was created but its provider can't evaluate the PRF
 * extension — the one capability our custody model needs. WebAuthn offers no
 * way to ask a provider about PRF support *before* creating a credential, so
 * this is necessarily detected after the fact; name the usual culprit and the
 * way out. (issue b5a7e62c)
 */
export const PRF_UNSUPPORTED_MESSAGE =
  "This passkey provider doesn't support the security feature TideWork needs " +
  '(WebAuthn PRF). Platform passkeys — Windows Hello, Touch ID / iCloud ' +
  'Keychain, Google Password Manager — and hardware security keys work; some ' +
  "password managers (e.g. Bitwarden) don't yet. You can delete the passkey " +
  'it just created, and keep using your recovery key or retry with a ' +
  'compatible provider.'

/** One-line compatibility note the setup screens show BEFORE the user picks a
 *  passkey, so a PRF-less provider isn't a mid-flow surprise. */
export const PRF_PROVIDER_HINT =
  'Passkeys work with Windows Hello, Touch ID / iCloud Keychain, Google ' +
  'Password Manager, and hardware security keys. Some password managers ' +
  "(like Bitwarden) don't yet support the required PRF feature — if setup " +
  'fails, your recovery key still works.'

/**
 * Whether a failure means "this passkey CANNOT do what we need", as opposed to
 * "the user cancelled" or "the network hiccuped".
 *
 * The distinction drives routing, not just wording: a capability failure has no
 * retry that will ever succeed, so the unlock screens send the user straight to
 * the recovery key instead of leaving them tapping a button that cannot work.
 */
export function isPrfCapabilityError(message: string | undefined | null): boolean {
  if (!message) return false
  return /PRF|does not support|doesn't support|can't unlock|cannot be used/i.test(message)
}

// ── minimal PRF typings (TS DOM lib coverage of the PRF extension varies) ──

interface PrfInputs {
  eval?: { first: BufferSource; second?: BufferSource }
}
interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

/** Whether this browser exposes the WebAuthn API at all (passkeys + PRF need it). */
export function isPasskeyPrfSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  )
}

/**
 * Whether a *usable* platform authenticator (Touch ID / Windows Hello / a synced
 * passkey provider) is actually available — the gate for whether we offer
 * passkey flows. Crucially, a headless browser with no authenticator returns
 * false here (even though `isPasskeyPrfSupported` is true), so the UI falls back
 * to the recovery-key flow instead of offering a passkey nobody can satisfy.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isPasskeyPrfSupported()) return false
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * Register a new discoverable passkey for `userId` and return the PRF-derived
 * secret string (the SSSS passphrase). Prompts the platform authenticator
 * (Touch ID / Windows Hello / security key). The passkey is resident, so it
 * syncs via the platform keychain and can be found on other devices.
 */
/** A freshly registered passkey: its PRF secret, plus the credential id that
 *  identifies WHICH passkey it is — needed so a wrap can be attached to it and
 *  removed later without disturbing the others (issue 63dc1339). */
export interface RegisteredPasskey {
  secret: string
  credentialId: string
}

export async function registerPasskeyPrf(
  userId: string,
  displayName: string,
): Promise<RegisteredPasskey> {
  if (!isPasskeyPrfSupported()) {
    throw new Error('Passkeys are not supported in this browser')
  }

  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: rpId() },
      user: {
        id: new TextEncoder().encode(userId),
        name: userId,
        displayName: displayName || userId,
      },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: 'required', // discoverable → syncs + found without an id
        requireResidentKey: true,
        userVerification: 'required',
      },
      // Steer the picker toward this device's own authenticator (Windows Hello,
      // Touch ID), because that is where PRF support is near-universal while some
      // password managers still lack it (issue b5a7e62c).
      //
      // `hints` and NOT `authenticatorSelection.authenticatorAttachment:
      // 'platform'`: attachment would EXCLUDE roaming authenticators, and
      // hardware security keys do support PRF (hmac-secret) — they are a
      // supported path here, not a failure mode. A hint reorders the UI; it
      // forbids nothing.
      //
      // What this cannot do, so nobody expects it to: a password manager
      // registered as the OS/browser platform credential provider (Windows 11
      // credential manager, Chrome's third-party provider API) legitimately IS
      // "client-device" and still appears. And an extension that shims
      // `navigator.credentials` decides for itself regardless of what we pass.
      // WebAuthn has no way to ask about PRF before creating a credential, so
      // the after-the-fact check below stays load-bearing.
      hints: ['client-device'],
      // Request PRF, and ask to evaluate it now — some authenticators return the
      // result at create() time (one prompt); others only at get() (we fall back).
      extensions: { prf: { eval: { first: PRF_SALT } } } as unknown as
        AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialCreationOptions & { hints: string[] },
  })) as PublicKeyCredential | null

  if (!cred) throw new Error('Passkey registration was cancelled')

  const ext = cred.getClientExtensionResults() as unknown as PrfExtensionResults
  const credentialId = toBase64Url(cred.rawId)
  if (ext.prf?.results?.first) {
    // Evaluated at create — single prompt.
    return { secret: toBase64Url(ext.prf.results.first), credentialId }
  }
  if (ext.prf?.enabled === false) {
    throw new Error(PRF_UNSUPPORTED_MESSAGE)
  }
  // Fall back to an assertion against the credential we just created. If the
  // provider turns out not to evaluate PRF there either, surface the provider
  // message — at this point a credential exists but can never derive a secret.
  try {
    return { secret: await derivePrfSecret([cred.rawId]), credentialId }
  } catch (err) {
    if (err instanceof Error && /PRF/.test(err.message)) {
      throw new Error(PRF_UNSUPPORTED_MESSAGE)
    }
    throw err
  }
}

/**
 * Re-derive the secret from an existing (possibly platform-synced) passkey — the
 * unlock path on a returning or fresh device. Empty `allowCredentials` lets the
 * platform offer the synced passkey without us knowing its id.
 */
export async function unlockPasskeyPrf(): Promise<string> {
  if (!isPasskeyPrfSupported()) {
    throw new Error('Passkeys are not supported in this browser')
  }
  return derivePrfSecret([])
}

const PASSKEY_CANNOT_UNLOCK =
  "This passkey can't unlock TideWork on this device, so it wasn't enabled. " +
  'Your existing key still works — keep using it, or try a different passkey.'

/**
 * Confirm a just-registered passkey can re-derive the SAME secret via the real
 * unlock path (a discoverable-credential assertion) BEFORE a caller relies on
 * it — e.g. before rotating away a working recovery key. A PRF-less or flaky
 * authenticator (a password manager without PRF, say) can't reproduce the
 * secret, so this throws and the caller aborts, leaving the existing key intact.
 *
 * This is the "confirm before rotate" guard against passkey enrollment burning
 * the only working key (issue 05a98123). Pass the secret `registerPasskeyPrf`
 * returned; costs one extra authenticator gesture (the confirming assertion).
 */
export async function confirmPasskeyPrf(expected: string): Promise<void> {
  let actual: string
  try {
    actual = await unlockPasskeyPrf()
  } catch {
    throw new Error(PASSKEY_CANNOT_UNLOCK)
  }
  if (actual !== expected) throw new Error(PASSKEY_CANNOT_UNLOCK)
}

/** Drive a WebAuthn assertion that evaluates the PRF and returns its output. */
async function derivePrfSecret(allow: ArrayBuffer[]): Promise<string> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      rpId: rpId(),
      challenge: randomBytes(32),
      allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id })),
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as unknown as
        AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null

  if (!assertion) throw new Error('Passkey unlock was cancelled')

  const results = (assertion.getClientExtensionResults() as unknown as PrfExtensionResults).prf
    ?.results
  if (!results?.first) {
    throw new Error('This passkey does not support PRF — a recovery key is required')
  }
  return toBase64Url(results.first)
}

/** The relying-party id: the current host (`localhost` in dev). */
function rpId(): string {
  return window.location.hostname
}

function randomBytes(n: number): BufferSource {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Encode the 32-byte PRF output as url-safe base64 (the passphrase string). */
function toBase64Url(buf: ArrayBuffer): string {
  let s = ''
  for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Re-exported so phase 3 (and tests) can reference the input type without a cast.
export type { PrfInputs }
