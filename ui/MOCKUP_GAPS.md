# UI Gaps vs Mockup

Comprehensive audit of every difference between the current implementation and the mockup.
Items are grouped by area. Stub implementations are explicitly noted where full backend wiring isn't needed.

---

## 1. Kanban — Drop-zone hover animation

**File:** `KanbanView.tsx` / `KanbanView.css`

**Gap:** The `.kcol__drop-area` element always fills the column. The mockup shows the drop-zone
animating (background highlight / border glow) *only while a card is being dragged over it*.

**Fix:** Use the `isOver` boolean returned by `useDroppable` and apply a CSS class conditionally:
```tsx
const { setNodeRef, isOver } = useDroppable({ id: column.id })
// <div ref={setNodeRef} className={`kcol__drop-area ${isOver ? 'kcol__drop-area--over' : ''}`}>
```
Add `.kcol__drop-area--over` CSS with a subtle border + background transition.

---

## 2. TableView — Remove "Create Kanban" button; replace with "New view" dropdown

**File:** `TableView.tsx`

**Gap:** The toolbar still has a `Create Kanban` button that opens a custom modal.
The mockup workflow is: **"New view" button → dropdown of view types → type-specific config modal**.

**Fix:**
- Remove the `Create Kanban` button and `isCreatingKanban` / `kanbanConfig` state.
- Add a `NewViewDropdown` component (reusable, lives in `components/`) that renders a popover with
  view-type options: Table, Kanban, Card (Calendar stub).
- Kanban config modal moves into a shared `NewViewModal` that accepts a `viewType` prop and shows
  the appropriate config fields.
- `NewViewDropdown` should also be accessible from the Sidebar "New view" button.

---

## 3. KanbanView — Cards are not clickable to open Entry view

**File:** `KanbanView.tsx`

**Gap:** `SortableCard`'s `onOpen` prop is wired to an empty arrow function
`onOpen={() => {/* entry navigation can be wired here */}}`. Clicking a card does nothing.

**Fix:**
```tsx
import { useNavigate } from 'react-router-dom'
// …inside KanbanView:
const navigate = useNavigate()
// Pass to SortableCard:
onOpen={(card) => navigate(`/table/${tableId}/entry/${card._row_id ?? card.id}`)}
```

---

## 4. TableView — Row click navigates to Entry but inline cell edit also fires navigation

**File:** `TableView.tsx`

**Gap:** The entire `<tr>` has `onClick={() => navigate(...)}` and the cells have
`onClick={e => e.stopPropagation()}`. This works, but:
- The row click target includes the delete button column, making the whole row feel like a link.
- The mockup shows clicking the *title cell* opens the entry; other cells are edit-in-place only.

**Fix:**
- Make only the first column (title) a clickable link to the entry.
- Remaining cells: edit-in-place, click does not navigate.
- Remove the whole-row `onClick` and move the navigate call to the title `<td>` only (or an
  explicit "open" icon on hover).

---

## 5. CardView — Card click navigates to Entry (currently working but untested from view route)

**File:** `CardView.tsx`

**Gap:** `CardView` reads `tableId` from `useParams` but when rendered via `ViewRouter` at
`/table/:tableId/view/:viewId`, the `:tableId` param is still present — this works. However the
toolbar title is hardcoded `"Card View"` instead of reading the view's name from the workspace.

**Fix:**
- Accept a `viewId` param (from `useParams`) and, if present, load the view config to get `v.name`
  for the toolbar title and `v.table_id` to confirm the table.

---

## 6. Sidebar — "New view" button is a no-op

**File:** `Sidebar.tsx`

**Gap:** The "New view" button has an empty `onClick`:
```tsx
onClick={() => { /* new view flow is per-table, navigate to first table if available */ }}
```

**Fix:**
- Clicking "New view" should open the `NewViewDropdown` (see item 2) or navigate to the current
  table with the dropdown pre-opened. As a stub: navigate to `/` or to the first available table
  and open the new-view modal there.
- Longer term: a global "New view" dialog that includes a table-selector step first.

---

## 7. Toolbar — "New entry" button doesn't create rows in TableView or navigate to new entry

**Files:** `TableView.tsx`, `KanbanView.tsx`, `CardView.tsx`

**Gap:**
- `TableView` calls `handleAddRow()` from the "New row" button, which creates a blank row.
  The mockup's "New entry" primary button should navigate directly to
  `/table/:tableId/entry/new` so the user fills in a proper form.
- `KanbanView` has a "New entry" button that does nothing (no `onClick`).
- `CardView`'s "New entry" calls `navigate(/table/:tableId/entry/new)` — this is correct.

