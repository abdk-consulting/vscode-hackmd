'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerMdFsProviderStub');

const {
  HackMDFsProvider,
  File,
  Directory,
  activate,
  getProvider,
  generateResourceUri,
  generateFolderResourceUri,
} = require('../../out/providers/mdFsProvider');

class MockModel {
  constructor() {
    this.calls = {};
    this.noteByKey = new Map();
    this.contentByKey = new Map();
    this.saveShouldThrow = null;
  }

  _k(noteId, teamPath) {
    return `${teamPath === null ? 'null' : teamPath}:${noteId}`;
  }

  _record(method, args) {
    this.calls[method] = this.calls[method] || [];
    this.calls[method].push(args);
  }

  setNote(note, teamPath = null) {
    this.noteByKey.set(this._k(note.id, teamPath), { ...note, teamPath });
  }

  setContent(noteId, teamPath, content) {
    this.contentByKey.set(this._k(noteId, teamPath), content);
  }

  async getNote(noteId, teamPath) {
    this._record('getNote', [noteId, teamPath]);
    return this.noteByKey.get(this._k(noteId, teamPath || null)) || null;
  }

  async getNoteContent(noteId, teamPath) {
    this._record('getNoteContent', [noteId, teamPath]);
    const key = this._k(noteId, teamPath || null);
    if (!this.contentByKey.has(key)) {
      throw new Error('not found');
    }
    return this.contentByKey.get(key);
  }

  async saveNoteContent(noteId, content, teamPath) {
    this._record('saveNoteContent', [noteId, content, teamPath]);
    if (this.saveShouldThrow) {
      throw this.saveShouldThrow;
    }
    this.setContent(noteId, teamPath || null, content);
    return { id: noteId, content, teamPath: teamPath || null };
  }
}

function callCount(model, method) {
  return (model.calls[method] || []).length;
}

function uriFor(noteId, teamPath = null) {
  const query = teamPath ? `noteId=${noteId}&teamPath=${teamPath}` : `noteId=${noteId}`;
  return stub.makeUri('hackmd', teamPath ? `/Teams/${teamPath}/Note` : '/My Notes/Note', query);
}

const originalConsoleError = console.error;

test.beforeEach(() => {
  stub.resetState();
  console.error = () => { };
});

test.afterEach(() => {
  console.error = originalConsoleError;
});

test('File constructor sets readonly permission when canEdit=false', () => {
  const file = new File('A', false);
  assert.equal(file.type, stub.vscodeStub.FileType.File);
  assert.equal(file.permissions, stub.vscodeStub.FilePermission.Readonly);
});

test('File constructor leaves permission undefined when editable', () => {
  const file = new File('A', true);
  assert.equal(file.permissions, undefined);
});

test('Directory constructor initializes entries map', () => {
  const dir = new Directory('D');
  assert.equal(dir.type, stub.vscodeStub.FileType.Directory);
  assert.equal(dir.entries.size, 0);
});

test('generateResourceUri builds personal note URI with sanitized title', () => {
  const uri = generateResourceUri('N:ote/#1', 'n1', null);
  assert.equal(uri.scheme, 'hackmd');
  assert.equal(uri.path, '/My Notes/N-ote--1');
  assert.ok(uri.query.includes('noteId=n1'));
});

test('generateResourceUri builds team note URI with folder path', () => {
  const uri = generateResourceUri('Roadmap', 'n1', 'acme', [{ id: 'f1', name: 'Sprint/1', clientId: 'c1' }]);
  assert.equal(uri.path, '/Teams/acme/Sprint-1/Roadmap');
  assert.ok(uri.query.includes('noteId=n1'));
  assert.ok(uri.query.includes('teamPath=acme'));
});

test('generateFolderResourceUri includes folderId and teamPath in query', () => {
  const uri = generateFolderResourceUri('Folder', 'f1', 'acme');
  assert.equal(uri.path, '/Teams/acme/Folder');
  assert.ok(uri.query.includes('folderId=f1'));
  assert.ok(uri.query.includes('teamPath=acme'));
});

test('activate registers hackmd filesystem provider and getProvider returns it', () => {
  const context = { subscriptions: { push() { } } };
  activate(context);
  assert.equal(stub.workspaceState.registerFsCalls.length, 1);
  assert.equal(stub.workspaceState.registerFsCalls[0][0], 'hackmd');
  assert.ok(getProvider());
});

