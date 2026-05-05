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
      { id: 't1', type: 'team', path: 'acme', name: 'Acme Corp' },
    ];
    this._personalSnapshot = {
      teamPath: null,
      rootFolders: [
        {
          id: 'pf1',
          type: 'folder',
          name: 'Work',
          path: '/Work',
          teamPath: null,
          notes: [{ id: 'pn1', type: 'note', title: 'My Note', shortId: 'abc', teamPath: null, children: [], notes: [] }],
          children: [
            {
              id: 'pf2',
              type: 'folder',
              name: 'Sub',
              path: '/Work/Sub',
              parentId: 'pf1',
              teamPath: null,
              notes: [],
              children: [],
            },
          ],
        },
        {
          id: 'pf3',
          type: 'folder',
          name: 'Archive',
          path: '/Archive',
          teamPath: null,
          notes: [],
          children: [],
        },
      ],
      rootNotes: [
        { id: 'pn2', type: 'note', title: 'Root Note', shortId: 'xyz', teamPath: null },
      ],
    };
    this._acmeSnapshot = {
      teamPath: 'acme',
      rootFolders: [
        {
          id: 'tf1',
          type: 'folder',
          name: 'Projects',
          path: '/Projects',
          teamPath: 'acme',
          notes: [{ id: 'tn1', type: 'note', title: 'Spec', shortId: 's1', teamPath: 'acme', children: [], notes: [] }],
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

  getScopeSnapshotSync(scope) {
    if (!scope || scope.type === 'my-notes') return this._personalSnapshot;
    if (scope.type === 'team' && scope.path === 'acme') return this._acmeSnapshot;
    return null;
  }

  getNoteSync(scope, noteId) {
    const snap = this.getScopeSnapshotSync(scope);
    if (!snap) return undefined;
    const all = [
      ...snap.rootNotes,
      ...snap.rootFolders.flatMap((f) => f.notes),
    ];
    return all.find((n) => n.id === noteId);
  }

  getMyNotesEntity() {
    return { type: 'my-notes' };
  }

  getTeamsEntity() {
    return { type: 'teams' };
  }

  getRecentNotesEntity() {
    return { type: 'recent-notes' };
  }

  getScopeEntityForItem(item) {
    if (item?.type === 'my-notes') return this.getMyNotesEntity();
    if (item?.type === 'team') return this._teams.find((t) => t.path === item.path) ?? this.getMyNotesEntity();
    if (!item?.teamPath) return this.getMyNotesEntity();
    return this._teams.find((t) => t.path === item.teamPath) ?? this.getMyNotesEntity();
  }

  getImmediateParentContainer(item) {
    this._record('getImmediateParentContainer', [item]);
    const scope = this.getScopeEntityForItem(item);
    if (item?.type === 'folder') {
      if (!item.parentId) return scope;
      return this.getFolderSync(scope, item.parentId) ?? scope;
    }
    const parentFolderId = item?.parentFolderId ?? item?.parentForderId ?? null;
    if (!parentFolderId) return scope;
    return this.getFolderSync(scope, parentFolderId) ?? scope;
  }

  getFolderSync(scope, folderId) {
    if (!scope) return undefined;
    const snap = this.getScopeSnapshotSync(scope);
    if (!snap) return undefined;
    const allFolders = [
      ...snap.rootFolders,
      ...snap.rootFolders.flatMap((f) => f.children || []),
    ];
    return allFolders.find((f) => f.id === folderId);
  }

  // --- async operations (all return resolved promises with mock data) ---

  async refresh(entity) {
    this._record('refresh', [entity]);
    return undefined;
  }
  async getScopeSnapshot(scope) {
    this._record('getScopeSnapshot', [scope]);
    return scope ? this.getScopeSnapshotSync(scope) : null;
  }
  async getNote(scope, noteId) {
    const teamPath = scope?.type === 'team' ? scope.path : null;
    this._record('getNote', [scope, noteId]);
    return { id: noteId, title: 'Mock Note', teamPath };
  }
  async getNoteContent(note) {
    this._record('getNoteContent', [note]);
    return { id: note.id, content: '# mock content' };
  }
  async getEntityByUri(uri) {
    this._record('getEntityByUri', [uri]);
    return { type: 'note', id: 'x1' };
  }
  async createNote(container, props) {
    this._record('createNote', [container, props]);
    const teamPath = container.type === 'my-notes' ? null
      : container.type === 'team' ? container.path
        : container.teamPath ?? null;
    const parentFolderId = container.type === 'folder' ? container.id : null;
    return {
      id: 'new1',
      title: props?.title ?? null,
      teamPath,
      parentFolderId,
    };
  }
  async createFolder(container, props) {
    this._record('createFolder', [container, props]);
    const teamPath = container.type === 'my-notes' ? null
      : container.type === 'team' ? container.path
        : container.teamPath ?? null;
    const parentFolderId = container.type === 'folder' ? container.id : null;
    return { id: 'newf1', name: props.name, teamPath, parentFolderId };
  }
  async updateNote(note, update) {
    this._record('updateNote', [note, update]);
    return { id: note.id, ...update };
  }
  async renameNote(noteId, newTitle, teamPath) {
    this._record('renameNote', [noteId, newTitle, teamPath]);
    return { id: noteId, title: newTitle };
  }
  async updateFolder(folder, update) {
    this._record('updateFolder', [folder, update]);
    return { id: folder.id, ...update };
  }
  async moveNote(note, destination) {
    this._record('moveNote', [note, destination]);
    return { id: note.id };
  }
  async moveFolder(folder, destination) {
    this._record('moveFolder', [folder, destination]);
    return { id: folder.id };
  }
  async deleteNote(note) {
    this._record('deleteNote', [note]);
    return undefined;
  }
  async deleteFolder(folder) {
    this._record('deleteFolder', [folder]);
    return undefined;
  }
}

// ============================================================
// Shared setup helpers
// ============================================================
function setupModel() {
  const model = new MockHackmdModel();
  stub.setModel(model);
  stub.resetExtensionState();
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
  const result = await invoke('hackmd.model.refreshMyNotes');
  assert.equal(result, undefined);
  assert.equal(errorShown, true);
  stub.window.showErrorMessage = async () => undefined; // reset
});

// ─────────────────────────────────────────────────────────────
// Simple no-picker commands
// ─────────────────────────────────────────────────────────────
test('refreshPersonalScope — calls model.refreshScope(personal) and returns true', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshMyNotes');
  assert.equal(result, true);
  assert.equal(model.calls.refresh[0][0].type, 'my-notes');
});

