const test = require('node:test');
const assert = require('node:assert/strict');

const { HackmdModel } = require('../../out/model/hackmdModel');
const {
  initializeHackmdModel,
  getHackmdModel,
  resetHackmdModelForTests,
} = require('../../out/model');

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function response(data, headers = {}) {
  return { data, headers };
}

class MockHackmdApi {
  constructor() {
    this.calls = {};
    this.delays = {};

    this.teams = [
      { id: 't2', path: 'bar-team', name: 'Bar' },
      { id: 't1', path: 'foo-team', name: 'Foo' },
    ];

    this.personalFolders = [
      { id: 'pf1', name: 'Foo' },
    ];

    this.personalNotes = [
      {
        id: 'pn1',
        title: 'alpha',
        folderPaths: [{ id: 'pf1', path: '/Foo', name: 'Foo' }],
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'pn2',
        title: 'Beta',
        createdAt: '2024-01-02T00:00:00.000Z',
      },
    ];

    this.teamFoldersByPath = {
      'foo-team': [
        { id: 'tf1', name: 'Folder Alpha' },
        { id: 'tf2', name: 'Foo' },
      ],
      'bar-team': [],
    };

    this.teamNotesByPath = {
      'foo-team': [
        {
          id: 'tn1',
          title: 'Team Note One',
          teamPath: 'foo-team',
          folderPaths: [{ id: 'tf2', path: '/Foo', name: 'Foo' }],
        },
        {
          id: 'tn2',
          title: 'Team Note Two',
          teamPath: 'foo-team',
        },
      ],
      'bar-team': [
        {
          id: 'tn3',
          title: 'Bar Intro',
          teamPath: 'bar-team',
        },
      ],
    };

    this.noteContentById = {
      pn1: '# personal content 1',
      pn2: '# personal content 2',
      tn1: '# team content 1',
      tn2: '# team content 2',
      tn3: '# bar content',
    };
  }

  setDelay(method, ms) {
    this.delays[method] = ms;
  }

  async _respond(method, data) {
    this.calls[method] = (this.calls[method] || 0) + 1;
    const delay = this.delays[method] || 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return response(clone(data));
  }

  _findPersonalNote(noteId) {
    return this.personalNotes.find((n) => n.id === noteId);
  }

  _findTeamNote(teamPath, noteId) {
    return (this.teamNotesByPath[teamPath] || []).find((n) => n.id === noteId);
  }

  _findAnyNote(noteId) {
    return this._findPersonalNote(noteId)
      || Object.keys(this.teamNotesByPath)
        .map((teamPath) => this._findTeamNote(teamPath, noteId))
        .find(Boolean)
      || null;
  }

  async getTeams() {
    return this._respond('getTeams', this.teams);
  }

  async getHistory() {
    const combined = [...this.personalNotes];
    for (const teamPath of Object.keys(this.teamNotesByPath)) {
      combined.push(...this.teamNotesByPath[teamPath]);
    }
    return this._respond('getHistory', combined);
  }

  async getNoteList() {
    return this._respond('getNoteList', this.personalNotes);
  }

  async getNote(noteId) {
    const note = this._findAnyNote(noteId);
    if (!note) {
      throw new Error(`Note not found: ${noteId}`);
    }
    return this._respond('getNote', {
      ...note,
      content: this.noteContentById[noteId] || note.content || '',
    });
  }

  async createNote(payload) {
    const id = `pn${this.personalNotes.length + 100}`;
    const note = {
      id,
      title: payload.title || 'Untitled',
      content: payload.content,
      folderPaths: payload.parentFolderId
        ? [{ id: payload.parentFolderId, path: '/', name: this.personalFolders.find((f) => f.id === payload.parentFolderId)?.name || 'Folder' }]
        : undefined,
    };
    this.personalNotes.push(note);
    if (payload.content !== undefined) {
      this.noteContentById[id] = payload.content;
    }
    return this._respond('createNote', note);
  }

