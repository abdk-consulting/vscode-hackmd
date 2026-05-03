'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerUiCommandsStub');

const fakeContext = {
  subscriptions: { push() { } },
};

const { registerUiCommands } = require('../../out/commands/ui');
registerUiCommands(fakeContext);

async function invoke(commandId, ...args) {
  const handler = stub.registeredHandlers.get(commandId);
  if (!handler) {
    throw new Error(`Command not registered: ${commandId}`);
  }
  return handler(...args);
}

class Interactions {
  constructor() {
    this.quickPickQueue = [];
    this.inputBoxQueue = [];
    this.openDialogQueue = [];
    this.saveDialogQueue = [];
    this.warningQueue = [];
  }

  qp(valueOrPredicate) {
    this.quickPickQueue.push(valueOrPredicate);
    return this;
  }

  ib(value) {
    this.inputBoxQueue.push(value);
    return this;
  }

  od(value) {
    this.openDialogQueue.push(value);
    return this;
  }

  sd(value) {
    this.saveDialogQueue.push(value);
    return this;
  }

  wm(value) {
    this.warningQueue.push(value);
    return this;
  }

  install() {
    const qpQueue = [...this.quickPickQueue];
    const ibQueue = [...this.inputBoxQueue];
    const odQueue = [...this.openDialogQueue];
    const sdQueue = [...this.saveDialogQueue];
    const wmQueue = [...this.warningQueue];

    stub.window.showQuickPick = async (items) => {
      if (qpQueue.length === 0) return undefined;
      const spec = qpQueue.shift();
      const resolved = await Promise.resolve(items);
      if (typeof spec === 'function') {
        return resolved.find(spec);
      }
      if (spec === null) {
        return undefined;
      }
      return resolved.find((it) => it.label === spec);
    };

    stub.window.showInputBox = async () => {
      if (ibQueue.length === 0) return undefined;
      const v = ibQueue.shift();
      return v === null ? undefined : v;
    };

    stub.window.showOpenDialog = async () => {
      if (odQueue.length === 0) return undefined;
      const v = odQueue.shift();
      return v === null ? undefined : v;
    };

    stub.window.showSaveDialog = async () => {
      if (sdQueue.length === 0) return undefined;
      const v = sdQueue.shift();
      return v === null ? undefined : v;
    };

    stub.window.showWarningMessage = async () => {
      if (wmQueue.length === 0) return undefined;
      return wmQueue.shift();
    };
  }
}

