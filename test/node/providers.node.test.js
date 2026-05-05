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
      refresh: 0,
    },
    pendingByTarget: new Map(),
  };

  const key = (scope, id) => `${scope ?? '__personal__'}:${id}`;

  const normalizeFolder = (folder, scope, parentId = null) => {
    folder.type = 'folder';
    folder.teamPath = scope;
    folder.parentId = parentId;
    folder.children = folder.children || [];
    folder.notes = folder.notes || [];
    for (const note of folder.notes) {
      note.type = 'note';
      note.teamPath = scope;
      note.parentFolderId = folder.id;
    }
    for (const child of folder.children) {
      normalizeFolder(child, scope, folder.id);
    }
  };

  const normalizeSnapshot = (scope, snapshot) => {
    if (!snapshot) {
      return snapshot;
    }
    snapshot.rootFolders = snapshot.rootFolders || [];
    snapshot.rootNotes = snapshot.rootNotes || [];
    for (const folder of snapshot.rootFolders) {
      normalizeFolder(folder, scope ?? null, null);
    }
    for (const note of snapshot.rootNotes) {
      note.type = 'note';
      note.teamPath = scope ?? null;
      note.parentFolderId = null;
    }
    return snapshot;
  };

  const normalizeEntityEventPayload = (payload) => {
    if (payload?.entity) {
      return payload;
    }

    if (payload?.entityType === 'team' && payload?.id) {
      const team = state.teamById.get(payload.id) || state.teamByPath.get(payload.scope || '');
      if (team) {
        return { entity: { type: 'team', ...team } };
      }
    }

    if (payload?.entityType === 'folder' && payload?.id) {
      const scope = payload.scope ?? null;
      const folder = state.foldersByScopeAndId.get(key(scope, payload.id));
      if (folder) {
        return { entity: { type: 'folder', ...folder } };
      }
    }

    if (payload?.entityType === 'note' && payload?.id) {
      const scope = payload.scope ?? null;
      const note = state.notesByScopeAndId.get(key(scope, payload.id))
        || state.historyNotes.find((candidate) => candidate.id === payload.id);
      if (note) {
        return { entity: { type: 'note', ...note } };
      }
    }

    return payload;
  };

  const normalizePendingEventPayload = (payload) => {
    if (payload?.entity) {
      return payload;
    }

    if (payload?.targetType === 'container' && payload?.container === 'my-notes') {
      return { entity: { type: 'my-notes', id: 'my-notes', label: 'My Notes' }, pending: !!payload.pending };
    }
    if (payload?.targetType === 'container' && payload?.container === 'team-notes') {
      return { entity: { type: 'teams', id: 'teams', label: 'Teams' }, pending: !!payload.pending };
    }
    if (payload?.targetType === 'container' && payload?.container === 'recent-notes') {
      return { entity: { type: 'recent-notes', id: 'recent-notes', label: 'Recent Notes' }, pending: !!payload.pending };
    }

    if (payload?.targetType === 'team' && payload?.scope) {
      const team = state.teamByPath.get(payload.scope);
      if (team) {
        return { entity: { type: 'team', ...team }, pending: !!payload.pending };
      }
    }

    if (payload?.targetType === 'folder' && payload?.id) {
      const scope = payload.scope ?? null;
      const folder = state.foldersByScopeAndId.get(key(scope, payload.id));
      if (folder) {
        return { entity: { type: 'folder', ...folder }, pending: !!payload.pending };
      }
    }

    if (payload?.targetType === 'note' && payload?.id) {
      const scope = payload.scope ?? null;
      const note = state.notesByScopeAndId.get(key(scope, payload.id));
      if (note) {
        return { entity: { type: 'note', ...note }, pending: !!payload.pending };
      }
    }

    return payload;
  };

  const pendingKey = (payload) => {
    const normalized = normalizePendingEventPayload(payload);
    const entity = normalized?.entity;
    if (!entity) {
      return undefined;
    }

    if (entity.type === 'my-notes') {
      return 'container:my-notes';
    }
    if (entity.type === 'teams') {
      return 'container:team-notes';
    }
    if (entity.type === 'recent-notes') {
      return 'container:recent-notes';
    }
    if (entity.type === 'team') {
      return `team:${entity.path}`;
    }
    if (entity.type === 'folder') {
      return `folder:${entity.teamPath ?? '__personal__'}:${entity.id}`;
    }
    if (entity.type === 'note') {
      return `note:${entity.teamPath ?? '__personal__'}:${entity.id}`;
    }
    return undefined;
  };

  const api = {
    onDidChangeEntity: (listener) => entityBus.on(listener),
    onDidChangePending: (listener) => pendingBus.on(listener),

    refresh: async (_entity) => {
      state.calls.refresh += 1;
    },

    getScopeSnapshotSync: (scope) => {
      const scopeKey = !scope || scope.type === 'my-notes' ? null : (scope.type === 'team' ? scope.path : null);
      return normalizeSnapshot(scopeKey ?? null, state.snapshots.get(scopeKey ?? null) || null);
    },
    getMyNotesEntity: () => ({ type: 'my-notes' }),
    getTeamsEntity: () => ({ type: 'teams' }),
    getRecentNotesEntity: () => ({ type: 'recent-notes' }),
    getTeams: () => state.teams.map((team) => ({ type: 'team', ...team })),
    getTeamByPath: (teamPath) => {
      const team = state.teamByPath.get(teamPath);
      return team ? { type: 'team', ...team } : team;
    },
    getTeamById: (teamId) => {
      const team = state.teamById.get(teamId);
      return team ? { type: 'team', ...team } : team;
    },
    getNoteSync: (noteId, scope) => {
      const note = state.notesByScopeAndId.get(key(scope ?? null, noteId));
      return note ? { type: 'note', ...note } : note;
    },
    getNoteById: (noteId, scope) => {
      const note = state.notesByScopeAndId.get(key(scope ?? null, noteId));
      return note ? { type: 'note', ...note } : note;
    },
    getFolderSync: (scope, folderId) => {
      const teamPath = scope?.type === 'team' ? scope.path : null;
      const folder = state.foldersByScopeAndId.get(key(teamPath, folderId));
      return folder ? { type: 'folder', ...folder } : folder;
    },
    getHistoryNotes: () => state.historyNotes.map((note) => ({ type: 'note', ...note })),
    isPending: (entity) => {
      if (entity.type === 'my-notes') return !!state.myNotesPendingOperation;
      if (entity.type === 'teams') return !!state.teamNotesPendingOperation;
      if (entity.type === 'recent-notes') return !!state.recentNotesPendingOperation;
      if (entity.type === 'team') return (state.pendingByTarget.get(`team:${entity.path}`) || 0) > 0;
      if (entity.type === 'folder') return (state.pendingByTarget.get(`folder:${entity.teamPath ?? '__personal__'}:${entity.id}`) || 0) > 0;
      if (entity.type === 'note') return (state.pendingByTarget.get(`note:${entity.teamPath ?? '__personal__'}:${entity.id}`) || 0) > 0;
      return false;
    },

    __emitEntity: (payload) => entityBus.emit(normalizeEntityEventPayload(payload)),
    __emitPending: (payload) => {
      const normalized = normalizePendingEventPayload(payload);
      const entity = normalized?.entity;

      if (entity?.type === 'my-notes') {
        state.myNotesPendingOperation = !!normalized.pending;
      }
      if (entity?.type === 'teams') {
        state.teamNotesPendingOperation = !!normalized.pending;
      }
      if (entity?.type === 'recent-notes') {
        state.recentNotesPendingOperation = !!normalized.pending;
      }
      const key = pendingKey(normalized);
      if (key) {
        if (normalized.pending) {
          state.pendingByTarget.set(key, (state.pendingByTarget.get(key) || 0) + 1);
        } else {
          state.pendingByTarget.delete(key);
        }
      }
      pendingBus.emit(normalized);
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
  assert.deepEqual(children.map((c) => `${c.type}:${c.id}`), [
    'folder:f1',
    'folder:f2',
    'note:n1',
    'note:n2',
  ]);
  assert.equal(model.__state.calls.refresh, 1);
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

test('MyNotesProvider note tree items bind single-click open with preserveFocus', async () => {
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
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode, preserveFocus: true }]);
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

test('MyNotesProvider refreshes folder node on personal folder pending events', async () => {
  const model = createMockModel();
  const folder = { id: 'f1', name: 'Folder One', children: [], notes: [], teamPath: null, pendingOperation: false, clientId: '' };
  const snapshot = {
    scope: null,
    rootFolders: [folder],
    rootNotes: [],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');
  await provider.getChildren();

  const treeEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));

  folder.pendingOperation = true;
  const indexedFolder = model.__state.foldersByScopeAndId.get('__personal__:f1');
  indexedFolder.pendingOperation = true;
  model.__emitPending({
    targetType: 'folder',
    pending: true,
    scope: null,
    id: 'f1',
  });

  assert.equal(treeEvents.length, 1);
  assert.ok(treeEvents[0]);
  assert.equal(treeEvents[0].type, 'folder');
  assert.equal(treeEvents[0].id, 'f1');
});

