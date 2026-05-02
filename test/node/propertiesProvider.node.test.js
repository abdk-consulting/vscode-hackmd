'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerPropertiesProviderStub');

const { NotePropertiesProvider } = require('../../out/providers/propertiesProvider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWebviewView() {
  const messages = [];
  const msgHandlers = [];
  const wv = {
    webview: {
      set options(_v) { },
      get options() { return {}; },
      set html(_v) { },
      get html() { return ''; },
      onDidReceiveMessage(handler) {
        msgHandlers.push(handler);
        return { dispose() { } };
      },
      postMessage(msg) {
        messages.push(msg);
      },
    },
    get messages() { return messages; },
    /** Simulate a message sent from the webview JS side to the extension. */
    sendMessage(data) {
      for (const h of msgHandlers) { h(data); }
    },
  };
  return wv;
}

function makeNote(overrides = {}) {
  return {
    type: 'note',
    id: 'n1',
    title: 'My Note',
    shortId: 'n1',
    teamPath: null,
    readPermission: 'guest',
    writePermission: 'signed_in',
    publishType: 'view',
    permalink: null,
    publishLink: 'https://hackmd.io/@user/n1',
    ...overrides,
  };
}

class MockModel {
  constructor() {
    this.calls = {};
    this.updateNotePropertiesResult = null; // null = resolve, Error instance = reject
  }

  _record(method, args) {
    this.calls[method] = this.calls[method] || [];
    this.calls[method].push(args);
  }

  async updateNoteProperties(noteId, input, teamPath) {
    this._record('updateNoteProperties', [noteId, input, teamPath]);
    if (this.updateNotePropertiesResult instanceof Error) {
      throw this.updateNotePropertiesResult;
    }
  }
}

function callCount(model, method) {
  return (model.calls[method] || []).length;
}

function lastCall(model, method) {
  const calls = model.calls[method] || [];
  return calls[calls.length - 1];
}

/**
 * Create a provider, resolve its webview, and optionally open a note.
 */
async function setup(openNote = null) {
  const extensionUri = stub.makeUri('file', '/extension');
  const provider = new NotePropertiesProvider(extensionUri);
  const wv = makeWebviewView();
  provider.resolveWebviewView(wv, {}, {});

  if (openNote) {
    await provider.openNote(openNote);
    // Clear the accumulated messages from openNote so tests see only subsequent messages
    wv.messages.length = 0;
  }

  return { provider, wv };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  stub.resetState();
});

// ---------------------------------------------------------------------------
// openNote
// ---------------------------------------------------------------------------

test('openNote: sets current note, clears pending changes, posts update', async () => {
  const { provider, wv } = await setup();
  const note = makeNote();

  const result = await provider.openNote(note);

  assert.equal(result, true);
  assert.equal(provider.hasPendingChanges(), false);
  // resolveWebviewView also posts an update (with note=undefined), so take the last one
  const updateMsgs = wv.messages.filter((m) => m.type === 'update');
  const updateMsg = updateMsgs[updateMsgs.length - 1];
  assert.ok(updateMsg, 'should post an update message');
  assert.equal(updateMsg.note.id, 'n1');
});

test('openNote: same note ID with pending changes reopens without warning', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  // Introduce a pending change
  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'my-custom-link' });
  assert.equal(provider.hasPendingChanges(), true);

  let warningShown = false;
  stub.window.showWarningMessage = async () => { warningShown = true; return undefined; };

  // Reopen the same note — should NOT show warning
  const result = await provider.openNote(note);

  assert.equal(warningShown, false);
  assert.equal(result, true);
});

test('openNote: different note + pending changes → Save → returns true', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'changed' });
  assert.equal(provider.hasPendingChanges(), true);

  const model = new MockModel();
  stub.setModel(model);

  stub.window.showWarningMessage = async () => 'Save';

  const note2 = makeNote({ id: 'n2', title: 'Note 2', permalink: null, readPermission: 'guest', writePermission: 'signed_in' });
  const result = await provider.openNote(note2);

  assert.equal(result, true);
  assert.equal(callCount(model, 'updateNoteProperties'), 1);
  // After save+reset the new note should be current
  assert.equal(provider.hasPendingChanges(), false);
});

