'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./registerNoteCompletionProviderStub');

const { NoteCompletionProvider } = require('../../out/providers/noteCompletionProvider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal TextDocument mock from an array of line strings.
 */
function makeDocument(lines) {
  return {
    lineAt(lineNumber) {
      return { text: lines[lineNumber] ?? '' };
    },
  };
}

/**
 * Builds a minimal Position mock.
 */
function makePosition(line, character) {
  return { line, character };
}

/**
 * Creates a minimal ModelNote.
 */
function makeNote(overrides = {}) {
  return {
    id: 'note1',
    shortId: 'n1',
    title: 'Test Note',
    teamPath: null,
    userPath: 'user1',
    permalink: null,
    publishLink: 'https://hackmd.io/@user1/note1',
    readPermission: 'guest',
    writePermission: 'guest',
    publishType: 'view',
    ...overrides,
  };
}

/**
 * Creates a scope snapshot (rootFolders + rootNotes).
 */
function makeSnapshot(notes = [], folders = []) {
  return { rootFolders: folders, rootNotes: notes };
}

/**
 * A model mock whose personal / team snapshots can be configured.
 */
class MockModel {
  constructor() {
    this._personal = null;
    this._teams = [];
    this._teamSnapshots = new Map();
  }

  setPersonal(snapshot) {
    this._personal = snapshot;
  }

  addTeam(path, snapshot) {
    this._teams.push({ type: 'team', path });
    if (snapshot !== undefined) {
      this._teamSnapshots.set(path, snapshot);
    }
  }

  getMyNotesEntity() {
    return { type: 'my-notes' };
  }

  getScopeSnapshotSync(scope) {
    if (!scope || scope.type === 'my-notes') {
      return this._personal;
    }
    if (scope.type === 'team') {
      return this._teamSnapshots.get(scope.path) ?? null;
    }
    return null;
  }

  getTeams() {
    return this._teams;
  }
}

/**
 * Invoke provideCompletionItems on a fresh provider for a single-line document.
 */
function complete(line, character, model = null) {
  if (model !== null) {
    stub.setModel(model);
  }
  const provider = new NoteCompletionProvider();
  const doc = makeDocument([line]);
  const pos = makePosition(0, character);
  return provider.provideCompletionItems(doc, pos);
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  stub.resetState();
});

// ===========================================================================
// findOpenBracketIndex — tested indirectly via provideCompletionItems
// ===========================================================================

test('findOpenBracketIndex: returns undefined when line has no bracket', () => {
  const result = complete('hello world', 11);
  assert.equal(result, undefined);
});

test('findOpenBracketIndex: returns undefined when bracket is already closed', () => {
  // "[already]" — cursor is after the closing ], so depth will be 1 when reaching [
  const result = complete('[already]', 9);
  assert.equal(result, undefined);
});

test('findOpenBracketIndex: returns undefined for nested closed brackets', () => {
  // "[[inner]]" — both brackets closed
  const result = complete('[[inner]]', 9);
  assert.equal(result, undefined);
});

test('findOpenBracketIndex: detects open bracket at start of line', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Alpha' })]));
  const items = complete('[', 1, model);
  assert.ok(Array.isArray(items));
  assert.ok(items.length > 0);
});

test('findOpenBracketIndex: detects open bracket after closed pair', () => {
  // "[closed][open" — second [ is unmatched
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Alpha' })]));
  const items = complete('[closed][open', 13, model);
  assert.ok(Array.isArray(items));
});

test('findOpenBracketIndex: correctly skips outer bracket when inner pair is closed', () => {
  // "[[inner]" — inner bracket closed, outer [ remains open
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'inner' })]));
  const items = complete('[[inner]', 8, model);
  assert.ok(Array.isArray(items), 'outer [ should be detected as open');
});

// ===========================================================================
// collectCachedNotes — model initialisation
// ===========================================================================