test('refreshTeams — calls model.refreshTeams()', async () => {
  const model = setupModel();
  await invoke('hackmd.model.refreshTeams');
  assert.equal(model.calls.refresh[0][0].type, 'teams');
});

test('refreshHistory — calls model.refreshHistory()', async () => {
  const model = setupModel();
  await invoke('hackmd.model.refreshRecentNotes');
  assert.equal(model.calls.refresh[0][0].type, 'recent-notes');
});

// ─────────────────────────────────────────────────────────────
// refreshScope
// ─────────────────────────────────────────────────────────────
test('refreshScope — with explicit ModelTeam argument', async () => {
  const model = setupModel();
  const result = await invoke('hackmd.model.refreshTeam', model.getTeams()[0]);
  assert.equal(result, true);
  assert.equal(model.calls.refresh[0][0].path, 'acme');
});

test('refreshScope — no args, picks team scope via picker', async () => {
  const model = setupModel();
  new Interactions().qp('Acme Corp').install();
  const result = await invoke('hackmd.model.refreshTeam');
  assert.equal(result, true);
  assert.equal(model.calls.refresh[0][0].path, 'acme');
});

test('refreshScope — picker cancelled returns undefined', async () => {
  setupModel();
  new Interactions().qp(null).install();
  const result = await invoke('hackmd.model.refreshTeam');
  assert.equal(result, undefined);
});