test('rename returns early when old and new URIs are identical', async () => {
  const model = new MockModel();
  stub.setModel(model);
  const provider = new HackMDFsProvider();
  const uri = uriFor('n1');

  await provider.rename(uri, uri, { overwrite: false });

  assert.equal(callCount(model, 'getNote'), 0);
});

test('rename rejects when note ids differ', async () => {
  const model = new MockModel();
  stub.setModel(model);
  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.rename(uriFor('n1'), uriFor('n2'), { overwrite: false }),
    (err) => err.code === 'NoPermissions'
  );
});

test('rename rejects when model cannot find source note', async () => {
  const model = new MockModel();
  stub.setModel(model);
  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.rename(uriFor('n1'), stub.makeUri('hackmd', '/My Notes/NewName', 'noteId=n1'), { overwrite: false }),
    (err) => err.code === 'FileNotFound'
  );
});

test('rename emits Deleted and Created events for same note identity', async () => {
  const model = new MockModel();
  model.setNote({ id: 'n1', title: 'Old', content: 'x' }, null);
  stub.setModel(model);

  const provider = new HackMDFsProvider();
  const oldUri = uriFor('n1');
  const newUri = stub.makeUri('hackmd', '/My Notes/NewName', 'noteId=n1');
  const events = [];
  const sub = provider.onDidChangeFile((payload) => events.push(payload));

  await provider.rename(oldUri, newUri, { overwrite: false });

  assert.equal(events.length, 1);
  assert.equal(events[0][0].type, stub.vscodeStub.FileChangeType.Deleted);
  assert.equal(events[0][1].type, stub.vscodeStub.FileChangeType.Created);
  sub.dispose();
});

test('readFile uses model.getNoteContent with teamPath and returns bytes', async () => {
  const model = new MockModel();
  model.setContent('n1', 'acme', '# hello');
  stub.setModel(model);

  const provider = new HackMDFsProvider();
  const bytes = await provider.readFile(uriFor('n1', 'acme'));

  assert.equal(Buffer.from(bytes).toString('utf8'), '# hello');
  assert.deepEqual(model.calls.getNoteContent[0], ['n1', 'acme']);
});

test('readFile throws FileNotFound when model read fails', async () => {
  const model = new MockModel();
  stub.setModel(model);
  const provider = new HackMDFsProvider();

  await assert.rejects(provider.readFile(uriFor('n1')), (err) => err.code === 'FileNotFound');
});

test('stat returns file with note title and content from model', async () => {
  const model = new MockModel();
  model.setNote({ id: 'n1', title: 'MyTitle', content: '# body' }, null);
  stub.setModel(model);

  const provider = new HackMDFsProvider();
  const stat = await provider.stat(uriFor('n1'));

  assert.equal(stat.name, 'MyTitle');
  assert.equal(Buffer.from(stat.data).toString('utf8'), '# body');
  assert.equal(stat.type, stub.vscodeStub.FileType.File);
});

test('stat throws FileNotFound when model cannot resolve note', async () => {
  const model = new MockModel();
  stub.setModel(model);
  const provider = new HackMDFsProvider();

  await assert.rejects(provider.stat(uriFor('n1')), (err) => err.code === 'FileNotFound');
});

test('writeFile throws FileNotFound when URI misses noteId', async () => {
  const provider = new HackMDFsProvider();
  const uri = stub.makeUri('hackmd', '/My Notes/NoId', 'teamPath=acme');

  await assert.rejects(
    provider.writeFile(uri, Buffer.from('x'), { create: false, overwrite: true }),
    (err) => err.code === 'FileNotFound'
  );
});

test('writeFile (personal) sets pending and calls model.saveNoteContent', async () => {
  const model = new MockModel();
  stub.setModel(model);

  const my = stub.createPendingProvider();
  const team = stub.createPendingProvider();
  const history = stub.createPendingProvider();
  stub.setProviders({ myNotesProvider: my, teamNotesProvider: team, historyProvider: history });

  const provider = new HackMDFsProvider();
  const uri = uriFor('n1', null);

  const originalSetImmediate = global.setImmediate;
  global.setImmediate = () => { };
  try {
    await provider.writeFile(uri, Buffer.from('# save'), { create: false, overwrite: true });
  } finally {
    global.setImmediate = originalSetImmediate;
  }

  assert.deepEqual(my.setPendingCalls, ['n1']);
  assert.deepEqual(history.setPendingCalls, ['n1']);
  assert.equal(team.setPendingCalls.length, 0);
  assert.deepEqual(model.calls.saveNoteContent[0], ['n1', '# save', null]);
});