class MockUiModel {
  constructor() {
    this.calls = {};

    this.teams = [{ id: 't1', path: 'acme', name: 'Acme' }];

    this.personalSnapshot = {
      scope: null,
      rootFolders: [
        {
          type: 'folder',
          id: 'f1',
          name: 'FolderOne',
          teamPath: null,
          path: '/FolderOne',
          children: [
            {
              type: 'folder',
              id: 'f2',
              name: 'Nested',
              teamPath: null,
              path: '/FolderOne/Nested',
              children: [],
              notes: [
                { type: 'note', id: 'n3', title: 'Nested Note', shortId: 'n3', teamPath: null },
              ],
            },
          ],
          notes: [
            { type: 'note', id: 'n2', title: 'Folder Note', shortId: 'n2', teamPath: null },
          ],
        },
      ],
      rootNotes: [
        { type: 'note', id: 'n1', title: 'Root Note', shortId: 'n1', teamPath: null, publishLink: 'https://hackmd.io/@user/n1' },
      ],
    };

    this.acmeSnapshot = {
      scope: 'acme',
      rootFolders: [
        {
          type: 'folder',
          id: 'tf1',
          name: 'TeamFolder',
          teamPath: 'acme',
          path: '/TeamFolder',
          children: [],
          notes: [
            { type: 'note', id: 'tn1', title: 'Team Note', shortId: 'tn1', teamPath: 'acme' },
          ],
        },
      ],
      rootNotes: [],
    };

    this.noteContentByKey = new Map([
      ['null:n1', '# root-note'],
      ['null:n2', '# folder-note'],
      ['null:n3', '# nested-note'],
      ['acme:tn1', '# team-note'],
    ]);

    this.fetchedNotes = new Map([
      ['null:n1', { id: 'n1', title: 'Root Note', publishLink: 'https://hackmd.io/@user/n1', teamPath: null }],
      ['null:missing', { id: 'missing', title: 'Missing', publishLink: 'https://hackmd.io/@user/missing', teamPath: null }],
    ]);

    this.syncNotes = new Map([
      ['null:n1', { type: 'note', id: 'n1', title: 'Root Note', shortId: 'n1', teamPath: null, readPermission: 'guest', writePermission: 'signed_in', publishType: 'view', permalink: null, publishLink: 'https://hackmd.io/@user/n1' }],
      ['null:n2', { type: 'note', id: 'n2', title: 'Folder Note', shortId: 'n2', teamPath: null, readPermission: 'signed_in', writePermission: 'owner', publishType: 'view', permalink: null }],
      ['null:n3', { type: 'note', id: 'n3', title: 'Nested Note', shortId: 'n3', teamPath: null, readPermission: 'signed_in', writePermission: 'owner', publishType: 'view', permalink: null }],
      ['acme:tn1', { type: 'note', id: 'tn1', title: 'Team Note', shortId: 'tn1', teamPath: 'acme', readPermission: 'signed_in', writePermission: 'owner', publishType: 'view', permalink: null }],
    ]);
  }

  _k(teamPath, id) {
    return `${teamPath === null ? 'null' : teamPath}:${id}`;
  }

  _record(method, args) {
    this.calls[method] = this.calls[method] || [];
    this.calls[method].push(args);
  }

  getTeams() {
    this._record('getTeams', []);
    return this.teams;
  }

  getScopeSnapshotSync(teamPath) {
    this._record('getScopeSnapshotSync', [teamPath]);
    if (teamPath === null || teamPath === undefined) {
      return this.personalSnapshot;
    }
    if (teamPath === 'acme') {
      return this.acmeSnapshot;
    }
    return null;
  }

  toNoteUri(note) {
    this._record('toNoteUri', [note.id, note.teamPath]);
    return stub.makeUri('hackmd', `/note/${note.id}`, `noteId=${note.id}${note.teamPath ? `&teamPath=${note.teamPath}` : ''}`);
  }

  async getNote(noteId, teamPath) {
    this._record('getNote', [noteId, teamPath]);
    return this.fetchedNotes.get(this._k(teamPath ?? null, noteId)) || { id: noteId, teamPath: teamPath ?? null };
  }

  getNoteSync(noteId, teamPath) {
    this._record('getNoteSync', [noteId, teamPath]);
    return this.syncNotes.get(this._k(teamPath ?? null, noteId)) || null;
  }

  async getNoteContent(noteId, teamPath) {
    this._record('getNoteContent', [noteId, teamPath]);
    return this.noteContentByKey.get(this._k(teamPath ?? null, noteId)) || '';
  }

  async createNote(input) {
    this._record('createNote', [input]);
    return {
      type: 'note',
      id: `new-${(this.calls.createNote || []).length}`,
      title: input.title,
      teamPath: input.teamPath ?? null,
    };
  }
}

function callCount(model, method) {
  return (model.calls[method] || []).length;
}

test.beforeEach(() => {
  stub.resetState();
  stub.clearModel();
});

