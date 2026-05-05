import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import * as extensionApi from '../extension';
import {
  getMyNotesTreeView,
  getPropertiesProvider,
  getTeamNotesTreeView
} from '../extension';
import { getHackmdModel, ModelFolder, ModelMyNotes, ModelNote, ModelTeam } from '../model';
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

async function openEditor(uri: vscode.Uri, preserveFocus = false): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus,
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
      const content = await model.getNoteContent(note);
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

function getSelectedTreeNodeFallback(): any | undefined {
  const selection = extensionApi.getActiveTreeSelection?.() || [];
  return selection[0];
}

function getSelectedTreeNodesFallback(): any[] {
  const selection = extensionApi.getActiveTreeSelection?.() || [];
  return [...selection];
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

type RevealEntity = ModelTeam | ModelFolder | ModelNote;

type RevealQuickPickItem = vscode.QuickPickItem & {
  entity: RevealEntity;
};

type OpenQuickPickItem = vscode.QuickPickItem & {
  entity: RevealEntity;
};

type ImportContainer = ModelMyNotes | ModelTeam | ModelFolder;

type ImportContainerQuickPickItem = vscode.QuickPickItem & {
  container: ImportContainer;
};

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

function getScopeLabel(teamPath: string | null, teamNameByPath: Map<string, string>): string {
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
      entity: team,
    });
  }

  const appendScopeItems = (teamPath: string | null, snapshot: ReturnType<typeof model.getScopeSnapshotSync>) => {
    if (!snapshot) {
      return;
    }

    const scopeLabel = getScopeLabel(teamPath, teamNameByPath);
    for (const folder of collectScopeFolders(snapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name || folder.id}`,
        description: `${scopeLabel}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        entity: folder,
      });
    }

    for (const note of collectNotes(snapshot.rootFolders, snapshot.rootNotes)) {
      const title = note.title || note.shortId || note.id;
      items.push({
        label: `$(note) ${title}`,
        description: `${scopeLabel} • ${note.id}`,
        detail: note.permalink || undefined,
        entity: note,
      });
    }
  };

  appendScopeItems(null, model.getScopeSnapshotSync(model.getMyNotesEntity()));
  for (const team of teams) {
    appendScopeItems(team.path, model.getScopeSnapshotSync(team));
  }

  return items;
}

async function pickRevealEntity(model: ReturnType<typeof getHackmdModel>): Promise<RevealEntity | undefined> {
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

  return selected?.entity;
}

