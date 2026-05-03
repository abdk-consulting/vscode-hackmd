'use strict';
/**
 * Comprehensive test suite for src/commands/model.ts
 *
 * Strategy
 * --------
 * - registerModelCommandsStub.js is required FIRST (via --require) so that
 *   Module._load is patched before any command-module import.
 * - We require the compiled commands module to trigger registerModelCommands().
 *   The fake context.subscriptions.push stores the Disposables returned by
 *   vscode.commands.registerCommand — but those are irrelevant here because
 *   the stub also keeps handlers in `registeredHandlers`.
 * - Each test calls invoke(commandId, ...args) which calls the stored handler.
 * - The MockHackmdModel records every async call and returns preconfigured data.
 * - The Interactions helper builds ordered queues for showQuickPick /
 *   showInputBox / showWarningMessage to simulate the full picker UX.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Must be the FIRST require after the stub is registered by --require flag.
const stub = require('./registerModelCommandsStub');

// Trigger command registration.  registerModelCommands() is called here.
const fakeContext = {
  subscriptions: { push() { } },
};

// The compiled commands module calls registerModelCommands(context) via
// named export.  We have to load it *after* the stub is set up.
const { registerModelCommands } = require('../../out/commands/model');
registerModelCommands(fakeContext);

// ============================================================
// Helper — call a registered command handler
// ============================================================
async function invoke(commandId, ...args) {
  const handler = stub.registeredHandlers.get(commandId);
  if (!handler) {
    throw new Error(`Command not registered: ${commandId}`);
  }
  return handler(...args);
}

// ============================================================
// Helper — build interaction queues that replace window methods
// ============================================================
class Interactions {
  constructor() {
    this._quickPickQueue = [];
    this._inputBoxQueue = [];
    this._warningQueue = [];
  }

  /** Queue a value to be returned by the next showQuickPick call */
  qp(valueOrPredicate) {
    this._quickPickQueue.push(valueOrPredicate);
    return this;
  }

  /** Queue a string to be returned by the next showInputBox call */
  ib(value) {
    this._inputBoxQueue.push(value);
    return this;
  }

  /** Queue a string to be returned by the next showWarningMessage call */
  wm(value) {
    this._warningQueue.push(value);
    return this;
  }

  /** Install the queues onto the stub window object */
  install() {
    const qpQueue = [...this._quickPickQueue];
    const ibQueue = [...this._inputBoxQueue];
    const wmQueue = [...this._warningQueue];

    stub.window.showQuickPick = async (items) => {
      if (qpQueue.length === 0) return undefined;
      const spec = qpQueue.shift();
      if (typeof spec === 'function') {
        // predicate receives the resolved item array
        const resolved = await Promise.resolve(items);
        return resolved.find(spec);
      }
      if (spec === null) return undefined; // simulate cancellation
      // spec is an item label — return the matching item
      const resolved = await Promise.resolve(items);
      return resolved.find((it) => it.label === spec);
    };

    stub.window.showInputBox = async (opts) => {
      if (ibQueue.length === 0) return undefined;
      const v = ibQueue.shift();
      if (v === null) return undefined; // simulate cancellation
      if (opts && opts.validateInput) {
        const err = opts.validateInput(v);
        if (err) throw new Error(`validateInput failed: ${err} (value: ${v})`);
      }
      return v;
    };

    stub.window.showWarningMessage = async (_msg, _opts, ...buttons) => {
      if (wmQueue.length === 0) return undefined;
      return wmQueue.shift();
    };
  }
}

// ============================================================
// MockHackmdModel
// ============================================================
class MockHackmdModel {
  constructor() {
    this.calls = {};
    this._teams = [
      { id: 't1', path: 'acme', name: 'Acme Corp' },
    ];
    this._personalSnapshot = {
      teamPath: null,
      rootFolders: [
        {
          id: 'pf1',
          name: 'Work',
          path: '/Work',
          notes: [{ id: 'pn1', title: 'My Note', shortId: 'abc', teamPath: null, children: [], notes: [] }],
          children: [
            {
              id: 'pf2',
              name: 'Sub',
              path: '/Work/Sub',
              parentId: 'pf1',
              notes: [],
              children: [],
            },
          ],
        },
        {
          id: 'pf3',
          name: 'Archive',
          path: '/Archive',
          notes: [],
          children: [],
        },
      ],
      rootNotes: [
        { id: 'pn2', title: 'Root Note', shortId: 'xyz', teamPath: null },
      ],
    };
    this._acmeSnapshot = {
      teamPath: 'acme',
      rootFolders: [
        {
          id: 'tf1',
          name: 'Projects',
          path: '/Projects',
          notes: [{ id: 'tn1', title: 'Spec', shortId: 's1', teamPath: 'acme', children: [], notes: [] }],
          children: [],
        },
      ],
      rootNotes: [],
    };
  }

