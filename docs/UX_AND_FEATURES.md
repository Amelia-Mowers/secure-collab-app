# UX and Features

## Views System

### View Types

All views are client-side projections over the underlying table data. The same table can be rendered simultaneously in multiple views.

**Table view** — the default. Rows and columns, inline editable, sortable, filterable. Column resizing and reordering. Familiar spreadsheet-like interaction model.

**Kanban board** — rows grouped into columns by a select/status field. Drag a card between columns to update that field. Cards show a configurable subset of fields (title, assignee avatar, due date, priority badge, etc.).

**Calendar** — rows plotted on a date grid by a date field. Drag to reschedule. Day, week, and month views. Rows without a date value don't appear but are accessible through a sidebar or filtered table view.

**Task list** — a flat or grouped checklist. Checkbox field toggles completion. Indentation or grouping by a parent reference field enables subtasks. Keyboard-driven: arrow keys to navigate, space to toggle, Enter to create a new task inline.

**Card view** — a grid of cards, each representing a row. Cards display a preview of the document cell (first few lines or a rendered thumbnail) alongside key fields. Useful for browsing document-heavy tables like knowledge bases, wikis, design docs, or template libraries. Think Pinterest-style grid or a file manager's icon view.

**Entry view** — a full-page view of a single row. Described in detail below.

### Temporary and Saved Views

Every view starts as a **temporary view**. When a user filters a table, changes the sort, switches to kanban, or adjusts which fields are visible, they're building a view config object in local client state. This config is identical in shape to a saved view — it has a view type, a target table, filter/sort/group rules, field visibility and ordering, and layout options.

The view is not persisted to the workspace until the user explicitly saves it. Before that, it exists only on the current client and is discarded on navigation or close.

**Saving a view** writes the config as a new row in the system views table. It becomes a `cell.update` event, syncs to all clients, and appears in the workspace's view sidebar for everyone. Saved views have a name, an icon, and an optional description.

**Updating a saved view** is the same as creating one — modify the config locally, then save to overwrite the existing view row.

**Duplicating a view** copies the config into a new temporary view, which can then be modified independently and optionally saved.

### Personal Views

Some views are useful to an individual but shouldn't clutter the shared workspace. Personal views are saved to Matrix account data (per-user key/value storage that is not shared to the room) rather than to the workspace's views table.

Personal views appear in the user's sidebar with a distinct indicator (e.g., a subtle "private" badge) and are not visible to other workspace members. They sync across the user's own devices via Matrix account data sync but never appear as events in the workspace room.

### View Configuration

Each view config includes:

- **Target table** — which table this view projects.
- **View type** — table, kanban, calendar, task list, or entry.
- **Filters** — field conditions (e.g., status = "In Progress", assignee = me, due date < next week). Multiple filters combine with AND/OR logic.
- **Sort** — ordered list of field + direction pairs.
- **Grouping** — for kanban and grouped table/list views, which field to group by.
- **Field visibility and order** — which columns/fields are shown and in what order. Different views of the same table can show different fields.
- **Field sizing** — column widths for table view, card field layout for kanban.
- **Creation defaults** — when creating a new entry from this view, pre-fill these fields with these values. For example, creating from a kanban column pre-fills the status field. Creating from a filtered view pre-fills the filter field values.

## Entry View

The entry view is the primary interface for viewing and editing a single row. It replaces the concept of "opening a page" in Notion or "expanding a record" in Airtable.

### Layout

The entry view renders a row's cells **in configured field order**, top to bottom. There is no fixed "properties panel" vs. "document area" split — document cells are just another cell type that appears in sequence alongside simple cells. An entry might render as:

- Title (text cell)
- Status (select cell)
- A project brief (document cell)
- Assignee (user cell)
- Due date (date cell)
- Technical spec (document cell)
- Notes (document cell)

Each cell renders according to its type:

