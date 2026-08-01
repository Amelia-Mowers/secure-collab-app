import { describe, it, expect } from 'vitest'
import { buildRecoveryKitPdf, recoveryKitFilename, chunkKey } from './recoveryKit'

const INFO = {
  userId: '@amelia:tidework.io',
  homeserver: 'https://matrix.tidework.io',
  recoveryKey: 'EsTb 7Kq2 mW9x 4Ldp Rn5J vH8c Zy3T gQ6f Bs1N eK4w Xm2R uP7a',
  appUrl: 'https://app.tidework.io',
  date: new Date('2026-08-01T00:00:00Z'),
}

/** jsdom's Blob has no `.text()`, so fall back to FileReader, which it does
 *  implement. Browsers take the first branch. */
const text = (blob: Blob): Promise<string> => {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('recovery kit', () => {
  it('produces a structurally valid single-page PDF', async () => {
    const pdf = await text(buildRecoveryKitPdf(INFO))
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true)
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(pdf).toContain('/Type /Catalog')
    expect(pdf).toContain('/Count 1')
  })

  // The xref table is the one part a reader will reject outright if it is
  // wrong, and it is pure arithmetic — so check the arithmetic rather than
  // trusting it.
  it('writes xref offsets that actually point at their objects', async () => {
    const pdf = await text(buildRecoveryKitPdf(INFO))
    const xrefAt = pdf.indexOf('xref\n')
    const startxref = Number(pdf.match(/startxref\n(\d+)/)![1])
    expect(startxref).toBe(xrefAt)

    const rows = pdf.slice(xrefAt).split('\n').slice(2)
    const offsets = rows
      .filter(r => / 00000 n ?$/.test(r))
      .map(r => Number(r.slice(0, 10)))
    expect(offsets).toHaveLength(7)
    offsets.forEach((off, i) => {
      expect(pdf.slice(off, off + 12)).toContain(`${i + 1} 0 obj`)
    })
  })

  it('declares a stream length matching the stream it wrote', async () => {
    const pdf = await text(buildRecoveryKitPdf(INFO))
    const declared = Number(pdf.match(/<< \/Length (\d+) >>/)![1])
    const body = pdf.slice(pdf.indexOf('stream\n') + 7, pdf.indexOf('\nendstream'))
    expect(body).toHaveLength(declared)
  })

  it('carries the context a bare key string cannot', async () => {
    const pdf = await text(buildRecoveryKitPdf(INFO))
    expect(pdf).toContain('@amelia:tidework.io')
    expect(pdf).toContain('matrix.tidework.io') // host, not the full URL
    expect(pdf).toContain('2026-08-01')
    expect(pdf).toContain('https://app.tidework.io')
    expect(pdf).toContain('standard Matrix recovery key')
  })

  it('contains every group of the key', async () => {
    const pdf = await text(buildRecoveryKitPdf(INFO))
    for (const group of INFO.recoveryKey.split(' ')) {
      expect(pdf).toContain(group)
    }
  })

  // A stray ( or ) would terminate the PDF string early and corrupt the page.
  it('escapes characters that would break a PDF string', async () => {
    const pdf = await text(
      buildRecoveryKitPdf({ ...INFO, userId: '@od(d)\\one:tidework.io' }),
    )
    expect(pdf).toContain('@od\\(d\\)\\\\one:tidework.io')
  })

  // The base-14 fonts are WinAnsi; an unmapped codepoint would print as the
  // wrong glyph, which on a page of instructions is worse than a '?'.
  it('keeps the document to bytes the base-14 fonts can render', async () => {
    const pdf = await text(buildRecoveryKitPdf({ ...INFO, userId: '@zoë-日本:tidework.io' }))
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(pdf)).toBe(false)
  })

  it('falls back to the raw homeserver when it is not a URL', async () => {
    const pdf = await text(buildRecoveryKitPdf({ ...INFO, homeserver: 'not a url' }))
    expect(pdf).toContain('not a url')
  })

  it('names the file so it is identifiable a year later', () => {
    expect(recoveryKitFilename(INFO)).toBe('tidework-recovery-kit-amelia-2026-08-01.pdf')
    // Path separators and the like must never reach a download name.
    expect(recoveryKitFilename({ ...INFO, userId: '@a/b\\c:tidework.io' })).toBe(
      'tidework-recovery-kit-a-b-c-2026-08-01.pdf',
    )
  })

  it('chunks the key into readable lines', () => {
    expect(chunkKey('a b c d e f g h i')).toEqual(['a b c d', 'e f g h', 'i'])
    expect(chunkKey('  a   b  ')).toEqual(['a b'])
    expect(chunkKey('')).toEqual([])
  })
})