test('registers all hackmd.ui commands', async () => {
  assert.ok(stub.registeredHandlers.has('hackmd.ui.edit'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.preview'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.sideBySide'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.openOnHackMD'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.import'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.export'));
  assert.ok(stub.registeredHandlers.has('hackmd.ui.properties'));
});

test('edit: uninitialized model shows connection error', async () => {
  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  await invoke('hackmd.ui.edit', { noteId: 'n1', teamPath: null });

  assert.equal(err, 'HackMD is not connected. Please configure your API key first.');
});

test('edit: programmatic note uses model.toNoteUri and opens editor', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let shown;
  stub.window.showTextDocument = async (doc, opts) => {
    shown = { doc, opts };
    return undefined;
  };

  await invoke('hackmd.ui.edit', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(callCount(model, 'toNoteUri'), 1);
  assert.equal(stub.workspaceState.openTextDocumentCalls.length, 1);
  assert.equal(shown.opts.preview, false);
  assert.equal(shown.opts.viewColumn, 1);
});

test('edit: falls back to a hackmd URI when note is not in sync cache', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.edit', { type: 'note', note: { id: 'unknown', teamPath: null } });

  assert.equal(callCount(model, 'toNoteUri'), 0);
  const opened = stub.workspaceState.openTextDocumentCalls[0];
  assert.equal(opened.scheme, 'hackmd');
  assert.ok(String(opened.query).includes('noteId=unknown'));
});

test('preview: executes markdown.showPreview with resolved URI', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.preview', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(stub.commandsState.executeCalls[0][0], 'markdown.showPreview');
  assert.equal(callCount(model, 'toNoteUri'), 1);
});

test('sideBySide: opens editor and then markdown.showPreviewToSide', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.sideBySide', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(stub.workspaceState.openTextDocumentCalls.length, 1);
  assert.equal(stub.commandsState.executeCalls.length, 1);
  assert.equal(stub.commandsState.executeCalls[0][0], 'markdown.showPreviewToSide');
});

test('openOnHackMD: uses cached publishLink without async getNote', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.openOnHackMD', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(callCount(model, 'getNote'), 0);
  assert.equal(stub.env.openExternalCalls.length, 1);
  assert.equal(stub.env.openExternalCalls[0].toString(), 'https://hackmd.io/@user/n1');
});

test('openOnHackMD: falls back to async getNote when publishLink is not cached', async () => {
  const model = new MockUiModel();
  model.personalSnapshot.rootNotes = [
    { type: 'note', id: 'missing', title: 'Missing', shortId: 'm1', teamPath: null },
  ];
  model.fetchedNotes.set('null:missing', {
    id: 'missing',
    title: 'Missing',
    teamPath: null,
    publishLink: 'https://hackmd.io/@user/missing',
  });
  stub.setModel(model);

  await invoke('hackmd.ui.openOnHackMD', { type: 'note', note: { id: 'missing', teamPath: null } });

  assert.equal(callCount(model, 'getNote'), 1);
  assert.equal(stub.env.openExternalCalls.length, 1);
  assert.equal(stub.env.openExternalCalls[0].toString(), 'https://hackmd.io/@user/missing');
});

test('openOnHackMD: shows error when publish link is unavailable', async () => {
  const model = new MockUiModel();
  model.personalSnapshot.rootNotes = [{ type: 'note', id: 'nolink', title: 'NoLink', teamPath: null }];
  model.fetchedNotes.set('null:nolink', { id: 'nolink', teamPath: null });
  stub.setModel(model);

  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  await invoke('hackmd.ui.openOnHackMD', { type: 'note', note: { id: 'nolink', teamPath: null } });

  assert.equal(err, 'No publish link is available for this note.');
  assert.equal(stub.env.openExternalCalls.length, 0);
});

test('openOnHackMD: folder uses folderClientId in personal scope URL', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.openOnHackMD', {
    type: 'folder',
    id: 'folder-raw-id',
    teamPath: null,
    value: { context: { folderClientId: 'cid-123' } },
  });

  assert.equal(stub.env.openExternalCalls.length, 1);
  assert.equal(stub.env.openExternalCalls[0].toString(), 'https://hackmd.io/folders/cid-123');
});