  async updateNote(noteId, payload) {
    const note = this._findPersonalNote(noteId);
    if (!note) {
      throw new Error(`Note not found: ${noteId}`);
    }
    Object.assign(note, payload);
    if (payload.parentFolderId !== undefined) {
      note.folderPaths = payload.parentFolderId
        ? [{ id: payload.parentFolderId, path: '/', name: this.personalFolders.find((f) => f.id === payload.parentFolderId)?.name || 'Folder' }]
        : undefined;
    }
    if (payload.content !== undefined) {
      this.noteContentById[noteId] = payload.content;
    }
    return this._respond('updateNote', note);
  }

  async updateNoteContent(noteId, content) {
    return this.updateNote(noteId, { content });
  }

  async deleteNote(noteId) {
    this.personalNotes = this.personalNotes.filter((n) => n.id !== noteId);
    delete this.noteContentById[noteId];
    return this._respond('deleteNote', undefined);
  }

  async getTeamNotes(teamPath) {
    return this._respond('getTeamNotes', this.teamNotesByPath[teamPath] || []);
  }

  async getTeamNote(teamPath, noteId) {
    const note = this._findTeamNote(teamPath, noteId);
    if (!note) {
      throw new Error(`Team note not found: ${teamPath}/${noteId}`);
    }
    return this._respond('getTeamNote', {
      ...note,
      content: this.noteContentById[noteId] || note.content || '',
    });
  }

  async createTeamNote(teamPath, payload) {
    const list = this.teamNotesByPath[teamPath] || (this.teamNotesByPath[teamPath] = []);
    const id = `tn${list.length + 200}`;
    const note = {
      id,
      teamPath,
      title: payload.title || 'Untitled',
      content: payload.content,
      folderPaths: payload.parentFolderId
        ? [{ id: payload.parentFolderId, path: '/', name: this.teamFoldersByPath[teamPath]?.find((f) => f.id === payload.parentFolderId)?.name || 'Folder' }]
        : undefined,
    };
    list.push(note);
    if (payload.content !== undefined) {
      this.noteContentById[id] = payload.content;
    }
    return this._respond('createTeamNote', note);
  }

  async updateTeamNote(teamPath, noteId, payload) {
    const note = this._findTeamNote(teamPath, noteId);
    if (!note) {
      throw new Error(`Team note not found: ${teamPath}/${noteId}`);
    }
    Object.assign(note, payload);
    if (payload.parentFolderId !== undefined) {
      note.folderPaths = payload.parentFolderId
        ? [{ id: payload.parentFolderId, path: '/', name: this.teamFoldersByPath[teamPath]?.find((f) => f.id === payload.parentFolderId)?.name || 'Folder' }]
        : undefined;
    }
    if (payload.content !== undefined) {
      this.noteContentById[noteId] = payload.content;
    }
    return this._respond('updateTeamNote', note);
  }

  async deleteTeamNote(teamPath, noteId) {
    const list = this.teamNotesByPath[teamPath] || [];
    this.teamNotesByPath[teamPath] = list.filter((n) => n.id !== noteId);
    delete this.noteContentById[noteId];
    return this._respond('deleteTeamNote', undefined);
  }

  async getFolders() {
    return this._respond('getFolders', this.personalFolders);
  }

  async createFolder(payload) {
    const id = `pf${this.personalFolders.length + 100}`;
    const folder = { id, name: payload.name, parentFolderId: payload.parentFolderId || null };
    this.personalFolders.push(folder);
    return this._respond('createFolder', folder);
  }

  async getFolder(folderId) {
    const folder = this.personalFolders.find((f) => f.id === folderId);
    if (!folder) {
      throw new Error(`Folder not found: ${folderId}`);
    }
    return this._respond('getFolder', folder);
  }

  async updateFolder(folderId, payload) {
    const folder = this.personalFolders.find((f) => f.id === folderId);
    if (!folder) {
      throw new Error(`Folder not found: ${folderId}`);
    }
    Object.assign(folder, payload);
    return this._respond('updateFolder', folder);
  }