  _record(method, args) {
    this.calls[method] = this.calls[method] || [];
    this.calls[method].push(args);
  }

  getTeams() {
    return this._teams;
  }

  getScopeSnapshotSync(teamPath) {
    if (teamPath === null || teamPath === undefined) return this._personalSnapshot;
    if (teamPath === 'acme') return this._acmeSnapshot;
    return null;
  }

  getNoteSync(noteId, teamPath) {
    const snap = this.getScopeSnapshotSync(teamPath);
    if (!snap) return undefined;
    const all = [
      ...snap.rootNotes,
      ...snap.rootFolders.flatMap((f) => f.notes),
    ];
    return all.find((n) => n.id === noteId);
  }

  // --- async operations (all return resolved promises with mock data) ---

  async refreshAll() {
    this._record('refreshAll', []);
    return undefined;
  }
  async refreshTeams() {
    this._record('refreshTeams', []);
    return this._teams;
  }
  async refreshHistory() {
    this._record('refreshHistory', []);
    return [];
  }
  async refreshScope({ teamPath }) {
    this._record('refreshScope', [teamPath]);
    return undefined;
  }
  async getScopeSnapshot(teamPath) {
    this._record('getScopeSnapshot', [teamPath]);
    return this.getScopeSnapshotSync(teamPath);
  }
  async getNote(noteId, teamPath) {
    this._record('getNote', [noteId, teamPath]);
    return { id: noteId, title: 'Mock Note', teamPath };
  }
  async getNoteContent(noteId, teamPath) {
    this._record('getNoteContent', [noteId, teamPath]);
    return { id: noteId, content: '# mock content' };
  }
  async getEntityByUri(uri) {
    this._record('getEntityByUri', [uri]);
    return { type: 'note', id: 'x1' };
  }
  async createNote(input) {
    this._record('createNote', [input]);
    return { id: 'new1', title: input.title };
  }
  async createFolder(input) {
    this._record('createFolder', [input]);
    return { id: 'newf1', name: input.name };
  }
  async loadNoteContent(noteId, teamPath) {
    this._record('loadNoteContent', [noteId, teamPath]);
    return { id: noteId, content: '# loaded' };
  }
  async saveNoteContent(noteId, content, teamPath) {
    this._record('saveNoteContent', [noteId, content, teamPath]);
    return { id: noteId };
  }
  async updateNoteProperties(noteId, update, teamPath) {
    this._record('updateNoteProperties', [noteId, update, teamPath]);
    return { id: noteId, ...update };
  }
  async renameNote(noteId, newTitle, teamPath) {
    this._record('renameNote', [noteId, newTitle, teamPath]);
    return { id: noteId, title: newTitle };
  }
  async renameFolder(folderId, newName, teamPath) {
    this._record('renameFolder', [folderId, newName, teamPath]);
    return { id: folderId, name: newName };
  }
  async updateFolder(folderId, update, teamPath) {
    this._record('updateFolder', [folderId, update, teamPath]);
    return { id: folderId, ...update };
  }
  async moveNote(input) {
    this._record('moveNote', [input]);
    return { id: input.noteId };
  }
  async moveFolder(input) {
    this._record('moveFolder', [input]);
    return { id: input.folderId };
  }
  async deleteNote(noteId, teamPath) {
    this._record('deleteNote', [noteId, teamPath]);
    return undefined;
  }
  async deleteFolder(folderId, teamPath) {
    this._record('deleteFolder', [folderId, teamPath]);
    return undefined;
  }
}

// ============================================================
// Shared setup helpers
// ============================================================
function setupModel() {
  const model = new MockHackmdModel();
  stub.setModel(model);
  return model;
}

// ============================================================
// TESTS
// ============================================================

// ─────────────────────────────────────────────────────────────
// Model not initialized
// ─────────────────────────────────────────────────────────────
test('getModel() returns undefined and shows error when model not initialized', async () => {
  stub.clearModel();
  let errorShown = false;
  stub.window.showErrorMessage = async () => { errorShown = true; return undefined; };
  const result = await invoke('hackmd.model.refreshAll');
  assert.equal(result, undefined);
  assert.equal(errorShown, true);
  stub.window.showErrorMessage = async () => undefined; // reset
});

