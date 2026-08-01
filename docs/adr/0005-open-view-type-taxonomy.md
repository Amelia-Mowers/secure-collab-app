# ADR 0005 — `view_type` is an open string, not a closed enum

**Status:** proposed
**Date:** 2026-08-01
**Issues:** `78529070` (open up the view-type taxonomy)

## Context

`ViewType` is a closed six-variant enum in `crates/app-core/src/views.rs:8-24`
(`Table | Kanban | Card | Calendar | TaskList | Custom`), with no
`#[serde(other)]` and no catch-all variant.

The original issue framed this as a taxonomy tidy-up — the enum "hid the missing
card variant". Tracing what actually happens to an unrecognised value turned up
something worse, and it is the reason this needs a decision rather than a patch.

### What happens today to a view this client does not know

Suppose a newer client writes a view with `type = "gantt"`.

1. **Sync ingests it fine.** `_views` rows are ordinary LWW cells; nothing on
   the write path parses `ViewType`. The workspace loads normally and no other
   view or table is affected. This is the one piece of good news, and it is what
   makes an open string cheap to adopt.
2. **`list_views_for_table` returns it** (`views.rs:380-392`) — it only checks
   `table_id` and the `deleted` tombstone.
3. **`get_view` returns `None`** (`views.rs:344-353`). The `.ok()?` on the
   deserialise turns an unknown type into a dropped view. Silently: nothing is
   logged.
4. So the sidebar **silently omits it**. `Sidebar.tsx` iterates the ids from
   step 2 and calls `getView` per id inside `catch { /* skip malformed view */ }`.
   The user sees "Q3 Gantt" on their other client and nothing here, with no
   indication anything is missing.
5. **Direct URL navigation gives a broken error state, not a fallback.**
   `ViewRouter` catches the throw and falls back to `KanbanView`, which then
   calls `getView` itself, throws again, and renders its error state.
6. **CSV export drops it** — export collects via `list_views_for_table` +
   `get_view`, so it never reaches the bundle.
7. **CSV import fails the *whole archive*.** `read_views` (`archive.rs:862-909`)
   propagates the deserialise error with `?`, so one unknown view type aborts
   the entire import. Note filters and sorts immediately below use
   `if let Ok(...)` and skip bad rows — the same file already disagrees with
   itself about how to handle an unparseable record.
8. **A view can be silently clobbered.** Because the gantt view is invisible
   here, a user can create a new view with the same id; `create_view` is
   upsert-by-id under LWW, so it overwrites the newer client's view. Nothing
   warns. This is the only genuine data-loss path in the list.

Net: not a hard failure, but silently invisible, unexportable, import-breaking,
and clobberable.

### Two further findings worth recording

**Nothing in Rust branches on the variant.** Grepping `crates/` finds no
`ViewType::X =>` match arms outside test constructors. The only reads are a
debug-format for a CLI display column and a string for CSV export. Behaviour is
driven entirely by the *separate* optional config structs (`kanban_config`,
`calendar_config`, …), each parsed leniently with `.ok()`. `create_view` does
not even check that a `Kanban` view has a `kanban_config`. **The enum buys no
type safety today** — it is pass-through data that can only reject.

**There is a green test that proves nothing.** `ViewRouter.test.tsx` — "renders
KanbanView as fallback for an unknown view_type" — passes because
`mockWorkspace.seedView` bypasses the mock's own validation. Against the real
core, `get_view` returns `None`, the bridge throws, and `ViewRouter` never
reaches the fallback branch with a real config; it goes down the `catch` into
the broken state in (5). The test's comment ("local creation rejects it, the
read path tolerates it") describes the mock, not the product.

## Decision

**`view_type` becomes an open string, validated structurally rather than by
enumeration. Renderability is the UI's decision, not the core's.**

Concretely:

1. **Core**: `ViewType` becomes a newtype over `String` (or gains
   `#[serde(other)] Unknown(String)` preserving the original text — the newtype
   is preferred because it cannot lose the value). Validation is structural: a
   non-empty string, so a view still cannot be typeless.
2. **`get_view` stops dropping views it cannot classify.** An unknown type
   returns a `ViewConfig` with the type intact, so the sidebar lists it, export
   round-trips it, and a rename preserves it. This is the change that closes the
   clobber path in (8).
3. **CSV import stops aborting.** `read_views` follows the filter/sort
   precedent already in that file.
4. **UI gains a registry** mapping type → component, replacing three
   independent lists (`ViewRouter`'s if-chain, `Sidebar.viewIcon`'s if-chain,
   `NewViewDropdown.VIEW_TYPE_OPTIONS`). Unknown types get one honest
   "this view needs a newer version of TideWork" render, not a Kanban that
   cannot load.
5. **Creation stays closed.** The dialogue offers only what this client can
   render. Being liberal in what we accept does not mean being liberal in what
   we emit.

## Alternatives considered

**Keep the enum, add variants as needed.** This is the status quo, and it fails
the forward-compatibility test that matters for a product where two devices can
run different versions against the same room. Every new view type would make
older clients silently hide data until they update.

**Keep the enum, but make `get_view` tolerant.** Fixes the invisibility and the
clobber path without opening the taxonomy. Cheaper, and a reasonable fallback if
(1) proves disruptive — but it leaves the value lossy on the way through
(`Unknown` with no payload cannot round-trip an export) and keeps three
hardcoded lists in the UI.

**Validate against a registry shipped in the workspace.** Over-engineering: it
makes the data self-describing at the cost of a schema-evolution problem we do
not have.

## Consequences

- **Forward compatibility becomes the default.** An older client shows an
  unknown view as unrenderable rather than pretending it does not exist, and no
  longer destroys it by id collision.
- **The UI carries the taxonomy.** That is the right place: it is the only layer
  that knows what it can draw.
- **`createView` must accept what `getView` returns.** Today rename and
  view-settings rebuild the config and re-`createView` it. Relaxing the read
  path without relaxing creation would turn a silent omission into a save-time
  throw — strictly worse. The two paths must move together, and that is the
  main implementation risk.
- **The mock and the real core must agree.** `mockWorkspace`'s `VIEW_TYPES` list
  and the `ViewRouter` fallback test both need rewriting against the new
  behaviour; the current test would otherwise keep passing while proving
  nothing.
- **Loss of a compile-time exhaustiveness check** — which costs nothing here,
  since no code exhaustively matches on it.
