# ADR 0004 — CSV archive as the single interchange format

**Status:** proposed
**Date:** 2026-07-26
**Issues:** `row_1785004738121` (New Workspace templates), `db09da3a` (export/import)

## Context

Three features want to move a workspace's shape and contents in and out of the
app, and they were about to grow three formats:

1. **Templates** — the New Workspace dialogue offers starter workspaces.
2. **Workspace export/import** — take your data out; put it back.
3. **Single-table import** — drop a spreadsheet into a table.

Today's starter content is hardcoded TypeScript (`ui/src/tableTemplates.ts`,
`ui/src/lib/demoWorkspace.ts`), which means templates can only be authored by
someone editing the UI bundle, and nothing round-trips.

The original issue asked that the template format be "based on the CSV/data
import format" — correctly identifying that these are one problem, not three.

## Decision

**One format serves all three: a CSV archive.** A workspace is a directory (or
zip) of CSV files. Both the *data* and the *metadata describing the data* are
CSVs, because our metadata is already tabular — columns, views, filters, and
sorts are each naturally a table of records.

That single property is what makes this worth committing to: there is exactly
one parser in the read path, every file in an archive opens in any spreadsheet,
and a human can author a template without running the app.

### Layout

```
workspace.csv          key,value  — name, format_version
tables.csv             id,name,order
columns.csv            table,column,name,type,options,reference_table,
                       reference_display_column,width,required,default,order
views.csv              id,name,table,type,settings
filters.csv            view,column,operator,value
sorts.csv              view,column,direction,order
data/<table>.csv       one per table; header row = column names
```

Only `workspace.csv` and `data/` are required. An archive with no `columns.csv`
is a valid import — types get inferred (see below). An archive with no `data/`
is a valid *template* that seeds structure and no rows.

### The decisions inside that layout

**Data headers are column _names_, not ids.** A single exported table CSV is
then an ordinary spreadsheet that opens correctly anywhere, and a hand-authored
CSV needs no invented identifiers. Names are matched back to `columns.csv` on
import; ids stay internal and are minted fresh.

**References are stored as the target row's display label, not its row id.**
This is the decision that makes templates work at all: because nothing in an
archive names a row id, instantiating a template needs no id-remapping pass —
row ids are minted fresh and references resolve by label against the target
table's `reference_display_column`. It also means a reference column reads as
meaningful text in a spreadsheet rather than `row_1785004738121`. Labels that
don't resolve are surfaced in the import preview rather than silently dropped.

**Multi-value cells are comma-separated inside the (RFC 4180-quoted) field.**
The usual objection — that option values may themselves contain commas — does
not apply here, because the reader knows the column's type *and* its enumerated
value set from `columns.csv` before parsing the cell: multiselect options and
reference labels are both known sets, so the split is resolved by matching
against them rather than guessing. Where no set exists (an unmanifested import),
the column is text and the comma is just a character.

**`views.csv` carries type-specific config as JSON in one `settings` cell;
filters and sorts get their own flat CSVs.** Kanban/calendar/tasklist configs
are per-type record shapes that would make a shared sheet wide and sparse.
Filters and sorts are genuinely uniform records and are also the part a template
author most wants to read and tweak, so they stay first-class rows. A filter
`value` is written plain when scalar and as JSON only when it is an array or a
span. JSON appears in an archive in exactly these two places and nowhere else.

**Container:** in-tree templates ship as plain directories (diffable, reviewable
in a PR). User-facing export produces a `.zip` of the same layout — one file to
hand to someone. Import accepts either.

**Implementation lives in `app-core`**, not the UI. The reader/writer is pure
logic over strings, so it is natively testable, and the same code backs the web
dialogue (wasm) and `tidework export` / `tidework import` in the CLI. A format
implemented twice diverges.

**Versioning:** `format_version` in `workspace.csv`. An unknown *major* is
refused with a clear message rather than partially applied.

### Single-table import

The dialogue that drops one CSV into the app is the same reader with no
manifest, plus a preview step:

- header row on/off;
- per-column inferred type, each overridable before commit;
- destination: a new table, or append to an existing one with column mapping;
- unresolvable reference labels and rows that fail their column's type are
  listed in the preview — the import is not committed until the user has seen
  the count.

Inference, applied per column over the sampled rows, first match wins: every
value parses ISO-8601 → `date`; every value numeric → `number`; every value in a
boolean vocabulary → `boolean`; distinct values ≤ 20 and ≤ half the row count →
`select` with those options; otherwise `text`.

Inference is a *starting point for the preview*, never a silent decision — which
is why the override exists in the same step.

## Consequences

- Templates become data. The shipped set moves out of the TypeScript bundle into
  reviewable CSV directories, and `tableTemplates.ts` / `demoWorkspace.ts`
  become archives instead of code.
- Export/import and templates cannot drift, because they are the same code path.
- Round-tripping is lossy in one deliberate place: internal ids (rows, columns,
  tables, views) are not preserved across an export/import cycle. Identity is
  re-minted. This is the cost of label-based references and name-based headers,
  and it is the right trade for a format whose primary job is portability
  between workspaces rather than backup/restore of one.
- A cell value that is itself a comma-separated string in a text column is
  unambiguous; the same string in a multiselect column is not recoverable as a
  single value. Multi-value columns cannot represent a value containing a comma.
- The zip path adds a dependency in `app-core`. It is confined to the container
  layer; the format itself is readable without it.