test('collectCachedNotes: returns [] when model not initialized', () => {
  // No model set → getHackmdModel() throws → provideCompletionItems returns []
  const provider = new NoteCompletionProvider();
  const doc = makeDocument(['[']);
  const pos = makePosition(0, 1);
  const items = provider.provideCompletionItems(doc, pos);
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

test('collectCachedNotes: collects notes from personal scope', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ id: 'p1', title: 'Personal' })]));

  const items = complete('[', 1, model);
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Personal');
});

test('collectCachedNotes: skips personal scope when snapshot is null', () => {
  const model = new MockModel();
  // personal stays null
  model.addTeam('myteam', makeSnapshot([makeNote({ id: 't1', title: 'Team Note', teamPath: 'myteam', userPath: null })]));

  const items = complete('[', 1, model);
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Team Note');
});

test('collectCachedNotes: collects notes from team scope', () => {
  const model = new MockModel();
  model.addTeam('alpha', makeSnapshot([makeNote({ id: 'a1', title: 'Alpha Note', teamPath: 'alpha', userPath: null })]));

  const items = complete('[', 1, model);
  assert.ok(Array.isArray(items));
  assert.equal(items[0].label, 'Alpha Note');
});

test('collectCachedNotes: skips team scope when snapshot is null', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ id: 'p1', title: 'Personal' })]));
  model.addTeam('missing', undefined); // no snapshot registered

  const items = complete('[', 1, model);
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Personal');
});

test('collectCachedNotes: combines notes from personal and multiple team scopes', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ id: 'p1', title: 'Personal' })]));
  model.addTeam('t1', makeSnapshot([makeNote({ id: 'a1', title: 'Team A', teamPath: 't1', userPath: null })]));
  model.addTeam('t2', makeSnapshot([makeNote({ id: 'b1', title: 'Team B', teamPath: 't2', userPath: null })]));

  const items = complete('[', 1, model);
  const titles = items.map((i) => i.label).sort();
  assert.deepEqual(titles, ['Personal', 'Team A', 'Team B']);
});

// ===========================================================================
// Filtering
// ===========================================================================

test('filtering: empty query returns all notes', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([
      makeNote({ id: 'p1', title: 'Alpha' }),
      makeNote({ id: 'p2', title: 'Beta' }),
    ]),
  );

  const items = complete('[', 1, model);
  assert.equal(items.length, 2);
});

test('filtering: matches note by title prefix (case-insensitive)', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([
      makeNote({ id: 'p1', title: 'FooBar' }),
      makeNote({ id: 'p2', title: 'Baz' }),
    ]),
  );

  const items = complete('[foo', 4, model);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'FooBar');
});

test('filtering: matches note by permalink (case-insensitive)', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([
      makeNote({ id: 'p1', title: 'Note A', permalink: 'My-Permalink' }),
      makeNote({ id: 'p2', title: 'Note B', permalink: null }),
    ]),
  );

  const items = complete('[my-perm', 8, model);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Note A');
});

test('filtering: excludes note that matches neither title nor permalink', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({ id: 'p1', title: 'Unrelated', permalink: 'other' })]),
  );

  const items = complete('[zzz', 4, model);
  assert.equal(items.length, 0);
});

test('filtering: query matches in the middle of title', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ id: 'p1', title: 'My Special Note' })]));

  const items = complete('[special', 8, model);
  assert.equal(items.length, 1);
});

test('filtering: uses query starting from character after the open bracket', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([
      makeNote({ id: 'p1', title: 'Alpha' }),
      makeNote({ id: 'p2', title: 'Beta' }),
    ]),
  );

  // "[alp" — only Alpha matches
  const items = complete('prefix [alp', 11, model);
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Alpha');
});

// ===========================================================================
// noteLinkPath
// ===========================================================================

test('noteLinkPath: team note with permalink → /@team/permalink', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: 'myteam',
      userPath: null,
      permalink: 'my-perm',
      publishLink: 'https://hackmd.io/@myteam/my-perm',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/@myteam/my-perm');
});

test('noteLinkPath: team note without permalink uses id → /@team/id', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: 'myteam',
      userPath: null,
      permalink: null,
      publishLink: 'https://hackmd.io/@myteam/id1',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/@myteam/id1');
});