**Fix:**
- `TableView`: rename "New row" → "New entry", change to `navigate(/table/:tableId/entry/new)`.
  Keep the inline "Add your first row" as a secondary path.
- `KanbanView`: wire "New entry" to `navigate(/table/:tableId/entry/new)`.
- `KanbanView` column-level "Add entry" buttons: navigate with pre-filled status query param
  (`/table/:tableId/entry/new?status=<column.id>`) — stub is fine.
- `EntryView` new-entry path: pre-populate the status field if a `?status=` param is present.

---

## 8. Toolbar — subtitle chip shows table name for views (currently missing from ViewRouter views)

**Files:** `ViewRouter.tsx`, `KanbanView.tsx`, `CardView.tsx`

**Gap:** The mockup toolbar shows the view name as the main title *and* the parent table name as
a small chip/badge to the right of it (like `Sprint Board [Tasks]`). The `Toolbar` component
accepts a `subtitle` prop but it isn't wired up in `KanbanView` or `CardView`.

**Fix:**
- Load the view config in `KanbanView` (already done) and the table schema name.
- Pass `subtitle={tableName}` to `Toolbar`.
- `CardView` similarly needs to load the view config when a `viewId` param is present.

---

## 9. EntryView — breadcrumb back target should be the *view* you came from, not just the raw table

**File:** `EntryView.tsx`

**Gap:** `handleBack` always navigates to `/table/:tableId`. If the user entered the entry from a
Kanban view, the back button should return to that view, not the plain table grid.

**Fix:**
- Pass the referrer path via React Router's `state` when navigating to the entry:
  ```tsx
  navigate(`/table/${tableId}/entry/${rowId}`, { state: { from: location.pathname } })
  ```
- In `EntryView`, read `location.state?.from` for the back destination, falling back to
  `/table/:tableId`.

---

## 10. EntryView — title is editable in the mockup (click-to-edit `<h1>`)

**File:** `EntryView.tsx`

**Gap:** The `<h1 className="entry-view__title">` is static. The mockup shows the title as a
large, click-to-edit inline field (no label, just the value).

**Fix:**
- Replace the static `<h1>` with a contenteditable div or a styled `<input>` that looks like a
  heading.
- On blur, call `handleFieldChange(titleCol.id, newTitle)`.
- The title field should NOT be duplicated in the fields list below it.

---

## 11. EntryView — field display order does not match mockup (should be schema-defined, not alpha)

**File:** `EntryView.tsx`

**Gap:** Columns are sorted alphabetically:
```tsx
const columns = Object.values(schema.columns).sort((a, b) => a.name.localeCompare(b.name))
```
The mockup shows a defined field order: Status → Priority → Assignee → Due date → then the
document field. There is no `sort_order` in the current schema type, but the workspace WASM
has `order` fields.

**Fix (stub):** Keep alpha sort for now but exclude the title column from the fields list (it's
already shown in the editable `<h1>`). Add a `// TODO: use schema-defined sort_order` comment.

---

## 12. EntryView — document field shows Source/Preview/Split tabs (currently MarkdownEditor only)

**File:** `EntryView.tsx` / `MarkdownEditor.tsx`

**Gap:** The mockup shows three tabs above the document editor: **Source | Preview | Split**.
`MarkdownEditor` already has internal edit/preview state but no visible tab UI in `EntryView`.

