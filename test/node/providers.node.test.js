const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setMockModel, resetMockModel } = require('./registerProvidersStub');

const { MyNotesProvider } = require('../../out/providers/myNotesProvider');
const { TeamNotesProvider } = require('../../out/providers/teamNotesProvider');
const { HistoryProvider } = require('../../out/providers/historyProvider');

function createEventBus() {
  const listeners = [];
  return {
    on(listener) {
      listeners.push(listener);
      return { dispose() { } };
    },
    emit(payload) {
      for (const listener of [...listeners]) {
        listener(payload);
      }
    },
  };
}

function createMockModel(overrides = {}) {
  const stateBus = createEventBus();
  const entityBus = createEventBus();
  const pendingBus = createEventBus();

  const state = {
    teams: [],
    snapshots: new Map(),
    historyNotes: [],
    teamByPath: new Map(),
    teamById: new Map(),
    notesByScopeAndId: new Map(),
    foldersByScopeAndId: new Map(),
    calls: {
      refreshScope: 0,
      refreshTeams: 0,
      refreshHistory: 0,
    },
  };

  const key = (scope, id) => `${scope ?? '__personal__'}:${id}`;

  const api = {
    onDidChangeState: (listener) => stateBus.on(listener),
    onDidChangeEntity: (listener) => entityBus.on(listener),
    onDidChangePending: (listener) => pendingBus.on(listener),

    refreshScope: async (_args) => {
      state.calls.refreshScope += 1;
    },
    refreshTeams: async () => {
      state.calls.refreshTeams += 1;
    },
    refreshHistory: async () => {
      state.calls.refreshHistory += 1;
    },

    getScopeSnapshotSync: (scope) => state.snapshots.get(scope ?? null) || null,
    getTeams: () => state.teams,
    getTeamByPath: (teamPath) => state.teamByPath.get(teamPath),
    getTeamById: (teamId) => state.teamById.get(teamId),
    getNoteSync: (noteId, scope) => state.notesByScopeAndId.get(key(scope ?? null, noteId)),
    getNoteById: (noteId, scope) => state.notesByScopeAndId.get(key(scope ?? null, noteId)),
    getFolderById: (folderId, scope) => state.foldersByScopeAndId.get(key(scope ?? null, folderId)),
    getHistoryNotes: () => state.historyNotes,
    isMyNotesPendingOperation: () => !!state.myNotesPendingOperation,
    isFolderPendingOperation: () => false,

    __emitState: (payload) => stateBus.emit(payload),
    __emitEntity: (payload) => entityBus.emit(payload),
    __emitPending: (payload) => {
      if (payload?.targetType === 'container' && payload?.container === 'my-notes') {
        state.myNotesPendingOperation = !!payload.pending;
      }
      pendingBus.emit(payload);
    },
    __state: state,
  };

  Object.assign(api, overrides);
  return api;
}

function indexSnapshot(snapshot, scope, modelState) {
  const walk = (folder, parentId = null) => {
    modelState.foldersByScopeAndId.set(`${scope ?? '__personal__'}:${folder.id}`, {
      ...folder,
      parentId,
      teamPath: scope,
    });
    for (const note of folder.notes || []) {
      modelState.notesByScopeAndId.set(`${scope ?? '__personal__'}:${note.id}`, {
        ...note,
        parentFolderId: folder.id,
        teamPath: scope,
      });
    }
    for (const child of folder.children || []) {
      walk(child, folder.id);
    }
  };

  for (const folder of snapshot.rootFolders || []) {
    walk(folder, null);
  }
  for (const note of snapshot.rootNotes || []) {
    modelState.notesByScopeAndId.set(`${scope ?? '__personal__'}:${note.id}`, {
      ...note,
      parentFolderId: null,
      teamPath: scope,
    });
  }
}

test.afterEach(() => {
  resetMockModel();
});

test('provider source files do not directly use API, provider cross-talk, or in-provider command registration', () => {
  const files = [
    path.resolve(__dirname, '../../src/providers/myNotesProvider.ts'),
    path.resolve(__dirname, '../../src/providers/teamNotesProvider.ts'),
    path.resolve(__dirname, '../../src/providers/historyProvider.ts'),
  ];

  const forbiddenPatterns = [
    /from '\.\/api'/,
    /\bAPI\./,
    /\brecordUsage\(/,
    /getMyNotesProvider|getTeamNotesProvider|getHistoryProvider/,
    /registerCommand\(/,
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(content), false, `${path.basename(filePath)} matched forbidden pattern ${pattern}`);
    }
  }
});