test('openOnHackMD: folder uses folderClientId in team scope URL', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  await invoke('hackmd.ui.openOnHackMD', {
    type: 'folder',
    id: 'folder-raw-id',
    teamPath: 'acme',
    value: { context: { folderClientId: 'cid-123' } },
  });

  assert.equal(stub.env.openExternalCalls.length, 1);
  assert.equal(stub.env.openExternalCalls[0].toString(), 'https://hackmd.io/team/acme/folders/cid-123');
});

test('import: programmatic files create notes and refresh personal tree', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const f1 = stub.makeUri('file', '/tmp/one.md');
  const f2 = stub.makeUri('file', '/tmp/two.md');
  stub.workspaceState.fileBytesByUri.set(f1.toString(), Buffer.from('# One', 'utf8'));
  stub.workspaceState.fileBytesByUri.set(f2.toString(), Buffer.from('# Two', 'utf8'));

  new Interactions()
    .od([f1, f2])
    .install();

  await invoke('hackmd.ui.import', { type: 'folder', id: null, teamPath: null });

  assert.equal(callCount(model, 'createNote'), 2);
  assert.equal(stub.commandsState.executeCalls[0][0], 'hackmd.model.refreshScope');
  assert.deepEqual(stub.commandsState.executeCalls[0][1], { teamPath: null });
});

test('import: interactive file picker + scope/folder pickers create notes', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const f1 = stub.makeUri('file', '/tmp/first.md');
  const f2 = stub.makeUri('file', '/tmp/second.md');
  stub.workspaceState.fileBytesByUri.set(f1.toString(), Buffer.from('# first', 'utf8'));
  stub.workspaceState.fileBytesByUri.set(f2.toString(), Buffer.from('# second', 'utf8'));

  new Interactions()
    .od([f1, f2])
    .qp('My Notes')
    .qp('Root')
    .install();

  await invoke('hackmd.ui.import');

  assert.equal(callCount(model, 'createNote'), 2);
  assert.deepEqual(model.calls.createNote[0][0], {
    teamPath: null,
    title: 'first',
    content: '# first',
    parentFolderId: null,
  });
  assert.equal(stub.commandsState.executeCalls[0][0], 'hackmd.model.refreshScope');
  assert.deepEqual(stub.commandsState.executeCalls[0][1], { teamPath: null });
});

test('import: open-dialog cancellation exits without creating notes', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  new Interactions().od(null).install();

  await invoke('hackmd.ui.import');

  assert.equal(callCount(model, 'createNote'), 0);
});

test('export: single note uses save dialog then writes one file', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const target = stub.makeUri('file', '/tmp/out.md');
  new Interactions().sd(target).install();

  await invoke('hackmd.ui.export', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(callCount(model, 'getNoteContent'), 1);
  assert.equal(stub.workspaceState.writeFileCalls.length, 1);
  assert.equal(stub.workspaceState.writeFileCalls[0][0].toString(), 'file:///tmp/out.md');
});

test('export: save dialog cancel aborts single-note export', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  new Interactions().sd(null).install();

  await invoke('hackmd.ui.export', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(callCount(model, 'getNoteContent'), 0);
  assert.equal(stub.workspaceState.writeFileCalls.length, 0);
});

test('export: multi-target writes note files and recursively exports folder notes', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const dir = stub.makeUri('file', '/tmp/export-dir');
  new Interactions().od([dir]).install();

  const noteNode = { type: 'note', note: { id: 'n1', teamPath: null } };
  const folderNode = { type: 'folder', id: 'f1', name: 'FolderOne', teamPath: null };
  await invoke('hackmd.ui.export', noteNode, [noteNode, folderNode]);

  assert.equal(callCount(model, 'getNoteContent'), 3);
  assert.ok(stub.workspaceState.createDirectoryCalls.length >= 2);
  assert.equal(stub.workspaceState.writeFileCalls.length, 3);
});

