# Change Log

[Checkout the complete changelog](https://bit.ly/2VXRTrq)

## Recent Changes (Unreleased)

### Changed

- Completed entity-first identifier cleanup for notes and folders outside model/API:
  - Removed non-model/API `noteId`/`folderId` transport in command and provider flows; callers now pass `ModelNote` / `ModelFolder` entities directly.
  - Updated export target shapes and export execution to carry note/folder entities instead of ID-based payloads.
  - Updated move command validation and execution to use entity identity and model parent-container APIs instead of folder/note ID comparisons.
  - Updated delete and duplicate command paths to operate directly on resolved entities.
  - Removed tree-item metadata fields that exposed `noteId` / `folderId` in provider UI node objects.
  - Refined note properties view state tracking to use current note object identity instead of a separate note-id cache field.

- Removed remaining wrapper/surrogate tree-node assumptions from command and tree interaction paths:
  - `hackmd.ui.reveal` now reveals direct model entities (team/folder/note) instead of synthetic wrapper payloads.
  - `hackmd.ui.edit` now accepts direct note entities with a separate options argument for `preserveFocus`.
  - Tree providers (`MyNotesProvider`, `TeamNotesProvider`, `HistoryProvider`) now pass note entities directly to edit commands.
  - Model create-note flows now call reveal/edit with direct created-note entities.
  - Drag-and-drop note handling now treats drag sources as `ModelNote[]` directly (no `node.note` unwrapping).
  - Export target resolution in UI commands now operates on `ModelNote | ModelFolder` entities, including team-scope expansion via direct team entities.

- Continued entity-first command and drag-and-drop cleanup:
  - `hackmd.model.rename` now follows a minimal entity-first flow: accepts an optional `ModelNote | ModelFolder`, falls back to a picker listing known notes/folders when omitted, prompts for the new name/title, and updates via `updateNote` / `updateFolder` only.
  - Removed `renameNote` from the model API; rename paths now use `updateNote` directly.
  - `runMove` now validates source/target scope equality via `model.getScopeEntityForItem(...)` instead of checking `teamPath`/`path` fields.
  - Tree drag-and-drop now delegates move execution through `hackmd.model.move` and passes the drop target as the command's third argument.
  - Drag URI-list generation was simplified to use `model.toUri(...)` directly for both folder and note drags (removed surrogate/cached URI construction).
  - Drag scope checks now use model scope entities (`getScopeEntityForItem`) instead of direct `teamPath` comparisons.
  - Removed `toEntityKey` from drag-and-drop filtering; dedupe/membership checks now use entity object identity via `Map`/`Set` keyed by entities.

- Note-link completion path generation now derives links from note publish URLs:
  - `noteLinkPath` now parses `note.publishLink` and uses its `pathname` as the completion link path.
  - Added relative-URL-safe parsing fallback with HackMD base URL.
  - Updated non-publish-link fallback path to `/${userPath}/${permalink ?? id}`.

- `getScopeSnapshotSync` now accepts a scope entity (`ModelMyNotes | ModelTeam`) instead of a `teamPath` string or `null`:
  - All call sites across `myNotesProvider.ts`, `teamNotesProvider.ts`, `noteCompletionProvider.ts`, `pickers.ts`, `model.ts`, and `ui.ts` were updated to resolve the appropriate entity before calling the method.
  - Callers that previously held a `teamPath` string now look up the team entity via `model.getTeamByPath(teamPath)` and pass it directly; personal-scope callers pass `model.getMyNotesEntity()`.
  - Test mocks in `hackmdModel.node.test.js`, `modelCommands.node.test.js`, `uiCommands.node.test.js`, `noteCompletionProvider.node.test.js`, and `providers.node.test.js` were updated to match the new signature (entity type-switch instead of null/string check).

- Continued entity-first model API cleanup around scope resolution and drag-and-drop:
  - `getScopeEntityForItem` now accepts typed model entities (`ModelMyNotes | ModelTeam | ModelFolder | ModelNote`) instead of duck-typed `{ teamPath }` surrogate objects.
  - Removed `getTeamByPath` from the model public API; internal code now resolves teams directly from model state and call sites were updated.
  - Tree drag-and-drop scope comparison no longer builds surrogate `{ teamPath: entity.path }` values for team targets.
  - Drag-and-drop data-transfer parsing now resolves dropped entities synchronously from `DataTransferItem.value`, and the controller supports a default My Notes drop target for blank-area drops.
  - Updated command/provider test doubles to dispatch scope resolution by entity `type` (`my-notes` / `team` / scoped item) rather than surrogate shape.

- Continued model API migration to entity-first method signatures and placement/pending internals:
  - `deleteNote` now accepts a `ModelNote` entity and `deleteFolder` now accepts a `ModelFolder` entity; command handlers resolve entities before dispatching delete operations.
  - `reconcileNotePlacement` and `reconcileFolderPlacement` now accept scope entities (`ModelMyNotes | ModelTeam`) instead of `teamPath` strings.
  - `withPendingOperation` now accepts a resolved `ModelEntity | undefined` directly; target-dispatch logic and `withScopePending` were removed.
  - `refreshScopeImpl` now composes pending-state wrapping inline for Teams/My Notes using entity arguments.
  - Updated Node tests to match the new delete and pending-operation signatures.

- Fixed visual jitter/jumping of tree nodes during pending (spinner) operations in My Notes and Team Notes views:
  - Root cause: VS Code treats the built-in `'folder'` ThemeIcon specially and uses it to compute sibling indentation/alignment. Switching from `'folder'` to `'sync~spin'` (spinner) and back caused all sibling nodes to reposition.
  - Fix: replaced `'folder'` with `'symbol-folder'` in `MyNotesProvider` and `TeamNotesProvider`. The icon is visually identical but is not subject to VS Code's special alignment treatment.
- Fixed duplicate model events when a pending flag toggles:
  - `setPendingForFolder()`, `setPendingForNote()`, and `setPendingForTeam()` previously emitted both an entity-upsert event and a pending-changed event. The spurious upsert emission has been removed; only the pending event fires.
- Fixed double tree refresh on folder/note upsert when sort order changed:
  - `handleEntityUpsert` in `MyNotesProvider` and `TeamNotesProvider` now takes either a parent-level refresh (when sort order changes) or a node-level refresh (when only data changes), never both.

### Changed

- Added `TreeItem` instance reuse across all three tree providers (`MyNotesProvider`, `TeamNotesProvider`, `HistoryProvider`):
  - Providers now cache `TreeItem` objects in per-entity `Map` caches (`folderTreeItemCache`, `noteTreeItemCache`, `teamTreeItemCache`).
  - `getTreeItem()` mutates cached instances in place rather than creating new objects, enabling VS Code to update the existing tree row without a full row replacement.
- Pending state changes now trigger targeted, node-level tree refreshes instead of broad parent or root refreshes:
  - `fireFolderPendingRefresh()`, `fireNotePendingRefresh()`, and `fireTeamPendingRefresh()` fire the specific cached `TreeItem` for the affected entity.
  - Avoids triggering children re-queries during spinner icon transitions.

### Removed

- Removed query-only model commands that just passed through to model methods without additional logic:
  - `hackmd.model.getNote` — callers now invoke `model.getNote()` directly.
  - `hackmd.model.getNoteContent` — callers now invoke `model.getNoteContent()` directly.
  - `hackmd.model.getEntityByUri` — callers now invoke `model.getEntityByUri()` directly.
  - `hackmd.model.loadNoteContent` — callers now invoke `model.loadNoteContent()` directly.
  - `hackmd.model.saveNoteContent` — callers now invoke `model.saveNoteContent()` directly.
  - `hackmd.model.updateNoteProperties` — callers now invoke `model.updateNoteProperties()` directly.
  - `hackmd.model.getScopeSnapshot` — UI export now calls `model.getScopeSnapshot()` directly.
- Removed corresponding test cases (39 model command tests removed).

### Changed

- TeamNotesProvider now detects team-level entity changes (team name updates) and fires root-level tree refresh when sort order changes:
  - Added `computeTeamsOrderSignature()` to track team sort order by computing a deterministic signature of sorted team IDs.
  - Added `handleTeamEntityChange()` to detect when team metadata changes (name/path updates) and compare before/after signatures.
  - Team entity upsert events now trigger signature comparison; root tree fires `fire(undefined)` only when teams sort order actually changes.
  - Completes the architectural pattern: personal notes, history notes, and team list all now escalate granular entity changes to root refresh only when sort order is affected.

- Tree-view keyboard interaction was expanded with dedicated keybindings across My Notes, Team Notes, and Recent Notes:
  - Added shortcuts for refresh (`F5`), create note/folder (`N` / `F`), rename (`R`), move (`M`), duplicate (`D`), delete (`Delete`), open (`Enter`), preview (`V`), side-by-side preview (`Cmd/Ctrl+Enter`), open on HackMD (`O`), import (`I`), export (`E`), and properties (`P`).
  - Keybinding `when` clauses now scope actions to active tree view and selection context to avoid cross-view collisions.
- Tree action dispatch is now selection-aware through internal extension commands:
  - Added `hackmd.internal.executeTreeAction` to execute model/UI actions against the current tree selection.
  - Added `hackmd.internal.refreshCurrentTreeContainer` to make refresh behavior view-aware (My Notes, Team Notes, Recent Notes).
- Note items in all three tree providers no longer bind `TreeItem.command` for open-on-click behavior:
  - Removed single-click note opening from `MyNotesProvider`, `TeamNotesProvider`, and `HistoryProvider`.
  - Opening notes from tree focus now relies on explicit keyboard actions (for example `Enter`) and context-menu commands.
- Model/UI refresh command naming was consolidated in command wiring and tests:
  - Personal refresh uses `hackmd.model.refreshMyNotes`.
  - Team-scope refresh uses `hackmd.model.refreshTeam`.
  - Recent-notes refresh is wired via `hackmd.model.hackmd.model.refreshRecentNotes`.

- Model mutation flows now apply local predicted tree effects instead of refreshing scope after note/folder updates:
  - `saveNoteContent`, `updateNoteProperties`, `updateFolder`, `moveNote`, `deleteNote`, and `deleteFolder` no longer trigger scope refresh for loaded scopes.
  - Scope loading remains only for insert operations into unloaded scopes (to materialize revealable tree state).
- Fixed local prediction identity handling for partial PATCH responses:
  - Update payload hydration now always preserves canonical entity identity (`id` + scope/teamPath) so update operations cannot create phantom notes/folders.
- Tightened partial-update merge semantics across model update hydration and `upsertNote` application:
  - `undefined` is treated as unspecified (leave existing value unchanged).
  - `null` and empty values are treated as explicit updates and are preserved.
  - Parent-folder update semantics now distinguish explicit clear (`null`) from omitted/no-op (`undefined`).

- New folder flows now reveal and select the created folder via the unified reveal command:
  - `hackmd.model.createFolder` now delegates to `hackmd.ui.reveal` with the created folder target after creation completes.
  - Scoped folder-create delegates inherit the same reveal behavior through the shared command path.
- Added explicit regression coverage for create flows that hydrate unloaded scopes in parallel while avoiding redundant refreshes for loaded scopes:
  - `createNote` and `createFolder` now have model tests verifying no extra scope refresh when scope data is already loaded.
  - Added timing-based regressions for both personal and team scopes confirming create and initial scope hydration overlap (parallel execution) for unloaded scopes.
- Type-checking is now integrated into webpack builds to keep editor and build diagnostics aligned:
  - Added webpack TypeScript checking via `fork-ts-checker-webpack-plugin` in build config.
  - `compile` and `vscode:prepublish` now rely on webpack-integrated checks (no separate pre-step typecheck command required).
  - `tsconfig.json` now includes Node type definitions so editor diagnostics recognize Node globals used by extension sources.
- Lint configuration and sources were aligned to remove current lint errors without changing runtime behavior:
  - Disabled JS-side `@typescript-eslint/no-unused-vars` in flat config for existing test/stub patterns.
  - Fixed `no-useless-assignment` findings in CSV-preview table helpers.
  - Fixed `no-empty` catch-block lint finding in page tests.

- Unified tree reveal actions into a single command: `hackmd.ui.reveal`.
  - Removed legacy reveal command variants (`hackmd.ui.revealNote`, `hackmd.ui.revealFolder`, `hackmd.ui.revealTeam`) from command contributions and runtime registration.
  - `hackmd.ui.reveal` now supports team/folder/note targets from one entry point, and interactive reveal uses a mixed picker listing known teams plus loaded folders and notes.
  - Reveal no longer refreshes scope implicitly; it only reveals already-loaded tree items.
- Scoped My Notes helper commands now delegate to unified command flows instead of duplicating logic:
  - `hackmd.model.createMyNote` -> `hackmd.model.createNote`
  - `hackmd.model.createMyFolder` -> `hackmd.model.createFolder`
  - `hackmd.ui.importMyNotes` -> `hackmd.ui.import`
  - Unified scope extraction now accepts explicit My Notes container arguments (for example `container: 'my-notes'`, `viewId: 'hackmd.tree.my-notes'`).
- Group operations now run in parallel where safe to improve responsiveness:
  - Multi-item delete starts note and folder deletions concurrently.
  - Multi-entity export starts note-content reads and folder-recursive exports concurrently.
  - Multi-file import creates notes concurrently.
- Import now reveals/selects the first imported note after refresh when importing multiple files (tree reveal supports single selection).
- Team Notes and Recent Notes container refresh now expose pending-state events and title-level progress indicators, matching My Notes pending UX.
- Newly created notes are now upserted as content-loaded in the model.
  - `createNote` stores known created content immediately (API content when present, otherwise provided input content, otherwise empty string).
  - Opening a just-created note can read content from model cache immediately without an extra fetch.

- Team export context menu now restricted to `team-loaded` viewItem only (previously allowed both `team` and `team-loaded`), ensuring export is only available for teams that have already been loaded.
- Fixed context menu visibility for delete and export actions on notes and folders:
  - Delete now appears on both individual notes/folders and multiselection.
  - Export now appears on both individual notes/folders and multiselection.
  - Multiselection delete and export use appropriate selection qualifiers (`hasMultiNoteSelection`).
- Unified note and folder rename actions into a single command: `hackmd.model.rename`.
  - Replaced `hackmd.model.renameNote` and `hackmd.model.renameFolder` command contributions in `package.json` with one shared `Rename...` entry.
  - Updated note and folder context-menu bindings to call `hackmd.model.rename`.
  - `src/commands/model.ts` now routes by selected node type when invoked from tree context menus, and for command-palette invocation asks whether to rename a Note or Folder before running the corresponding picker flow.
  - Updated Node test suites to cover unified rename behavior and interactive picker path (`test/node/modelCommands.node.test.js`, `test/node/contextMenus.node.test.js`).
- Improved My Notes title actions to behave as direct root actions:
  - `hackmd.model.createMyNote` now creates an untitled note at My Notes root (no title/location prompts) and immediately opens it by delegating to `hackmd.ui.edit`.
  - `hackmd.model.createMyFolder` now creates folders at My Notes root by default and no longer asks for location from the title action.
  - My Notes title-bar `Import...` now invokes `hackmd.ui.importMyNotes` (instead of generic `hackmd.ui.import`).
  - `hackmd.ui.importMyNotes` now imports directly into My Notes root without a location picker.
- New-note flows now reveal and select the created note before opening it:
  - `hackmd.model.createNote` and `hackmd.model.createMyNote` now delegate to `hackmd.ui.revealNote` first, then call `hackmd.ui.edit`.
  - Team-scope reveals refresh unloaded team scopes before attempting tree reveal/selection.
- Separated My Notes pending-state updates from tree-dirty updates:
  - `MyNotesProvider` now exposes a dedicated pending event (`onDidChangePendingState`) for container pending changes.
  - Container pending changes no longer trigger `onDidChangeTreeData`; tree updates are reserved for actual data changes.
  - Extension activation now listens to pending-state events to drive title-level progress indication for My Notes.
- Fixed "Open on HackMD" context menu visibility for folders by enriching folder `clientId` from note folder-path metadata:
  - Model now extracts folder metadata from `note.folderPaths` during scope rebuild and merges with folders API response.
  - `ModelFolder` now carries `clientId` field, populated from ancestor metadata when folders API lacks it.
  - Both tree providers now classify folders as `folder` or `folder-pending` (showing "Open on HackMD") when clientId is present, and as `folder-no-client-id` only when truly absent.
  - Folders reachable via descendant notes now properly expose the "Open on HackMD" menu option.

### Added

- Added two regression tests for folder "Open on HackMD" URL generation in `test/node/uiCommands.node.test.js`:
  - Verify that folder clientId is correctly used in personal-scope URL (`https://hackmd.io/folders/<clientId>`).
  - Verify that folder clientId is correctly used in team-scope URL (`https://hackmd.io/team/<teamPath>/folders/<clientId>`).
- Added tree navigation UI commands for command palette and reuse by model flows:
  - `hackmd.ui.revealNote`
  - `hackmd.ui.revealFolder`
  - `hackmd.ui.revealTeam`
  - All three reveal commands now explicitly reveal and select the target tree item when successful.

- Added `markdown-it-task-lists` plugin to the `extendMarkdownIt` hook in `src/extension.ts`, enabling GitHub-style task list rendering (`- [ ]` / `- [x]`) in VS Code's markdown preview. The plugin is registered with `{ enabled: true }` so checkboxes are interactive.
- Added pure-Node test suite for task-list rendering (`test/node/markdownTaskLists.node.test.js`):
  - 9 tests covering unchecked items, checked items, uppercase `[X]`, mixed lists, the nested HackMD ToDo example, plain lists (no false positives), baseline without plugin, `enabled:true` interactivity, and CSS class assertions.
- Added `test:md` npm script; included in the default `npm test` run.

### Chores

- Added `markdown-it-task-lists` as a runtime dependency.
- Added `markdown-it` as a dev dependency (used by the `test:md` test suite).

- Added `csvpreview` fenced-block rendering in `src/extension.ts` `extendMarkdownIt`:
  fenced blocks tagged `csvpreview` (with optional `{header="true"}`) are converted
  to an HTML table via `csv-to-markdown-table` instead of being shown as a code block.
- Added pure-Node test suite for CSV preview rendering (`test/node/markdownCsvPreview.node.test.js`):
  8 tests covering basic table with header, no-header default (empty header row), the full
  HackMD four-column example, correct data-row count, non-csvpreview code block passthrough,
  bare `csvpreview` language tag, `header="false"` attribute, and absence of `<pre><code>` wrapper.
- Added `test:csv` npm script; included in the default `npm test` run.

### Chores (continued)

- Added `csv-to-markdown-table` as a runtime dependency.

### Changed

- All three tree providers (`MyNotesProvider`, `TeamNotesProvider`, `HistoryProvider`) now pass `{ type: 'note', note }` as the argument to `hackmd.ui.edit` instead of the previous `{ noteId, teamPath }` shape, giving command handlers direct access to the full note object.
- Page enhancer (`src/page.ts`) now lazy-loads `flowchart.js` and `js-sequence-diagrams` at call time instead of at module import time, preventing jQuery-plugin initialisation crashes during VS Code markdown preview startup.
- Page enhancer migrates mermaid rendering from the deprecated `mermaid.init()` API to `mermaid.renderAsync()`, and calls `mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })` once per update pass.
- Fixed the `markdown-it-container` import in `src/extension.ts` to use the default export, matching the package's ESM-compatible interface.
- Fixed the jQuery `ProvidePlugin` entries in `webpack.config.js` to use the `['jquery', 'default']` tuple form so that jQuery's ESM default export is correctly aliased as `$`, `jQuery`, and `window.jQuery`.

### Added

- Added `icon` declarations to all 15 model and UI commands in `package.json` so that tree-view inline buttons and command-palette entries display dedicated icons:
  - `hackmd.model.createNote` / `hackmd.model.createMyNote` / `hackmd.model.createTeamNote` — custom `new-note.svg` (light/dark).
  - `hackmd.model.createFolder` / `hackmd.model.createMyFolder` / `hackmd.model.createTeamFolder` — VS Code codicon `$(new-folder)`.
  - `hackmd.ui.edit`, `hackmd.ui.preview`, `hackmd.ui.sideBySide`, `hackmd.ui.openOnHackMD`, `hackmd.ui.import` / `importToMyNotes` / `importToTeam`, `hackmd.ui.export`, `hackmd.ui.properties` — dedicated custom SVG icons (light/dark pairs).
- Added `onLanguage:markdown` to the extension's `activationEvents` so that the extension activates as soon as a Markdown file is opened.
- Added pure-Node test suite for the page-enhancer rendering logic (`test/node/page.node.test.js`) using `happy-dom` as a lightweight DOM implementation:
  - 9 tests covering mermaid, sequence-diagram, flowchart, MathJax/KaTeX, ABC notation, Graphviz, multi-diagram documents, empty-diagram edge cases, and mixed-diagram integration.
- Added `test:page` npm script (`node --test ./test/node/page.node.test.js`); included in the default `npm test` run.
- Added 3 regression tests in `test/node/providers.node.test.js` asserting that each provider's note tree items pass `{ type: 'note', note }` to `hackmd.ui.edit`.

### Chores

- Added `happy-dom ^20.9.0` and `jsdom ^24.1.3` as dev dependencies for the test suite.
- Deleted unused legacy icon assets under `images/icon/dark/`, `images/icon/light/`, and `images/icon/` (Browser-light.png, column-light.svg, folder.svg, new-file.svg, open-preview.svg, plus.svg, preview.svg, sync.svg, users.svg, view-light.svg, education.svg, eye.svg, notes.svg, refresh.svg, and their light-theme counterparts).

- Simplified tree and context-menu actions around unified model commands.
  - Removed legacy separate move/delete command variants and routed tree interactions through the shared `hackmd.model.move` and `hackmd.model.delete` flows.
  - Removed obsolete tree-view wrapper command registrations and kept drag-and-drop behavior in a shared utility instead of command wiring.
- Reorganized the source tree by concern.
  - API code now lives under `src/api`.
  - Tree/data providers now live under `src/providers`.
  - Preview and markdown styles now live under `src/css`.
  - Shared helpers now live under `src/utils`.

### Added

- Added regression coverage for the refactor surfaces introduced by the source-tree reorganization.
  - Added pure Node tests for shared tree drag-and-drop behavior, including unified move command routing and invalid-drop handling.
  - Added pure Node tests for provider architecture constraints and deterministic tree ordering.
  - Added pure Node tests for context-menu command ordering after command unification.
- Added `test:tree:dnd` and included it in the default `npm test` run.

### Chores

- Upgraded ESLint to `^10.2.1` and migrated lint configuration from legacy `.eslintrc.js` to ESLint flat config (`eslint.config.js`).
  - Removed `eslint-plugin-import` and `eslint-import-resolver-typescript` (incompatible with ESLint 10 peer requirements).
- Aligned ESLint rules with current extension code style by disabling `@typescript-eslint/no-var-requires` for TypeScript sources.
- Upgraded TypeScript to `^6.0.3`.
- Upgraded `glob` to `^13.0.6` and migrated call sites to the async Promise API.
- Upgraded `jquery` to `^4.0.0` and `@types/jquery` to `^4.0.0`.
- Upgraded `imports-loader` to `^5.0.0`.

### Added

- Added pure-Node tests for tree-view command delegation (`test/node/treeViewCommands.node.test.js`) with a dedicated VS Code/runtime stub (`test/node/registerTreeViewCommandsStub.js`).
- Added `test:treeview:compile` and `test:treeview` scripts; `test` now runs the tree-view command suite in addition to model, command, FS, properties, and completion suites.
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
- Migrated the virtual filesystem provider (`src/mdFsProvider.ts`) to use the model layer exclusively:
  - Removed direct `api` and `recordUsage` imports; the provider now calls `model.getNote()`, `model.getNoteContent()`, and `model.saveNoteContent()`.
  - A module-level `getModel()` guard maps model initialisation failures to `vscode.FileSystemError.Unavailable`, keeping `FileSystemError.FileNotFound` for read/stat paths when the model is missing.
  - All tree-provider pending-state interactions (`setPendingNote` / `clearPendingNote`) are preserved.
- Migrated the Note Properties panel (`src/propertiesProvider.ts`) to use the model layer exclusively:
  - Removed all direct `api`, `recordUsage`, and tree-provider imports; the provider now calls `model.updateNoteProperties()` only.
  - `openNote(note: ModelNote)` replaces the old separate `noteId`/`teamPath` arguments.
  - Unsaved-changes guard (`openNote`, `cancelEditing`) prompts Save / Discard / Cancel before switching notes.
  - `updateCurrentNote(noteId, updatedNote)` allows external callers (e.g. tree views) to refresh the displayed note without re-opening the panel.
  - HTTP error codes 400 / 403 / 409 are mapped to user-friendly messages.
- Added `permalink?: string | null` to the `UpdateNoteInput` interface in `src/model/hackmdModel.ts`.
- Added `hackmd.ui.properties` command in `src/commands/ui.ts`:
  - Accepts optional `{ noteId, teamPath }` args for programmatic invocation (e.g. from tree-view context menus).
  - When called without args, presents a sync-only scope + note picker (no network calls in picker path).
  - Resolves the note via `model.getNoteSync()` (cache only); shows an error if the note is not loaded yet.
  - Focuses the Properties panel via `hackmd.properties.focus` then calls `propertiesProvider.openNote()`.
- `HackMD.openNoteProperties` tree-view command now delegates entirely to `hackmd.ui.properties`, eliminating duplicate pick logic.
- Added pure-Node test suite for the Note Properties provider (`test/node/propertiesProvider.node.test.js`):
  - 28 tests covering `openNote` flows (Save / Discard / Cancel on pending changes), `hasPendingChanges`, permission normalization/clamping, `cancelEditing`, `updateCurrentNote`, `saveCurrentProperties` (success, invalid permalink, HTTP 400/403/409/generic, `_isSaving` guard, model-uninitialized guard), and webview messages (`copyShareUrl`, `ready`).
  - Uses a dedicated `registerPropertiesProviderStub.js` that stubs `vscode` and the model module; a `makeWebviewView()` helper captures `postMessage` output and lets tests fire inbound messages.
- Extended `uiCommands.node.test.js` with 7 new `hackmd.ui.properties` tests (27 total); added `getNoteSync` to `MockUiModel`.
- Added `test:properties:compile` and `test:properties` scripts; `test` script now runs all four suites (model, commands, FS provider, properties provider).
- Added comprehensive pure-Node test suite for the FS provider (`test/node/mdFsProvider.node.test.js`) with a dedicated `registerMdFsProviderStub.js` runtime mock:
  - 25 tests covering `File`/`Directory` constructors, URI helpers, provider activation, rename, readFile, stat, writeFile (including pending-state tracking and save-failure cleanup), watch disposable, unimplemented methods, and all four operations when the model is not initialised.
  - Added `test:fs:compile` and `test:fs:provider` scripts; the `test` script now runs `test:model`, `test:commands`, and `test:fs:provider` (112 tests total).
- Migrated the note editor completion provider (`src/noteCompletionProvider.ts`) to use the model layer exclusively:
  - Removed direct imports of `getMyNotesProvider`, `getTeamNotesProvider`, and the old `Note` type; replaced with `getHackmdModel()` + `ModelNote`.
  - `collectCachedNotes()` now reads `getScopeSnapshotSync(null)` for personal notes and iterates `getTeams()` + `getScopeSnapshotSync(team.path)` for team notes via the shared `collectNotes()` utility from `src/commands/pickers.ts`.
  - Zero async operations — the provider remains purely synchronous and performs no network requests.
  - Zero `as any` casts; all note data is accessed through the typed model interfaces.
- Added pure-Node test suite for the note completion provider (`test/node/noteCompletionProvider.node.test.js`):
  - 36 tests covering `findOpenBracketIndex` (open/closed/nested brackets), `collectCachedNotes` (uninitialized model, personal/team scope presence and absence, multi-scope combination), filtering (empty query, title/permalink matching, exclusions, mid-string match, offset bracket position), `noteLinkPath` (all six `teamPath`/`userPath` × `permalink`/`id` combinations), completion item properties (`insertText`, `detail`, `sortText`, `filterText`, `kind`, `documentation`), replace range (bracket column, cursor end, auto-inserted `]` consumption), and untitled-note fallback label.
  - Uses a dedicated `registerNoteCompletionProviderStub.js` that stubs `vscode` (`CompletionItem`, `CompletionItemKind`, `Range`, `MarkdownString`) and the model module; `src/commands/pickers.ts` loads as real compiled code.
- Added picker customization options (`allowCustom`) for note/folder entity pickers so commands can disable manual ID entry when they require cache-only behavior.
- Extended UI command tests with cache-only properties picker regressions:
  - Verifies that `hackmd.ui.properties` interactive note picker does not expose `Custom Note ID...`.
  - Verifies that when no local notes are available, properties flow shows an informational message and exits without opening the panel.
- Added model regressions for note-content cache semantics:
  - Verifies list/snapshot payload note `content` fields do not mark content as loaded.
  - Verifies `lastChangedAt` updates from scope refresh evict cached content so next read re-fetches full note content.
- Added model-level pending-operation state and events for tree-view spinner support:
  - Added per-entity `pendingOperation` flags on `ModelTeam`, `ModelFolder`, and `ModelNote`.
  - Added container pending flags for My Notes and Team Notes.
  - Added `onDidChangePending` event stream with typed payloads for container/team/folder/note pending transitions.
  - Added model pending-state query helpers (`isMyNotesPendingOperation`, `isTeamNotesPendingOperation`, `isTeamPendingOperation`, `isFolderPendingOperation`, `isNotePendingOperation`).
- Added model regressions for pending-operation semantics:
  - Verifies personal-scope refresh toggles My Notes pending state and emits pending start/finish events.
  - Verifies team-scope refresh toggles Team Notes container and per-team pending states and emits events.
  - Verifies note-content load toggles per-note pending state and emits events.
- Added `test:completion:compile` and `test:completion` scripts; `test` script now runs all five suites (191 tests total).
- Migrated Recent Notes tree provider (`src/historyProvider.ts`) to the model layer:
  - Removed direct API calls and local note cache from the provider.
  - History loading now uses model refresh/state (`refreshHistory` + `getHistoryNotes`).
  - Spinner state now follows model `pendingOperation` flags on notes.
  - Provider listens to model state/entity/pending events and refreshes reactively.

### Changed

- Migrated My Notes tree provider (`src/myNotesProvider.ts`) to the model layer:
  - Removed direct API reads and local note/folder caches from the provider.
  - Tree rendering now uses personal-scope model snapshots and model pending-operation flags.
  - Note-open behavior delegates to `hackmd.ui.edit`.
- Migrated My Notes tree actions in `src/commands/treeView.ts` to command-layer delegation:
  - `treeView.createMyNotes` -> `hackmd.model.createNote` + `hackmd.ui.edit`.
  - `treeView.createMyFolder` -> `hackmd.model.createFolder`.
  - `treeView.importMyNotes` -> `hackmd.ui.import`.
  - My Notes folder context actions (`create note/folder`, `import`, `export`, `rename`, `delete`) now delegate to `hackmd.model.*` / `hackmd.ui.*` for model-backed nodes.
- Drag-and-drop note moves now route through the Move command path (`HackMD.moveNoteTo`) with resolved destination payloads, and model-backed nodes use `hackmd.model.moveNote` / `hackmd.model.moveFolder`.
- "New Folder..." actions everywhere now use the `new-folder` codicon instead of the custom folder SVG icon.
- Moved HackMD API domain types (`Note`, `Team`, `HackMdFolder`, `NotePublishType`) from global ambient declarations to named exports in the local API client module.
- Updated note-related providers and tree commands to import API domain types explicitly from the local API client.
- Model layer no longer depends on the global API singleton; it now requires an injected `HackMdApiClient` instance.
- Model refresh/update flow now applies patch-style updates over existing state, preserving object identity for unchanged entities and suppressing redundant upsert events.
- Async model getters/refresh methods now deduplicate concurrent requests by caching in-flight promises per scope/entity/URI.
- `hackmd:` URI parsing now requires `noteId` in query params; legacy note-ID-in-fragment fallback was removed.
- Project test flow now compiles `src/commands/pickers.ts` and `src/commands/ui.ts` as part of `test:model:compile` and runs command tests as two dedicated suites (`model` and `ui`).
- `hackmd.ui.properties` now invokes the note picker in cache-only mode (no custom/manual note ID path), aligning interactive behavior with its sync-only `getNoteSync` resolution.
- Recent Notes note-open now delegates directly to `hackmd.ui.edit` with `{ noteId, teamPath }` args.
- Legacy tree view note actions now delegate to model/UI commands when invoked from model-backed Recent Notes nodes:
  - Edit/Preview/Side-by-Side/Open on HackMD -> `hackmd.ui.*`
  - Rename/Delete/Duplicate -> `hackmd.model.*` paths
  - Export (notes-only selection) -> `hackmd.ui.export`

### Fixed

- Removed stale `Window.MathJax` global typing from `src/types.d.ts`; math rendering remains KaTeX-based and does not use a `window.MathJax` runtime global.
- Fixed folder hierarchy rendering when the HackMD folder API returns `null` for a folder's parent despite the note paths showing it has a parent.
  - Parent relationships inferred from note `folderPaths` now take precedence over the API-returned `parentFolderId`.
  - Defensive fallback added for the API typo field `parentForderId`.
  - String `"null"` is now treated as no parent when returned by the API.
- Fixed note-content cache loading semantics in the model:
  - Full note content is now marked as loaded only for explicit full-note reads/writes (`getNote`/`getTeamNote` fetch path and save-content responses), not from scope/list refresh payloads.
  - Cached content is preserved across scope refreshes that do not include full content.
  - Cached content is evicted when `lastChangedAt` changes during refresh so stale content is reloaded on next content read.

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