test('MyNotesProvider sorts folders before notes and uses deterministic folder/note ordering', async () => {
  const model = createMockModel();

  const snapshot = {
    scope: null,
    rootFolders: [
      { id: 'f2', name: 'Alpha', children: [], notes: [], teamPath: null },
      { id: 'f1', name: 'Alpha', children: [], notes: [], teamPath: null },
    ],
    rootNotes: [
      { id: 'n2', title: 'Beta', teamPath: null, pendingOperation: false },
      { id: 'n1', title: 'Beta', teamPath: null, pendingOperation: false },
    ],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');

  const children = await provider.getChildren();
  assert.deepEqual(children.map((c) => `${c.type}:${c.type === 'folder' ? c.id : c.note.id}`), [
    'folder:f1',
    'folder:f2',
    'note:n1',
    'note:n2',
  ]);
  assert.equal(model.__state.calls.refreshScope, 1);
});

test('MyNotesProvider fires parent refresh when note upsert changes sibling sort order', async () => {
  const model = createMockModel();

  const snapshot = {
    scope: null,
    rootFolders: [],
    rootNotes: [
      { id: 'n1', title: 'B', teamPath: null, pendingOperation: false },
      { id: 'n2', title: 'A', teamPath: null, pendingOperation: false },
    ],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');
  await provider.getChildren();

  const events = [];
  provider.onDidChangeTreeData((e) => events.push(e));

  snapshot.rootNotes[1].title = 'Z';
  const n2 = model.__state.notesByScopeAndId.get('__personal__:n2');
  n2.title = 'Z';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: null, id: 'n2' });

  assert.ok(events.length > 0);
  assert.ok(events.some((e) => e === undefined));
});

test('MyNotesProvider note tree items pass the clicked note object to hackmd.ui.edit', async () => {
  const model = createMockModel();
  const snapshot = {
    scope: null,
    rootFolders: [],
    rootNotes: [
      { id: 'n1', title: 'Note One', teamPath: null, pendingOperation: false },
    ],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');
  const [noteNode] = await provider.getChildren();
  const item = provider.getTreeItem(noteNode);

  assert.equal(item.command.command, 'hackmd.ui.edit');
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode.note }]);
});

test('MyNotesProvider emits pending-state changes without marking tree dirty', async () => {
  const model = createMockModel();
  const snapshot = {
    scope: null,
    rootFolders: [],
    rootNotes: [
      { id: 'n1', title: 'Note One', teamPath: null, pendingOperation: false },
    ],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');

  await provider.getChildren();

  const treeEvents = [];
  const pendingEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));
  provider.onDidChangePendingState((pending) => pendingEvents.push(pending));

  model.__emitPending({
    targetType: 'container',
    container: 'my-notes',
    pending: true,
    scope: null,
    id: null,
  });

  assert.deepEqual(pendingEvents, [true]);
  assert.equal(treeEvents.length, 0);

  model.__emitPending({
    targetType: 'container',
    container: 'my-notes',
    pending: false,
    scope: null,
    id: null,
  });

  assert.deepEqual(pendingEvents, [true, false]);
  assert.equal(treeEvents.length, 0);
});

test('TeamNotesProvider sorts teams and children deterministically with folders before notes', async () => {
  const model = createMockModel();
  const teamA = { id: 't2', path: 'scope-b', name: 'Alpha', pendingOperation: false, rootFolders: [], rootNotes: [] };
  const teamB = { id: 't1', path: 'scope-a', name: 'Alpha', pendingOperation: false, rootFolders: [], rootNotes: [] };

  model.__state.teams = [teamA, teamB];
  model.__state.teamById.set(teamA.id, teamA);
  model.__state.teamById.set(teamB.id, teamB);
  model.__state.teamByPath.set(teamA.path, teamA);
  model.__state.teamByPath.set(teamB.path, teamB);

  const snapshot = {
    scope: 'scope-a',
    rootFolders: [
      { id: 'f2', name: 'Alpha', children: [], notes: [], teamPath: 'scope-a' },
      { id: 'f1', name: 'Alpha', children: [], notes: [], teamPath: 'scope-a' },
    ],
    rootNotes: [
      { id: 'n2', title: 'Beta', teamPath: 'scope-a', pendingOperation: false },
      { id: 'n1', title: 'Beta', teamPath: 'scope-a', pendingOperation: false },
    ],
  };

  model.__state.snapshots.set('scope-a', snapshot);
  indexSnapshot(snapshot, 'scope-a', model.__state);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');

  const teams = await provider.getChildren();
  assert.deepEqual(teams.map((t) => t.team.id), ['t1', 't2']);

  const teamChildren = await provider.getChildren(teams[0]);
  assert.deepEqual(teamChildren.map((c) => `${c.type}:${c.type === 'folder' ? c.id : c.note.id}`), [
    'folder:f1',
    'folder:f2',
    'note:n1',
    'note:n2',
  ]);
});