- Text → inline editable text field
- Number → number input with optional formatting (currency, percentage, plain)
- Select → dropdown with colored option pills
- Multi-select → tag-style input with colored pills
- Date → date picker, with optional time
- Checkbox → toggle switch
- Reference → linked chip showing the referenced row's title, clickable to navigate
- User/assignee → avatar with name, selectable from workspace members
- URL → clickable link with inline edit

Fields are displayed in a configurable order per view. Different entry views of the same table can show different fields in different orders — a "Quick Edit" view might show only title, status, and assignee as compact form fields, while a "Full Entry" view shows every field including multiple document cells. A "Writing" view might show only the title and the main document cell, hiding everything else for a distraction-free editing experience.

An entry can have **multiple document cells** — a project brief, a technical spec, meeting notes, a changelog — each appearing as a distinct editable region in the entry view, interspersed with simple fields wherever they fall in the configured order.

### Document Cell

The document cell is a special cell type whose value is collaborative rich text rather than a simple scalar.

For V1, the document editor supports:

- Block types: paragraphs, headings (H1-H3), bullet lists, numbered lists, checklists, code blocks, blockquotes, horizontal dividers.
- Inline formatting: bold, italic, strikethrough, inline code, links.
- Inline references: `@`-mention a row from any table in the workspace, rendered as a clickable chip.
- Markdown shortcuts: typing `#` + space at the start of a line creates a heading, `- ` creates a bullet, `[] ` creates a checklist item, ``` starts a code block, etc.
- Slash commands: typing `/` opens a block type picker.

The document cell uses a text CRDT for collaborative editing. Operations are serialized as JSON/binary and sent as Matrix events. Periodic snapshots are emitted when the document is quiescent to bound the history needed for reconstruction.

The document content is **lazily loaded**. Table views, kanban boards, calendars, and task lists never need the document body — they only use the simple cells (title, status, date, assignee, etc.). The document CRDT history is only fetched and reconstructed when a user opens the entry view for that specific row.

### Typst as the Document / Template Engine

The document engine is built on **Typst**, a modern typesetting system implemented in Rust. Typst compiles to PDF and has a powerful scripting/template language while remaining human-readable. This is a strategic choice that unlocks capabilities that neither Notion nor Airtable offer natively.

#### Templated Documents

Typst templates can reference cell values from the current entry, from related entries, or from entire tables in the workspace. This enables:

- **Contract generation** — a contract template that pulls in `client.name`, `project.start_date`, `hourly_rate`, and generates a formatted PDF on demand.
- **Invoice creation** — a template that iterates over rows in a linked line-items table, calculates totals, and renders a professional invoice.
- **Reports** — aggregate data across entries (count, sum, average) and present it in a formatted document with charts or tables.
- **Certificates, letters, proposals** — any document where structure is reusable but data varies per entry.

Template definitions are stored as document cells in a system templates table. Each template has access to an injection context that provides the current entry's fields, related entries via references, and query functions over workspace tables.

#### Batch PDF Rendering

The "print a set of entries as PDFs" workflow: select multiple rows in a table view, choose a template, and render each entry through the template to produce a batch of PDFs (or a single merged PDF). This runs entirely client-side in the Rust/WASM core — Typst compiles in Rust, so PDF generation requires no server-side component.

Use cases: generating a stack of invoices for all clients, printing certificates for all event attendees, creating a report packet for a quarterly review.

#### Editing Experience

The document editing experience follows the same pattern as Typst's own first-party apps: a **dual-pane source/render view**. The left pane is a plain text editor showing the Typst source, and the right pane shows the live-rendered output. Changes in the source are reflected in the render in real time.

This approach has several advantages:

- **Plain text CRDT is sufficient.** Since the source is just text, a plain text CRDT (like Diamond Types) handles collaborative editing. No need for a structured rich text CRDT — the complexity stays low and performance stays high.
- **Full Typst power is always accessible.** There's no lossy mapping between a WYSIWYG model and the underlying format. Users see exactly what they're editing. Templates, scripting, conditional logic, computed values — all directly editable.
- **Predictable rendering.** Every user sees the same source, compiled by the same Typst engine, producing identical output. No ambiguity.

For users who are less comfortable with markup, the editor provides:

- **Toolbar buttons** that insert common Typst syntax (bold, italic, headings, lists, links) at the cursor position.
- **Markdown-compatible shortcuts** — Typst's syntax is similar enough to Markdown that common patterns (e.g., `= Heading`, `- list item`, `*bold*`) feel natural to Markdown users.
- **Slash commands** — typing `/` opens a block type picker that inserts the correct Typst syntax.
- **Syntax highlighting** in the source pane for readability.

The render pane updates live as the user types. For simple content like notes and task descriptions, the source is readable enough that some users may prefer to hide the render pane entirely and work in source-only mode, similar to writing Markdown.

### Navigation

Entry views support standard navigation patterns:

- **Back** — return to the previous view (table, kanban, etc.).
- **Previous / Next** — navigate to the adjacent row in the current view's sort order. Arrow keys or dedicated buttons. Useful for reviewing a series of entries.
- **Breadcrumb** — shows the path: Workspace → Table → View → Entry title.
- **Deep linking** — every entry view has a URL that can be shared. Opening it loads the workspace, navigates to the table, and opens the entry.

## Rapid Entry Creation

The entry view doubles as a creation form. The goal is to make creating many entries in sequence as frictionless as possible.

### Flow

1. User triggers "new entry" from any view — the "+" button on a table, kanban, or task list, or a keyboard shortcut.
2. A blank entry view opens with a fresh `row_id`. If triggered from a context with implicit field values (e.g., a kanban column, a filtered view, a specific date on the calendar), those fields are pre-filled from the view's creation defaults.
3. The cursor lands in the title/name field.
4. The user fills in fields using Tab to advance between them. The field order matches the entry view's configured layout.
5. At any point, the user can press a "Commit & Next" button, or a keyboard shortcut (Ctrl/Cmd+Enter), to save the current entry and immediately open a fresh blank entry with the same creation defaults.
6. Repeat as many times as needed. The previous entries are written to the workspace as `cell.update` events asynchronously.
7. When done, the user presses Escape or clicks "Done" to return to the previous view.

### Feedback

- A subtle counter shows how many entries have been created in the current session ("3 entries created").
- Each committed entry briefly appears as a confirmation (a small toast or inline flash) before the form resets.
- The previous view updates in the background as entries land — if the user glances at the kanban board behind the entry form, new cards appear in real time.

### Keyboard-Driven Design

The entire creation flow is navigable without a mouse:

- **Tab / Shift+Tab** — move between fields.
- **Enter** — within a select/dropdown, confirms the selection. Within a text field, moves to the next field (or inserts a newline in the document cell, context-dependent).
- **Ctrl/Cmd+Enter** — commit current entry and open next.
- **Escape** — close the entry form. If fields have been modified but not committed, prompt to save or discard.
- **Arrow keys** — within select fields, navigate options. Within the document cell, standard text navigation.
- **`@`** — in the document cell or a reference field, opens a row search picker for creating inline references.

### Form-Style Creation

For structured data entry (e.g., onboarding a batch of inventory items, logging a series of bug reports), the entry view can be configured to show only the relevant fields in a compact form layout. This is configured per-view — a "Bug Report Form" view might show only title, severity, assignee, and a description document cell, while the full entry view shows all fields including every document cell. Since document cells are just another cell type in the field order, they can be included or excluded from any view like any other field.

## Cross-Cutting UX Patterns

### Inline Editing

All views support inline editing where it makes sense:

- **Table view** — click a cell to edit in-place. Tab to move to the next cell. Enter to confirm and move down.
- **Kanban** — click a card's title to rename inline. Click other visible fields to edit. Drag to change the grouping field.
- **Calendar** — drag to reschedule. Click to open entry view for full editing.
- **Task list** — click to edit title inline. Space to toggle checkbox. Enter to create a new task below.

The entry view is always available for full editing — inline editing is a convenience for quick changes, not a replacement.

### Undo

Local undo (Ctrl/Cmd+Z) reverts the most recent cell write on the current client. This emits a new `cell.update` with the previous value — undo is not special, it's just another write. Undo history is local and ephemeral (not persisted across sessions).

For document cells, undo operates at the CRDT operation level — undoing a character insertion emits a delete operation for that character.

### Search

Global search across all tables in the workspace. Searches simple cell values (titles, text fields, select values) and optionally document cell content. Since document cells are lazily loaded, deep search may require a full traversal of the room history — this can be implemented as a background indexing task that builds a local search index progressively.

### Mobile

On mobile, the entry view is the primary editing interface. Table and kanban views serve as navigation — tap a row/card to open the entry view. The rapid creation flow adapts to touch: a prominent "+" FAB (floating action button), swipe-to-commit-and-next, and large touch targets for field inputs.

The properties panel in entry view collapses to a horizontal scrollable strip or a collapsible section at the top, giving the document cell maximum screen space.

## Comments and Messaging

Building on Matrix means in-app communication is nearly free to implement. The workspace room already supports message events — comments and discussions are just a UI treatment and an event convention on top of existing infrastructure.

### Entry Comments

Comments on an entry are Matrix message events with a custom content field tagging them to a specific `(table_id, row_id)`. The client filters these events and renders them as a comment thread in the entry view — typically in a sidebar or below the document area.

Features inherited from Matrix for free:

- **Threaded replies** — respond to a specific comment, rendered as a thread.
- **Reactions** — emoji reactions on comments for lightweight acknowledgment.
- **Read receipts** — see who has read the comment thread.
- **Rich content** — comments can include formatted text, images, file attachments, and inline references to other entries.
- **Notifications** — Matrix push notifications surface new comments to relevant users.

### Field-Level Comments

For more granular discussion, comments can be tagged to a specific `(table_id, row_id, column_id)` — a conversation about a particular field value. The entry view shows a comment indicator on fields that have active discussions. Clicking it opens the thread for that specific field.

### Workspace-Level Chat

Since the workspace is a Matrix room, a general chat channel is available with zero additional infrastructure. A "Chat" tab or sidebar shows the room's untagged messages — general team discussion that isn't tied to a specific entry. This coexists with the structured data in the same room, differentiated by event type.

## Forms

Forms allow data collection from people who may not have access to the workspace — survey responses, bug reports, contact forms, event registrations, etc.

### Authenticated Forms (Internal)

For team-internal forms, no additional infrastructure is needed. The form is a view configuration that specifies a subset of fields, a layout, and creation defaults. Team members fill it out using the normal rapid entry creation flow — they're already authenticated via Matrix.

### Anonymous / External Forms

External forms require a lightweight **forms service** — a small server-side component (a single Rust binary) that bridges unauthenticated HTTP submissions into the Matrix room.

Architecture:

- The forms service runs alongside (or on) the Matrix homeserver.
- It holds a Matrix bot account with write access to the workspace room.
- Each published form gets a unique URL served by the forms service.
- The service reads the form definition from the workspace (field schema, layout, validation rules) and serves an HTML form page.
- Submissions hit an HTTP POST endpoint. The service validates against the schema and writes `cell.update` events to the room on behalf of the bot account.
- Rate limiting, CAPTCHA, and spam prevention are handled at the service level.

The form definition itself is stored in the workspace as a view config row — the forms service just reads it. This means form configuration is collaborative, version-controlled, and encrypted at rest like everything else in the workspace.

For the hosted/SaaS offering, the forms service is included. For self-hosted deployments, it's an optional component that can be deployed alongside the homeserver.

## API, CLI, and Library

The three-layer architecture (tables-over-matrix → app core → UI) naturally exposes programmatic access at multiple levels.

### Library

Both Rust crates are designed to be usable as standalone libraries, not just internal implementation details:

- **`tables-over-matrix`** — the foundational layer. Any Rust project can depend on it to get encrypted collaborative tables over Matrix. It handles Matrix SDK integration, LWW resolution, cell materialization, CRDT operations, and compaction. Useful for anyone who wants the data layer without the application semantics.
- **App core crate** — adds workspace semantics on top: system table conventions, schema management, view definitions, Typst template rendering, entry lifecycle. This is the layer that the CLI, the web UI, and any third-party integrations should target. It exposes a complete API for workspace operations — creating tables, querying entries, managing views, rendering documents — without coupling to any specific UI or transport.

Both crates are published to crates.io. A third-party developer could use the app core crate to build a completely different UI, a Matrix bot that interacts with workspace data, a sync bridge to another system, or a custom automation pipeline — all while sharing the same encrypted workspace via Matrix.

### CLI

A command-line tool that wraps the app core, providing direct access to workspace operations:

- `workspace login` — authenticate to a Matrix homeserver.
- `workspace tables` — list tables in a workspace.
- `workspace query <table> --filter "status=done"` — query entries.
- `workspace create <table> --field "title=Bug fix" --field "priority=high"` — create an entry.
- `workspace update <table> <row_id> --field "status=done"` — update a cell.
- `workspace render <template> <entry_id> --output invoice.pdf` — render a Typst template to PDF.
- `workspace export <table> --format csv` — export table data.

This enables scripting, CI/CD integration, and automation. A GitHub Action could create entries from issue events. A cron job could generate weekly report PDFs. A migration script could bulk-import data from a CSV.

### REST API

For integrations that can't use the Rust library directly, the forms service (or a dedicated API service) can expose a REST API over HTTP. Authenticated via Matrix tokens, it provides CRUD operations on workspace data. This enables webhooks, Zapier-style integrations, and custom dashboards.

## Deployment and Hosting

### Web App

The primary deployment target is a static web application — a JS/WASM bundle hosted on any static file server. The app runs entirely client-side, communicating with Matrix homeservers via the client-server API. No application server needed for the core product.

Hosting options:

- **GitHub Pages** — free, versioned, easy CI/CD from the repository. Good default for the open-source project.
- **Cloudflare Pages / Netlify / Vercel** — alternatives with CDN distribution.
- **Self-hosted** — drop the static files on any web server or S3 bucket.

Users load the app in their browser, enter their homeserver URL, authenticate, and start working. The WASM core handles encryption, sync, and data processing locally.

### Desktop App

Using Electron, the same JS UI + Rust WASM core can be packaged as a desktop application. This simplifies the build process and provides a consistent runtime across platforms. The WASM core handles all the heavy lifting while Electron provides native OS integration and packaging.

### Mobile

A progressive web app (PWA) for initial mobile support, with native apps (via React Native or a dedicated mobile framework) as a future option.

## Feature Scope by Version

### V1 — Core

- Table view with inline editing, sort, filter.
- Kanban view with drag-and-drop.
- Entry view with properties panel and markdown document cell.
- Temporary and saved views.
- Rapid entry creation with Commit & Next.
- Single-user and multi-user via Matrix.
- E2E encryption on by default.
- Entry comments via Matrix messages.
- Static web app hosted on GitHub Pages.

### V2 — Expand

- Calendar view.
- Card view for document browsing.
- Task list view with subtask hierarchy.
- Typst integration for templated documents and PDF generation.
- Native rich text document cell (CRDT upgrade from markdown-on-plain-text).
- Personal views.
- Global search with background indexing.
- Reference fields with backlinks ("entries that link to this entry").
- Field-level comments.
- CLI tool for scripting and automation.
- Mobile-optimized entry view (PWA).

### V3 — Mature

- Form-style creation views with field subsetting.
- Anonymous/external forms via forms service.
- REST API for integrations and webhooks.
- Batch PDF rendering (multiple entries through a template).
- View-level creation defaults and entry templates.
- Electron desktop app.
- Workspace-level chat.
- Admin tooling and audit features for enterprise.
- SSO integration polish for corporate IdPs.