test('openNote: different note + pending changes → Discard → returns true without saving', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'changed' });

  const model = new MockModel();
  stub.setModel(model);

  stub.window.showWarningMessage = async () => 'Discard';

  const note2 = makeNote({ id: 'n2' });
  const result = await provider.openNote(note2);

  assert.equal(result, true);
  assert.equal(callCount(model, 'updateNoteProperties'), 0);
  assert.equal(provider.hasPendingChanges(), false);
});

test('openNote: different note + pending changes → Cancel → returns false', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'changed' });

  stub.window.showWarningMessage = async () => undefined; // cancelled (closed dialog)

  const note2 = makeNote({ id: 'n2' });
  const result = await provider.openNote(note2);

  assert.equal(result, false);
});

test('openNote: Save fails (model error) → returns false', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'changed' });

  const model = new MockModel();
  const apiErr = new Error('Server error');
  apiErr.response = { status: 500 };
  model.updateNotePropertiesResult = apiErr;
  stub.setModel(model);

  stub.window.showWarningMessage = async () => 'Save';

  const note2 = makeNote({ id: 'n2' });
  const result = await provider.openNote(note2);

  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// hasPendingChanges + _onPropertyChanged
// ---------------------------------------------------------------------------

test('hasPendingChanges: false by default, true after property change', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  assert.equal(provider.hasPendingChanges(), false);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'new-link' });

  assert.equal(provider.hasPendingChanges(), true);
});

test('hasPendingChanges: reverts to false when property restored to original', async () => {
  const note = makeNote({ permalink: 'original' });
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'changed' });
  assert.equal(provider.hasPendingChanges(), true);

  // Restore to original value
  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'original' });
  assert.equal(provider.hasPendingChanges(), false);
});

test('_onPropertyChanged: permission normalization clamps writePermission when read is raised', async () => {
  // note: read=owner, write=guest → read gets raised to guest → write should be clamped to guest
  const note = makeNote({ readPermission: 'owner', writePermission: 'guest' });
  const { provider, wv } = await setup(note);

  // Change readPermission to 'guest' (more permissive than write=guest is fine, but
  // here let's test: change read to 'signed_in' while write='guest'
  // read rank: owner=0, signed_in=1, guest=2; write=guest rank=2
  // read 'signed_in'(rank=1) < write 'guest'(rank=2) → OK, no clamp needed
  // Let's use: read='owner', write='guest'; change write to 'owner' → write(0) < read was owner(0)=equal → no clamp
  // Actually let's test the real clamp: note has read='guest', write='owner', change read to 'owner'
  // read='owner'(0) < write='owner'(0) → equal so no clamp. Let me try:
  // note: read=guest, write=guest; change read to owner(0) < write guest(2) → clamp write to owner

  const note2 = makeNote({ readPermission: 'guest', writePermission: 'guest' });
  const { provider: p2, wv: wv2 } = await setup(note2);

  wv2.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });

  // After clamp: readPermission=owner, writePermission should be clamped to owner too
  const updateMsg = wv2.messages.find((m) => m.type === 'update');
  assert.ok(updateMsg, 'should post update after permission change');
  const pendingChanges = updateMsg.pendingChanges;
  assert.equal(pendingChanges.readPermission, 'owner');
  assert.equal(pendingChanges.writePermission, 'owner');
});

test('_onPropertyChanged: changing value back to original removes it from pending', async () => {
  // When write changes to a value that doesn't trigger clamping and then changes back,
  // that single field leaves pending — without any cross-field side-effects.
  const note = makeNote({ readPermission: 'signed_in', writePermission: 'signed_in' });
  const { provider, wv } = await setup(note);

  // Change writePermission to 'guest' — triggers clamping: read is also clamped to guest
  wv.sendMessage({ type: 'propertyChanged', property: 'writePermission', value: 'guest' });
  assert.equal(provider.hasPendingChanges(), true);

  // Explicitly restore both permissions to their original values
  wv.sendMessage({ type: 'propertyChanged', property: 'writePermission', value: 'signed_in' });
  // writePermission is back to original; readPermission (still 'guest' in pending) is different
  // so there is still a pending change on readPermission
  assert.equal(provider.hasPendingChanges(), true, 'read is still pending after only restoring write');

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'signed_in' });
  // Now both are back to original
  assert.equal(provider.hasPendingChanges(), false);
});

