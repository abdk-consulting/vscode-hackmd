'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerTreeViewCommandsStub');

const fakeContext = {
  subscriptions: { push() { } },
};

const { registerTreeViewCommands } = require('../../out/commands/treeView');
registerTreeViewCommands(fakeContext);

async function invoke(commandId, ...args) {
  const handler = stub.registeredHandlers.get(commandId);
  if (!handler) {
    throw new Error(`Command not registered: ${commandId}`);
  }
  return handler(...args);
}

test.beforeEach(() => {
  stub.resetState();
});

test('treeView.createMyNotes delegates to model create + ui edit', async () => {
  stub.setExecuteResult('hackmd.model.createNote', { id: 'new-note-1' });

  await invoke('treeView.createMyNotes');

  assert.equal(stub.commandsState.executeCalls.length, 2);
  assert.deepEqual(stub.commandsState.executeCalls[0], ['hackmd.model.createNote', { teamPath: null }]);
  assert.deepEqual(stub.commandsState.executeCalls[1], ['hackmd.ui.edit', { noteId: 'new-note-1', teamPath: null }]);
});

test('treeView.importMyNotes delegates to ui import command', async () => {
  await invoke('treeView.importMyNotes');

  assert.equal(stub.commandsState.executeCalls.length, 1);
  assert.deepEqual(stub.commandsState.executeCalls[0], ['hackmd.ui.import', { teamPath: null, parentFolderId: null }]);
});

test('HackMD.folder.createFolder delegates model folder create for model-backed my notes nodes', async () => {
  const folderNode = {
    type: 'folder',
    source: 'model',
    id: 'folder-parent-1',
    name: 'Parent',
    teamPath: null,
  };

  await invoke('HackMD.folder.createFolder', folderNode);

  assert.equal(stub.commandsState.executeCalls.length, 1);
  assert.deepEqual(stub.commandsState.executeCalls[0], ['hackmd.model.createFolder', { teamPath: null, parentFolderId: 'parent-1' }]);
});

test('HackMD.moveNoteTo with explicit target delegates model note move for model note nodes', async () => {
  const node = {
    type: 'note',
    note: {
      type: 'note',
      id: 'n1',
      teamPath: null,
      folderPaths: [],
    },
  };

  await invoke(
    'HackMD.moveNoteTo',
    node,
    [node],
    {
      folderId: 'dest',
      folderPaths: [{ id: 'dest', name: 'Dest' }],
      teamPath: null,
    }
  );

  const moveCall = stub.commandsState.executeCalls.find((entry) => entry[0] === 'hackmd.model.moveNote');
  assert.ok(moveCall, 'Expected hackmd.model.moveNote to be called');
  assert.deepEqual(moveCall, [
    'hackmd.model.moveNote',
    {
      noteId: 'n1',
      sourceTeamPath: null,
      targetTeamPath: null,
      targetParentFolderId: 'dest',
    },
  ]);
});