// ─────────────────────────────────────────────────────────────
// createNote
// ─────────────────────────────────────────────────────────────
test('createNote — with all args provided', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  const result = await invoke('hackmd.model.createNote', { type: 'my-notes' });
  assert.ok(result);
  assert.equal('title' in model.calls.createNote[0][1], false);
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[1][0], 'hackmd.ui.edit');
  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createNote — fully interactive (single location picker → creates untitled note)', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  new Interactions()
    .qp((it) => String(it.label || '').includes('My Notes'))
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  const container = model.calls.createNote[0][0];
  const props = model.calls.createNote[0][1];
  assert.equal('title' in props, false);
  assert.equal('content' in props, false);
  assert.equal(container.type, 'my-notes');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[1][0], 'hackmd.ui.edit');
  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createNote — location picker cancelled returns undefined', async () => {
  setupModel();
  new Interactions().qp(null).install();
  const result = await invoke('hackmd.model.createNote');
  assert.equal(result, undefined);
});

test('createNote — title input cancelled returns undefined', async () => {
  // No longer asks for title — this test is superseded; location picker cancel still works
  setupModel();
  new Interactions().qp(null).install();
  const result = await invoke('hackmd.model.createNote');
  assert.equal(result, undefined);
});

test('createNote — can target a team root from unified location picker', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  new Interactions()
    .qp((it) => String(it.label || '').includes('Acme Corp'))
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].type, 'team');
  assert.equal(model.calls.createNote[0][0].path, 'acme');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[1][0], 'hackmd.ui.edit');
  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createMyNote — delegates to createNote with My Notes container', async () => {
  setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  stub.window.showQuickPick = async () => {
    throw new Error('showQuickPick should not be called for createMyNote root action');
  };
  stub.window.showInputBox = async () => {
    throw new Error('showInputBox should not be called for createMyNote root action');
  };

  const result = await invoke('hackmd.model.createMyNote');
  assert.equal(result, undefined);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0][0], 'hackmd.model.createNote');
  assert.equal(executeCalls[0][1]?.type, 'my-notes');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createMyNote — ignores provided node and delegates with My Notes container', async () => {
  setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  stub.window.showQuickPick = async () => {
    throw new Error('showQuickPick should not be called for createMyNote folder action');
  };
  stub.window.showInputBox = async () => {
    throw new Error('showInputBox should not be called for createMyNote folder action');
  };

  const result = await invoke('hackmd.model.createMyNote', { type: 'folder', id: 'pf1', teamPath: null });
  assert.equal(result, undefined);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0][0], 'hackmd.model.createNote');
  assert.equal(executeCalls[0][1]?.type, 'my-notes');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createNote — folder container argument is passed directly to model.createNote', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  const folderContainer = {
    type: 'folder',
    id: 'pf1',
    teamPath: null,
  };

  const result = await invoke('hackmd.model.createNote', folderContainer);
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].type, 'folder');
  assert.equal(model.calls.createNote[0][0].id, 'pf1');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[1][0], 'hackmd.ui.edit');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createNote — note argument is remapped to its immediate parent container', async () => {
  const model = setupModel();
  const noteArg = {
    type: 'note',
    id: 'pn1',
    teamPath: null,
    parentFolderId: 'pf1',
  };

  const result = await invoke('hackmd.model.createNote', noteArg);
  assert.ok(result);
  assert.equal((model.calls.getImmediateParentContainer || []).length, 1);
  assert.equal(model.calls.createNote[0][0].type, 'folder');
  assert.equal(model.calls.createNote[0][0].id, 'pf1');
});

test('createNote — passes provided container argument as-is', async () => {
  const model = setupModel();
  const containerArg = { type: 'folder', id: 'arg-folder', teamPath: null, parentId: null };
  const result = await invoke('hackmd.model.createNote', containerArg);
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0], containerArg);
});

test('createMyNote — delegates to createNote command', async () => {
  setupModel();
  const executeCalls = [];

  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  const result = await invoke('hackmd.model.createMyNote');
  assert.equal(result, undefined);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0][0], 'hackmd.model.createNote');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createNote — delegates reveal command before opening editor', async () => {
  const model = setupModel();
  const executeCalls = [];

  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  new Interactions()
    .qp((it) => String(it.label || '').includes('Acme Corp'))
    .install();

  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[1][0], 'hackmd.ui.edit');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