// ─────────────────────────────────────────────────────────────
// Simple no-picker commands
// ─────────────────────────────────────────────────────────────
test('refreshAll — calls model.refreshAll() and returns true', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshAll');
  assert.equal(result, true);
  assert.equal(model.calls.refreshAll.length, 1);
});

test('refreshPersonalScope — calls model.refreshScope(personal) and returns true', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshPersonalScope');
  assert.equal(result, true);
  assert.deepEqual(model.calls.refreshScope[0], [null]);
});

test('refreshTeams — calls model.refreshTeams()', async () => {
  const model = setupModel();
  await invoke('hackmd.model.refreshTeams');
  assert.equal(model.calls.refreshTeams.length, 1);
});

test('refreshHistory — calls model.refreshHistory()', async () => {
  const model = setupModel();
  await invoke('hackmd.model.refreshHistory');
  assert.equal(model.calls.refreshHistory.length, 1);
});

// ─────────────────────────────────────────────────────────────
// refreshScope
// ─────────────────────────────────────────────────────────────
test('refreshScope — with explicit null teamPath', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshScope', { teamPath: null });
  assert.equal(result, true);
  assert.deepEqual(model.calls.refreshScope[0], [null]);
});

test('refreshScope — with explicit team path', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshScope', { teamPath: 'acme' });
  assert.equal(result, true);
  assert.deepEqual(model.calls.refreshScope[0], ['acme']);
});

test('refreshScope — with tree team node argument', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshScope', { type: 'team', team: { path: 'acme' } });
  assert.equal(result, true);
  assert.deepEqual(model.calls.refreshScope[0], ['acme']);
});

test('refreshScope — no args, picks personal scope via picker', async () => {
  const model = setupModel();
  new Interactions().qp('My Notes').install();
  const result = await invoke('hackmd.model.refreshScope');
  assert.equal(result, true);
  assert.deepEqual(model.calls.refreshScope[0], [null]);
});

test('refreshScope — picker cancelled returns undefined', async () => {
  setupModel();
  new Interactions().qp(null).install();
  const result = await invoke('hackmd.model.refreshScope');
  assert.equal(result, undefined);
});

// ─────────────────────────────────────────────────────────────
// createNote
// ─────────────────────────────────────────────────────────────
test('createNote — with all args provided', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Hello')    // title
    .ib('# hi')     // content
    .install();
  const result = await invoke('hackmd.model.createNote', { type: 'folder', id: null, teamPath: null });
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].title, 'Hello');
  assert.equal(model.calls.createNote[0][0].content, '# hi');
});

test('createNote — fully interactive (scope → folder → title → content)', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')    // scope picker
    .qp('Root')        // folder picker (includeRoot = true)
    .ib('New Note')    // title input
    .ib('# content')   // content input
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  const args = model.calls.createNote[0][0];
  assert.equal(args.title, 'New Note');
  assert.equal(args.content, '# content');
  assert.equal(args.teamPath, null);
  assert.equal(args.parentFolderId, null);
});

test('createNote — scope picker cancelled returns undefined', async () => {
  setupModel();
  new Interactions().qp(null).install();
  const result = await invoke('hackmd.model.createNote');
  assert.equal(result, undefined);
});

test('createNote — folder picker cancelled returns undefined', async () => {
  setupModel();
  new Interactions()
    .qp('My Notes')
    .qp(null)
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.equal(result, undefined);
});

test('createNote — title input cancelled returns undefined', async () => {
  setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Root')
    .ib(null)
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.equal(result, undefined);
});

test('createNote — custom scope input ("Custom Team Path...")', async () => {
  const model = setupModel();
  new Interactions()
    .qp('Custom Team Path...')  // scope picker → custom
    .ib('acme')                 // custom team path input
    .qp('Root')                 // folder picker
    .ib('Team Note Title')      // title
    .ib('')                     // content (empty = no content)
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].teamPath, 'acme');
});

// ─────────────────────────────────────────────────────────────
// createFolder
// ─────────────────────────────────────────────────────────────
test('createFolder — with all args provided', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Archive')  // name
    .install();
  await invoke('hackmd.model.createFolder', { type: 'folder', id: null, teamPath: null });
  assert.equal(model.calls.createFolder[0][0].name, 'Archive');
});

test('createFolder — fully interactive (scope → folder → name)', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Root')
    .ib('My Folder')
    .install();
  const result = await invoke('hackmd.model.createFolder');
  assert.ok(result);
  assert.equal(model.calls.createFolder[0][0].name, 'My Folder');
  assert.equal(model.calls.createFolder[0][0].teamPath, null);
});

test('createFolder — name input cancelled returns undefined', async () => {
  setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Root')
    .ib(null)
    .install();
  const result = await invoke('hackmd.model.createFolder');
  assert.equal(result, undefined);
});

