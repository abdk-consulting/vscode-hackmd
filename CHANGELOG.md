# Change Log

[Checkout the complete changelog](https://bit.ly/2VXRTrq)

## Recent Changes (Unreleased)

### Added

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

### Removed

- Removed redundant `viewsWelcome` entries that duplicated API token prompts.
- Removed publish mode from Note Properties editor.
- Removed disruptive save/discard/cancel prompt that appeared whenever VS Code lost window focus.

### Fixed

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