// ─────────────────────────────────────────────────────────────
// createFolder
// ─────────────────────────────────────────────────────────────
test('createFolder — with all args provided', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  new Interactions()
    .ib('Archive')  // name
    .install();
  await invoke('hackmd.model.createFolder', { type: 'my-notes' });
  assert.equal(model.calls.createFolder[0][1].name, 'Archive');
  assert.equal(model.calls.createFolder[0][0].type, 'my-notes');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[0][1]?.type, 'folder');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createFolder — fully interactive (single location picker → name)', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  new Interactions()
    .qp((it) => String(it.label || '').includes('My Notes'))
    .ib('My Folder')
    .install();
  const result = await invoke('hackmd.model.createFolder');
  assert.ok(result);
  assert.equal(model.calls.createFolder[0][1].name, 'My Folder');
  assert.equal(model.calls.createFolder[0][0].type, 'my-notes');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[0][1]?.type, 'folder');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createFolder — name input cancelled returns undefined', async () => {
  setupModel();
  new Interactions()
    .qp((it) => String(it.label || '').includes('My Notes'))
    .ib(null)
    .install();
  const result = await invoke('hackmd.model.createFolder');
  assert.equal(result, undefined);
});

test('createFolder — can target a team root from unified location picker', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };
  new Interactions()
    .qp((it) => String(it.label || '').includes('Acme Corp'))
    .ib('Team Folder')
    .install();

  const result = await invoke('hackmd.model.createFolder');
  assert.ok(result);

  const container = model.calls.createFolder[0][0];
  const props = model.calls.createFolder[0][1];
  assert.equal(container.type, 'team');
  assert.equal(container.path, 'acme');
  assert.equal(props.name, 'Team Folder');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[0][1]?.type, 'folder');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createFolder — delegates reveal command after create', async () => {
  const model = setupModel();
  const executeCalls = [];

  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  new Interactions()
    .qp((it) => String(it.label || '').includes('My Notes'))
    .ib('Shown Folder')
    .install();

  const result = await invoke('hackmd.model.createFolder');
  assert.ok(result);
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');
  assert.equal(executeCalls[0][1]?.type, 'folder');
  assert.equal(executeCalls[0][1]?.id, result.id);

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createFolder — passes provided container argument as-is', async () => {
  const model = setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  new Interactions()
    .ib('Nested Team Folder')
    .install();

  const containerArg = { type: 'folder', id: 'arg-folder', teamPath: null, parentId: null };
  const result = await invoke('hackmd.model.createFolder', containerArg);
  assert.ok(result);
  assert.equal(model.calls.createFolder[0][0], containerArg);
  assert.equal(model.calls.createFolder[0][1].name, 'Nested Team Folder');
  assert.equal(executeCalls[0][0], 'hackmd.ui.reveal');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createFolder — note argument is remapped to its immediate parent container', async () => {
  const model = setupModel();
  new Interactions().ib('Sibling Folder').install();

  const noteArg = {
    type: 'note',
    id: 'pn1',
    teamPath: null,
    parentFolderId: 'pf1',
  };

  const result = await invoke('hackmd.model.createFolder', noteArg);
  assert.ok(result);
  assert.equal((model.calls.getImmediateParentContainer || []).length, 1);
  assert.equal(model.calls.createFolder[0][0].type, 'folder');
  assert.equal(model.calls.createFolder[0][0].id, 'pf1');
});

test('createMyFolder — delegates to createFolder with My Notes container', async () => {
  setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  stub.window.showQuickPick = async () => {
    throw new Error('showQuickPick should not be called for createMyFolder title action');
  };

  const result = await invoke('hackmd.model.createMyFolder');
  assert.equal(result, undefined);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0][0], 'hackmd.model.createFolder');
  assert.equal(executeCalls[0][1]?.type, 'my-notes');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

test('createMyFolder — ignores provided node and delegates with My Notes container', async () => {
  setupModel();
  const executeCalls = [];
  stub.vscodeStub.commands.executeCommand = async (...args) => {
    executeCalls.push(args);
    return undefined;
  };

  stub.window.showQuickPick = async () => {
    throw new Error('showQuickPick should not be called for createMyFolder folder action');
  };

  const result = await invoke('hackmd.model.createMyFolder', { type: 'folder', id: 'pf1', teamPath: null });
  assert.equal(result, undefined);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0][0], 'hackmd.model.createFolder');
  assert.equal(executeCalls[0][1]?.type, 'my-notes');

  stub.vscodeStub.commands.executeCommand = async () => undefined;
});

