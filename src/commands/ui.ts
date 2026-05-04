import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  getMyNotesProvider,
  getMyNotesTreeView,
  getPropertiesProvider,
  getTeamNotesProvider,
  getTeamNotesTreeView
} from '../extension';
import { getHackmdModel, ModelFolder, ModelNote, ModelScope } from '../model';
import { pickCreateLocation } from './model';
import { collectNotes, pickEntity, pickNote } from './pickers';

// ---------------------------------------------------------------------------
// Internal guard
// ---------------------------------------------------------------------------

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    vscode.window.showErrorMessage('HackMD is not connected. Please configure your API key first.');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// VS Code UI helpers
// ---------------------------------------------------------------------------

async function openEditor(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.One,
  });
}

async function openPreview(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

async function openSideBySide(uri: vscode.Uri): Promise<void> {
  await openEditor(uri);
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function sanitizePathSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled';
}

function getUniqueMarkdownFileName(baseName: string, usedNames: Set<string>): string {
  const safe = sanitizePathSegment(baseName);
  let index = 1;
  let candidate = `${safe}.md`;
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${safe} (${index}).md`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function getUsedNamesForDirectory(uri: vscode.Uri): Promise<Set<string>> {
  const usedNames = new Set<string>();
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name] of entries) {
      usedNames.add(name.toLowerCase());
    }
  } catch {
    // Directory may not exist yet; callers create it first.
  }
  return usedNames;
}

function findFolderById(rootFolders: readonly ModelFolder[], folderId: string): ModelFolder | undefined {
  for (const folder of rootFolders) {
    if (folder.id === folderId) {
      return folder;
    }
    const found = findFolderById(folder.children, folderId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function exportFolderRecursive(
  model: ReturnType<typeof getHackmdModel>,
  folder: ModelFolder,
  destParentUri: vscode.Uri
): Promise<number> {
  const dirUri = vscode.Uri.joinPath(destParentUri, sanitizePathSegment(folder.name || 'Folder'));
  await vscode.workspace.fs.createDirectory(dirUri);

  const usedNames = await getUsedNamesForDirectory(dirUri);
  const noteJobs = folder.notes.map((note) => {
    const fileName = getUniqueMarkdownFileName(note.title || note.shortId || 'Untitled', usedNames);
    return (async () => {
      const content = await model.getNoteContent(note.id, folder.teamPath);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dirUri, fileName),
        Buffer.from(content ?? '', 'utf8')
      );
      return 1;
    })();
  });

  const childJobs = folder.children.map((child) => exportFolderRecursive(model, child, dirUri));
  const counts = await Promise.all([...noteJobs, ...childJobs]);
  return counts.reduce((sum, value) => sum + value, 0);
}

// ---------------------------------------------------------------------------
// Tree node helpers (mirrored from model.ts — no shared module to avoid coupling)
// ---------------------------------------------------------------------------

function extractNote(node: any): any | undefined {
  if (!node) { return undefined; }
  if (node.type === 'note' && node.note) { return node.note; }
  if (node.id && node.type !== 'folder' && node.type !== 'team' && node.team === undefined) { return node; }
  return undefined;
}

function extractFolderWebContext(node: any): { folderId?: string; teamPath: string | null } | undefined {
  if (!node || node.type !== 'folder') {
    return undefined;
  }

  const rawFolderId = node.value?.context?.folderClientId
    || node.value?.context?.folderId
    || node.folderClientId
    || node.clientId
    || node.id;

  if (!rawFolderId) {
    return undefined;
  }

  const folderId = String(rawFolderId).startsWith('folder-')
    ? String(rawFolderId).slice('folder-'.length)
    : String(rawFolderId);

  return {
    folderId,
    teamPath: (node.value?.context?.teamPath || node.teamPath || null) as string | null,
  };
}

function extractScopeContext(node: any): { teamPath?: string | null; parentFolderId?: string } {
  if (!node) { return {}; }
  if (
    node?.container === 'my-notes'
    || node?.containerId === 'my-notes'
    || node?.id === 'my-notes'
    || node?.viewId === 'hackmd.tree.my-notes'
  ) {
    return { teamPath: null };
  }
  if (node.team !== undefined) { return { teamPath: node.team?.path ?? null }; }
  if (node.type === 'folder') { return { teamPath: node.teamPath ?? null, parentFolderId: node.id }; }
  const note = extractNote(node);
  if (note) { return { teamPath: note.teamPath ?? null }; }
  return {};
}

function toFolderTreeNode(folder: ModelFolder, teamPath: string | null): any {
  return {
    type: 'folder',
    source: 'model',
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    clientId: folder.clientId || '',
    teamPath,
    children: folder.children,
    notes: folder.notes,
  };
}

type RevealTarget =
  | { targetType: 'team'; teamPath: string }
  | { targetType: 'folder'; folderId: string; teamPath: ModelScope }
  | { targetType: 'note'; noteId: string; teamPath: ModelScope };

type RevealQuickPickItem = vscode.QuickPickItem & RevealTarget;

function extractRevealTarget(node: any): RevealTarget | undefined {
  if (node?.team?.path) {
    return { targetType: 'team', teamPath: node.team.path };
  }

  if (node?.type === 'folder' && node?.id) {
    return {
      targetType: 'folder',
      folderId: node.id,
      teamPath: node.teamPath ?? null,
    };
  }

  const note = extractNote(node);
  if (note?.id) {
    return {
      targetType: 'note',
      noteId: note.id,
      teamPath: note.teamPath ?? null,
    };
  }

  return undefined;
}

function collectScopeFolders(rootFolders: readonly ModelFolder[]): ModelFolder[] {
  const result: ModelFolder[] = [];
  const stack = [...rootFolders];
  while (stack.length > 0) {
    const folder = stack.shift();
    if (!folder) {
      continue;
    }
    result.push(folder);
    for (const child of folder.children || []) {
      stack.push(child);
    }
  }
  return result;
}

function getScopeLabel(teamPath: ModelScope, teamNameByPath: Map<string, string>): string {
  if (!teamPath) {
    return 'My Notes';
  }
  return teamNameByPath.get(teamPath) || teamPath;
}

function buildRevealPickerItems(model: ReturnType<typeof getHackmdModel>): RevealQuickPickItem[] {
  const items: RevealQuickPickItem[] = [];
  const teams = [...model.getTeams()].sort((a, b) => {
    const left = (a.name || a.path || '').toLowerCase();
    const right = (b.name || b.path || '').toLowerCase();
    if (left === right) {
      return (a.id || '').localeCompare(b.id || '');
    }
    return left.localeCompare(right);
  });

  const teamNameByPath = new Map<string, string>();
  for (const team of teams) {
    teamNameByPath.set(team.path, team.name || team.path);
    items.push({
      label: `$(organization) ${team.name || team.path}`,
      description: team.path,
      targetType: 'team',
      teamPath: team.path,
    });
  }

  const appendScopeItems = (teamPath: ModelScope, snapshot: ReturnType<typeof model.getScopeSnapshotSync>) => {
    if (!snapshot) {
      return;
    }

    const scopeLabel = getScopeLabel(teamPath, teamNameByPath);
    const folders = collectScopeFolders(snapshot.rootFolders);
    for (const folder of folders) {
      items.push({
        label: `$(folder) ${folder.name || folder.id}`,
        description: `${scopeLabel}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        targetType: 'folder',
        folderId: folder.id,
        teamPath,
      });
    }

    const notes = collectNotes(snapshot.rootFolders, snapshot.rootNotes);
    for (const note of notes) {
      const title = note.title || note.shortId || note.id;
      items.push({
        label: `$(note) ${title}`,
        description: `${scopeLabel} • ${note.id}`,
        detail: note.permalink || undefined,
        targetType: 'note',
        noteId: note.id,
        teamPath,
      });
    }
  };

  appendScopeItems(null, model.getScopeSnapshotSync(null));
  for (const team of teams) {
    appendScopeItems(team.path, model.getScopeSnapshotSync(team.path));
  }

  return items;
}