  async deleteFolder(folderId) {
    this.personalFolders = this.personalFolders.filter((f) => f.id !== folderId);
    for (const note of this.personalNotes) {
      if ((note.folderPaths || []).some((fp) => fp.id === folderId)) {
        note.folderPaths = undefined;
      }
    }
    return this._respond('deleteFolder', undefined);
  }

  async getTeamFolders(teamPath) {
    return this._respond('getTeamFolders', this.teamFoldersByPath[teamPath] || []);
  }

  async createTeamFolder(teamPath, payload) {
    const list = this.teamFoldersByPath[teamPath] || (this.teamFoldersByPath[teamPath] = []);
    const id = `tf${list.length + 200}`;
    const folder = { id, name: payload.name, parentFolderId: payload.parentFolderId || null, teamPath };
    list.push(folder);
    return this._respond('createTeamFolder', folder);
  }

  async getTeamFolder(teamPath, folderId) {
    const folder = (this.teamFoldersByPath[teamPath] || []).find((f) => f.id === folderId);
    if (!folder) {
      throw new Error(`Team folder not found: ${teamPath}/${folderId}`);
    }
    return this._respond('getTeamFolder', folder);
  }

  async updateTeamFolder(teamPath, folderId, payload) {
    const folder = (this.teamFoldersByPath[teamPath] || []).find((f) => f.id === folderId);
    if (!folder) {
      throw new Error(`Team folder not found: ${teamPath}/${folderId}`);
    }
    Object.assign(folder, payload);
    return this._respond('updateTeamFolder', folder);
  }

  async deleteTeamFolder(teamPath, folderId) {
    const list = this.teamFoldersByPath[teamPath] || [];
    this.teamFoldersByPath[teamPath] = list.filter((f) => f.id !== folderId);
    for (const note of this.teamNotesByPath[teamPath] || []) {
      if ((note.folderPaths || []).some((fp) => fp.id === folderId)) {
        note.folderPaths = undefined;
      }
    }
    return this._respond('deleteTeamFolder', undefined);
  }
}

function createModelAndApi() {
  const api = new MockHackmdApi();
  const model = new HackmdModel(api);
  return { api, model };
}

test('scope snapshot sync/async loading without model-level team sorting', async () => {
  const { model } = createModelAndApi();

  assert.equal(model.getScopeSnapshotSync(model.getMyNotesEntity()), null);

  const personal = await model.getScopeSnapshot(null);
  assert.equal(personal.scope, null);
  assert.equal(personal.rootFolders[0].name, 'Foo');

  await model.refreshTeams();
  const teamNames = model.getTeams().map((t) => t.name);
  assert.deepEqual(teamNames, ['Bar', 'Foo']);
});

test('dedupes concurrent refreshScope requests by scope', async () => {
  const { api, model } = createModelAndApi();
  api.setDelay('getNoteList', 40);
  api.setDelay('getFolders', 40);

  await Promise.all([
    model.refreshScope({ teamPath: null }),
    model.refreshScope({ teamPath: null }),
    model.getScopeSnapshot(null),
  ]);

  assert.equal(api.calls.getNoteList, 1);
  assert.equal(api.calls.getFolders, 1);
});

test('dedupes concurrent getNote calls and supports sync lookup', async () => {
  const { api, model } = createModelAndApi();
  api.setDelay('getNote', 40);

  assert.equal(model.getNoteSync('pn1', null), null);

  const [n1, n2] = await Promise.all([
    model.getNote('pn1', null),
    model.getNote('pn1', null),
  ]);

  assert.ok(n1);
  assert.strictEqual(n1, n2);
  assert.equal(api.calls.getNote, 1);
  assert.strictEqual(model.getNoteSync('pn1', null), n1);
});