// ─────────────────────────────────────────────────────────────
// rename
// ─────────────────────────────────────────────────────────────
test('rename (note) — with explicit args', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Renamed')  // new title
    .install();
  await invoke('hackmd.model.rename', { type: 'note', note: { id: 'pn1', teamPath: null, title: 'Old' } });
  assert.deepEqual(model.calls.renameNote[0], ['pn1', 'Renamed', null]);
});

test('rename (note) — picks note, prompts new title', async () => {
  const model = setupModel();
  new Interactions()
    .qp((it) => String(it.label || '').includes('My Note'))
    .ib('Brand New Title')
    .install();
  await invoke('hackmd.model.rename');
  assert.equal(model.calls.renameNote[0][1], 'Brand New Title');
});

test('rename (folder) — with explicit args', async () => {
  const model = setupModel();
  new Interactions()
    .ib('Archives')  // new name
    .install();
  await invoke('hackmd.model.rename', { type: 'folder', id: 'pf1', teamPath: null, name: 'Work' });
  assert.equal(model.calls.updateFolder[0][0].id, 'pf1');
  assert.equal(model.calls.updateFolder[0][1].name, 'Archives');
});

test('rename (folder) — fully interactive (single picker → name)', async () => {
  const model = setupModel();
  new Interactions()
    .qp((it) => String(it.label || '').includes('Work'))
    .ib('Old Work')
    .install();
  await invoke('hackmd.model.rename');
  assert.equal(model.calls.updateFolder[0][0].id, 'pf1');
  assert.equal(model.calls.updateFolder[0][1].name, 'Old Work');
});

// ─────────────────────────────────────────────────────────────
// move
// ─────────────────────────────────────────────────────────────
test('move — active item only: asks destination and moves the item', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  await invoke('hackmd.model.move', { type: 'note', note: { id: 'pn1', teamPath: null } });

  assert.equal(model.calls.moveNote[0][0].id, 'pn1');
  assert.equal(model.calls.moveNote[0][1].id, 'pf3');
});

test('move — selected items take precedence over active item', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  const activeItem = { type: 'note', note: { id: 'pn1', teamPath: null } };
  const selectedItems = [{ type: 'note', note: { id: 'pn2', teamPath: null } }];

  await invoke('hackmd.model.move', activeItem, selectedItems);

  assert.equal(model.calls.moveNote.length, 1);
  assert.equal(model.calls.moveNote[0][0].id, 'pn2');
});

test('move — command palette flow picks entity then destination', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .qp((it) => String(it.label || '').includes('My Note'))
    .qp('Archive')
    .install();

  await invoke('hackmd.model.move');

  assert.equal(model.calls.moveNote[0][0].id, 'pn1');
});