**Fix:**
- `MarkdownEditor` should expose `mode` as a prop (`'source' | 'preview' | 'split'`).
- Render `TabButton` row above the editor in `EntryView` (or inside `MarkdownEditor` itself,
  matching the mockup's placement inside the field area).
- "Split" is a stub — show source + a placeholder preview pane side by side.

---

## 13. TableView — rows render only raw cell text; no StatusPill / Avatar for special columns

**File:** `TableView.tsx`

**Gap:** The mockup's table view shows `StatusPill` coloured badges for Status/Priority columns
and `Avatar` chips for Assignee. Currently all cells render as plain `<input type="text">`.

**Fix:**
- For display mode (not focused), detect column type from schema: `select` → render a
  `StatusPill`; `text` columns named "assignee" → render an `Avatar`.
- On click, switch to edit mode (the current `<input>`).
- This requires a `display` vs `editing` cell state — scope to the clicked cell.

---

## 14. KanbanView — cards should show priority pill and due date (mockup card layout)

**File:** `KanbanView.tsx`

**Gap:** `SortableCard` shows `extraFields` as a generic key-value list. The mockup shows cards
with a formatted layout: priority coloured pill (bottom left), due date (bottom centre), assignee
avatar (bottom right).

**Fix:**
- Detect known columns (priority, due, assignee) in the card data and render them with
  `StatusPill` / date string / `Avatar` in the card footer row.
- Fall back to generic key-value display for unrecognised fields.

---

## 15. Sidebar — "New view" should know which table to attach to

**File:** `Sidebar.tsx`

**Gap:** The sidebar has no concept of a "current table" context when "New view" is clicked from
the Views section. The mockup implies views are always attached to a specific table.

**Fix:**
- Detect the current `tableId` from `useLocation()` / path matching when "New view" is clicked.
- If on a table route, pre-populate the table selector in the new-view modal.
- If no table is active, show a table-selection step first.

---

## 16. Sidebar — collapsed state only hides content, but logo is still rendered

**File:** `Sidebar.tsx` / `Sidebar.css`

**Gap:** When `collapsed = true`, the sidebar shows only the logo tile. The mockup's collapsed
state also shows icon-only versions of each nav item (just the icon, no label).

**Fix (stub):** In collapsed mode, show the workspace logo + vertically stacked view-type icons
for each view. This is purely cosmetic — the icons are already available.

---

## 17. TableView — the "New view" entry point should be in the toolbar, not a separate modal button

**File:** `TableView.tsx`

**Gap:** Currently `Create Kanban` is a `toolbar__btn--secondary`. After fix #2, the toolbar
should have a `New view` dropdown button (consistent with what the sidebar shows).

**Fix:** Replace `Create Kanban` button with `<NewViewDropdown tableId={tableId} onCreated={...} />`
placed in the Toolbar actions. After a view is created, navigate to it.

---

## 18. ViewRouter — loading flash (renders `null` briefly)

**File:** `ViewRouter.tsx`

**Gap:** While resolving the view type, `ViewRouter` returns `null`, causing a blank content area
for one render cycle.

**Fix:** Return a loading spinner or the Toolbar skeleton while resolving:
```tsx
if (viewType === null) return <div className="view-loading"><LoadingSpinner /></div>
```

---

## 19. Entry breadcrumb — shows schema table name but not the view name

**File:** `EntryView.tsx`

**Gap:** The mockup breadcrumb is: `Sprint Board > Task title` (view name → entry title).
Current code shows `Tasks > Task title` (table name).

**Fix:** Read `location.state?.from` (set in fix #9) to derive the view name, or pass the
originating view name in navigate state:
```tsx
navigate(`/table/${tableId}/entry/${rowId}`, {
  state: { from: location.pathname, viewName: viewConfig.name }
})
```
Then in `EntryView`, use `location.state?.viewName ?? schema.name` for the breadcrumb label.

---

## 20. No "New entry" keyboard shortcut / focus management

**File:** `EntryView.tsx`

**Gap:** The mockup implies good keyboard navigation between fields. Currently there is no focus
management after "New entry" navigation — the user lands on a blank form with no focused field.

**Fix (stub):** Auto-focus the title field on mount when `rowId` is undefined (new entry mode).

---

## Summary Table

| # | Area | Severity | Stub OK? |
|---|------|----------|----------|
| 1 | Kanban drop-zone hover animation | Medium | Yes |
| 2 | New view dropdown (replace Create Kanban button) | High | Yes |
| 3 | Kanban card click → Entry view | High | No — needs wiring |
| 4 | Table row click scope (title-only navigation) | Medium | No |
| 5 | CardView toolbar title from view config | Low | Yes |
| 6 | Sidebar "New view" no-op | Medium | Yes |
| 7 | "New entry" buttons not wired | High | Partial |
| 8 | Toolbar subtitle (table name chip) missing | Low | Yes |
| 9 | Entry back button ignores originating view | Medium | Yes |
| 10 | Entry title editable inline | Medium | No |
| 11 | Field display order (title excluded from list) | Medium | Yes |
| 12 | Document field Source/Preview/Split tabs | Medium | Yes |
| 13 | Table cells: StatusPill/Avatar for known columns | Medium | Yes |
| 14 | Kanban card: priority/due/avatar layout | Low | Yes |
| 15 | Sidebar "New view" needs table context | Medium | Yes |
| 16 | Sidebar collapsed: icon-only nav items | Low | Yes |
| 17 | Toolbar "New view" dropdown consistency | High | Yes |
| 18 | ViewRouter null loading flash | Low | Yes |
| 19 | Entry breadcrumb shows table name not view name | Medium | Yes |
| 20 | Auto-focus title on new entry | Low | Yes |