test('supports note content sync/async getters with lazy loading', async () => {
  const { model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  assert.equal(model.getNoteContentSync('pn1', null), null);

  const content = await model.getNoteContent('pn1', null);
  assert.equal(content, '# personal content 1');
  assert.equal(model.getNoteContentSync('pn1', null), '# personal content 1');
});

test('refreshScope(personal) toggles My Notes pending flag and emits pending events', async () => {
  const { api, model } = createModelAndApi();
  api.setDelay('getNoteList', 30);
  api.setDelay('getFolders', 30);

  const pendingEvents = [];
  const d = model.onDidChangePending((event) => pendingEvents.push(event));

  const inflight = model.refreshScope({ teamPath: null });
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(model.isMyNotesPendingOperation(), true);

  await inflight;
  assert.equal(model.isMyNotesPendingOperation(), false);

  const myNotesEvents = pendingEvents.filter((e) => e.entity.type === 'my-notes');
  assert.equal(myNotesEvents.length, 2);
  assert.equal(myNotesEvents[0].pending, true);
  assert.equal(myNotesEvents[1].pending, false);
  d.dispose();
});

test('refreshScope(team) toggles Team Notes container and team pending flags', async () => {
  const { api, model } = createModelAndApi();
  await model.refreshTeams();
  api.setDelay('getTeamNotes', 30);
  api.setDelay('getTeamFolders', 30);

  const pendingEvents = [];
  const d = model.onDidChangePending((event) => pendingEvents.push(event));

  const inflight = model.refreshScope({ teamPath: 'foo-team' });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(model.isTeamNotesPendingOperation(), true);
  assert.equal(model.isTeamPendingOperation('foo-team'), true);

  await inflight;

  assert.equal(model.isTeamNotesPendingOperation(), false);
  assert.equal(model.isTeamPendingOperation('foo-team'), false);

  const teamContainerEvents = pendingEvents.filter((e) => e.entity.type === 'teams');
  const teamEvents = pendingEvents.filter((e) => e.entity.type === 'team' && e.entity.path === 'foo-team');
  assert.equal(teamContainerEvents.length, 2);
  assert.equal(teamContainerEvents[0].pending, true);
  assert.equal(teamContainerEvents[1].pending, false);
  assert.equal(teamEvents.length, 2);
  assert.equal(teamEvents[0].pending, true);
  assert.equal(teamEvents[1].pending, false);
  d.dispose();
});

test('loadNoteContent toggles per-note pending flag and emits pending events', async () => {
  const { api, model } = createModelAndApi();
  await model.refreshScope({ teamPath: null });
  api.setDelay('getNote', 30);

  const pendingEvents = [];
  const d = model.onDidChangePending((event) => pendingEvents.push(event));

  const inflight = model.getNoteContent('pn1', null);
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(model.isNotePendingOperation('pn1', null), true);

  await inflight;

  assert.equal(model.isNotePendingOperation('pn1', null), false);
  const note = model.getNoteById('pn1', null);
  assert.ok(note);

  const noteEvents = pendingEvents.filter((e) => e.entity.type === 'note' && e.entity.id === 'pn1');
  assert.equal(noteEvents.length, 2);
  assert.equal(noteEvents[0].pending, true);
  assert.equal(noteEvents[1].pending, false);
  d.dispose();
});

test('scope list content does not mark note content as loaded', async () => {
  const { api, model } = createModelAndApi();
  api.personalNotes[0].content = '';

  await model.refreshScope({ teamPath: null });

  // Even if list payload includes an empty content string, content is not
  // considered loaded until a full note fetch happens.
  assert.equal(model.getNoteContentSync('pn1', null), null);

  const content = await model.getNoteContent('pn1', null);
  assert.equal(content, '# personal content 1');
  assert.equal(api.calls.getNote, 1);
});

test('scope refresh evicts cached content when lastChangedAt changes', async () => {
  const { api, model } = createModelAndApi();
  api.personalNotes[0].lastChangedAt = '2024-01-01T00:00:00.000Z';

  await model.refreshScope({ teamPath: null });
  await model.getNoteContent('pn1', null);
  assert.equal(model.getNoteContentSync('pn1', null), '# personal content 1');
  assert.equal(api.calls.getNote, 1);

  // Simulate an out-of-band server update reflected by scope refresh metadata.
  api.personalNotes[0].lastChangedAt = '2024-01-03T00:00:00.000Z';
  await model.refreshScope({ teamPath: null });

  assert.equal(model.getNoteContentSync('pn1', null), null);

  const content = await model.getNoteContent('pn1', null);
  assert.equal(content, '# personal content 1');
  assert.equal(api.calls.getNote, 2);
});

test('note/folder/team URI conversion and sync lookup', async () => {
  const { model } = createModelAndApi();

  await model.refreshTeams();
  await model.refreshScope({ teamPath: 'foo-team' });

  const team = model.getTeamByPath('foo-team');
  const teamUri = model.toTeamUri(team);
  assert.strictEqual(model.getEntityByUriSync(teamUri), team);

  const folder = team.rootFolders.find((f) => f.name === 'Foo');
  const folderUri = model.toFolderUri(folder);
  assert.strictEqual(model.getEntityByUriSync(folderUri), folder);

  const note = team.rootNotes.find((n) => n.id === 'tn2');
  const noteUri = model.toNoteUri(note);
  assert.strictEqual(model.getEntityByUriSync(noteUri), note);
});

test('async URI lookup fetches entities not yet loaded', async () => {
  const { api, model } = createModelAndApi();
  const uri = {
    scheme: 'hackmd',
    path: '/Teams/foo-team/Team-Note-One',
    query: 'noteId=tn1&teamPath=foo-team',
    fragment: '',
    toString() {
      return `${this.scheme}:${this.path}?${this.query}`;
    },
  };

  const entity = await model.getEntityByUri(uri);
  assert.ok(entity);
  assert.equal(entity.type, 'note');
  assert.equal(entity.id, 'tn1');
  assert.equal(api.calls.getTeamNote, 1);
});

test('refresh with unchanged personal scope emits no entity events', async () => {
  const { model } = createModelAndApi();
  const entityEvents = [];
  const d1 = model.onDidChangeEntity((event) => entityEvents.push(event));

  await model.refreshScope({ teamPath: null });
  entityEvents.length = 0;

  await model.refreshScope({ teamPath: null });

  assert.equal(entityEvents.length, 0);
  d1.dispose();
});

test('refreshHistory with unchanged data emits no entity events', async () => {
  const { model } = createModelAndApi();
  const entityEvents = [];
  const d1 = model.onDidChangeEntity((event) => entityEvents.push(event));

  await model.refreshHistory();
  entityEvents.length = 0;

  await model.refreshHistory();

  assert.equal(entityEvents.length, 0);
  d1.dispose();
});

test('refreshTeams keeps existing order on reorder-only backend changes and emits no entity events', async () => {
  const { api, model } = createModelAndApi();
  const entityEvents = [];
  const d1 = model.onDidChangeEntity((event) => entityEvents.push(event));

  await model.refreshTeams();
  const initialOrder = model.getTeams().map((t) => t.path);
  assert.deepEqual(initialOrder, ['bar-team', 'foo-team']);

  entityEvents.length = 0;
  api.teams = [
    { id: 't1', path: 'foo-team', name: 'Foo' },
    { id: 't2', path: 'bar-team', name: 'Bar' },
  ];

  await model.refreshTeams();

  const finalOrder = model.getTeams().map((t) => t.path);
  assert.deepEqual(finalOrder, ['bar-team', 'foo-team']);
  assert.equal(entityEvents.length, 0);
  d1.dispose();
});

test('refreshScope keeps existing root note order on reorder-only backend changes and emits no entity events', async () => {
  const { api, model } = createModelAndApi();

  // Make both notes root-level so order can be asserted directly.
  api.personalNotes[0].folderPaths = undefined;

  const entityEvents = [];
  const d1 = model.onDidChangeEntity((event) => entityEvents.push(event));

  await model.refreshScope({ teamPath: null });
  const initialRootOrder = model.getScopeSnapshotSync(model.getMyNotesEntity()).rootNotes.map((n) => n.id);
  assert.deepEqual(initialRootOrder, ['pn1', 'pn2']);

  entityEvents.length = 0;
  api.personalNotes = [api.personalNotes[1], api.personalNotes[0]];

  await model.refreshScope({ teamPath: null });

  const finalRootOrder = model.getScopeSnapshotSync(model.getMyNotesEntity()).rootNotes.map((n) => n.id);
  assert.deepEqual(finalRootOrder, ['pn1', 'pn2']);
  assert.equal(entityEvents.length, 0);
  d1.dispose();
});

test('create, update, move, and delete note workflow', async () => {
  const { model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });

  const created = await model.createNote(model.getMyNotesEntity(), { title: 'New Note', content: '# hello' });
  assert.ok(created.id);

  const renamed = await model.renameNote(created.id, 'Renamed Note');
  assert.equal(renamed.title, 'Renamed Note');

  const moved = await model.moveNote({ noteId: created.id, sourceTeamPath: null, targetTeamPath: 'foo-team' });
  assert.equal(moved.teamPath, 'foo-team');

  await model.deleteNote(moved.id, 'foo-team');
  const deleted = await model.getNote(moved.id, 'foo-team');
  assert.equal(deleted, null);
});