// ---------------------------------------------------------------------------
// cancelEditing
// ---------------------------------------------------------------------------

test('cancelEditing: no pending changes resets state, returns true', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  const result = await provider.cancelEditing();

  assert.equal(result, true);
  const updateMsg = wv.messages.find((m) => m.type === 'update');
  assert.ok(updateMsg);
  assert.equal(updateMsg.note, undefined, 'note should be cleared after reset');
});

test('cancelEditing: pending changes → Save → saves and returns true', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'new-link' });

  const model = new MockModel();
  stub.setModel(model);

  stub.window.showWarningMessage = async () => 'Save';

  const result = await provider.cancelEditing();

  assert.equal(result, true);
  assert.equal(callCount(model, 'updateNoteProperties'), 1);
});

test('cancelEditing: pending changes → Discard → resets without saving', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'new-link' });

  const model = new MockModel();
  stub.setModel(model);

  stub.window.showWarningMessage = async () => 'Discard';

  const result = await provider.cancelEditing();

  assert.equal(result, true);
  assert.equal(callCount(model, 'updateNoteProperties'), 0);
});

test('cancelEditing: pending changes → Cancel → returns false', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'new-link' });

  stub.window.showWarningMessage = async () => undefined;

  const result = await provider.cancelEditing();

  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// updateCurrentNote
// ---------------------------------------------------------------------------

test('updateCurrentNote: matching id updates note and re-renders', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.messages.length = 0;

  const updatedNote = makeNote({ title: 'Updated Title' });
  provider.updateCurrentNote('n1', updatedNote);

  const updateMsg = wv.messages.find((m) => m.type === 'update');
  assert.ok(updateMsg);
  assert.equal(updateMsg.note.title, 'Updated Title');
});

test('updateCurrentNote: non-matching id is ignored', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.messages.length = 0;

  const otherNote = makeNote({ id: 'other' });
  provider.updateCurrentNote('other', otherNote);

  assert.equal(wv.messages.length, 0, 'no messages should be posted for a non-matching id');
});

// ---------------------------------------------------------------------------
// saveCurrentProperties
// ---------------------------------------------------------------------------

test('saveCurrentProperties: no current note returns false', async () => {
  const { provider } = await setup(); // no note opened

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
});

test('saveCurrentProperties: model not initialized shows error and returns false', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });
  // model is not set (stub.clearModel() was called in beforeEach via resetState)

  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(err && err.includes('not connected'), `expected "not connected" in error, got: ${err}`);
});

test('saveCurrentProperties: invalid permalink shows error and returns false', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  // Set an invalid permalink (contains spaces)
  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'invalid permalink!' });

  let err;
  stub.window.showErrorMessage = async (msg) => { err = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(err && err.includes('Permalink'), `expected permalink error, got: ${err}`);
});

test('saveCurrentProperties: success — calls model with correct input and resets', async () => {
  const note = makeNote({ readPermission: 'guest', writePermission: 'signed_in' });
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });

  const model = new MockModel();
  stub.setModel(model);

  const result = await provider.saveCurrentProperties();

  assert.equal(result, true);
  assert.equal(callCount(model, 'updateNoteProperties'), 1);
  const [calledNoteId, calledInput, calledTeamPath] = lastCall(model, 'updateNoteProperties');
  assert.equal(calledNoteId, 'n1');
  assert.equal(calledTeamPath, null);
  assert.ok('readPermission' in calledInput);
  assert.ok('writePermission' in calledInput);
  assert.ok(!('permalink' in calledInput), 'permalink should not be in input when not pending');

  // After success the provider should be reset
  assert.equal(provider.hasPendingChanges(), false);
  // The last 'update' message is from reset() and should have note=undefined
  const updateMsgs = wv.messages.filter((m) => m.type === 'update');
  const lastUpdate = updateMsgs[updateMsgs.length - 1];
  assert.ok(lastUpdate);
  assert.equal(lastUpdate.note, undefined, 'note should be cleared after successful save');
});