// ─────────────────────────────────────────────────────────────
// renameNote
// ─────────────────────────────────────────────────────────────
test('renameNote — with explicit args', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Renamed')  // new title
    .install();
  await invoke('hackmd.model.renameNote', { type: 'note', note: { id: 'pn1', teamPath: null, title: 'Old' } });
  assert.deepEqual(model.calls.renameNote[0], ['pn1', 'Renamed', null]);
});

test('renameNote — picks note, prompts new title', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('My Note')
    .ib('Brand New Title')
    .install();
  await invoke('hackmd.model.renameNote');
  assert.equal(model.calls.renameNote[0][1], 'Brand New Title');
});

// ─────────────────────────────────────────────────────────────
// renameFolder
// ─────────────────────────────────────────────────────────────
test('renameFolder — with explicit args', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Archives')  // new name
    .install();
  await invoke('hackmd.model.renameFolder', { type: 'folder', id: 'pf1', teamPath: null, name: 'Work' });
  assert.deepEqual(model.calls.renameFolder[0], ['pf1', 'Archives', null]);
});

test('renameFolder — fully interactive (scope → folder → name)', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Work')
    .ib('Old Work')
    .install();
  await invoke('hackmd.model.renameFolder');
  assert.equal(model.calls.renameFolder[0][0], 'pf1');
  assert.equal(model.calls.renameFolder[0][1], 'Old Work');
});

// ─────────────────────────────────────────────────────────────
// updateFolder
// ─────────────────────────────────────────────────────────────
test('updateFolder — with explicit args', async () => {
  const model = setupModel();
  const update = { name: 'Foo' };
  await invoke('hackmd.model.updateFolder', { folderId: 'pf1', teamPath: null, update });
  assert.deepEqual(model.calls.updateFolder[0], ['pf1', update, null]);
});

test('updateFolder — picks scope → folder → JSON', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Work')
    .ib('{"name":"Updated Work"}')
    .install();
  await invoke('hackmd.model.updateFolder');
  assert.deepEqual(model.calls.updateFolder[0][1], { name: 'Updated Work' });
});

// ─────────────────────────────────────────────────────────────
// move
// ─────────────────────────────────────────────────────────────
test('move — active item only: asks destination and moves the item', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  await invoke('hackmd.model.move', { type: 'note', note: { id: 'pn1', teamPath: null } });

  assert.equal(model.calls.moveNote[0][0].noteId, 'pn1');
  assert.equal(model.calls.moveNote[0][0].sourceTeamPath, null);
  assert.equal(model.calls.moveNote[0][0].targetTeamPath, null);
  assert.equal(model.calls.moveNote[0][0].targetParentFolderId, 'pf3');
});

test('move — selected items take precedence over active item', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  const activeItem = { type: 'note', note: { id: 'pn1', teamPath: null } };
  const selectedItems = [{ type: 'note', note: { id: 'pn2', teamPath: null } }];

  await invoke('hackmd.model.move', activeItem, selectedItems);

  assert.equal(model.calls.moveNote.length, 1);
  assert.equal(model.calls.moveNote[0][0].noteId, 'pn2');
});

test('move — command palette flow picks entity then destination', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp((it) => String(it.label || '').includes('My Note'))
    .qp('Archive')
    .install();

  await invoke('hackmd.model.move');

  assert.equal(model.calls.moveNote[0][0].noteId, 'pn1');
});

test('move — folder candidate removes descendant candidates before moving', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  const folder = { type: 'folder', id: 'pf1', teamPath: null };
  const descendantFolder = { type: 'folder', id: 'pf2', teamPath: null, parentId: 'pf1' };
  const descendantNote = { type: 'note', note: { id: 'pn1', teamPath: null, parentFolderId: 'pf1' } };

  await invoke('hackmd.model.move', folder, [folder, descendantFolder, descendantNote]);

  assert.equal(model.calls.moveFolder.length, 1);
  assert.equal(model.calls.moveFolder[0][0].folderId, 'pf1');
  assert.equal(model.calls.moveNote ? model.calls.moveNote.length : 0, 0);
});

test('move — provided target folder skips destination picker', async () => {
  const model = setupModel();
  await invoke(
    'hackmd.model.move',
    { type: 'note', note: { id: 'pn2', teamPath: null } },
    undefined,
    { teamPath: null, folderId: 'pf1' }
  );

  assert.equal(model.calls.moveNote[0][0].noteId, 'pn2');
  assert.equal(model.calls.moveNote[0][0].targetParentFolderId, 'pf1');
});