test('createNote skips scope refresh when scope is already loaded', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const getNoteListBefore = api.calls.getNoteList || 0;
  const getFoldersBefore = api.calls.getFolders || 0;

  await model.createNote(model.getMyNotesEntity(), { title: 'No extra refresh' });

  assert.equal(api.calls.getNoteList || 0, getNoteListBefore);
  assert.equal(api.calls.getFolders || 0, getFoldersBefore);
  assert.equal(api.calls.createNote || 0, 1);
});

test('createFolder skips scope refresh when scope is already loaded', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const getNoteListBefore = api.calls.getNoteList || 0;
  const getFoldersBefore = api.calls.getFolders || 0;

  await model.createFolder(model.getMyNotesEntity(), { name: 'No extra refresh' });

  assert.equal(api.calls.getNoteList || 0, getNoteListBefore);
  assert.equal(api.calls.getFolders || 0, getFoldersBefore);
  assert.equal(api.calls.createFolder || 0, 1);
});

test('createFolder under personal parent sets pending on parent folder and updates local placement', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  api.setDelay('createFolder', 30);

  const pendingEvents = [];
  const d = model.onDidChangePending((event) => pendingEvents.push(event));

  const inflight = model.createFolder(model.getFolderById('pf1', null), { name: 'Nested Child' });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(model.isFolderPendingOperation('pf1', null), true);
  assert.equal(model.isMyNotesPendingOperation(), false);

  const created = await inflight;

  assert.equal(model.isFolderPendingOperation('pf1', null), false);
  assert.equal(created.parentId, 'pf1');

  const parent = model.getFolderById('pf1', null);
  assert.ok(parent);
  assert.ok(parent.children.some((child) => child.id === created.id));

  const folderPendingEvents = pendingEvents.filter((event) => event.entity.type === 'folder' && event.entity.id === 'pf1');
  assert.equal(folderPendingEvents.length, 2);
  assert.equal(folderPendingEvents[0].pending, true);
  assert.equal(folderPendingEvents[1].pending, false);

  const myNotesPendingEvents = pendingEvents.filter((event) => event.entity.type === 'my-notes');
  assert.equal(myNotesPendingEvents.length, 0);

  d.dispose();
});

