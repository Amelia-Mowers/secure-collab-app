/**
 * The recovery kit: a one-page PDF carrying the recovery key and everything
 * needed to use it.
 *
 * WHY A FILE AND NOT THE CLIPBOARD. The clipboard is close to the worst
 * destination for a secret with no recovery path. Clipboard managers keep it in
 * plaintext, any app can read it, synced clipboards propagate it to devices the
 * user was not thinking about, and the next copy silently overwrites it. A file
 * lands in Downloads, gets swept up by whatever backs that folder up, and can
 * be printed and put somewhere physical — which for a key whose loss is
 * unrecoverable is a legitimate answer.
 *
 * It also carries what a modal cannot: which account, which server, the date,
 * what the key opens, what happens if it is lost, and where to type it back in.
 * A bare 48-character string found in a notes app in six months means nothing.
 *
 * WHY HAND-ROLLED. This file is generated from a secret, so it must never leave
 * the device — which rules out any server-side rendering. A PDF library would
 * do it, but the smallest is a few hundred kilobytes to lay out one page of
 * text, and this app ships seven runtime dependencies in total. A single page
 * of Helvetica needs no library: the base-14 fonts require no embedding, and
 * the whole document is a handful of objects. What follows is that document,
 * written out longhand and auditable in one sitting — which for the file that
 * holds the user's only key seems like the right trade.
 *
 * The format: a PDF is a set of numbered objects, then a cross-reference table
 * giving each object's byte offset, then a trailer pointing at the catalog.
 * Getting those offsets right is the only fiddly part.
 */

export interface RecoveryKitInfo {
  /** Full Matrix user id, e.g. `@amelia:tidework.io`. */
  userId: string
  /** Homeserver base URL the account lives on. */
  homeserver: string
  /** The recovery key itself, in its usual space-separated groups. */
  recoveryKey: string
  /** Where the user goes to type it back in. */
  appUrl: string
  /** Issue date. Injected so tests are deterministic. */
  date?: Date
}

/** Escape the three characters that terminate or nest a PDF string literal.
 *  A user id can't contain them today, but a filename-shaped value one day
 *  could, and a broken kit is worse than an ugly one. */
function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** WinAnsi is the base-14 encoding; anything outside it would render as the
 *  wrong glyph, so non-ASCII is transliterated rather than silently mangled. */
function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    // Non-breaking space, as an escape: an invisible byte in a source file is
    // exactly the kind of thing nobody catches in review.
    .replace(/\u00a0/g, ' ')
    // Anything left outside printable ASCII becomes '?'. Written as escapes
    // because a literal range of "space through tilde" is unreadable, and
    // silently wrong if someone's editor touches the whitespace.
    .replace(/[^\x20-\x7e]/g, '?')
}

type Line =
  | { kind: 'text'; text: string; font: 'body' | 'bold' | 'mono'; size: number; gap: number }
  | { kind: 'rule'; gap: number }
  | { kind: 'space'; gap: number }

/** The page, as a list of lines. Kept separate from the PDF plumbing below so
 *  the wording is editable without touching byte offsets. */