test('export: interactive mode picks one entity and exports it', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const target = stub.makeUri('file', '/tmp/interactive.md');
  new Interactions()
    .qp('My Notes')
    .qp((it) => it.entityKind === 'note' && it.noteId === 'n1')
    .sd(target)
    .install();

  await invoke('hackmd.ui.export');

  assert.equal(callCount(model, 'getNoteContent'), 1);
  assert.equal(stub.workspaceState.writeFileCalls.length, 1);
});

test('export: warns when folder scope snapshot is not loaded', async () => {
  const model = new MockUiModel();
  model.getScopeSnapshotSync = function getScopeSnapshotSync(teamPath) {
    this._record('getScopeSnapshotSync', [teamPath]);
    return null;
  };
  stub.setModel(model);

  const dir = stub.makeUri('file', '/tmp/export-dir');
  new Interactions().od([dir]).install();

  let warning;
  stub.window.showWarningMessage = async (msg) => { warning = msg; };

  await invoke('hackmd.ui.export', { type: 'folder', id: 'missing', name: 'MissingFolder', teamPath: null });

  assert.ok(warning.includes('is not loaded'));
  assert.equal(stub.workspaceState.writeFileCalls.length, 0);
});

test('export: warns when folder id is missing in loaded scope', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  const dir = stub.makeUri('file', '/tmp/export-dir');
  new Interactions().od([dir]).install();

  let warning;
  stub.window.showWarningMessage = async (msg) => { warning = msg; };

  await invoke('hackmd.ui.export', { type: 'folder', id: 'nope', name: 'Nope', teamPath: null });

  assert.ok(warning.includes('was not found in scope'));
  assert.equal(stub.workspaceState.writeFileCalls.length, 0);
});

test('picker flows use sync model APIs only (no async snapshot methods)', async () => {
  const model = new MockUiModel();
  let asyncSnapshotTouched = false;
  model.getScopeSnapshot = async () => {
    asyncSnapshotTouched = true;
    return null;
  };
  stub.setModel(model);

  const target = stub.makeUri('file', '/tmp/onlysync.md');
  new Interactions()
    .qp('My Notes')
    .qp((it) => it.entityKind === 'note' && it.noteId === 'n1')
    .sd(target)
    .install();

  await invoke('hackmd.ui.export');

  assert.equal(asyncSnapshotTouched, false);
});

// ---------------------------------------------------------------------------
// hackmd.ui.properties
// ---------------------------------------------------------------------------

test('properties: uninitialized model shows connection error', async () => {
  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  await invoke('hackmd.ui.properties', { noteId: 'n1', teamPath: null });

  assert.equal(err, 'HackMD is not connected. Please configure your API key first.');
});

test('properties: programmatic noteId uses getNoteSync and opens properties panel', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let openNoteArg;
  stub.setPropertiesProvider({
    async openNote(note) { openNoteArg = note; return true; },
  });

  await invoke('hackmd.ui.properties', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal((model.calls.getNoteSync || []).length, 1);
  assert.equal((model.calls.getNote || []).length, 0, 'should not use async getNote');
  assert.equal(stub.commandsState.executeCalls[0][0], 'hackmd.properties.focus');
  assert.ok(openNoteArg, 'openNote should have been called');
  assert.equal(openNoteArg.id, 'n1');
});

test('properties: note not in sync cache shows error message', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  await invoke('hackmd.ui.properties', { type: 'note', note: { id: 'unknown', teamPath: null } });

  assert.ok(err && err.includes('unknown'), 'error message should mention note id');
  assert.equal(stub.commandsState.executeCalls.length, 0, 'focus should not be called');
});

test('properties: no propertiesProvider returns without error', async () => {
  const model = new MockUiModel();
  stub.setModel(model);
  // propertiesProvider stays null (clearPropertiesProvider was called in beforeEach via resetState)

  await invoke('hackmd.ui.properties', { noteId: 'n1', teamPath: null });

  // No error thrown, focus command not executed since provider is null
  assert.equal(stub.commandsState.executeCalls.length, 0);
});

