'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerTreeDragAndDropStub');

const { NoteDragAndDropController } = require('../../out/utils/treeDragAndDrop');

class MockModel {
  constructor() {
    this.folderByKey = new Map();
    this.noteByKey = new Map();
    this.entityByUri = new Map();
    this.myNotesEntity = { type: 'my-notes' };
    this.teamByPath = new Map();
    this.calls = {
      toUri: [],
      getEntityByUri: [],
      getEntityByUriSync: [],
      getNoteSync: [],
      getFolderSync: [],
      moveNote: [],
      moveFolder: [],
    };
  }

  key(id, teamPath) {
    return `${teamPath ?? 'null'}:${id}`;
  }

  setNote(note) {
    this.noteByKey.set(this.key(note.id, note.teamPath ?? null), note);
  }

  setFolder(folder) {
    this.folderByKey.set(this.key(folder.id, folder.teamPath ?? null), folder);
  }

  mapUri(uriText, entity) {
    this.entityByUri.set(uriText, entity);
  }

  getMyNotesEntity() {
    return this.myNotesEntity;
  }

  getScopeEntityForItem(item) {
    if (item?.type === 'my-notes') return this.getMyNotesEntity();
    if (item?.type === 'team') {
      if (!this.teamByPath.has(item.path)) {
        this.teamByPath.set(item.path, { type: 'team', id: item.path, path: item.path, name: item.path, rootFolders: [], rootNotes: [] });
      }
      return this.teamByPath.get(item.path);
    }
    if (!item?.teamPath) return this.getMyNotesEntity();
    if (!this.teamByPath.has(item.teamPath)) {
      this.teamByPath.set(item.teamPath, { type: 'team', id: item.teamPath, path: item.teamPath, name: item.teamPath, rootFolders: [], rootNotes: [] });
    }
    return this.teamByPath.get(item.teamPath);
  }

  getNoteSync(scope, id) {
    const teamPath = scope.type === 'team' ? scope.path : null;
    this.calls.getNoteSync.push([id, teamPath]);
    return this.noteByKey.get(this.key(id, teamPath)) || null;
  }

  getFolderSync(scope, id) {
    const teamPath = scope.type === 'team' ? scope.path : null;
    this.calls.getFolderSync.push([id, teamPath]);
    return this.folderByKey.get(this.key(id, teamPath)) || null;
  }

  getImmediateParentContainer(item) {
    if (item.type === 'team') {
      return { type: 'teams' };
    }

    const scope = this.getScopeEntityForItem(item);
    if (item.type === 'folder') {
      if (!item.parentId) {
        return scope;
      }
      return this.getFolderSync(scope, item.parentId) || scope;
    }

    const note = this.getNoteSync(scope, item.id) || item;
    const parentFolderId = note.parentFolderId ?? null;
    if (!parentFolderId) {
      return scope;
    }
    return this.getFolderSync(scope, parentFolderId) || scope;
  }

  async moveNote(note, destination) {
    this.calls.moveNote.push([note, destination]);
    return note;
  }

  async moveFolder(folder, destination) {
    this.calls.moveFolder.push([folder, destination]);
    return folder;
  }

  toUri(entity) {
    this.calls.toUri.push([entity]);
    if (entity.type === 'note') {
      return stub.makeUri('hackmd', `/notes/${entity.id}`, `noteId=${entity.id}${entity.teamPath ? `&teamPath=${entity.teamPath}` : ''}`);
    }
    return stub.makeUri('hackmd', `/folders/${entity.id}`, `folderId=${entity.id}${entity.teamPath ? `&teamPath=${entity.teamPath}` : ''}`);
  }

  async getEntityByUri(uri) {
    this.calls.getEntityByUri.push([uri.toString()]);
    return this.entityByUri.get(uri.toString());
  }

  getEntityByUriSync(uri) {
    this.calls.getEntityByUriSync.push([uri.toString()]);
    return this.entityByUri.get(uri.toString());
  }
}

function makeNote(id, teamPath = null, extra = {}) {
  return {
    id,
    title: id,
    shortId: id,
    teamPath,
    folderPaths: extra.folderPaths || [],
    parentFolderId: extra.parentFolderId,
    ...extra,
  };
}

