const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readPackageJson() {
  const filePath = path.resolve(__dirname, '../../package.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getContextMenuEntries(pkg) {
  return pkg.contributes?.menus?.['view/item/context'] || [];
}

function getViewTitleEntries(pkg) {
  return pkg.contributes?.menus?.['view/title'] || [];
}

function getKeybindings(pkg) {
  return pkg.contributes?.keybindings || [];
}

function findContextEntry(entries, command, group) {
  return entries.find((entry) => entry.command === command && entry.group === group);
}

test('note context menu keeps Duplicate -> Export -> Delete ordering', () => {
  const pkg = readPackageJson();
  const entries = getContextMenuEntries(pkg);

  const duplicate = findContextEntry(entries, 'hackmd.model.duplicateNote', '2_noteActions@4');
  const exportEntry = findContextEntry(entries, 'hackmd.ui.export', '2_noteActions@5');
  const deleteEntry = findContextEntry(entries, 'hackmd.model.delete', '9_noteDanger@1');

  assert.ok(duplicate, 'Duplicate menu item must exist at 2_noteActions@4');
  assert.ok(exportEntry, 'Export menu item must exist at 2_noteActions@5');
  assert.ok(deleteEntry, 'Delete menu item must exist at 9_noteDanger@1');

  assert.match(exportEntry.when || '', /viewItem\s*==\s*file/);
});

test('folder context menu groups remain in requested order', () => {
  const pkg = readPackageJson();
  const entries = getContextMenuEntries(pkg);

  const expected = [
    ['hackmd.model.createNote', '1_folderMain@1'],
    ['hackmd.model.createFolder', '1_folderMain@2'],
    ['hackmd.ui.openOnHackMD', '1_folderMain@3'],
    ['hackmd.model.rename', '2_folderManage@1'],
    ['hackmd.model.move', '2_folderManage@2'],
    ['hackmd.ui.import', '2_folderManage@3'],
    ['hackmd.ui.export', '2_folderManage@4'],
    ['hackmd.model.delete', '3_folderDanger@1'],
  ];

  for (const [command, group] of expected) {
    const entry = findContextEntry(entries, command, group);
    assert.ok(entry, `Expected ${command} in group ${group}`);
  }
});

test('folder Open on HackMD is available only for folders with client IDs', () => {
  const pkg = readPackageJson();
  const entries = getContextMenuEntries(pkg);
  const entry = findContextEntry(entries, 'hackmd.ui.openOnHackMD', '1_folderMain@3');

  assert.ok(entry, 'Expected hackmd.ui.openOnHackMD in group 1_folderMain@3');
  assert.match(entry.when || '', /viewItem\s*==\s*folder/);
  assert.match(entry.when || '', /viewItem\s*==\s*folder-pending/);
  assert.doesNotMatch(entry.when || '', /folder-no-client-id/);
});

test('team refresh command title remains Refresh', () => {
  const pkg = readPackageJson();
  const refreshTeamCommand = (pkg.contributes?.commands || []).find((command) => command.command === 'hackmd.model.refreshTeam');

  assert.ok(refreshTeamCommand, 'hackmd.model.refreshTeam command must exist');
  assert.equal(refreshTeamCommand.title, 'Refresh');
});

test('team export is only available for loaded team nodes', () => {
  const pkg = readPackageJson();
  const entries = getContextMenuEntries(pkg);
  const teamExportEntry = findContextEntry(entries, 'hackmd.ui.export', '2_teamTransfer@2');

  assert.ok(teamExportEntry, 'Team export menu item must exist at 2_teamTransfer@2');
  assert.match(teamExportEntry.when || '', /view\s*==\s*hackmd\.tree\.team-notes/);
  assert.match(teamExportEntry.when || '', /viewItem\s*==\s*team-loaded/);
  assert.doesNotMatch(teamExportEntry.when || '', /viewItem\s*==\s*team\s*\|\|/);
});

test('My Notes title Import button uses scoped importMyNotes command', () => {
  const pkg = readPackageJson();
  const entries = getViewTitleEntries(pkg);
  const myNotesImport = entries.find(
    (entry) => entry.command === 'hackmd.ui.importMyNotes' && entry.group === 'navigation@3'
  );

  assert.ok(myNotesImport, 'Expected hackmd.ui.importMyNotes in view/title navigation@3');
  assert.match(myNotesImport.when || '', /view\s*=~\s*\/hackmd\.tree\.my-notes\//);
});

test('tree keybindings keep note and folder scopes consistent', () => {
  const pkg = readPackageJson();
  const keybindings = getKeybindings(pkg);

  const createMyFolder = keybindings.find((entry) => entry.command === 'hackmd.model.createMyFolder' && entry.key === 'f');
  const createFolder = keybindings.find((entry) => entry.command === 'hackmd.model.createFolder' && entry.key === 'f');
  const rename = keybindings.find((entry) => entry.command === 'hackmd.model.rename' && entry.key === 'r');
  const duplicate = keybindings.find((entry) => entry.command === 'hackmd.model.duplicateNote' && entry.key === 'd');
  const properties = keybindings.find((entry) => entry.command === 'hackmd.ui.properties' && entry.key === 'p');

  assert.ok(createMyFolder, 'Expected hackmd.model.createMyFolder keybinding on "f"');
  assert.ok(createFolder, 'Expected hackmd.model.createFolder keybinding on "f"');
  assert.ok(rename, 'Expected hackmd.model.rename keybinding on "r"');
  assert.ok(duplicate, 'Expected hackmd.model.duplicateNote keybinding on "d"');
  assert.ok(properties, 'Expected hackmd.ui.properties keybinding on "p"');

  assert.match(createMyFolder.when || '', /focusedView\s*==\s*hackmd\.tree\.my-notes/);
  assert.match(createFolder.when || '', /focusedView\s*==\s*hackmd\.tree\.team-notes/);
  assert.match(rename.when || '', /focusedView\s*==\s*hackmd\.tree\.my-notes|focusedView\s*==\s*hackmd\.tree\.team-notes|focusedView\s*==\s*hackmd\.tree\.recent-notes/);
  assert.match(duplicate.when || '', /focusedView\s*==\s*hackmd\.tree\.my-notes|focusedView\s*==\s*hackmd\.tree\.team-notes|focusedView\s*==\s*hackmd\.tree\.recent-notes/);
  assert.match(properties.when || '', /focusedView\s*==\s*hackmd\.tree\.my-notes|focusedView\s*==\s*hackmd\.tree\.team-notes|focusedView\s*==\s*hackmd\.tree\.recent-notes/);
});