test('properties: interactive picker selects note from personal scope', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let openNoteArg;
  stub.setPropertiesProvider({
    async openNote(note) { openNoteArg = note; return true; },
  });

  new Interactions()
    .qp('My Notes')
    .qp((it) => it.note?.id === 'n1')
    .install();

  await invoke('hackmd.ui.properties');

  assert.equal(stub.commandsState.executeCalls[0][0], 'hackmd.properties.focus');
  assert.ok(openNoteArg);
  assert.equal(openNoteArg.id, 'n1');
});

test('properties: interactive note picker does not allow custom note ID', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let openNoteArg;
  stub.setPropertiesProvider({
    async openNote(note) { openNoteArg = note; return true; },
  });

  let quickPickCall = 0;
  stub.window.showQuickPick = async (items) => {
    const resolved = await Promise.resolve(items);
    quickPickCall += 1;
    if (quickPickCall === 1) {
      return resolved.find((it) => it.label === 'My Notes');
    }
    if (quickPickCall === 2) {
      assert.equal(
        resolved.some((it) => it.label === 'Custom Note ID...'),
        false,
        'properties picker should be cache-only and not allow custom note IDs'
      );
      return resolved.find((it) => it.note?.id === 'n1');
    }
    return undefined;
  };

  await invoke('hackmd.ui.properties');

  assert.ok(openNoteArg);
  assert.equal(openNoteArg.id, 'n1');
});

test('properties: no local notes shows info and returns without opening', async () => {
  const model = new MockUiModel();
  model.personalSnapshot = { scope: null, rootFolders: [], rootNotes: [] };
  stub.setModel(model);

  let openNoteCalled = false;
  stub.setPropertiesProvider({
    async openNote() { openNoteCalled = true; return true; },
  });

  let infoMessage;
  stub.window.showInformationMessage = async (msg) => { infoMessage = msg; };

  new Interactions().qp('My Notes').install();

  await invoke('hackmd.ui.properties');

  assert.ok(
    infoMessage
    && (infoMessage.includes('No local note data') || infoMessage.includes('No notes found in this scope.'))
  );
  assert.equal(openNoteCalled, false);
  assert.equal(stub.commandsState.executeCalls.length, 0);
});

test('properties: interactive picker cancellation returns without opening', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let openNoteCalled = false;
  stub.setPropertiesProvider({
    async openNote() { openNoteCalled = true; return true; },
  });

  new Interactions().qp(null).install();

  await invoke('hackmd.ui.properties');

  assert.equal(openNoteCalled, false);
  assert.equal(stub.commandsState.executeCalls.length, 0);
});

test('properties: sync-only — getNoteSync called, getNote never called', async () => {
  const model = new MockUiModel();
  let asyncGetNoteTouched = false;
  model.getNote = async () => {
    asyncGetNoteTouched = true;
    return null;
  };
  stub.setModel(model);
  stub.setPropertiesProvider({ async openNote() { return true; } });

  await invoke('hackmd.ui.properties', { type: 'note', note: { id: 'n1', teamPath: null } });

  assert.equal(asyncGetNoteTouched, false);
  assert.equal((model.calls.getNoteSync || []).length, 1);
});

test('properties: team note uses teamPath from args', async () => {
  const model = new MockUiModel();
  stub.setModel(model);

  let openNoteArg;
  stub.setPropertiesProvider({
    async openNote(note) { openNoteArg = note; return true; },
  });

  await invoke('hackmd.ui.properties', { type: 'note', note: { id: 'tn1', teamPath: 'acme' } });

  assert.ok(openNoteArg);
  assert.equal(openNoteArg.id, 'tn1');
  assert.equal(openNoteArg.teamPath, 'acme');
  assert.deepEqual(model.calls.getNoteSync[0], ['tn1', 'acme']);
});
