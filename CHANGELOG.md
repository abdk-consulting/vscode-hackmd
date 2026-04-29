# Change Log

[Checkout the complete changelog](https://bit.ly/2VXRTrq)

## Recent Changes (Unreleased)

### Added

- Added note renaming functionality with context menu command for owned notes
  - Shows input box with current title pre-filled
  - Updates note title via API for both personal and team notes
  - Displays spinner during rename operation with immediate tree update on completion
- Added folder context menu with commands: Create Note in Folder, and Open Folder on HackMD
- Added inline toolbar buttons on folders and teams for quick note creation
- Added team-level "Create Team Note" command and context menu
- Implemented auto-expand and reveal functionality for newly created notes
- Added stable TreeItem IDs for proper VS Code tree tracking

### Changed

- **Major Architecture Change**: Migrated all tree views (Team Notes, My Notes, History) from React-based `@hackmd/react-vsc-treeview` to standard VS Code TreeDataProvider pattern
  - Reduced bundle size from 2.01 MiB to 1.13 MiB
  - Improved performance and reliability
  - Enabled native VS Code tree features (lazy loading, proper refresh, reveal/select)
- **Team Notes Restructure**: Changed from single-team selector view to showing all teams at top level
  - Team notes load on-demand when team is expanded (lazy loading)
  - All teams visible simultaneously for better navigation
- Renamed "Refresh My Notes", "Refresh History", and "Refresh Team Notes" buttons to just "Refresh"
- Renamed "Create My Note" button to "Create Note"
- Updated `@hackmd/api` from 2.4.0 to 2.5.0
- Changed note insertion order: newer notes now appear first (at top of list) instead of last
- Optimized note creation in uncached teams to execute API calls in parallel instead of sequentially

### Fixed

- Fixed extension not loading due to missing compiled output in dist folder
- Fixed `HackMD.apiKey` command not being registered, which prevented API key setup
- Fixed "Enter HackMD API token" button doing nothing in tree views
- Fixed extension ID reference in `api.ts` from `HackMD.hackmd-vscode` to `HackMD.vscode-hackmd`
- Updated `abcjs` from 5.8.0 to 6.6.3 to resolve broken MIDI.js dependency
- Changed Git dependency URLs from SSH to HTTPS for better compatibility
- Fixed clicking on notes with empty/missing titles
- Fixed folder note creation to properly distinguish between team and personal notes
- Fixed team note editing and saving (now uses correct API endpoints: `updateTeamNoteContent` for team notes, `updateNoteContent` for personal notes)
- Fixed team note deletion (now uses `deleteTeamNote` API for team notes)
- Fixed note deletion menu to only show on notes owned by the user (using `file-owned` context value)
- Fixed ownership checking to properly use `checkIsOwner` method (considers both `userPath` match and `writePermission === 'owner'`)
- **Tree Update Improvements**:
  - Implemented granular change events: only affected folder/team refreshes instead of entire tree
  - Fixed tree updates by maintaining stable object references for folders and teams (required by VS Code TreeDataProvider)
  - Fixed notes not appearing/disappearing in tree after creation/deletion without manual refresh
  - Fixed folders not expanding automatically when notes created inside them
  - Implemented synchronous cache updates with immediate tree refresh (no arbitrary timeouts)
  - Fixed root-level team notes not being removed from tree after deletion
- **Visual Feedback for Async Operations**:
  - Added spinner indicators during note opening, deletion, creation, and saving operations
  - Notes show spinner icon and are non-interactive while pending operations are in progress
  - Folders and teams show spinners during note creation
  - Pending states use granular tree updates firing on parent nodes for optimal performance
- Fixed 403 error when saving team notes by using correct API method (`updateTeamNote` instead of non-existent `updateTeamNoteContent`)
- Fixed team note save operations to properly handle `teamPath` parameter
- **Codebase Cleanup**:
  - Removed all React tree implementation remnants (`treeReactApp/` and `tree/` directories)
  - Consolidated state management into single `store.ts` file
  - Removed unused React hooks and event emitters
  - Reduced extension bundle size from 1.16 MiB to 1.05 MiB (~9.5% reduction)
  - Eliminated duplicate identifier names between old React tree and new native tree implementations

### Contributors

- Bug fixes, architecture improvements, and feature enhancements by ABDK Consulting
