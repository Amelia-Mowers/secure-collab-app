import { test, expect } from '@playwright/test'

/**
 * Can a NON-EXTRACTABLE CryptoKey be persisted in IndexedDB, survive a reload,
 * and still decrypt — while remaining impossible for script to export?
 *
 * This is a mechanism proof, not a product test. The whole two-wrap at-rest
 * design (issue 8509dc68) rests on this being true: if it holds, the local store
 * can be encrypted with a key that needs NO user interaction on page load, and
 * the master key goes back to meaning "restore my history on a new device"
 * instead of "let me read my own screen again".
 *
 * It is deliberately written against the raw platform rather than app code, so a
 * failure here means "the browser cannot do this" rather than "our wiring is
 * wrong". It runs in the app's real origin and its real browsers, because that
 * is where the answer has to hold.
 *
 * What it proves, and what it does NOT: a non-extractable key protects the raw
 * key material from being read out by script or lifted from the IndexedDB value
 * on disk. It does not protect against malicious script on this origin (which
 * can still USE the key), nor against someone at an unlocked machine. That is
 * the honest boundary of this design.
 */

const DB = 'io.tidework.devicekey.probe'
const STORE = 'keys'

/** The whole probe, run in page context. Returns the ciphertext + the key's own
 *  reported extractability, so the assertions can be made outside. */
const SETUP = `
(async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // NOT extractable — the property under test
    ['encrypt', 'decrypt'],
  )

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('${DB}', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('${STORE}')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  // Storing the CryptoKey OBJECT itself — this is the step that has to work.
  await new Promise((resolve, reject) => {
    const tx = db.transaction('${STORE}', 'readwrite')
    tx.objectStore('${STORE}').put(key, 'device')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode('the data key'),
  )
  return {
    extractable: key.extractable,
    iv: Array.from(iv),
    ct: Array.from(new Uint8Array(ct)),
  }
})()
`

/** After a reload: read the key back and decrypt with it. */
const VERIFY = `
(async (stored) => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('${DB}', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('${STORE}')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const key = await new Promise((resolve, reject) => {
    const tx = db.transaction('${STORE}', 'readonly')
    const req = tx.objectStore('${STORE}').get('device')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()

  if (!key) return { found: false }

  let plaintext = null
  let decryptError = null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(stored.iv) },
      key,
      new Uint8Array(stored.ct),
    )
    plaintext = new TextDecoder().decode(pt)
  } catch (e) {
    decryptError = String(e)
  }

  // And it must STILL refuse to hand over its bytes.
  let exported = null
  let exportError = null
  try {
    exported = await crypto.subtle.exportKey('raw', key)
  } catch (e) {
    exportError = String(e)
  }

  return {
    found: true,
    isCryptoKey: key instanceof CryptoKey,
    extractable: key.extractable,
    plaintext,
    decryptError,
    exported: exported ? exported.byteLength : null,
    exportError,
  }
})
`

test('a non-extractable CryptoKey persists in IndexedDB and still decrypts after a reload', async ({
  page,
}) => {
  await page.goto('/')

  const stored = await page.evaluate(SETUP)
  expect(stored, 'key reports itself non-extractable').toMatchObject({ extractable: false })

  // The load-bearing step: a completely fresh JS context.
  await page.reload()

  const result: any = await page.evaluate(
    ([fn, arg]) => eval(fn as string)(arg),
    [VERIFY, stored] as [string, unknown],
  )

  expect(result.found, 'the key survived the reload').toBe(true)
  expect(result.isCryptoKey, 'it came back as a CryptoKey, not a clone of nothing').toBe(true)
  expect(result.extractable, 'still non-extractable').toBe(false)
  expect(result.decryptError, 'no decrypt error').toBeNull()
  expect(result.plaintext, 'it can still decrypt what it encrypted before the reload').toBe(
    'the data key',
  )

  // The security property: usable, never readable.
  expect(result.exported, 'the raw bytes must NOT be exportable').toBeNull()
  expect(result.exportError, 'exportKey must reject').toBeTruthy()
})