test('createNote under personal parent sets pending on parent folder and updates local placement', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  api.setDelay('createNote', 30);

  const pendingEvents = [];
  const d = model.onDidChangePending((event) => pendingEvents.push(event));

  const inflight = model.createNote(model.getFolderById('pf1', null), { title: 'Nested Note' });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(model.isFolderPendingOperation('pf1', null), true);
  assert.equal(model.isMyNotesPendingOperation(), false);

  const created = await inflight;

  assert.equal(model.isFolderPendingOperation('pf1', null), false);
  assert.equal(created.parentFolderId, 'pf1');

  const parent = model.getFolderById('pf1', null);
  assert.ok(parent);
  assert.ok(parent.notes.some((note) => note.id === created.id));

  const folderPendingEvents = pendingEvents.filter((event) => event.entity.type === 'folder' && event.entity.id === 'pf1');
  assert.equal(folderPendingEvents.length, 2);
  assert.equal(folderPendingEvents[0].pending, true);
  assert.equal(folderPendingEvents[1].pending, false);

  const myNotesPendingEvents = pendingEvents.filter((event) => event.entity.type === 'my-notes');
  assert.equal(myNotesPendingEvents.length, 0);

  d.dispose();
});

test('createNote refreshes unloaded scope in parallel with create call', async () => {
  const { api, model } = createModelAndApi();
  const delayMs = 120;

  api.setDelay('createNote', delayMs);
  api.setDelay('getNoteList', delayMs);
  api.setDelay('getFolders', delayMs);

  const start = Date.now();
  await model.createNote(model.getMyNotesEntity(), { title: 'Parallel note' });
  const elapsedMs = Date.now() - start;

  assert.equal(api.calls.createNote || 0, 1);
  assert.equal(api.calls.getNoteList || 0, 1);
  assert.equal(api.calls.getFolders || 0, 1);
  assert.ok(elapsedMs < (delayMs * 2) - 40, `Expected overlapping refresh/create, got ${elapsedMs}ms`);
});