test('move — invalid destination for all items shows error', async () => {
  const model = setupModel();
  let error;
  stub.window.showErrorMessage = async (message) => { error = message; return undefined; };

  await invoke(
    'hackmd.model.move',
    { type: 'folder', id: 'pf1', teamPath: null },
    undefined,
    { teamPath: null, folderId: 'pf2' }
  );

  assert.ok(error.includes('not a valid move destination'));
  assert.equal(model.calls.moveFolder ? model.calls.moveFolder.length : 0, 0);
  stub.window.showErrorMessage = async () => undefined;
});

test('move — all items already in destination does nothing silently', async () => {
  const model = setupModel();
  await invoke(
    'hackmd.model.move',
    { type: 'note', note: { id: 'pn2', teamPath: null, parentFolderId: null } },
    undefined,
    { teamPath: null, folderId: null }
  );

  assert.equal(model.calls.moveNote ? model.calls.moveNote.length : 0, 0);
});

// ─────────────────────────────────────────────────────────────
// delete
// ─────────────────────────────────────────────────────────────
test('delete — confirmation accepted deletes note', async () => {
  const model = setupModel();
  new Interactions().wm('Delete').install();
  const result = await invoke('hackmd.model.delete', { type: 'note', note: { id: 'pn1', teamPath: null } });
  assert.equal(result, true);
  assert.deepEqual(model.calls.deleteNote[0], ['pn1', null]);
});

test('delete — confirmation rejected returns undefined', async () => {
  setupModel();
  new Interactions().wm(undefined).install();
  const result = await invoke('hackmd.model.delete', { type: 'note', note: { id: 'pn1', teamPath: null } });
  assert.equal(result, undefined);
});

test('delete — fully interactive, then confirms', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('My Note')
    .wm('Delete')
    .install();
  const result = await invoke('hackmd.model.delete');
  assert.equal(result, true);
  assert.equal(model.calls.deleteNote[0][0], 'pn1');
});

test('delete — fully interactive, note picker cancelled', async () => {
  setupModel();
  new Interactions()
    .qp('My Notes')
    .qp(null)
    .install();
  const result = await invoke('hackmd.model.delete');
  assert.equal(result, undefined);
});

test('delete — confirmation accepted deletes folder', async () => {
  const model = setupModel();
  new Interactions().wm('Delete').install();
  const result = await invoke('hackmd.model.delete', { type: 'folder', id: 'pf1', teamPath: null });
  assert.equal(result, true);
  assert.deepEqual(model.calls.deleteFolder[0], ['pf1', null]);
});

test('delete — folder confirmation rejected returns undefined', async () => {
  setupModel();
  new Interactions().wm(undefined).install();
  const result = await invoke('hackmd.model.delete', { type: 'folder', id: 'pf1', teamPath: null });
  assert.equal(result, undefined);
});

// ─────────────────────────────────────────────────────────────
// Custom picker paths
// ─────────────────────────────────────────────────────────────
test('pickScope — custom path input used as team path', async () => {
  const model = setupModel();
  new Interactions()
    .qp('Custom Team Path...')
    .ib('custom-team')
    .install();
  const result = await invoke('hackmd.model.refreshScope');
  assert.equal(result, true);
  assert.equal(model.calls.refreshScope[0][0], 'custom-team');
});

test('pickScope — custom path empty string treated as personal (null)', async () => {
  const model = setupModel();
  new Interactions()
    .qp('Custom Team Path...')
    .ib('')
    .install();
  const result = await invoke('hackmd.model.refreshScope');
  assert.equal(result, true);
  assert.equal(model.calls.refreshScope[0][0], null);
});

test('pickNote — custom note ID input used', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Custom Note ID...')
    .ib('custom-note-123')
    .install();
  await invoke('hackmd.model.renameNote', { type: 'note', note: { id: 'custom-note-123', teamPath: null, title: 'Old' } });
  assert.equal(model.calls.renameNote[0][0], 'custom-note-123');
});

test('pickFolder — custom folder ID input used', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp('Custom Folder ID...')
    .ib('custom-folder-456')
    .ib('Folder Name')
    .install();
  await invoke('hackmd.model.renameFolder');
  assert.equal(model.calls.renameFolder[0][0], 'custom-folder-456');
});

test('pickFolder with includeRoot — custom folder ID empty = root (null)', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')           // scope
    .qp('Custom Folder ID...')  // folder picker → custom (with includeRoot)
    .ib('')                   // empty → Root (null parentFolderId)
    .ib('Note Title')         // title
    .ib('')                   // content
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].parentFolderId, null);
});