test('saveCurrentProperties: includes permalink in input when it is pending', async () => {
  const note = makeNote({ permalink: null });
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'valid-link' });

  const model = new MockModel();
  stub.setModel(model);

  const result = await provider.saveCurrentProperties();

  assert.equal(result, true);
  const [, calledInput] = lastCall(model, 'updateNoteProperties');
  assert.ok('permalink' in calledInput, 'permalink should be in input when it is pending');
  assert.equal(calledInput.permalink, 'valid-link');
});

test('saveCurrentProperties: error 403 shows permission error', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });

  const model = new MockModel();
  const err = new Error('Forbidden');
  err.response = { status: 403 };
  model.updateNotePropertiesResult = err;
  stub.setModel(model);

  let shownError;
  stub.window.showErrorMessage = async (msg) => { shownError = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(shownError && shownError.includes('permission'), `expected permission error, got: ${shownError}`);
});

test('saveCurrentProperties: error 409 shows permalink conflict error', async () => {
  const note = makeNote({ permalink: null });
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'taken-link' });

  const model = new MockModel();
  const err = new Error('Conflict');
  err.response = { status: 409 };
  model.updateNotePropertiesResult = err;
  stub.setModel(model);

  let shownError;
  stub.window.showErrorMessage = async (msg) => { shownError = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(shownError && shownError.includes('permalink'), `expected permalink conflict error, got: ${shownError}`);
});

test('saveCurrentProperties: error 400 shows invalid permalink error', async () => {
  const note = makeNote({ permalink: null });
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'permalink', value: 'valid-format' });

  const model = new MockModel();
  const err = new Error('Bad Request');
  err.response = { status: 400 };
  model.updateNotePropertiesResult = err;
  stub.setModel(model);

  let shownError;
  stub.window.showErrorMessage = async (msg) => { shownError = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(shownError && shownError.includes('Invalid permalink'), `expected invalid permalink error, got: ${shownError}`);
});

test('saveCurrentProperties: generic error shows message with error text', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });

  const model = new MockModel();
  const err = new Error('Network timeout');
  model.updateNotePropertiesResult = err;
  stub.setModel(model);

  let shownError;
  stub.window.showErrorMessage = async (msg) => { shownError = msg; };

  const result = await provider.saveCurrentProperties();

  assert.equal(result, false);
  assert.ok(shownError && shownError.includes('Network timeout'), `expected generic error text, got: ${shownError}`);
});

test('saveCurrentProperties: _isSaving guard prevents concurrent saves', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.sendMessage({ type: 'propertyChanged', property: 'readPermission', value: 'owner' });

  const model = new MockModel();
  // Slow save — we'll interleave a second call
  let resolveSave;
  model.updateNoteProperties = async (...args) => {
    model._record('updateNoteProperties', args);
    await new Promise((res) => { resolveSave = res; });
  };
  stub.setModel(model);

  const first = provider.saveCurrentProperties();
  // Second call while first is in flight
  const second = provider.saveCurrentProperties();

  resolveSave();
  await first;
  const secondResult = await second;

  assert.equal(callCount(model, 'updateNoteProperties'), 1, 'model should be called only once');
  assert.equal(secondResult, false);
});

// ---------------------------------------------------------------------------
// Webview messages — copyShareUrl + ready
// ---------------------------------------------------------------------------

test('copyShareUrl: copies url to clipboard and shows status bar message', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  let statusBarMsg;
  stub.window.setStatusBarMessage = (msg) => { statusBarMsg = msg; return { dispose() { } }; };

  wv.sendMessage({ type: 'copyShareUrl', url: 'https://hackmd.io/share/abc' });

  // Allow any microtask/promise inside the handler to flush
  await new Promise((res) => setImmediate(res));

  assert.equal(stub.clipboardCalls[0], 'https://hackmd.io/share/abc');
  assert.ok(statusBarMsg && statusBarMsg.includes('copied'), `expected status bar msg, got: ${statusBarMsg}`);
});

test('ready: triggers full render of current note', async () => {
  const note = makeNote();
  const { provider, wv } = await setup(note);

  wv.messages.length = 0;
  wv.sendMessage({ type: 'ready' });

  const updateMsg = wv.messages.find((m) => m.type === 'update');
  assert.ok(updateMsg, 'should post update on ready');
  assert.equal(updateMsg.note.id, 'n1');
});