test('createNote skips team scope refresh when scope is already loaded', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshTeams();
  await model.refreshScope({ teamPath: 'foo-team' });
  const getTeamNotesBefore = api.calls.getTeamNotes || 0;
  const getTeamFoldersBefore = api.calls.getTeamFolders || 0;

  await model.createNote(model.getTeamByPath('foo-team'), { title: 'No extra team refresh' });

  assert.equal(api.calls.getTeamNotes || 0, getTeamNotesBefore);
  assert.equal(api.calls.getTeamFolders || 0, getTeamFoldersBefore);
  assert.equal(api.calls.createTeamNote || 0, 1);
});

test('save/update/move/delete note in loaded personal scope do not refresh scope', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const getNoteListBefore = api.calls.getNoteList || 0;
  const getFoldersBefore = api.calls.getFolders || 0;

  await model.saveNoteContent('pn1', '# changed content', null);
  await model.updateNoteProperties('pn1', { title: 'Changed Title' }, null);
  await model.moveNote({
    noteId: 'pn1',
    sourceTeamPath: null,
    targetTeamPath: null,
    targetParentFolderId: null,
  });

  const created = await model.createNote(model.getMyNotesEntity(), { title: 'Delete me' });
  await model.deleteNote(created.id, null);

  assert.equal(api.calls.getNoteList || 0, getNoteListBefore);
  assert.equal(api.calls.getFolders || 0, getFoldersBefore);
});

test('saveNoteContent with partial PATCH response updates existing note identity', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });

  const originalUpdateNote = api.updateNote.bind(api);
  api.updateNote = async (noteId, payload) => {
    await originalUpdateNote(noteId, payload);
    // Simulate backend returning partial PATCH payload (without id/title).
    return response({ content: payload.content });
  };

  const beforeIds = model.getScopeSnapshotSync(model.getMyNotesEntity()).rootNotes.map((n) => n.id).sort();
  const updated = await model.saveNoteContent('pn2', '# partial response content', null);
  const afterSnapshot = model.getScopeSnapshotSync(model.getMyNotesEntity());
  const afterIds = afterSnapshot.rootNotes.map((n) => n.id).sort();

  assert.equal(updated.id, 'pn2');
  assert.deepEqual(afterIds, beforeIds);
  assert.equal(model.getNoteById('pn2', null)?.content, '# partial response content');
});

test('updateNoteProperties preserves existing fields when partial response has undefined fields', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const before = model.getNoteById('pn1', null);
  assert.ok(before);

  const originalUpdateNote = api.updateNote.bind(api);
  api.updateNote = async (noteId, payload) => {
    await originalUpdateNote(noteId, payload);
    // Simulate a sparse/partial response where some keys are present but undefined.
    return response({
      id: noteId,
      title: undefined,
      shortId: undefined,
      content: undefined,
      writePermission: 'owner',
    });
  };

  const updated = await model.updateNoteProperties('pn1', { writePermission: 'owner' }, null);

  assert.equal(updated.id, 'pn1');
  assert.equal(updated.title, before.title);
  assert.equal(updated.shortId, before.shortId);
  assert.equal(updated.writePermission, 'owner');
});

