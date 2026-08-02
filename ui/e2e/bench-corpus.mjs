#!/usr/bin/env node
// Generate a CSV-archive corpus for the cold-start benchmark (ADR 0006, M1).
//
//   node bench-corpus.mjs <out-dir> <rows> [chunk]
//
// Emits <out-dir>/chunk-000/, chunk-001/ … each a complete workspace archive
// that `tidework import` can apply. CHUNKED ON PURPOSE: `import` sends every
// update from one archive in a single `send_cell_batch`, which is ONE Matrix
// event — a few thousand rows in one archive meets the homeserver's 64 KiB
// event limit. Chunking belongs here rather than in `import`, because it is a
// property of how much you are seeding, not of the import format.
//
// The data is deterministic (no Date.now, no Math.random): the same row count
// always produces byte-identical archives, so two benchmark runs measure the
// client rather than the corpus.
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

const [, , outDir, rowsArg, chunkArg] = process.argv
if (!outDir || !rowsArg) {
  console.error('usage: bench-corpus.mjs <out-dir> <rows> [chunk=500]')
  process.exit(2)
}
const ROWS = Number(rowsArg)
const CHUNK = Number(chunkArg ?? 500)
if (!Number.isFinite(ROWS) || ROWS < 1) throw new Error(`bad row count: ${rowsArg}`)

/** RFC4180 quoting — a stray comma or quote in generated text would silently
 *  shift every column after it. */
const q = v => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csv = rows => rows.map(r => r.map(q).join(',')).join('\n') + '\n'

const STATUS = ['Todo', 'In Progress', 'Blocked', 'Done']
const PRIORITY = ['Low', 'Medium', 'High']

/** Deterministic pseudo-random: a small integer hash, so the corpus is varied
 *  but reproducible without a seeded RNG dependency. */
const mix = n => {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0
  return (x ^ (x >>> 15)) >>> 0
}

rmSync(outDir, { recursive: true, force: true })

const chunks = Math.ceil(ROWS / CHUNK)
for (let c = 0; c < chunks; c++) {
  const dir = join(outDir, `chunk-${String(c).padStart(3, '0')}`)
  mkdirSync(join(dir, 'data'), { recursive: true })

  // Only the first chunk defines the schema; the rest append rows to it.
  // `import` matches columns by name, so repeating the definition is harmless
  // but pointless — and keeping it in one place makes a schema change one edit.
  writeFileSync(join(dir, 'workspace.csv'), csv([
    ['key', 'value'],
    ['name', `Bench ${ROWS}`],
  ]))
  writeFileSync(join(dir, 'tables.csv'), csv([
    ['id', 'name'],
    ['bench', 'Bench'],
  ]))
  writeFileSync(join(dir, 'columns.csv'), csv([
    ['table', 'id', 'name', 'type', 'options'],
    ['bench', 'title', 'Title', 'text', ''],
    ['bench', 'status', 'Status', 'select', STATUS.join('|')],
    ['bench', 'priority', 'Priority', 'select', PRIORITY.join('|')],
    ['bench', 'estimate', 'Estimate', 'number', ''],
    ['bench', 'due', 'Due', 'date', ''],
    ['bench', 'notes', 'Notes', 'text', ''],
  ]))

  const start = c * CHUNK
  const end = Math.min(start + CHUNK, ROWS)
  const rows = [['title', 'status', 'priority', 'estimate', 'due', 'notes']]
  for (let i = start; i < end; i++) {
    const h = mix(i)
    rows.push([
      `Task ${i} — ${['refactor', 'investigate', 'ship', 'document', 'measure'][h % 5]} the ${
        ['sync loop', 'kanban board', 'filter engine', 'archive import', 'recovery flow'][(h >> 3) % 5]
      }`,
      STATUS[h % STATUS.length],
      PRIORITY[(h >> 5) % PRIORITY.length],
      (h % 13) + 1,
      // Deterministic dates across a year, so date filters have something real
      // to chew on.
      `2026-${String((h % 12) + 1).padStart(2, '0')}-${String((h % 28) + 1).padStart(2, '0')}`,
      `Generated row ${i}. ${'Detail '.repeat((h % 4) + 1)}`.trim(),
    ])
  }
  writeFileSync(join(dir, 'data', 'bench.csv'), csv(rows))
}

console.log(JSON.stringify({ outDir, rows: ROWS, chunkSize: CHUNK, chunks }))