test.beforeEach(() => {
  stub.resetState();
});

test('handleDrag serializes notes with model note URIs', async () => {
  const model = new MockModel();
  const note = makeNote('n1');
  model.setNote({ type: 'note', ...note, pendingOperation: false });
  stub.setModel(model);

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();

  controller.handleDrag([{ type: 'note', ...note }], dataTransfer);

  const raw = await dataTransfer.get('text/uri-list').asString();
  assert.match(raw, /hackmd:\/notes\/n1\?noteId=n1/);
  assert.equal(model.calls.toUri.length, 1);
});

test('handleDrag ignores folders from mixed scopes', async () => {
  const model = new MockModel();
  stub.setModel(model);

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();

  controller.handleDrag([
    { type: 'folder', id: 'f1', name: 'One', teamPath: null },
    { type: 'folder', id: 'f2', name: 'Two', teamPath: 'acme' },
  ], dataTransfer);

  assert.equal(dataTransfer.get('text/uri-list'), undefined);
  assert.equal(model.calls.toUri.length, 0);
});

test('handleDrop moves notes into a folder target via model moveNote', async () => {
  const model = new MockModel();
  const note = makeNote('n1', null, { parentFolderId: 'from-folder' });
  const uri = 'hackmd:/notes/n1?noteId=n1';

  model.setNote({ type: 'note', ...note, pendingOperation: false });
  model.mapUri(uri, { type: 'note', id: 'n1', teamPath: null, folderPaths: [] });
  stub.setModel(model);
  stub.vscodeStub.window.tabGroups.all = [];

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();
  dataTransfer.set('text/uri-list', new stub.vscodeStub.DataTransferItem(uri));

  await controller.handleDrop({ type: 'folder', id: 'dest-folder', teamPath: null }, dataTransfer);

  assert.equal(stub.commandsState.executeCalls.length, 1);
  assert.equal(stub.commandsState.executeCalls[0][0], 'hackmd.model.move');
  assert.equal(stub.commandsState.executeCalls[0][1].id, 'n1');
  assert.equal(stub.commandsState.executeCalls[0][3].id, 'dest-folder');
  assert.equal(model.calls.moveNote.length, 0);
});

test('handleDrop rejects cross-scope note drops', async () => {
  const model = new MockModel();
  const uri = 'hackmd:/notes/n1?noteId=n1&teamPath=acme';

  model.mapUri(uri, { type: 'note', id: 'n1', teamPath: 'acme', folderPaths: [] });
  stub.setModel(model);

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();
  dataTransfer.set('text/uri-list', new stub.vscodeStub.DataTransferItem(uri));

  await assert.rejects(
    controller.handleDrop({ type: 'folder', id: 'dest-folder', teamPath: null }, dataTransfer),
    /same scope/
  );
});

test('handleDrop rejects moving folders into descendant targets', async () => {
  const model = new MockModel();
  const folderUriA = 'hackmd:/folders/f1?folderId=f1';
  const folderUriB = 'hackmd:/folders/f2?folderId=f2';
  const normalizedFolderUriA = stub.vscodeStub.Uri.parse(folderUriA).toString();
  const normalizedFolderUriB = stub.vscodeStub.Uri.parse(folderUriB).toString();

  const f1 = { type: 'folder', id: 'f1', parentId: null, teamPath: null, name: 'Folder One', children: [], notes: [] };
  const f2 = { type: 'folder', id: 'f2', parentId: null, teamPath: null, name: 'Folder Two', children: [], notes: [] };

  model.mapUri(folderUriA, f1);
  model.mapUri(normalizedFolderUriA, f1);
  model.mapUri(folderUriB, f2);
  model.mapUri(normalizedFolderUriB, f2);
  model.setFolder(f1);
  model.setFolder({ type: 'folder', id: 'dest', parentId: 'f1', teamPath: null, name: 'Dest', children: [], notes: [] });
  stub.setModel(model);

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();
  dataTransfer.set('text/uri-list', new stub.vscodeStub.DataTransferItem(`${folderUriA}\r\n${folderUriB}`));

  await assert.rejects(
    controller.handleDrop(
      { type: 'folder', id: 'dest', parentId: 'f1', teamPath: null },
      dataTransfer,
    ),
    /descendant/
  );
});