test('updateNoteProperties applies explicit null/empty values from partial response', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });

  const originalUpdateNote = api.updateNote.bind(api);
  api.updateNote = async (noteId, payload) => {
    await originalUpdateNote(noteId, payload);
    return response({
      id: noteId,
      title: '',
      permalink: null,
      writePermission: undefined,
    });
  };

  const before = model.getNoteById('pn1', null);
  const updated = await model.updateNoteProperties('pn1', { title: 'ignored-by-response' }, null);

  assert.equal(updated.id, 'pn1');
  assert.equal(updated.title, '');
  assert.equal(updated.permalink, null);
  assert.equal(updated.writePermission, before?.writePermission);
});

test('updateNoteProperties treats parentFolderId undefined as unspecified (no change)', async () => {
  const { model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const before = model.getNoteById('pn1', null);
  assert.equal(before?.parentFolderId, 'pf1');

  const updated = await model.updateNoteProperties('pn1', { parentFolderId: undefined }, null);

  assert.equal(updated.parentFolderId, 'pf1');
});

test('updateNoteProperties treats parentFolderId null as explicit clear', async () => {
  const { model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const before = model.getNoteById('pn1', null);
  assert.equal(before?.parentFolderId, 'pf1');

  const updated = await model.updateNoteProperties('pn1', { parentFolderId: null }, null);

  assert.equal(updated.parentFolderId, null);
});

test('createFolder refreshes unloaded scope in parallel with create call', async () => {
  const { api, model } = createModelAndApi();
  const delayMs = 120;

  api.setDelay('createFolder', delayMs);
  api.setDelay('getNoteList', delayMs);
  api.setDelay('getFolders', delayMs);

  const start = Date.now();
  await model.createFolder(model.getMyNotesEntity(), { name: 'Parallel folder' });
  const elapsedMs = Date.now() - start;

  assert.equal(api.calls.createFolder || 0, 1);
  assert.equal(api.calls.getNoteList || 0, 1);
  assert.equal(api.calls.getFolders || 0, 1);
  assert.ok(elapsedMs < (delayMs * 2) - 40, `Expected overlapping refresh/create, got ${elapsedMs}ms`);
});

test('createFolder refreshes unloaded team scope in parallel with create call', async () => {
  const { api, model } = createModelAndApi();
  const delayMs = 120;

  await model.refreshTeams();
  api.setDelay('createTeamFolder', delayMs);
  api.setDelay('getTeamNotes', delayMs);
  api.setDelay('getTeamFolders', delayMs);

  const start = Date.now();
  await model.createFolder(model.getTeamByPath('foo-team'), { name: 'Parallel team folder' });
  const elapsedMs = Date.now() - start;

  assert.equal(api.calls.createTeamFolder || 0, 1);
  assert.equal(api.calls.getTeamNotes || 0, 1);
  assert.equal(api.calls.getTeamFolders || 0, 1);
  assert.ok(elapsedMs < (delayMs * 2) - 40, `Expected overlapping team refresh/create, got ${elapsedMs}ms`);
});

test('createNote marks created content as loaded for instant reads', async () => {
  const { api, model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });
  const created = await model.createNote(model.getMyNotesEntity(), { title: 'Instant Read' });
  const getNoteCallsBeforeRead = api.calls.getNote || 0;

  const content = await model.getNoteContent(created.id, null);

  assert.equal(content, '');
  assert.equal(api.calls.getNote || 0, getNoteCallsBeforeRead);
});

test('model index requires explicit initialization with injected API', async () => {
  resetHackmdModelForTests();
  assert.throws(() => getHackmdModel(), /not initialized/i);

  const api = new MockHackmdApi();
  const model = initializeHackmdModel(api);
  assert.strictEqual(getHackmdModel(), model);

  await model.refreshTeams();
  assert.deepEqual(model.getTeams().map((t) => t.name), ['Bar', 'Foo']);
});
