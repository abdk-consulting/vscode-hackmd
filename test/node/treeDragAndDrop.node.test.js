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
    this.calls = {
      toNoteUri: [],
      toFolderUri: [],
      getEntityByUri: [],
      getEntityByUriSync: [],
      getNoteById: [],
      getFolderById: [],
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

  getNoteById(id, teamPath) {
    this.calls.getNoteById.push([id, teamPath ?? null]);
    return this.noteByKey.get(this.key(id, teamPath ?? null));
  }

  getFolderById(id, teamPath) {
    this.calls.getFolderById.push([id, teamPath ?? null]);
    return this.folderByKey.get(this.key(id, teamPath ?? null));
  }

  toNoteUri(note) {
    this.calls.toNoteUri.push([note]);
    return stub.makeUri('hackmd', `/notes/${note.id}`, `noteId=${note.id}${note.teamPath ? `&teamPath=${note.teamPath}` : ''}`);
  }

  toFolderUri(folder) {
    this.calls.toFolderUri.push([folder]);
    return stub.makeUri('hackmd', `/folders/${folder.id}`, `folderId=${folder.id}${folder.teamPath ? `&teamPath=${folder.teamPath}` : ''}`);
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

  controller.handleDrag([{ type: 'note', note }], dataTransfer);

  const raw = await dataTransfer.get('text/uri-list').asString();
  assert.match(raw, /hackmd:\/notes\/n1\?noteId=n1/);
  assert.equal(model.calls.toNoteUri.length, 1);
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
  assert.equal(model.calls.toFolderUri.length, 0);
});

test('handleDrop moves notes into a folder target via unified move command', async () => {
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
  const [commandId, activeItem, selectedItems, target] = stub.commandsState.executeCalls[0];
  assert.equal(commandId, 'hackmd.model.move');
  assert.equal(activeItem.type, 'note');
  assert.equal(selectedItems.length, 1);
  assert.equal(target.folderId, 'dest-folder');
});

test('handleDrop rejects cross-scope note drops with warning', async () => {
  const model = new MockModel();
  const uri = 'hackmd:/notes/n1?noteId=n1&teamPath=acme';

  model.mapUri(uri, { type: 'note', id: 'n1', teamPath: 'acme', folderPaths: [] });
  stub.setModel(model);

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();
  dataTransfer.set('text/uri-list', new stub.vscodeStub.DataTransferItem(uri));

  await controller.handleDrop({ type: 'folder', id: 'dest-folder', teamPath: null }, dataTransfer);

  assert.equal(stub.commandsState.executeCalls.length, 0);
  assert.deepEqual(stub.windowState.warningMessages, ['This note cannot be moved here.']);
});

test('handleDrop filters descendant folder moves before executing unified move', async () => {
  const model = new MockModel();
  const folderUriA = 'hackmd:/folders/f1?folderId=f1';
  const folderUriB = 'hackmd:/folders/f2?folderId=f2';

  model.mapUri(folderUriA, { type: 'folder', id: 'f1', teamPath: null, name: 'Folder One' });
  model.mapUri(folderUriB, { type: 'folder', id: 'f2', teamPath: null, name: 'Folder Two' });
  stub.setModel(model);
  stub.setProviders({
    my: {
      getMoveFolderTargetsFromCache() {
        return [
          { folderId: 'dest', folderPaths: [{ id: 'ancestor', name: 'Ancestor' }, { id: 'dest', name: 'Dest' }] },
        ];
      },
      findNoteInCache() {
        return undefined;
      },
    },
  });

  const controller = new NoteDragAndDropController();
  const dataTransfer = new stub.vscodeStub.DataTransfer();
  dataTransfer.set('text/uri-list', new stub.vscodeStub.DataTransferItem(`${folderUriA}\r\n${folderUriB}`));

  await controller.handleDrop(
    { type: 'folder', id: 'dest', teamPath: null },
    dataTransfer,
  );

  assert.equal(stub.commandsState.executeCalls.length, 1);
  const [, activeItem, selectedItems] = stub.commandsState.executeCalls[0];
  assert.equal(activeItem.id, 'f1');
  assert.deepEqual(selectedItems.map((item) => item.id), ['f1', 'f2']);
});