test('move — folder candidate removes descendant candidates before moving', async () => {
  const model = setupModel();
  new Interactions().qp('Archive').install();

  const folder = { type: 'folder', id: 'pf1', teamPath: null };
  const descendantFolder = { type: 'folder', id: 'pf2', teamPath: null, parentId: 'pf1' };
  const descendantNote = { type: 'note', note: { id: 'pn1', teamPath: null, parentFolderId: 'pf1' } };

  await invoke('hackmd.model.move', folder, [folder, descendantFolder, descendantNote]);

  assert.equal(model.calls.moveFolder.length, 1);
  assert.equal(model.calls.moveFolder[0][0].id, 'pf1');
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

  assert.equal(model.calls.moveNote[0][0].id, 'pn2');
  assert.equal(model.calls.moveNote[0][1].id, 'pf1');
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

test('move — multi-item move starts model calls in parallel', async () => {
  const model = setupModel();
  const started = [];
  const resolvers = [];

  model.moveNote = async (input) => {
    started.push(input.noteId);
    return new Promise((resolve) => {
      resolvers.push(() => resolve({ id: input.noteId }));
    });
  };

  const n1 = { type: 'note', note: { id: 'pn1', teamPath: null, parentFolderId: 'pf1' } };
  const n2 = { type: 'note', note: { id: 'pn2', teamPath: null, parentFolderId: 'pf1' } };

  const pending = invoke('hackmd.model.move', n1, [n1, n2], { teamPath: null, folderId: 'pf3' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(started.length, 2);
  resolvers.forEach((resolve) => resolve());
  await pending;
});

// ─────────────────────────────────────────────────────────────
// delete
// ─────────────────────────────────────────────────────────────
test('delete — confirmation accepted deletes note', async () => {
  const model = setupModel();
  new Interactions().wm('Delete').install();
  const result = await invoke('hackmd.model.delete', { type: 'note', note: { id: 'pn1', teamPath: null } });
  assert.equal(result, true);
  assert.equal(model.calls.deleteNote[0][0].id, 'pn1');
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
  assert.equal(model.calls.deleteNote[0][0].id, 'pn1');
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
  assert.equal(model.calls.deleteFolder[0][0].id, 'pf1');
});

test('delete — folder confirmation rejected returns undefined', async () => {
  setupModel();
  new Interactions().wm(undefined).install();
  const result = await invoke('hackmd.model.delete', { type: 'folder', id: 'pf1', teamPath: null });
  assert.equal(result, undefined);
});

test('delete — multi-item delete starts note and folder deletions in parallel', async () => {
  const model = setupModel();
  const started = [];
  const resolvers = [];

  model.deleteNote = async (note) => {
    started.push(`note:${note.id}:${note.teamPath ?? 'null'}`);
    return new Promise((resolve) => {
      resolvers.push(() => resolve(undefined));
    });
  };

  model.deleteFolder = async (folder) => {
    started.push(`folder:${folder.id}:${folder.teamPath ?? 'null'}`);
    return new Promise((resolve) => {
      resolvers.push(() => resolve(undefined));
    });
  };

  new Interactions().wm('Delete').install();

  const note = { type: 'note', note: { id: 'pn1', teamPath: null } };
  const folder = { type: 'folder', id: 'pf1', teamPath: null };

  const pending = invoke('hackmd.model.delete', note, [note, folder]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(started.length, 2);
  resolvers.forEach((resolve) => resolve());
  const result = await pending;
  assert.equal(result, true);
});

// ─────────────────────────────────────────────────────────────
// Scope picker paths
// ─────────────────────────────────────────────────────────────
test('pickScope — selecting team scope refreshes that team', async () => {
  const model = setupModel();
  new Interactions()
    .qp('Acme Corp')
    .install();
  const result = await invoke('hackmd.model.refreshTeam');
  assert.equal(result, true);
  assert.equal(model.calls.refresh[0][0].path, 'acme');
});

test('pickScope — My Notes is not offered in refreshTeam picker', async () => {
  const model = setupModel();
  new Interactions()
    .qp('My Notes')
    .install();
  const result = await invoke('hackmd.model.refreshTeam');
  assert.equal(result, undefined);
  assert.equal(model.calls.refresh, undefined);
});

test('rename picker excludes custom ID entries', async () => {
  const model = setupModel();
  let sawCustomNote = false;
  let sawCustomFolder = false;
  stub.window.showInputBox = async () => 'Renamed Loaded Note';

  stub.window.showQuickPick = async (items) => {
    const resolved = await Promise.resolve(items);
    sawCustomNote = resolved.some((it) => it.label === 'Custom Note ID...');
    sawCustomFolder = resolved.some((it) => it.label === 'Custom Folder ID...');
    return resolved.find((it) => String(it.label || '').includes('My Note'));
  };

  await invoke('hackmd.model.rename');
  assert.equal(sawCustomNote, false);
  assert.equal(sawCustomFolder, false);
  assert.equal(model.calls.renameNote[0][0], 'pn1');
  stub.window.showInputBox = async () => undefined;
});

test('pickFolder with includeRoot — selecting My Notes root creates note at root', async () => {
  const model = setupModel();
  new Interactions()
    .qp((it) => String(it.label || '').includes('My Notes'))
    .install();
  const result = await invoke('hackmd.model.createNote');
  assert.ok(result);
  assert.equal(model.calls.createNote[0][0].type, 'my-notes');
});
