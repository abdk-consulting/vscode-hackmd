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
      { id: 't2', path: 'tornado', name: 'Tornado' },
      { id: 't1', path: 'abdk', name: 'ABDK' },
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
      abdk: [
        { id: 'tf1', name: 'Babylon Labs' },
        { id: 'tf2', name: 'Foo' },
      ],
      tornado: [],
    };

    this.teamNotesByPath = {
      abdk: [
        {
          id: 'tn1',
          title: 'Processing Sensitive Information',
          teamPath: 'abdk',
          folderPaths: [{ id: 'tf2', path: '/Foo', name: 'Foo' }],
        },
        {
          id: 'tn2',
          title: 'Glow Notes',
          teamPath: 'abdk',
        },
      ],
      tornado: [
        {
          id: 'tn3',
          title: 'Tornado Intro',
          teamPath: 'tornado',
        },
      ],
    };

    this.noteContentById = {
      pn1: '# personal content 1',
      pn2: '# personal content 2',
      tn1: '# team content 1',
      tn2: '# team content 2',
      tn3: '# tornado content',
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

test('scope snapshot sync/async loading and team sorting', async () => {
  const { model } = createModelAndApi();

  assert.equal(model.getScopeSnapshotSync(null), null);

  const personal = await model.getScopeSnapshot(null);
  assert.equal(personal.scope, null);
  assert.equal(personal.rootFolders[0].name, 'Foo');

  await model.refreshTeams();
  const teamNames = model.getTeams().map((t) => t.name);
  assert.deepEqual(teamNames, ['ABDK', 'Tornado']);
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

test('note/folder/team URI conversion and sync lookup', async () => {
  const { model } = createModelAndApi();

  await model.refreshTeams();
  await model.refreshScope({ teamPath: 'abdk' });

  const team = model.getTeamByPath('abdk');
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
    path: '/Teams/abdk/Processing',
    query: 'noteId=tn1&teamPath=abdk',
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

test('refresh with unchanged data does not emit upsert events', async () => {
  const { model } = createModelAndApi();
  const events = [];
  const disposable = model.onDidChangeEntity((event) => events.push(event));

  await model.refreshScope({ teamPath: null });
  events.length = 0;

  await model.refreshScope({ teamPath: null });

  assert.equal(events.length, 0);
  disposable.dispose();
});

test('create, update, move, and delete note workflow', async () => {
  const { model } = createModelAndApi();

  await model.refreshScope({ teamPath: null });

  const created = await model.createNote({ title: 'New Note', content: '# hello' });
  assert.ok(created.id);

  const renamed = await model.renameNote(created.id, 'Renamed Note');
  assert.equal(renamed.title, 'Renamed Note');

  const moved = await model.moveNote({ noteId: created.id, sourceTeamPath: null, targetTeamPath: 'abdk' });
  assert.equal(moved.teamPath, 'abdk');

  await model.deleteNote(moved.id, 'abdk');
  const deleted = await model.getNote(moved.id, 'abdk');
  assert.equal(deleted, null);
});

test('model index requires explicit initialization with injected API', async () => {
  resetHackmdModelForTests();
  assert.throws(() => getHackmdModel(), /not initialized/i);

  const api = new MockHackmdApi();
  const model = initializeHackmdModel(api);
  assert.strictEqual(getHackmdModel(), model);

  await model.refreshTeams();
  assert.deepEqual(model.getTeams().map((t) => t.name), ['ABDK', 'Tornado']);
});