function buildOpenPickerItems(model: ReturnType<typeof getHackmdModel>): OpenQuickPickItem[] {
  const items: OpenQuickPickItem[] = [];
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
      entity: team,
    });
  }

  const appendScopeItems = (teamPath: string | null, snapshot: ReturnType<typeof model.getScopeSnapshotSync>) => {
    if (!snapshot) {
      return;
    }

    const scopeLabel = getScopeLabel(teamPath, teamNameByPath);
    for (const folder of collectScopeFolders(snapshot.rootFolders)) {
      if (!folder.clientId) {
        continue;
      }
      items.push({
        label: `$(folder) ${folder.name || folder.id}`,
        description: `${scopeLabel}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        entity: folder,
      });
    }

    for (const note of collectNotes(snapshot.rootFolders, snapshot.rootNotes)) {
      if (!note.publishLink) {
        continue;
      }
      const title = note.title || note.shortId || note.id;
      items.push({
        label: `$(note) ${title}`,
        description: `${scopeLabel} • ${note.id}`,
        detail: note.publishLink,
        entity: note,
      });
    }
  };

  appendScopeItems(null, model.getScopeSnapshotSync(model.getMyNotesEntity()));
  for (const team of teams) {
    appendScopeItems(team.path, model.getScopeSnapshotSync(team));
  }

  return items;
}

async function pickOpenEntity(model: ReturnType<typeof getHackmdModel>): Promise<RevealEntity | undefined> {
  const items = buildOpenPickerItems(model);
  if (items.length === 0) {
    vscode.window.showInformationMessage('No openable teams, folders, or notes are available.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose an item to open on HackMD',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.entity;
}

async function pickImportContainer(model: ReturnType<typeof getHackmdModel>): Promise<ImportContainer | undefined> {
  const items: ImportContainerQuickPickItem[] = [];

  items.push({
    label: '$(home) My Notes',
    description: 'Root',
    container: model.getMyNotesEntity(),
  });

  const personalSnapshot = model.getScopeSnapshotSync(model.getMyNotesEntity());
  if (personalSnapshot) {
    for (const folder of collectScopeFolders(personalSnapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name || folder.id}`,
        description: `My Notes${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        container: folder,
      });
    }
  }

  for (const team of model.getTeams()) {
    items.push({
      label: `$(organization) ${team.name || team.path}`,
      description: 'Root',
      detail: team.path,
      container: team,
    });

    const snapshot = model.getScopeSnapshotSync(team);
    if (!snapshot) {
      continue;
    }

    for (const folder of collectScopeFolders(snapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name || folder.id}`,
        description: `${team.name || team.path}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        container: folder,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose where to import notes into',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.container;
}

async function revealLoadedTarget(entity: RevealEntity): Promise<void> {
  if (entity.type === 'team') {
    const treeView = getTeamNotesTreeView();
    if (!treeView) {
      return;
    }

    await treeView.reveal({ type: 'team', source: 'model', team: entity }, { select: true, focus: false });
    return;
  }

  if (entity.type === 'folder') {
    const treeView = entity.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
    if (!treeView) {
      return;
    }

    await treeView.reveal(toFolderTreeNode(entity, entity.teamPath ?? null), { select: true, focus: false });
    return;
  }

  const treeView = entity.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
  if (!treeView) {
    return;
  }

  await treeView.reveal({ type: 'note', source: 'model', note: entity }, { select: true, focus: false });
}

// ---------------------------------------------------------------------------
// Note URI resolution
// ---------------------------------------------------------------------------

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

    const targetNode = node ?? getSelectedTreeNodeFallback();
    const noteFromNode = extractNote(targetNode);
    if (targetNode !== undefined && !noteFromNode) {
      return;
    }
    const note: ModelNote | undefined = noteFromNode ?? await pickNote(model);
    if (!note) {
      return;
    }

    const preserveFocus = !!node?.preserveFocus;
    await openEditor(model.toUri(note), preserveFocus);
  });

  // ── hackmd.ui.preview ────────────────────────────────────────────────────
  // Opens the note in VS Code's built-in Markdown preview.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.preview', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const targetNode = node ?? getSelectedTreeNodeFallback();
    const noteFromNode = extractNote(targetNode);
    if (targetNode !== undefined && !noteFromNode) {
      return;
    }
    const note: ModelNote | undefined = noteFromNode ?? await pickNote(model);
    if (!note) {
      return;
    }

    await openPreview(model.toUri(note));
  });

  // ── hackmd.ui.sideBySide ─────────────────────────────────────────────────
  // Opens the note with the editor on the left and Markdown preview on the right.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.sideBySide', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const targetNode = node ?? getSelectedTreeNodeFallback();
    const noteFromNode = extractNote(targetNode);
    if (targetNode !== undefined && !noteFromNode) {
      return;
    }
    const note: ModelNote | undefined = noteFromNode ?? await pickNote(model);
    if (!note) {
      return;
    }

    await openSideBySide(model.toUri(note));
  });

  // ── hackmd.ui.reveal ─────────────────────────────────────────────────────
  // Reveals and selects a team, folder, or note.
  // Arg: team/folder/note tree node or undefined (mixed picker when absent).
  const revealHandler = async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const nodeEntity: RevealEntity | undefined = node?.team?.path
      ? (node.team as ModelTeam)
      : node?.type === 'team' && typeof node.path === 'string'
        ? (node as ModelTeam)
        : node?.type === 'folder' && node?.id
          ? (node as ModelFolder)
          : (extractNote(node) as ModelNote | undefined);

    const entity = nodeEntity ?? await pickRevealEntity(model);
    if (!entity) {
      return;
    }

    await revealLoadedTarget(entity);
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

    const nodeEntity: RevealEntity | undefined = node?.team?.path
      ? (node.team as ModelTeam)
      : node?.type === 'team' && typeof node.path === 'string'
        ? (node as ModelTeam)
        : node?.type === 'folder' && node?.id
          ? (node as ModelFolder)
          : (extractNote(node) as ModelNote | undefined);

    const entity = nodeEntity ?? await pickOpenEntity(model);
    if (!entity) {
      return;
    }

    if (entity.type === 'team') {
      await vscode.env.openExternal(vscode.Uri.parse(`https://hackmd.io/team/${entity.path}`));
      return;
    }

    if (entity.type === 'folder') {
      if (!entity.clientId) {
        vscode.window.showErrorMessage('No folder client ID is available for this folder.');
        return;
      }
      const url = entity.teamPath
        ? `https://hackmd.io/team/${entity.teamPath}/folders/${entity.clientId}`
        : `https://hackmd.io/folders/${entity.clientId}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    if (!entity.publishLink) {
      vscode.window.showErrorMessage('No publish link is available for this note.');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(entity.publishLink));
  });

  // ── hackmd.ui.import ─────────────────────────────────────────────────────
  // Imports one or more Markdown files as HackMD notes.
  //
  // Arg: model container entity (`my-notes`, `team`, or `folder`) or undefined (interactive).
  register('hackmd.ui.import', async (containerArg?: any) => {
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

    // 2. Resolve destination container: argument, or picker.
    const containerFromArg = containerArg?.type === 'note'
      ? model.getImmediateParentContainer(containerArg as ModelNote)
      : containerArg;
    const container: ImportContainer | any = containerFromArg ?? await pickImportContainer(model);
    if (!container) {
      return;
    }

    // 3. Create notes.

    const createdNotes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${files.length} note${files.length === 1 ? '' : 's'}…`,
        cancellable: false,
      },
      async () => Promise.all(files.map((file) => model.createNote(container, { title: file.title, content: file.content })))
    );

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
    const fallbackSelection = (!node && (!selectedNodes || selectedNodes.length === 0))
      ? getSelectedTreeNodesFallback()
      : [];
    const hasTreeSelectionContext = fallbackSelection.length > 0 || !!node || !!(selectedNodes && selectedNodes.length > 0);

    if (node || (selectedNodes && selectedNodes.length > 0) || fallbackSelection.length > 0) {
      const effectiveNodes = selectedNodes?.length ? selectedNodes : node ? [node] : fallbackSelection;
      const noteTargets: ExportNoteTarget[] = [];
      const folderTargets: ExportFolderTarget[] = [];

      for (const n of effectiveNodes) {
        // Team node: export all root notes + folders for that team
        if (n?.team?.path || (n?.type === 'team' && typeof n.path === 'string')) {
          const teamEntity = (n.team ?? n) as ModelTeam;
          const teamPath: string = teamEntity.path;
          const snapshot = await model.getScopeSnapshot(teamEntity) as any;
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
      if (hasTreeSelectionContext) {
        return;
      }
      const picked = await pickEntity(model, 'Choose a note or folder to export');
      if (!picked) {
        return;
      }
      if (picked.kind === 'note') {
        targets = [{ type: 'note', noteId: picked.note.id, teamPath: picked.note.teamPath ?? null }];
      } else {
        targets = [{
          type: 'folder',
          folderId: picked.folder.id,
          name: picked.folder.name,
          teamPath: picked.folder.teamPath ?? null,
        }];
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
      const ntScopeEntity = nt.teamPath ? model.getTeams().find((t) => t.path === nt.teamPath) ?? null : model.getMyNotesEntity();
      const ntSnapshot = ntScopeEntity ? model.getScopeSnapshotSync(ntScopeEntity) : null;
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
        const ntScope = nt.teamPath ? model.getTeams().find((t) => t.path === nt.teamPath) ?? null : model.getMyNotesEntity();
        const ntNote = ntScope ? await model.getNote(ntScope, nt.noteId) : null;
        const content = ntNote ? await model.getNoteContent(ntNote) : null;
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(content ?? '', 'utf8'));
      } else if (exportDirUri) {
        const usedNames = await getUsedNamesForDirectory(exportDirUri);

        const noteJobs = noteTargets.map((nt) => {
          const ntScopeEntity = nt.teamPath ? model.getTeams().find((t) => t.path === nt.teamPath) ?? null : model.getMyNotesEntity();
          const snapshot = ntScopeEntity ? model.getScopeSnapshotSync(ntScopeEntity) : null;
          const cached = snapshot
            ? collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === nt.noteId)
            : undefined;
          const baseName = cached?.title || cached?.shortId || nt.noteId;
          const fileName = getUniqueMarkdownFileName(baseName, usedNames);
          return (async () => {
            const ntNote = ntScopeEntity ? await model.getNote(ntScopeEntity, nt.noteId) : null;
            const content = ntNote ? await model.getNoteContent(ntNote) : null;
            await vscode.workspace.fs.writeFile(
              vscode.Uri.joinPath(exportDirUri, fileName),
              Buffer.from(content ?? '', 'utf8')
            );
          })();
        });

        const folderJobs: Promise<number>[] = [];
        for (const ft of folderTargets) {
          const ftScopeEntity = ft.teamPath ? model.getTeams().find((t) => t.path === ft.teamPath) ?? null : model.getMyNotesEntity();
          const snapshot = ftScopeEntity ? model.getScopeSnapshotSync(ftScopeEntity) : null;
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

    const targetNode = node ?? getSelectedTreeNodeFallback();
    const noteFromNode = extractNote(targetNode);
    if (targetNode !== undefined && !noteFromNode) {
      return;
    }
    const note: ModelNote | null = noteFromNode
      ? (model.getScopeEntityForItem(noteFromNode) ? model.getNoteSync(model.getScopeEntityForItem(noteFromNode)!, noteFromNode.id) : null)
      : (await pickNote(model) ?? null);
    if (!note) {
      if (noteFromNode) {
        vscode.window.showErrorMessage(`Note "${noteFromNode.id}" is not loaded. Please refresh the scope first.`);
      }
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
  register('hackmd.ui.importMyNotes', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return vscode.commands.executeCommand('hackmd.ui.import', model.getMyNotesEntity());
  });

}