test('MyNotesProvider updates note TreeItem contextValue across pending toggles', async () => {
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
  const [initialNode] = await provider.getChildren();
  const firstItem = provider.getTreeItem(initialNode);

  snapshot.rootNotes[0].pendingOperation = true;
  const indexedNote = model.__state.notesByScopeAndId.get('__personal__:n1');
  indexedNote.pendingOperation = true;
  model.__emitPending({
    targetType: 'note',
    pending: true,
    scope: null,
    id: 'n1',
  });

  const [updatedNode] = await provider.getChildren();
  const secondItem = provider.getTreeItem(updatedNode);

  assert.notEqual(secondItem, firstItem);
  assert.equal(secondItem.contextValue, 'file-pending');
});

test('MyNotesProvider refreshes folder node on personal folder upsert events', async () => {
  const model = createMockModel();
  const folder = { id: 'f1', name: 'Folder One', children: [], notes: [], teamPath: null, pendingOperation: false };
  const snapshot = {
    scope: null,
    rootFolders: [folder],
    rootNotes: [
      { id: 'n1', title: 'Root Note', teamPath: null, pendingOperation: false },
    ],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');
  await provider.getChildren();

  const treeEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));

  model.__emitEntity({
    entityType: 'folder',
    changeType: 'upsert',
    scope: null,
    id: 'f1',
  });

  assert.equal(treeEvents.length, 1);
  assert.ok(treeEvents[0]);
  assert.equal(treeEvents[0].type, 'folder');
  assert.equal(treeEvents[0].id, 'f1');
});