test('TeamNotesProvider fires parent team refresh when root note sort order changes on upsert', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', pendingOperation: false, rootFolders: [], rootNotes: [] };
  model.__state.teams = [team];
  model.__state.teamById.set(team.id, team);
  model.__state.teamByPath.set(team.path, team);

  const snapshot = {
    scope: 'scope-a',
    rootFolders: [],
    rootNotes: [
      { id: 'n1', title: 'B', teamPath: 'scope-a', pendingOperation: false },
      { id: 'n2', title: 'A', teamPath: 'scope-a', pendingOperation: false },
    ],
  };

  model.__state.snapshots.set('scope-a', snapshot);
  indexSnapshot(snapshot, 'scope-a', model.__state);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');

  const teams = await provider.getChildren();
  await provider.getChildren(teams[0]);

  const events = [];
  provider.onDidChangeTreeData((e) => events.push(e));

  snapshot.rootNotes[1].title = 'Z';
  const n2 = model.__state.notesByScopeAndId.get('scope-a:n2');
  n2.title = 'Z';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: 'scope-a', id: 'n2' });

  assert.ok(events.length > 0);
  assert.ok(events.some((e) => e && e.type === 'team' && e.team.id === 't1'));
});

test('TeamNotesProvider note tree items pass the clicked note object to hackmd.ui.edit', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', pendingOperation: false, rootFolders: [], rootNotes: [] };
  model.__state.teams = [team];
  model.__state.teamById.set(team.id, team);
  model.__state.teamByPath.set(team.path, team);

  const snapshot = {
    scope: 'scope-a',
    rootFolders: [],
    rootNotes: [
      { id: 'n1', title: 'Team Note', teamPath: 'scope-a', pendingOperation: false },
    ],
  };

  model.__state.snapshots.set('scope-a', snapshot);
  indexSnapshot(snapshot, 'scope-a', model.__state);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');
  const [teamNode] = await provider.getChildren();
  const [noteNode] = await provider.getChildren(teamNode);
  const item = provider.getTreeItem(noteNode);

  assert.equal(item.command.command, 'hackmd.ui.edit');
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode.note }]);
});

test('HistoryProvider sorts by lastChangedAt desc then id and refreshes only when order changes', async () => {
  const model = createMockModel();
  model.__state.historyNotes = [
    { id: 'n2', title: 'N2', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'n1', title: 'N1', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
  ];

  setMockModel(model);
  const provider = new HistoryProvider('/tmp');
  const initial = await provider.getChildren();
  assert.deepEqual(initial.map((n) => n.note.id), ['n1', 'n2']);

  const events = [];
  provider.onDidChangeTreeData((e) => events.push(e));

  model.__state.historyNotes[0].title = 'N2 renamed';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: null, id: 'n2' });
  const afterTitleOnly = events.length;

  model.__state.historyNotes[0].lastChangedAt = '2025-01-01T00:00:00.000Z';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: null, id: 'n2' });

  assert.equal(afterTitleOnly, 0);
  assert.ok(events.length > 0);
});

test('HistoryProvider note tree items pass the clicked note object to hackmd.ui.edit', async () => {
  const model = createMockModel();
  model.__state.historyNotes = [
    { id: 'n1', title: 'Recent Note', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
  ];

  setMockModel(model);
  const provider = new HistoryProvider('/tmp');
  const [noteNode] = await provider.getChildren();
  const item = provider.getTreeItem(noteNode);

  assert.equal(item.command.command, 'hackmd.ui.edit');
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode.note }]);
});
