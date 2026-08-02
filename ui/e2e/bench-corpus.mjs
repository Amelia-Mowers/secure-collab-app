#!/usr/bin/env node
// Build a benchmark corpus by MULTIPLYING A REAL TEMPLATE (ADR 0006, M1).
//
//   node bench-corpus.mjs <out-dir> <rows> [chunk] [template-dir]
//
// The previous version generated the CSV-archive format from scratch and got it
// wrong in four ways — wrong `tables.csv` columns, wrong `columns.csv` columns,
// wrong options separator, and column ids where the format wants names. It was a
// second copy of the archive format, and it had already drifted from ADR 0004
// before it was used once.
//
// So it no longer knows the format at all. The schema files are copied verbatim
// from a shipped template, and size comes from repeating that template's own
// data rows. `import` appends and matches columns by name, so N chunks of the
// same schema simply accumulate. If the format changes, the template changes
// with it and this keeps working.
//
// Deterministic: same row count always produces byte-identical archives, so two
// runs measure the client rather than the corpus.
//
// Chunked: `import` sends one archive as a single `send_cell_batch`, i.e. ONE
// Matrix event, which meets the homeserver's 64 KiB limit long before thousands
// of rows. That is a property of how much you are seeding, not of the format,
// which is why it lives here and not in `import`.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const [, , outDir, rowsArg, chunkArg, templateArg] = process.argv
if (!outDir || !rowsArg) {
  console.error('usage: bench-corpus.mjs <out-dir> <rows> [chunk=500] [template-dir]')
  process.exit(2)
}
const ROWS = Number(rowsArg)
const CHUNK = Number(chunkArg ?? 500)
const TEMPLATE = templateArg ?? join(HERE, '..', 'src', 'templates', 'demo')
if (!Number.isFinite(ROWS) || ROWS < 1) throw new Error(`bad row count: ${rowsArg}`)
if (!existsSync(join(TEMPLATE, 'tables.csv'))) throw new Error(`no template at ${TEMPLATE}`)

/** RFC4180 parse — the template's notes contain quoted commas AND newlines, so
 *  a split(',') would corrupt every row after the first one. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.length > 1 || r[0] !== '')
}

const quote = v => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
const toCsv = rows => rows.map(r => r.map(quote).join(',')).join('\n') + '\n'

// The data file to multiply: the largest one, which is the table a cold start
// spends its time on.
const dataDir = join(TEMPLATE, 'data')
const dataFiles = readdirSync(dataDir).filter(f => f.endsWith('.csv'))
const main = dataFiles
  .map(f => ({ f, rows: parseCsv(readFileSync(join(dataDir, f), 'utf8')) }))
  .sort((a, b) => b.rows.length - a.rows.length)[0]
if (!main || main.rows.length < 2) throw new Error(`no usable data rows in ${dataDir}`)

const header = main.rows[0]
const source = main.rows.slice(1)

/** Row i, built by cycling the template's own rows and making the first column
 *  unique so rows stay distinguishable at any size. */
const rowAt = i => {
  const base = source[i % source.length].slice()
  base[0] = `${base[0]} #${i + 1}`
  return base
}

rmSync(outDir, { recursive: true, force: true })
const schemaFiles = readdirSync(TEMPLATE).filter(f => f.endsWith('.csv'))
// Chunk by CELL COUNT, not by CSV bytes.
//
// One archive becomes one send_cell_batch, i.e. one Matrix event — and each
// cell arrives as its own JSON update carrying ids and a timestamp, so the
// event is several times the size of the CSV it came from. Budgeting CSV bytes
// looked right and still produced 413 M_TOO_LARGE, because the file was small
// while the event was not. Cells are the unit that actually maps to event size.
const MAX_CELLS = 250
const rowsPerChunk = Math.max(1, Math.min(CHUNK, Math.floor(MAX_CELLS / Math.max(1, header.length))))
const plan = []
for (let i = 0; i < ROWS; i += rowsPerChunk) {
  const cur = []
  for (let j = i; j < Math.min(i + rowsPerChunk, ROWS); j++) cur.push(j)
  plan.push(cur)
}
const chunks = plan.length

for (let c = 0; c < chunks; c++) {
  const dir = join(outDir, `chunk-${String(c).padStart(3, '0')}`)
  mkdirSync(join(dir, 'data'), { recursive: true })
  // Schema verbatim from the template — this is the whole point.
  for (const f of schemaFiles) writeFileSync(join(dir, f), readFileSync(join(TEMPLATE, f)))

  const rows = [header]
  for (const i of plan[c]) rows.push(rowAt(i))
  writeFileSync(join(dir, 'data', main.f), toCsv(rows))
}

console.log(JSON.stringify({
  outDir, rows: ROWS, chunkSize: CHUNK, maxCells: MAX_CELLS, rowsPerChunk, chunks,
  template: TEMPLATE, dataFile: main.f, sourceRows: source.length,
}))
