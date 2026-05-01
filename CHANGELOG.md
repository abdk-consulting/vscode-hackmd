# Change Log

[Checkout the complete changelog](https://bit.ly/2VXRTrq)

## Recent Changes (Unreleased)

### Chores

- Upgraded ESLint to `^10.2.1` and migrated lint configuration from legacy `.eslintrc.js` to ESLint flat config (`eslint.config.js`).
  - Removed `eslint-plugin-import` and `eslint-import-resolver-typescript` (incompatible with ESLint 10 peer requirements).
- Aligned ESLint rules with current extension code style by disabling `@typescript-eslint/no-var-requires` for TypeScript sources.
- Upgraded TypeScript to `^6.0.3`.
- Upgraded `glob` to `^13.0.6` and migrated call sites to the async Promise API.
- Upgraded `jquery` to `^4.0.0` and `@types/jquery` to `^4.0.0`.
- Upgraded `imports-loader` to `^5.0.0`.

### Added

- Added progress indicator in My Notes and Team Notes tree view headers while a folder is being created at root level, matching note-creation UX.
- Added spinner on folders during drag-and-drop and command-based move operations, matching the note-drag pending-state behavior.
- Notes and folders in the My Notes and Team Notes trees are now sorted alphabetically. Within each container, folders appear first (sorted by name), followed by notes (sorted by title). Sorting is case-insensitive, with a case-sensitive tiebreaker when names differ only in case. Team workspaces at the root of Team Notes are also sorted by name.
- Added a UI-agnostic HackMD model layer with stable entity objects (`team`/`folder`/`note`), sync state getters, change events, URI conversion/lookup helpers, and asynchronous operations for refresh/create/update/move/delete/content loading.
- Added comprehensive pure Node tests for the model layer using built-in `node:test` + `node:assert` and an in-memory mock HackMD API implementation (no Jest/Mocha).
- Added model test scripts:
  - `test:model:compile` to compile model-only sources.
  - `test:model` to run model tests with a lightweight VS Code runtime stub.
- Added an interactive command-palette layer (`src/commands/model.ts`) exposing all 20 `hackmd.model.*` commands:
  - All pickers are sync-only (no in-picker API fetches); unloaded scopes show a hint linking to "HackMD Model: Refresh Scope".
  - Every picker includes a `Custom…` fallback so users can enter IDs/paths manually.
  - `createNote` and `createFolder` use location-first UX: scope → parent folder → name/title/content.
  - `deleteNote` / `deleteFolder` require explicit confirmation unless `force: true` is passed programmatically.
  - The commands layer has zero direct `api` imports; it depends only on the model singleton.
- Added a second command layer (`src/commands/ui.ts`) with `hackmd.ui.*` commands that glue model operations to VS Code UI actions:
  - `hackmd.ui.edit`, `hackmd.ui.preview`, `hackmd.ui.sideBySide`, `hackmd.ui.openOnHackMD`, `hackmd.ui.import`, and `hackmd.ui.export`.
  - Export supports programmatic multi-entity input (`notes` + `folders`) and interactive single-entity selection from Command Palette.
  - Picker/data selection paths are sync-only against model cache, with async calls used only for operation execution.
  - UI command handlers have zero direct `api` imports and use the model layer exclusively.
- Added comprehensive pure-Node test suite for the commands layer (`test/node/modelCommands.node.test.js`):
  - 59 tests covering all 20 commands, full interactive picker flows, cancellation at every step, `force` flag, and all custom-input fallback paths.
  - Uses a dedicated `registerModelCommandsStub.js` that monkey-patches `Module._load` for both `vscode` and the model module, with a queue-based `Interactions` helper for controlling picker/input responses.
  - Added `test:commands` script; `test` script now runs both `test:model` and `test:commands`.
- Added shared picker utilities in `src/commands/pickers.ts` (scope/folder/note/entity pickers and prompt helpers), extracted from `src/commands/model.ts` and reused by UI commands.
- Added a comprehensive pure-Node UI commands test suite (`test/node/uiCommands.node.test.js`) with a dedicated `registerUiCommandsStub.js` runtime mock:
  - 19 tests covering all `hackmd.ui.*` commands, programmatic + interactive flows, cancellation paths, recursive folder export, and sync-only picker guarantees.
  - Command tests are now split into `test:commands:model` and `test:commands:ui`, with `test:commands` orchestrating both suites.
- Model is now initialized eagerly in `extension.ts` immediately after the API client, and `registerModelCommands` is wired into the main command registration in `src/commands/index.ts`.

### Changed

- "New Folder..." actions everywhere now use the `new-folder` codicon instead of the custom folder SVG icon.
- Moved HackMD API domain types (`Note`, `Team`, `HackMdFolder`, `NotePublishType`) from global ambient declarations to named exports in the local API client module.
- Updated note-related providers and tree commands to import API domain types explicitly from the local API client.
- Model layer no longer depends on the global API singleton; it now requires an injected `HackMdApiClient` instance.
- Model refresh/update flow now applies patch-style updates over existing state, preserving object identity for unchanged entities and suppressing redundant upsert events.
- Async model getters/refresh methods now deduplicate concurrent requests by caching in-flight promises per scope/entity/URI.
- `hackmd:` URI parsing now requires `noteId` in query params; legacy note-ID-in-fragment fallback was removed.
- Project test flow now compiles `src/commands/pickers.ts` and `src/commands/ui.ts` as part of `test:model:compile` and runs command tests as two dedicated suites (`model` and `ui`).

### Fixed

- Removed stale `Window.MathJax` global typing from `src/types.d.ts`; math rendering remains KaTeX-based and does not use a `window.MathJax` runtime global.
- Fixed folder hierarchy rendering when the HackMD folder API returns `null` for a folder's parent despite the note paths showing it has a parent.
  - Parent relationships inferred from note `folderPaths` now take precedence over the API-returned `parentFolderId`.
  - Defensive fallback added for the API typo field `parentForderId`.
  - String `"null"` is now treated as no parent when returned by the API.

### Changed

- Replaced the runtime HackMD API client dependency with an in-repo, fully controlled HTTP client implementation.
  - API bootstrap now uses the new local client wrapper instead of `@hackmd/api`.
  - Existing `recordUsage(...)` rate-limit tracking compatibility is preserved for update calls that require full Axios responses.
- Removed unused `@hackmd/react-vsc-treeview` dependency and related transitive packages from the lockfile.
- Import actions now support selecting multiple `.md` files at once; each selected file is created as a separate note.
- Tree views now support multi-selection for note actions.
  - Batch actions are available for selected notes: Move, Delete, and Export.
  - Single-note actions (Edit, Preview, Rename, Duplicate, etc.) are hidden during multi-note selection.
  - Mixed selections (notes + folders/teams) suppress note batch actions.
  - Move is only shown for multi-note selections within the same scope/team.
  - Context-menu targeting now matches VS Code Explorer behavior for selected vs non-selected right-clicked items.
- Batch note operations now execute in parallel to improve UX.
  - Multi-note Delete runs API requests concurrently and reports aggregated failures.
  - Multi-note drag-and-drop Move runs note moves concurrently after validation/tab-close checks.
- Note Export now supports multi-note selection.
  - Single-note export keeps Save dialog behavior.
  - Multi-note export prompts for a target directory and writes one Markdown file per note with conflict-safe filenames.
- Rename and Move operations now close all open tabs for the affected note before proceeding, including markdown preview tabs, not just text editor tabs.
- Unified tab-closing logic into a single `closeTabsForNote` helper that matches any tab type (editor, preview, etc.) by checking whether the tab's URI contains the note URI.
- Removed redundant `API.getNote` content-validation fetch from the Side-by-Side fallback path in the editor command.

### Added

- Added a local HackMD API client wrapper that follows the Swagger/OpenAPI endpoints and includes folder operations for personal and team scopes.
- Added "Open on HackMD", "Export...", and improved inline buttons to team entries in the Team Notes tree view.
  - Inline buttons on team rows: New Note, Import..., and Refresh (Refresh visible only after team notes are loaded).
  - Context menu groups: primary actions (New Note, Open on HackMD, Refresh) and a transfer group (Import..., Export...) separated by a divider.
  - "Export..." downloads all notes from the team and recreates the folder hierarchy on disk, mirroring the folder Export behavior.
  - "Open on HackMD" opens `https://hackmd.io/team/{teamPath}` in the browser.
- Added note-link completion inside HackMD editors when typing `[`.
  - Suggests cached personal and team notes whose titles or permalinks match the typed query.
  - Inserts links in the form `[Note Title](/@scope/permalink-or-id)`.
- Added note export action in tree context menus.
  - Shows a Save dialog with default filename `{note-title}.md`.
  - Exports the note's markdown content to the selected local file.
- Added markdown import actions for all note-creation entry points.
  - My Notes view title action now includes `Import...`.
  - Folder and Team context menus now include `Import...` (including inline buttons).
  - Import reads a local `.md` file and creates a note with title derived from filename (without extension).
- Added per-team inline Refresh button in Team Notes tree view, visible after a team's notes have been loaded.
  - Refresh keeps stale children visible during the background fetch and replaces them atomically on completion.
  - The team row shows a spinner while the refresh is in progress.
- Added progress indicator in My Notes tree view header while a new note is being created.
- Team notes now load in the background on first expand.
  - The team row shows a spinner and a "Loading notes..." placeholder until the initial fetch completes.
  - Global tree-view progress bar is no longer shown during team note loading.

### Added (previously unreleased)

- Added Note Properties sidebar panel (`hackmd.properties`) for currently open notes.
  - Editable fields: publish type, permalink, read permission, write permission.
  - Property edits mark the editor dirty and are saved with normal note save.
  - Shows pending-change indicators in the panel.
- Added duplicate-editor prevention when opening notes from tree commands.
  - If a note is already open, commands switch to the existing editor instead of opening another tab.
- Added robust note ID normalization from URI fragments in command and FS paths.
- Added drag-and-drop note move support across tree views using `text/uri-list` payloads with `hackmd:` URIs.
  - Dragging from Recent Notes to My Notes / Team Notes now works.
  - Dropping on a note resolves to that note's containing folder.
  - Invalid drop destinations show a clear warning.

### Changed

- Updated HackMD resource URI structure to support meaningful breadcrumbs.
  - Personal notes: `My Notes/{folders}/{title}`
  - Team notes: `Teams/{teamPath}/{folders}/{title}`
- Switched URI construction to `vscode.Uri.from(...)` with correct query/fragment ordering.
- Replaced activity bar icon with a codicon-based SVG using `currentColor` for better theme integration.
- Updated note renaming workflow to use the context-menu rename command as the single title-change path.
  - If the note is open, the editor is closed first so users get normal Save/Don't Save/Cancel behavior.
  - Rename is cancelled if editor close is cancelled.
  - Virtual FS rename is applied after successful API title update.
- Updated Note Properties panel layout to a compact sharing/permissions design.
  - Added share URL copy action and status feedback.
  - Moved pending-change warning placement to avoid layout jumps.
- Updated permission wording in Note Properties to match HackMD semantics.
  - Personal notes show `Only me`.
  - Team notes show `Owners`.
- Removed owner/non-owner distinctions from tree item context and icon rendering.
  - Notes now use unified `file` / `file-pending` context values.
  - Edit authorization is handled by backend APIs.
- Empty permalink now only blocks saving when the permalink field itself has been modified.
  - Notes with no original permalink can have other properties saved without setting a permalink.
- "Properties..." context menu item is now available for all notes, not only owned ones.
- "Rename" context menu item is now available for all notes, not only owned ones.
- "Delete Note" context menu item is now available for all notes, not only owned ones.
- Added "Move to..." note action in tree context menu for My Notes and Team Notes.
  - Destination picker is built from the already loaded tree/folder cache (no backend folder fetch).
  - The current location is excluded from the destination list.
  - Move operation now follows a strict sequence after API success: model update, deduplicated tree refresh, reveal, select.
  - If the note is open, editors are closed first using the normal Save/Don't Save/Cancel flow.
  - Canceling editor close cancels the move operation.
- All notes now open as editable in the editor.
  - If the backend rejects a save due to permissions, the user sees an error but retains their content.
- Note Properties panel now automatically updates the displayed title when the note is renamed.
- Recent Notes is drag-only (not a drop target) to prevent misleading drop highlighting.
- Import actions now use a cloud-upload icon for clearer local-file import affordance.
- Imported notes are now revealed and selected in the tree without automatically opening an editor.

### Removed

- Removed redundant `viewsWelcome` entries that duplicated API token prompts.
- Removed legacy placeholder extension test harness (`src/test/**`) and related Mocha/`vscode-test` dependencies.
- Removed publish mode from Note Properties editor.
- Removed disruptive save/discard/cancel prompt that appeared whenever VS Code lost window focus.

### Fixed

- Fixed note-link completion insertion when VS Code auto-inserts a closing `]` after `[`. The completion now consumes that bracket instead of leaving a trailing `]`.
- Fixed export UX by showing pending spinner state on the selected note while export content is being fetched.
- Fixed note open failures caused by malformed team-note URIs (`#fragment?query` ordering).
- Fixed URI fragment parsing so note IDs remain stable even with legacy malformed links.
- Fixed duplicate/incorrect breadcrumb behavior while preserving folder hierarchy.
- Fixed Note Properties panel initialization and active-note synchronization.
- Fixed focus loss in properties inputs by avoiding full re-render on every keystroke.
- Fixed title/rename regressions by removing title edits from Note Properties save flow.
- Fixed extension activation regression caused by automatic workspace settings mutation (removed).
- Fixed team note property persistence by keeping content and metadata updates compatible with HackMD APIs.
- Fixed read-only lock icon regressions by using editability checks in all note trees.
- Fixed save failures when permalink is empty by omitting empty permalink values from payloads.
- Fixed low-level HTTP error messages on property save failure; now shows friendly messages for common cases:
  - 403 → insufficient permissions
  - 409 → permalink already in use
  - 400 → invalid permalink format
- Fixed delay before opening the team-note Move-to picker by avoiding subtree traversal that could trigger async loads.
- Fixed intermittent loss of selection after moving notes by preventing overlapping/late tree refreshes after reveal.
- Fixed Move-to empty-state UX by showing clear messages when there are no valid destination folders.
- Fixed Recent Notes spinner not clearing after successful move operations.

### Contributors

- Bug fixes, architecture improvements, and feature enhancements by ABDK Consulting