test('MyNotesProvider folder upsert emits parent refresh only when root sorting changes', async () => {
  const model = createMockModel();
  const folderA = { id: 'f1', name: 'A', children: [], notes: [], teamPath: null, pendingOperation: false };
  const folderB = { id: 'f2', name: 'B', children: [], notes: [], teamPath: null, pendingOperation: false };
  const snapshot = {
    scope: null,
    rootFolders: [folderA, folderB],
    rootNotes: [],
  };

  model.__state.snapshots.set(null, snapshot);
  indexSnapshot(snapshot, null, model.__state);

  setMockModel(model);
  const provider = new MyNotesProvider('/tmp');
  await provider.getChildren();

  const treeEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));

  folderB.name = '0';
  const indexedFolder = model.__state.foldersByScopeAndId.get('__personal__:f2');
  indexedFolder.name = '0';
  model.__emitEntity({
    entityType: 'folder',
    changeType: 'upsert',
    scope: null,
    id: 'f2',
  });

  assert.equal(treeEvents.length, 1);
  assert.equal(treeEvents[0], undefined);
});

test('TeamNotesProvider sorts teams and children deterministically with folders before notes', async () => {
  const model = createMockModel();
  const teamA = { id: 't2', path: 'scope-b', name: 'Alpha', type: 'team', rootFolders: [], rootNotes: [] };
  const teamB = { id: 't1', path: 'scope-a', name: 'Alpha', type: 'team', rootFolders: [], rootNotes: [] };

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
  assert.deepEqual(teams.map((t) => t.id), ['t1', 't2']);

  const teamChildren = await provider.getChildren(teams[0]);
  assert.deepEqual(teamChildren.map((c) => `${c.type}:${c.id}`), [
    'folder:f1',
    'folder:f2',
    'note:n1',
    'note:n2',
  ]);
});

test('TeamNotesProvider fires parent team refresh when root note sort order changes on upsert', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', type: 'team', rootFolders: [], rootNotes: [] };
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
  assert.ok(events.some((e) => e && e.type === 'team' && e.id === 't1'));
});

test('TeamNotesProvider note tree items bind single-click open with preserveFocus', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', type: 'team', rootFolders: [], rootNotes: [] };
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
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode, preserveFocus: true }]);
});

test('TeamNotesProvider emits pending-state changes without marking tree dirty for container transitions', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', type: 'team', rootFolders: [], rootNotes: [] };
  model.__state.teams = [team];
  model.__state.teamById.set(team.id, team);
  model.__state.teamByPath.set(team.path, team);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');
  await provider.getChildren();

  const treeEvents = [];
  const pendingEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));
  provider.onDidChangePendingState((pending) => pendingEvents.push(pending));

  model.__emitPending({
    targetType: 'container',
    container: 'team-notes',
    pending: true,
    scope: null,
    id: null,
  });

  assert.deepEqual(pendingEvents, [true]);
  assert.equal(treeEvents.length, 0);

  model.__emitPending({
    targetType: 'container',
    container: 'team-notes',
    pending: false,
    scope: null,
    id: null,
  });

  assert.deepEqual(pendingEvents, [true, false]);
  assert.equal(treeEvents.length, 0);
});