test('noteLinkPath: personal note with userPath and permalink → /@user/permalink', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: null,
      userPath: 'alice',
      permalink: 'alice-perm',
      publishLink: 'https://hackmd.io/@alice/alice-perm',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/@alice/alice-perm');
});

test('noteLinkPath: personal note with userPath, no permalink → /@user/id', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: null,
      userPath: 'alice',
      permalink: null,
      publishLink: 'https://hackmd.io/@alice/id1',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/@alice/id1');
});

test('noteLinkPath: note with no scope → /id', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: null,
      userPath: null,
      permalink: null,
      publishLink: 'https://hackmd.io/id1',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/id1');
});

test('noteLinkPath: note with no scope but permalink → /permalink', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({
      id: 'id1',
      title: 'T',
      teamPath: null,
      userPath: null,
      permalink: 'slug',
      publishLink: 'https://hackmd.io/slug',
    })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/slug');
});

// ===========================================================================
// CompletionItem properties
// ===========================================================================

test('item.insertText is [Title](linkPath)', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({ id: 'id1', title: 'My Note', userPath: 'u', permalink: 'p', publishLink: null })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].insertText, '[My Note](/u/p)');
});

test('item.detail equals the link path', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({ id: 'id1', title: 'N', userPath: 'u', permalink: 'p', publishLink: null })]),
  );

  const items = complete('[', 1, model);
  assert.equal(items[0].detail, '/u/p');
});

test('item.sortText is title.toLowerCase()', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'ZebraNote' })]));

  const items = complete('[', 1, model);
  assert.equal(items[0].sortText, 'zebranote');
});

test('item.filterText starts with "["', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Hello' })]));

  const items = complete('[hel', 4, model);
  assert.ok(items[0].filterText.startsWith('['));
});

test('item.kind is CompletionItemKind.Reference (9)', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'N' })]));

  const items = complete('[', 1, model);
  assert.equal(items[0].kind, 9);
});

test('item.documentation mentions permalink when note has one', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'N', permalink: 'my-perm' })]));

  const items = complete('[', 1, model);
  assert.ok(items[0].documentation.value.includes('my-perm'));
});

test('item.documentation omits permalink line when note has none', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'N', permalink: null })]));

  const items = complete('[', 1, model);
  assert.ok(!items[0].documentation.value.includes('Permalink'));
});

test('item.documentation always includes the link text', () => {
  const model = new MockModel();
  model.setPersonal(
    makeSnapshot([makeNote({ id: 'id1', title: 'N', userPath: 'u', permalink: null, publishLink: null })]),
  );

  const items = complete('[', 1, model);
  assert.ok(items[0].documentation.value.includes('[N](/u/id1)'));
});

// ===========================================================================
// Replace range
// ===========================================================================

test('range: starts at the open bracket column', () => {
  // "prefix [q" — bracket is at index 7
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Query' })]));

  const items = complete('prefix [q', 9, model);
  assert.equal(items.length, 1);
  assert.equal(items[0].range.start.character, 7);
});

test('range: endCharacter equals cursor position when no ] follows', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Note' })]));

  const items = complete('[n', 2, model);
  // cursor at character 2, no ] at position 2
  assert.equal(items[0].range.end.character, 2);
});

test('range: endCharacter is cursor+1 when ] immediately follows cursor', () => {
  // Document is "[n]" — cursor is at character 2, ']' is at index 2
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: 'Note' })]));
  stub.setModel(model);

  const provider = new NoteCompletionProvider();
  const doc = makeDocument(['[n]']);
  const pos = makePosition(0, 2); // cursor between 'n' and ']'
  const items = provider.provideCompletionItems(doc, pos);

  assert.ok(Array.isArray(items) && items.length > 0);
  // charAfterCursor is ']' → endCharacter should be 3
  assert.equal(items[0].range.end.character, 3);
});

// ===========================================================================
// Untitled note title fallback
// ===========================================================================

test('untitled note uses "(Untitled)" as display label', () => {
  const model = new MockModel();
  model.setPersonal(makeSnapshot([makeNote({ title: '' })]));

  const items = complete('[', 1, model);
  assert.equal(items[0].label, '(Untitled)');
});