function layout(info: RecoveryKitInfo): Line[] {
  const date = info.date ?? new Date()
  const issued = date.toISOString().slice(0, 10)
  const host = (() => {
    try {
      return new URL(info.homeserver).host
    } catch {
      return info.homeserver
    }
  })()

  const t = (text: string, gap = 15): Line => ({ kind: 'text', text, font: 'body', size: 10, gap })
  const b = (text: string, size = 10, gap = 15): Line => ({ kind: 'text', text, font: 'bold', size, gap })
  const m = (text: string, size = 13, gap = 20): Line => ({ kind: 'text', text, font: 'mono', size, gap })

  return [
    b('TideWork recovery kit', 20, 12),
    t(`Account:    ${info.userId}`, 14),
    t(`Server:     ${host}`, 14),
    t(`Issued:     ${issued}`, 20),
    { kind: 'rule', gap: 22 },

    b('YOUR RECOVERY KEY', 11, 18),
    // Broken across lines so it stays legible in print and can be typed back
    // one group at a time.
    ...chunkKey(info.recoveryKey).map(l => m(l)),
    { kind: 'space', gap: 6 },
    { kind: 'rule', gap: 22 },

    b('What this opens', 11, 16),
    t('Everything in your TideWork account. Your tables, boards and documents are', 14),
    t('encrypted on your devices before they are sent, so the server only ever holds', 14),
    t('ciphertext. This key is what lets a new device read that ciphertext.', 20),

    b('When you will need it', 11, 16),
    t('Signing in on a new device or browser, or on this one after clearing its data.', 20),

    b('Where to enter it', 11, 16),
    t(`${info.appUrl} - sign in, then paste this key when asked to unlock.`, 20),

    b('If you lose it', 11, 16),
    t('Your data is gone permanently. No one - including us - can recover it, because', 14),
    t('no one else has ever held the key. That is the point of the design, and it is', 14),
    t('also why this sheet matters.', 20),

    b('Keep this safe', 11, 16),
    t('Store this file somewhere backed up, or print it and keep the paper somewhere', 14),
    t('you would keep a passport. Anyone who has this key can read your data.', 20),

    { kind: 'rule', gap: 18 },
    t('This is a standard Matrix recovery key. It is the same secret other Matrix', 13),
    t('clients call a recovery key or security key, and it works with them too.', 13),
  ]
}

/** Four groups per line: short enough to read across accurately, few enough
 *  lines to see the whole key at once. */
export function chunkKey(key: string, perLine = 4): string[] {
  const groups = key.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += perLine) {
    lines.push(groups.slice(i, i + perLine).join(' '))
  }
  return lines
}

const FONTS = { body: '/F1', bold: '/F2', mono: '/F3' } as const

/** Build the page's content stream: the drawing instructions. */
function contentStream(lines: Line[]): string {
  const left = 62
  const right = 550
  // 792pt page, so this is a ~62pt top margin — near the 1-inch a printer
  // wants, and enough that no printer trims the title.
  let y = 730
  const ops: string[] = []
  for (const line of lines) {
    if (line.kind === 'text') {
      ops.push(
        'BT',
        `${FONTS[line.font]} ${line.size} Tf`,
        `1 0 0 1 ${left} ${y} Tm`,
        `(${pdfEscape(toWinAnsi(line.text))}) Tj`,
        'ET',
      )
    } else if (line.kind === 'rule') {
      ops.push('0.75 G', '0.5 w', `${left} ${y + 4} m`, `${right} ${y + 4} l`, 'S')
    }
    y -= line.gap
  }
  return ops.join('\n')
}

/** Assemble the objects, then the xref table that indexes them by byte offset.
 *  Offsets are counted in BYTES, and every string here is WinAnsi-safe ASCII by
 *  construction, so string length is byte length. */
export function buildRecoveryKitPdf(info: RecoveryKitInfo): Blob {
  const stream = contentStream(layout(info))
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return new Blob([pdf], { type: 'application/pdf' })
}

/** `tidework-recovery-kit-amelia-2026-08-01.pdf` — identifiable in a Downloads
 *  folder a year later, which is the whole point of not using the clipboard. */
export function recoveryKitFilename(info: RecoveryKitInfo): string {
  const local = info.userId.replace(/^@/, '').split(':')[0] || 'account'
  const safe = local.replace(/[^a-zA-Z0-9._-]/g, '-')
  const date = (info.date ?? new Date()).toISOString().slice(0, 10)
  return `tidework-recovery-kit-${safe}-${date}.pdf`
}

/**
 * Generate and save the kit.
 *
 * The object URL is revoked on a timer rather than immediately: revoking it in
 * the same tick cancels the download in some browsers, because the click has
 * only been queued at that point.
 */
export function downloadRecoveryKit(info: RecoveryKitInfo): void {
  const url = URL.createObjectURL(buildRecoveryKitPdf(info))
  const a = document.createElement('a')
  a.href = url
  a.download = recoveryKitFilename(info)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
