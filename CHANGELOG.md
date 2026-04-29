# Change Log

[Checkout the complete changelog](https://bit.ly/2VXRTrq)

## Recent Changes (Unreleased)

### Added

- Added Note Properties sidebar panel (`hackmd.properties`) for currently open notes.
  - Editable fields: title, publish type, permalink, read permission, write permission.
  - Property edits mark the editor dirty and are saved with normal note save.
  - Shows pending-change indicators in the panel.
- Added duplicate-editor prevention when opening notes from tree commands.
  - If a note is already open, commands switch to the existing editor instead of opening another tab.
- Added robust note ID normalization from URI fragments in command and FS paths.

### Changed

- Updated HackMD resource URI structure to support meaningful breadcrumbs.
  - Personal notes: `My Notes/{folders}/{title}`
  - Team notes: `Teams/{teamPath}/{folders}/{title}`
- Switched URI construction to `vscode.Uri.from(...)` with correct query/fragment ordering.
- Replaced activity bar icon with a codicon-based SVG using `currentColor` for better theme integration.

### Removed

- Removed redundant `viewsWelcome` entries that duplicated API token prompts.

### Fixed

- Fixed note open failures caused by malformed team-note URIs (`#fragment?query` ordering).
- Fixed URI fragment parsing so note IDs remain stable even with legacy malformed links.
- Fixed duplicate/incorrect breadcrumb behavior while preserving folder hierarchy.
- Fixed Note Properties panel initialization and active-note synchronization.
- Fixed focus loss in properties inputs by avoiding full re-render on every keystroke.
- Fixed title update flow so cached note metadata and breadcrumbs stay in sync after save.
- Fixed extension activation regression caused by automatic workspace settings mutation (removed).

### Contributors

- Bug fixes, architecture improvements, and feature enhancements by ABDK Consulting