test('writeFile (team) sets team pending and calls model.saveNoteContent with teamPath', async () => {
  const model = new MockModel();
  stub.setModel(model);

  const my = stub.createPendingProvider();
  const team = stub.createPendingProvider();
  const history = stub.createPendingProvider();
  stub.setProviders({ myNotesProvider: my, teamNotesProvider: team, historyProvider: history });

  const provider = new HackMDFsProvider();
  const uri = uriFor('n1', 'acme');

  const originalSetImmediate = global.setImmediate;
  global.setImmediate = () => { };
  try {
    await provider.writeFile(uri, Buffer.from('# team save'), { create: false, overwrite: true });
  } finally {
    global.setImmediate = originalSetImmediate;
  }

  assert.deepEqual(team.setPendingCalls, ['n1']);
  assert.deepEqual(history.setPendingCalls, ['n1']);
  assert.equal(my.setPendingCalls.length, 0);
  assert.deepEqual(model.calls.saveNoteContent[0], ['n1', '# team save', 'acme']);
});

test('writeFile clears pending and throws Unavailable when model save fails', async () => {
  const model = new MockModel();
  model.saveShouldThrow = new Error('network down');
  stub.setModel(model);

  const my = stub.createPendingProvider();
  const team = stub.createPendingProvider();
  const history = stub.createPendingProvider();
  stub.setProviders({ myNotesProvider: my, teamNotesProvider: team, historyProvider: history });

  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.writeFile(uriFor('n1'), Buffer.from('x'), { create: false, overwrite: true }),
    (err) => err.code === 'Unavailable' && String(err.message).includes('network down')
  );

  assert.deepEqual(my.clearPendingCalls, ['n1']);
  assert.deepEqual(team.clearPendingCalls, ['n1']);
  assert.deepEqual(history.clearPendingCalls, ['n1']);
});

test('watch returns disposable', () => {
  const provider = new HackMDFsProvider();
  const disposable = provider.watch(uriFor('n1'));
  assert.equal(typeof disposable.dispose, 'function');
});

test('createDirectory/delete/readDirectory throw not implemented errors', async () => {
  const provider = new HackMDFsProvider();

  assert.throws(() => provider.createDirectory(uriFor('n1')), /not implemented/i);
  assert.throws(() => provider.readDirectory(uriFor('n1')), /not implemented/i);
  assert.throws(() => provider.delete(uriFor('n1'), { recursive: false }), /not implemented/i);
});

test('readFile throws FileNotFound when model is not initialized', async () => {
  stub.clearModel();
  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.readFile(uriFor('n1')),
    (err) => err.code === 'FileNotFound'
  );
});

test('writeFile throws Unavailable when model is not initialized', async () => {
  stub.clearModel();
  const my = stub.createPendingProvider();
  const team = stub.createPendingProvider();
  const history = stub.createPendingProvider();
  stub.setProviders({ myNotesProvider: my, teamNotesProvider: team, historyProvider: history });

  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.writeFile(uriFor('n1'), Buffer.from('x'), { create: false, overwrite: true }),
    (err) => err.code === 'Unavailable'
  );
});

test('stat throws FileNotFound when model is not initialized', async () => {
  stub.clearModel();
  const provider = new HackMDFsProvider();

  await assert.rejects(
    provider.stat(uriFor('n1')),
    (err) => err.code === 'FileNotFound'
  );
});

test('rename throws Unavailable when model is not initialized', async () => {
  stub.clearModel();
  const provider = new HackMDFsProvider();
  const uri = uriFor('n1');
  const newUri = stub.makeUri('hackmd', '/My Notes/NewName', 'noteId=n1');

  await assert.rejects(
    provider.rename(uri, newUri, { overwrite: false }),
    (err) => err.code === 'Unavailable'
  );
});