test('TeamNotesProvider refreshes team node on team pending events', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', type: 'team', rootFolders: [], rootNotes: [] };
  model.__state.teams = [team];
  model.__state.teamById.set(team.id, team);
  model.__state.teamByPath.set(team.path, team);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');
  await provider.getChildren();

  const treeEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));

  team.pendingOperation = true;
  model.__emitPending({
    targetType: 'team',
    pending: true,
    scope: 'scope-a',
    id: 't1',
  });

  assert.equal(treeEvents.length, 1);
  assert.ok(treeEvents[0]);
  assert.equal(treeEvents[0].type, 'team');
  assert.equal(treeEvents[0].id, 't1');
});

test('TeamNotesProvider refreshes folder node on team folder pending events', async () => {
  const model = createMockModel();
  const team = { id: 't1', path: 'scope-a', name: 'Team A', type: 'team', rootFolders: [], rootNotes: [] };
  model.__state.teams = [team];
  model.__state.teamById.set(team.id, team);
  model.__state.teamByPath.set(team.path, team);

  const folder = { id: 'f1', name: 'Folder One', children: [], notes: [], teamPath: 'scope-a', pendingOperation: false, clientId: '' };
  const snapshot = {
    scope: 'scope-a',
    rootFolders: [folder],
    rootNotes: [],
  };

  model.__state.snapshots.set('scope-a', snapshot);
  indexSnapshot(snapshot, 'scope-a', model.__state);

  setMockModel(model);
  const provider = new TeamNotesProvider('/tmp');
  const [teamNode] = await provider.getChildren();
  await provider.getChildren(teamNode);

  const treeEvents = [];
  provider.onDidChangeTreeData((e) => treeEvents.push(e));

  folder.pendingOperation = true;
  const indexedFolder = model.__state.foldersByScopeAndId.get('scope-a:f1');
  indexedFolder.pendingOperation = true;
  model.__emitPending({
    targetType: 'folder',
    pending: true,
    scope: 'scope-a',
    id: 'f1',
  });

  assert.equal(treeEvents.length, 1);
  assert.ok(treeEvents[0]);
  assert.equal(treeEvents[0].type, 'folder');
  assert.equal(treeEvents[0].id, 'f1');
});

test('HistoryProvider sorts by lastChangedAt desc then id and refreshes targeted note when order is unchanged', async () => {
  const model = createMockModel();
  model.__state.historyNotes = [
    { id: 'n2', title: 'N2', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'n1', title: 'N1', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
  ];

  setMockModel(model);
  const provider = new HistoryProvider('/tmp');
  const initial = await provider.getChildren();
  assert.deepEqual(initial.map((n) => n.id), ['n1', 'n2']);

  const events = [];
  provider.onDidChangeTreeData((e) => events.push(e));

  model.__state.historyNotes[0].title = 'N2 renamed';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: null, id: 'n2' });
  const afterTitleOnly = events.length;

  model.__state.historyNotes[0].lastChangedAt = '2025-01-01T00:00:00.000Z';
  model.__emitEntity({ entityType: 'note', changeType: 'upsert', scope: null, id: 'n2' });

  assert.equal(afterTitleOnly, 1);
  assert.ok(events[0]);
  assert.equal(events[0].type, 'note');
  assert.equal(events[0].id, 'n2');
  assert.ok(events.some((event) => event === undefined));
});

test('HistoryProvider note tree items bind single-click open with preserveFocus', async () => {
  const model = createMockModel();
  model.__state.historyNotes = [
    { id: 'n1', title: 'Recent Note', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
  ];

  setMockModel(model);
  const provider = new HistoryProvider('/tmp');
  const [noteNode] = await provider.getChildren();
  const item = provider.getTreeItem(noteNode);

  assert.equal(item.command.command, 'hackmd.ui.edit');
  assert.deepEqual(item.command.arguments, [{ type: 'note', note: noteNode, preserveFocus: true }]);
});

test('HistoryProvider emits pending-state changes around refresh lifecycle', async () => {
  let resolveRefresh;
  const model = createMockModel({
    refresh: async (entity) => {
      model.__state.calls.refresh += 1;
      model.__emitPending({ targetType: 'container', container: 'recent-notes', pending: true });
      await new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      model.__emitPending({ targetType: 'container', container: 'recent-notes', pending: false });
    },
  });

  model.__state.historyNotes = [
    { id: 'n1', title: 'Recent Note', teamPath: null, pendingOperation: false, lastChangedAt: '2024-01-01T00:00:00.000Z' },
  ];

  setMockModel(model);
  const provider = new HistoryProvider('/tmp');
  const pendingEvents = [];
  provider.onDidChangePendingState((pending) => pendingEvents.push(pending));

  provider.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pendingEvents, [true]);
  assert.equal(provider.isPendingOperation(), true);

  resolveRefresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pendingEvents, [true, false]);
  assert.equal(provider.isPendingOperation(), false);
});