async function pickRevealTarget(model: ReturnType<typeof getHackmdModel>): Promise<RevealTarget | undefined> {
  const items = buildRevealPickerItems(model);
  if (items.length === 0) {
    vscode.window.showInformationMessage('No loaded teams, folders, or notes are available to reveal.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose an item to reveal',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {
    return undefined;
  }

  if (selected.targetType === 'team') {
    return { targetType: 'team', teamPath: selected.teamPath };
  }
  if (selected.targetType === 'folder') {
    return { targetType: 'folder', folderId: selected.folderId, teamPath: selected.teamPath };
  }
  return { targetType: 'note', noteId: selected.noteId, teamPath: selected.teamPath };
}

function isScopeLoadedForReveal(model: ReturnType<typeof getHackmdModel>, teamPath: ModelScope): boolean {
  return model.getScopeSnapshotSync(teamPath) !== null;
}

async function revealLoadedTarget(model: ReturnType<typeof getHackmdModel>, target: RevealTarget): Promise<void> {
  if (target.targetType === 'team') {
    const treeView = getTeamNotesTreeView();
    if (!treeView) {
      return;
    }

    const team = model.getTeamByPath(target.teamPath) || model.getTeams().find((candidate) => candidate.path === target.teamPath);
    if (!team) {
      vscode.window.showErrorMessage(`Team "${target.teamPath}" was not found.`);
      return;
    }

    await treeView.reveal({ type: 'team', source: 'model', team }, { select: true, focus: false });
    return;
  }

  if (!isScopeLoadedForReveal(model, target.teamPath)) {
    const scopeName = target.teamPath || 'My Notes';
    vscode.window.showErrorMessage(`Cannot reveal item because scope "${scopeName}" is not loaded in the tree.`);
    return;
  }

  if (target.targetType === 'folder') {
    const folder = model.getFolderById(target.folderId, target.teamPath);
    if (!folder) {
      vscode.window.showErrorMessage(`Folder "${target.folderId}" was not found among loaded items.`);
      return;
    }

    const treeView = target.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
    if (!treeView) {
      return;
    }

    await treeView.reveal(toFolderTreeNode(folder, target.teamPath), { select: true, focus: false });
    return;
  }

  const note = target.teamPath
    ? (getTeamNotesProvider()?.findNoteInCache(target.noteId, target.teamPath) || model.getNoteSync(target.noteId, target.teamPath))
    : (getMyNotesProvider()?.findNoteInCache(target.noteId) || model.getNoteSync(target.noteId, null));

  if (!note) {
    vscode.window.showErrorMessage(`Note "${target.noteId}" was not found among loaded items.`);
    return;
  }

  const treeView = target.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
  if (!treeView) {
    return;
  }

  await treeView.reveal({ type: 'note', source: 'model', note }, { select: true, focus: false });
}

// ---------------------------------------------------------------------------
// Note URI resolution
// ---------------------------------------------------------------------------

/** Builds a minimal hackmd: URI when the note is not in the local model cache. */
function buildFallbackNoteUri(noteId: string, teamPath: string | null): vscode.Uri {
  const params = new URLSearchParams();
  params.set('noteId', noteId);
  if (teamPath) {
    params.set('teamPath', teamPath);
  }
  return vscode.Uri.from({
    scheme: 'hackmd',
    path: teamPath ? `/Teams/${teamPath}/Note` : `/My Notes/Note`,
    query: params.toString(),
  });
}

async function resolveNoteUri(
  model: ReturnType<typeof getHackmdModel>,
  node: any | undefined
): Promise<vscode.Uri | undefined> {
  const noteFromNode = extractNote(node);
  let noteId: string | undefined = noteFromNode?.id;
  let teamPath: ModelScope = noteFromNode ? (noteFromNode.teamPath ?? null) : undefined;
  let note: ModelNote | undefined;

  if (!noteId) {
    const picked = await pickNote(model, teamPath);
    if (!picked) {
      return undefined;
    }
    noteId = picked.noteId;
    teamPath = picked.teamPath;
    note = picked.note;
  } else {
    if (teamPath === undefined) {
      teamPath = null;
    }
    const snapshot = model.getScopeSnapshotSync(teamPath ?? null);
    if (snapshot) {
      note = collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === noteId);
    }
  }

  return note ? model.toNoteUri(note) : buildFallbackNoteUri(noteId!, teamPath ?? null);
}

// ---------------------------------------------------------------------------
// Export target types (public — usable by callers and tests)
// ---------------------------------------------------------------------------

export type ExportNoteTarget = {
  type: 'note';
  noteId: string;
  teamPath: string | null;
};

export type ExportFolderTarget = {
  type: 'folder';
  folderId: string;
  name?: string;
  teamPath: string | null;
};

export type ExportTarget = ExportNoteTarget | ExportFolderTarget;

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerUiCommands(context: vscode.ExtensionContext): void {
  const register = <T extends any[]>(id: string, handler: (...args: T) => Promise<any>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  // ── hackmd.ui.edit ───────────────────────────────────────────────────────
  // Opens the note in a text editor (column 1, non-preview tab).
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.edit', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openEditor(uri);
  });

  // ── hackmd.ui.preview ────────────────────────────────────────────────────
  // Opens the note in VS Code's built-in Markdown preview.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.preview', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openPreview(uri);
  });

  // ── hackmd.ui.sideBySide ─────────────────────────────────────────────────
  // Opens the note with the editor on the left and Markdown preview on the right.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.sideBySide', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openSideBySide(uri);
  });

  // ── hackmd.ui.reveal ─────────────────────────────────────────────────────
  // Reveals and selects a team, folder, or note.
  // Arg: team/folder/note tree node or undefined (mixed picker when absent).
  const revealHandler = async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const target = extractRevealTarget(node) || await pickRevealTarget(model);
    if (!target) {
      return;
    }

    await revealLoadedTarget(model, target);
  };

  register('hackmd.ui.reveal', revealHandler);

  // ── hackmd.ui.openOnHackMD ───────────────────────────────────────────────
  // Opens the note (or team) on hackmd.io.
  // Arg: tree note/team node or undefined (interactive picker when absent).
  register('hackmd.ui.openOnHackMD', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Folder node: open folder URL directly.
    const folder = extractFolderWebContext(node);
    if (folder) {
      const url = folder.teamPath
        ? `https://hackmd.io/team/${folder.teamPath}/folders/${folder.folderId}`
        : `https://hackmd.io/folders/${folder.folderId}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    if (node?.type === 'folder') {
      vscode.window.showErrorMessage('Folder ID not found');
      return;
    }

    // Team node: open the team workspace URL
    if (node?.team?.path) {
      await vscode.env.openExternal(vscode.Uri.parse(`https://hackmd.io/team/${node.team.path}`));
      return;
    }

    const noteFromNode = extractNote(node);
    let noteId: string | undefined = noteFromNode?.id;
    let teamPath: ModelScope = noteFromNode ? (noteFromNode.teamPath ?? null) : undefined;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    } else if (teamPath === undefined) {
      teamPath = null;
    }

    // Try sync cache first to avoid an extra API call.
    let publishLink: string | undefined;
    const snapshot = model.getScopeSnapshotSync(teamPath ?? null);
    if (snapshot) {
      const cached = collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === noteId);
      publishLink = cached?.publishLink;
    }

    // Fall back to a full fetch when the link is not cached.
    if (!publishLink) {
      const fetched = await model.getNote(noteId!, teamPath ?? null);
      publishLink = fetched?.publishLink ?? undefined;
    }

    if (!publishLink) {
      vscode.window.showErrorMessage('No publish link is available for this note.');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(publishLink));
  });

  // ── hackmd.ui.import ─────────────────────────────────────────────────────
  // Imports one or more Markdown files as HackMD notes.
  //
  // Arg: tree folder/team node to pre-populate scope, or undefined (interactive).
  register('hackmd.ui.import', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // 1. Resolve file list.
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Markdown: ['md'] },
      openLabel: 'Import Notes',
    });
    if (!selection || selection.length === 0) {
      return;
    }

    const files: { title: string; content: string }[] = [];
    for (const fileUri of selection) {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const title = path.parse(fileUri.fsPath).name || 'Untitled';
      files.push({ title, content: Buffer.from(bytes).toString('utf8') });
    }

    if (files.length === 0) {
      return;
    }

    // 2. Resolve scope from node (folder or team) or interactive picker.
    const scope = extractScopeContext(node);
    let teamPath: ModelScope = scope.teamPath;
    let parentFolderId: string | null | undefined = scope.parentFolderId ?? null;

    if (teamPath === undefined) {
      const location = await pickCreateLocation(model, 'Choose where to import notes into');
      if (!location) {
        return;
      }
      teamPath = location.teamPath;
      parentFolderId = location.parentFolderId;
    }

    // 3. Create notes.
    const resolvedTeamPath = teamPath;
    const resolvedFolderId = parentFolderId;

    const createdNotes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${files.length} note${files.length === 1 ? '' : 's'}…`,
        cancellable: false,
      },
      async () => Promise.all(files.map((file) => model.createNote({
        teamPath: resolvedTeamPath,
        title: file.title,
        content: file.content,
        parentFolderId: resolvedFolderId,
      })))
    );

    // 4. Refresh the relevant scope so provider updates are model-event-driven.
    try {
      await vscode.commands.executeCommand('hackmd.model.refreshScope', { teamPath: resolvedTeamPath ?? null });
    } catch {
      // Tree view may not be registered during testing.
    }

    if (createdNotes.length > 0) {
      await vscode.commands.executeCommand('hackmd.ui.reveal', {
        type: 'note',
        note: createdNotes[0],
      });
    }

    vscode.window.showInformationMessage(
      `Imported ${createdNotes.length} note${createdNotes.length === 1 ? '' : 's'} successfully.`
    );
  });

  // ── hackmd.ui.export ─────────────────────────────────────────────────────
  // Exports notes and/or folders to Markdown files on disk.
  //
  // Arg: tree note/folder/team node (pre-populates targets), or undefined (shows picker).
  // Second arg: selected nodes array for multi-selection (from VS Code context menu).
  //
  // Single-note export  → showSaveDialog  → writes <title>.md
  // Multi-entity export → showOpenDialog  → writes into the chosen directory
  register('hackmd.ui.export', async (node?: any, selectedNodes?: any[]) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Resolve targets from node / selectedNodes, or fall back to interactive picker.
    let targets: ExportTarget[] | undefined;

    if (node || (selectedNodes && selectedNodes.length > 0)) {
      const effectiveNodes = selectedNodes?.length ? selectedNodes : node ? [node] : [];
      const noteTargets: ExportNoteTarget[] = [];
      const folderTargets: ExportFolderTarget[] = [];

      for (const n of effectiveNodes) {
        // Team node: export all root notes + folders for that team
        if (n?.team?.path) {
          const teamPath: string = n.team.path;
          const snapshot = await model.getScopeSnapshot(teamPath) as any;
          const rootNotes: any[] = snapshot?.rootNotes ?? [];
          const rootFolders: any[] = snapshot?.rootFolders ?? [];
          for (const rn of rootNotes) { noteTargets.push({ type: 'note', noteId: rn.id, teamPath }); }
          for (const rf of rootFolders) { folderTargets.push({ type: 'folder', folderId: rf.id, name: rf.name, teamPath }); }
          continue;
        }
        const note = extractNote(n);
        if (note) { noteTargets.push({ type: 'note', noteId: note.id, teamPath: note.teamPath ?? null }); continue; }
        const folder = n?.type === 'folder' ? n : undefined;
        if (folder) { folderTargets.push({ type: 'folder', folderId: folder.id, name: folder.name, teamPath: folder.teamPath ?? null }); }
      }

      if (noteTargets.length > 0 || folderTargets.length > 0) {
        targets = [...noteTargets, ...folderTargets];
      }
    }

    if (!targets || targets.length === 0) {
      const picked = await pickEntity(model, 'Choose a note or folder to export');
      if (!picked) {
        return;
      }
      if (picked.kind === 'note') {
        targets = [{ type: 'note', noteId: picked.noteId, teamPath: picked.teamPath ?? null }];
      } else {
        targets = [{ type: 'folder', folderId: picked.folderId, name: picked.name, teamPath: picked.teamPath ?? null }];
      }
    }

    const noteTargets = targets.filter((t): t is ExportNoteTarget => t.type === 'note');
    const folderTargets = targets.filter((t): t is ExportFolderTarget => t.type === 'folder');
    const defaultDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    let targetFileUri: vscode.Uri | undefined;
    let exportDirUri: vscode.Uri | undefined;

    if (folderTargets.length === 0 && noteTargets.length === 1) {
      // Single note → ask where to save the .md file.
      // Use sync cache so no async call happens before the dialog.
      const nt = noteTargets[0];
      const ntSnapshot = model.getScopeSnapshotSync(nt.teamPath);
      const ntCached = ntSnapshot
        ? collectNotes(ntSnapshot.rootFolders, ntSnapshot.rootNotes).find((n) => n.id === nt.noteId)
        : undefined;
      const baseName = sanitizePathSegment(ntCached?.title || ntCached?.shortId || nt.noteId) + '.md';
      targetFileUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDirectory, baseName)),
        filters: { Markdown: ['md'] },
        saveLabel: 'Export Note',
      });
    } else {
      // Multiple entities or at least one folder → pick an output directory.
      exportDirUri = (await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(defaultDirectory),
        openLabel: 'Export to Folder',
      }))?.[0];
    }

    if (!targetFileUri && !exportDirUri) {
      return;
    }

    try {
      if (targetFileUri) {
        const nt = noteTargets[0];
        const content = await model.getNoteContent(nt.noteId, nt.teamPath);
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(content ?? '', 'utf8'));
      } else if (exportDirUri) {
        const usedNames = await getUsedNamesForDirectory(exportDirUri);

        const noteJobs = noteTargets.map((nt) => {
          const snapshot = model.getScopeSnapshotSync(nt.teamPath);
          const cached = snapshot
            ? collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === nt.noteId)
            : undefined;
          const baseName = cached?.title || cached?.shortId || nt.noteId;
          const fileName = getUniqueMarkdownFileName(baseName, usedNames);
          return (async () => {
            const content = await model.getNoteContent(nt.noteId, nt.teamPath);
            await vscode.workspace.fs.writeFile(
              vscode.Uri.joinPath(exportDirUri, fileName),
              Buffer.from(content ?? '', 'utf8')
            );
          })();
        });

        const folderJobs: Promise<number>[] = [];
        for (const ft of folderTargets) {
          const snapshot = model.getScopeSnapshotSync(ft.teamPath);
          if (!snapshot) {
            vscode.window.showWarningMessage(
              `Scope data for "${ft.name ?? ft.folderId}" is not loaded. Refresh the scope first.`
            );
            continue;
          }
          const folder = findFolderById(snapshot.rootFolders, ft.folderId);
          if (!folder) {
            vscode.window.showWarningMessage(
              `Folder "${ft.name ?? ft.folderId}" was not found in scope. Skipping.`
            );
            continue;
          }
          folderJobs.push(exportFolderRecursive(model, folder, exportDirUri));
        }

        await Promise.all([...noteJobs, ...folderJobs]);
      }

      vscode.window.showInformationMessage('Export completed successfully.');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Export failed: ${error.message ?? 'Unknown error'}`);
    }
  });

  // ── hackmd.ui.properties ─────────────────────────────────────────────────
  // Opens the Properties panel for a given note.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.properties', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const noteFromNode = extractNote(node);
    let noteId: string | undefined = noteFromNode?.id;
    let teamPath: string | null = noteFromNode ? (noteFromNode.teamPath ?? null) : null;

    if (!noteId) {
      const picked = await pickNote(model, undefined, { allowCustom: false });
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath ?? null;
    }

    const note = model.getNoteSync(noteId, teamPath);
    if (!note) {
      vscode.window.showErrorMessage(`Note "${noteId}" is not loaded. Please refresh the scope first.`);
      return;
    }

    const propertiesProvider = getPropertiesProvider();
    if (!propertiesProvider) {
      return;
    }

    await vscode.commands.executeCommand('hackmd.properties.focus');
    await propertiesProvider.openNote(note);
  });

  // ── hackmd.ui.importMyNotes ───────────────────────────────────────────
  // Scoped variant: import files directly to My Notes (no team picker)
  register('hackmd.ui.importMyNotes', async (node?: any) => {
    const targetNode = node || {
      type: 'container',
      container: 'my-notes',
      viewId: 'hackmd.tree.my-notes',
    };
    return vscode.commands.executeCommand('hackmd.ui.import', targetNode);
  });

}

