import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';


import { getHistoryProvider, getHistoryTreeView, getMyNotesProvider, getMyNotesTreeView, getPropertiesProvider, getTeamNotesProvider, getTeamNotesTreeView } from '../extension';
import { Note, Team } from '../hackmdApiClient';
import { generateFolderResourceUri, generateResourceUri } from '../mdFsProvider';
import { recordUsage, teamNotesStore } from '../store';

import { API } from './../api';

function unwrapApiData<T>(responseOrData: any): T {
  if (responseOrData && typeof responseOrData === 'object' && 'data' in responseOrData) {
    return responseOrData.data as T;
  }
  return responseOrData as T;
}

function getUriParams(uri: vscode.Uri): { noteId: string; folderId: string; teamPath: string | null } {
  const params = new URLSearchParams(uri.query || '');
  return {
    noteId: params.get('noteId') || '',
    folderId: params.get('folderId') || '',
    teamPath: params.get('teamPath'),
  };
}

function getNoteIdFromUri(uri: vscode.Uri): string {
  return getUriParams(uri).noteId;
}

function getFolderIdFromUri(uri: vscode.Uri): string {
  return getUriParams(uri).folderId;
}

function getTeamPathFromUri(uri: vscode.Uri): string | null {
  return getUriParams(uri).teamPath;
}

function getExportFileName(note: Note): string {
  const baseName = (note.title || note.shortId || 'Untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled';
  return baseName.toLowerCase().endsWith('.md') ? baseName : `${baseName}.md`;
}

function sanitizePathSegment(name: string): string {
  const sanitized = (name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return sanitized || 'Untitled';
}

function normalizeFolderId(rawFolderId: unknown): string | undefined {
  if (!rawFolderId) {
    return undefined;
  }

  const value = String(rawFolderId);
  return value.startsWith('folder-') ? value.slice('folder-'.length) : value;
}

function resolveFolderCommandContext(node: any): { folderId?: string; folderName: string; teamPath: string | null } {
  if (!node) {
    return { folderName: 'Folder', teamPath: null };
  }

  if (node.type === 'folder') {
    return {
      folderId: normalizeFolderId(node.id),
      folderName: node.name || 'Folder',
      teamPath: node.teamPath ?? null,
    };
  }

  return {
    folderId: normalizeFolderId(node.value?.context?.folderId || node.folderId || node.id),
    folderName: node.value?.context?.name || node.folderName || node.name || 'Folder',
    teamPath: (node.value?.context?.teamPath || node.teamPath || null),
  };
}

async function promptFolderName(defaultValue = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: 'Enter folder name',
    value: defaultValue,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Folder name cannot be empty';
      }
      return null;
    },
  });

  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function createFolderInScope(options: { teamPath?: string | null; parentFolderId?: string }): Promise<void> {
  const { teamPath, parentFolderId } = options;
  const folderName = await promptFolderName();
  if (!folderName) {
    return;
  }

  const payload: Record<string, any> = { name: folderName };
  if (parentFolderId) {
    payload.parentFolderId = parentFolderId;
  }

  const myNotesProvider = getMyNotesProvider();
  const teamNotesProvider = getTeamNotesProvider();
  const provider = teamPath ? teamNotesProvider : myNotesProvider;
  const containerId = parentFolderId
    ? `folder-${parentFolderId}`
    : (teamPath
      ? `team-${teamNotesProvider?.getTeamIdFromPath(teamPath)}`
      : 'root');

  const isRoot = !parentFolderId;
  const viewId = teamPath ? 'hackmd.tree.team-notes' : 'hackmd.tree.my-notes';

  const doCreate = async () => {
    if (teamPath) {
      const createdFolder = unwrapApiData<any>(
        await recordUsage(API.createTeamFolder(teamPath, payload, { unwrapData: false }))
      );
      if (createdFolder?.id) {
        const normalizedCreatedFolder = {
          ...createdFolder,
          parentFolderId: createdFolder.parentFolderId || createdFolder.parentId || parentFolderId,
          parentId: createdFolder.parentId || createdFolder.parentFolderId || parentFolderId,
          teamPath,
        };
        teamNotesProvider?.addFolderToCache(teamPath, normalizedCreatedFolder);
      }
    } else {
      const createdFolder = unwrapApiData<any>(
        await recordUsage(API.createFolder(payload, { unwrapData: false }))
      );
      if (createdFolder?.id) {
        const normalizedCreatedFolder = {
          ...createdFolder,
          parentFolderId: createdFolder.parentFolderId || createdFolder.parentId || parentFolderId,
          parentId: createdFolder.parentId || createdFolder.parentFolderId || parentFolderId,
        };
        myNotesProvider?.addFolderToCache(normalizedCreatedFolder);
      }
    }
  };

  provider?.setPendingContainer(containerId);
  try {
    if (isRoot) {
      await vscode.window.withProgress(
        { location: { viewId }, title: 'Creating folder...' },
        doCreate
      );
    } else {
      await doCreate();
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to create folder: ${error.message || 'Unknown error'}`);
  } finally {
    provider?.clearPendingContainer(containerId);
  }
}

function getUniqueMarkdownFileName(baseName: string, usedNames: Set<string>): string {
  const safeBaseName = sanitizePathSegment(baseName);
  let index = 1;
  let candidate = `${safeBaseName}.md`;

  while (usedNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${safeBaseName} (${index}).md`;
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
    // Directory may not exist yet; callers create it before write.
  }
  return usedNames;
}

async function exportFolderNotesRecursively(options: {
  folderId: string;
  folderName: string;
  teamPath?: string | null;
  destinationParentUri: vscode.Uri;
}): Promise<{ exportedCount: number; exportRootUri: vscode.Uri }> {
  const { folderId, folderName, teamPath, destinationParentUri } = options;
  const notes = teamPath
    ? await recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }))
    : await recordUsage(API.getNoteList({ unwrapData: false }));

  const exportRootUri = vscode.Uri.joinPath(destinationParentUri, sanitizePathSegment(folderName));
  await vscode.workspace.fs.createDirectory(exportRootUri);

  const usedNamesByDirectory = new Map<string, Set<string>>();
  let exportedCount = 0;

  for (const note of notes) {
    const folderPaths = ((note as any).folderPaths || []) as any[];
    const folderIndex = folderPaths.findIndex((entry) => entry.id === folderId);
    if (folderIndex === -1) {
      continue;
    }

    const relativeFolders = folderPaths.slice(folderIndex + 1);
    let targetDirectory = exportRootUri;

    for (const folder of relativeFolders) {
      targetDirectory = vscode.Uri.joinPath(targetDirectory, sanitizePathSegment(folder.name || 'Folder'));
      await vscode.workspace.fs.createDirectory(targetDirectory);
    }

    const targetDirectoryKey = targetDirectory.toString();
    let usedNames = usedNamesByDirectory.get(targetDirectoryKey);
    if (!usedNames) {
      usedNames = await getUsedNamesForDirectory(targetDirectory);
      usedNamesByDirectory.set(targetDirectoryKey, usedNames);
    }

    const baseName = note.title || note.shortId || 'Untitled';
    const fileName = getUniqueMarkdownFileName(baseName, usedNames);

    const noteWithContent = await recordUsage(API.getNote(note.id, { unwrapData: false }));
    const fileUri = vscode.Uri.joinPath(targetDirectory, fileName);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(noteWithContent.content || '', 'utf8'));
    exportedCount += 1;
  }

  return { exportedCount, exportRootUri };
}

async function exportTeamNotes(options: {
  teamPath: string;
  teamName: string;
  destinationParentUri: vscode.Uri;
}): Promise<{ exportedCount: number; exportRootUri: vscode.Uri }> {
  const { teamPath, teamName, destinationParentUri } = options;
  const notes = await recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }));

  const exportRootUri = vscode.Uri.joinPath(destinationParentUri, sanitizePathSegment(teamName));
  await vscode.workspace.fs.createDirectory(exportRootUri);

  const usedNamesByDirectory = new Map<string, Set<string>>();
  let exportedCount = 0;

  for (const note of notes) {
    const folderPaths = ((note as any).folderPaths || []) as any[];
    let targetDirectory = exportRootUri;

    for (const folder of folderPaths) {
      targetDirectory = vscode.Uri.joinPath(targetDirectory, sanitizePathSegment(folder.name || 'Folder'));
      await vscode.workspace.fs.createDirectory(targetDirectory);
    }

    const targetDirectoryKey = targetDirectory.toString();
    let usedNames = usedNamesByDirectory.get(targetDirectoryKey);
    if (!usedNames) {
      usedNames = await getUsedNamesForDirectory(targetDirectory);
      usedNamesByDirectory.set(targetDirectoryKey, usedNames);
    }

    const baseName = note.title || note.shortId || 'Untitled';
    const fileName = getUniqueMarkdownFileName(baseName, usedNames);

    const noteWithContent = await recordUsage(API.getNote(note.id, { unwrapData: false }));
    const fileUri = vscode.Uri.joinPath(targetDirectory, fileName);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(noteWithContent.content || '', 'utf8'));
    exportedCount += 1;
  }

  return { exportedCount, exportRootUri };
}

async function pickMarkdownImportData(): Promise<{ title: string; content: string }[]> {
  const selection = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: {
      Markdown: ['md'],
    },
    openLabel: 'Import Note',
  });

  if (!selection || selection.length === 0) {
    return [];
  }

  const results: { title: string; content: string }[] = [];
  for (const sourceUri of selection) {
    const fileBytes = await vscode.workspace.fs.readFile(sourceUri);
    const title = path.parse(sourceUri.fsPath).name || 'Untitled';
    results.push({ title, content: Buffer.from(fileBytes).toString('utf8') });
  }
  return results;
}

async function createNoteInScope(
  payload: Record<string, any>,
  options: { teamPath?: string | null; openEditor?: boolean }
): Promise<void> {
  const { teamPath, openEditor = true } = options;
  const myNotesProvider = getMyNotesProvider();
  const teamNotesProvider = getTeamNotesProvider();

  let note: any;
  let noteNode: any;

  if (teamPath) {
    const teamId = teamNotesProvider?.getTeamIdFromPath(teamPath);
    const areNotesLoaded = teamId && teamNotesProvider?.isTeamNotesCached(teamId);

    if (!areNotesLoaded && teamNotesProvider) {
      const [createdNote, loadedNotes] = await Promise.all([
        recordUsage(API.createTeamNote(teamPath, payload as any, { unwrapData: false })),
        recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }))
      ]);
      note = createdNote;
      if (teamId && loadedNotes) {
        teamNotesProvider.cacheTeamNotes(teamId, loadedNotes);
      }
    } else {
      note = await recordUsage(API.createTeamNote(teamPath, payload as any, { unwrapData: false }));
    }

    if (teamNotesProvider) {
      const targetFolderId = normalizeFolderId(payload.parentFolderId);
      if (targetFolderId) {
        const hasFolderPaths = Array.isArray((note as any).folderPaths) && (note as any).folderPaths.length > 0;
        if (!hasFolderPaths) {
          (note as any).folderPaths = getFolderPathsForContainer(teamPath, targetFolderId);
        }
        if (!(note as any).parentFolderId) {
          (note as any).parentFolderId = targetFolderId;
        }
      }
      if (!(note as any).teamPath) {
        (note as any).teamPath = teamPath;
      }
      noteNode = await teamNotesProvider.addNoteToCache(note, teamPath);
    }
  } else {
    note = await recordUsage(API.createNote(payload as any, { unwrapData: false }));
    if (myNotesProvider) {
      const targetFolderId = normalizeFolderId(payload.parentFolderId);
      if (targetFolderId) {
        const hasFolderPaths = Array.isArray((note as any).folderPaths) && (note as any).folderPaths.length > 0;
        if (!hasFolderPaths) {
          (note as any).folderPaths = getFolderPathsForContainer(null, targetFolderId);
        }
        if (!(note as any).parentFolderId) {
          (note as any).parentFolderId = targetFolderId;
        }
      }
      noteNode = await myNotesProvider.addNoteToCache(note);
    }
  }

  if (openEditor) {
    const uri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
    await openNoteEditorByUri(uri);
  }

  if (noteNode) {
    if (teamPath) {
      await revealNote(getTeamNotesTreeView(), noteNode);
    } else {
      await revealNote(getMyNotesTreeView(), noteNode);
    }
  }
}

function isSameNoteUri(uri: vscode.Uri, noteId: string, teamPath?: string | null): boolean {
  if (uri.scheme !== 'hackmd') {
    return false;
  }
  const uriNoteId = getNoteIdFromUri(uri);
  const uriTeamPath = getTeamPathFromUri(uri);
  return uriNoteId === noteId && (uriTeamPath || null) === (teamPath || null);
}

function isNoteNode(node: any): node is { type: 'note'; note: Note } {
  return node?.type === 'note' && !!node.note?.id;
}

type ResolvedFolderSelection = {
  id: string;
  name: string;
  teamPath: string | null;
  parentId: string | null;
  folderPaths: any[];
};

type ResolvedOperationSelection = {
  notes: Note[];
  folders: ResolvedFolderSelection[];
  hasUnsupportedNodes: boolean;
  hasSingleScope: boolean;
};

function isFolderNode(node: any): boolean {
  if (!node || node.type !== 'folder') {
    return false;
  }

  return !!normalizeFolderId(node.id ?? node.folderId ?? node.value?.context?.folderId);
}

function getScopeKey(teamPath: string | null | undefined): string {
  return teamPath || '__personal__';
}

function toResolvedFolderSelection(node: any): ResolvedFolderSelection | null {
  if (!isFolderNode(node)) {
    return null;
  }

  const id = normalizeFolderId(node.id ?? node.folderId ?? node.value?.context?.folderId);
  if (!id) {
    return null;
  }

  const teamPath = (node.teamPath ?? node.value?.context?.teamPath ?? null) as string | null;
  const parentId = normalizeFolderId(node.parentId ?? node.value?.context?.parentId) || null;
  const folderPaths = getFolderPathsForContainer(teamPath, id);

  return {
    id,
    name: node.name || node.folderName || node.value?.context?.name || 'Folder',
    teamPath,
    parentId,
    folderPaths,
  };
}

function hasSelectedAncestorFolder(folder: ResolvedFolderSelection, selectedFolderIdsByScope: Map<string, Set<string>>): boolean {
  const selectedInScope = selectedFolderIdsByScope.get(getScopeKey(folder.teamPath));
  if (!selectedInScope) {
    return false;
  }

  if (folder.folderPaths.length > 0) {
    return folder.folderPaths.some((entry) => entry?.id && entry.id !== folder.id && selectedInScope.has(entry.id));
  }

  return false;
}

function isNoteUnderSelectedFolder(note: Note, selectedFolderIdsByScope: Map<string, Set<string>>): boolean {
  const selectedInScope = selectedFolderIdsByScope.get(getScopeKey(((note as any).teamPath as string | null | undefined) ?? null));
  if (!selectedInScope || selectedInScope.size === 0) {
    return false;
  }

  const noteFolderPaths = ((note as any).folderPaths || []) as any[];
  return noteFolderPaths.some((entry) => entry?.id && selectedInScope.has(entry.id));
}

function resolveOperationSelection(node: any, selectedNodes?: any[]): ResolvedOperationSelection {
  const selection = getTreeSelectionForNode(node, selectedNodes);
  const sourceNodes = selection.length > 0 ? selection : (node ? [node] : []);

  if (sourceNodes.length === 0) {
    return {
      notes: [],
      folders: [],
      hasUnsupportedNodes: false,
      hasSingleScope: true,
    };
  }

  const notesByKey = new Map<string, Note>();
  const foldersByKey = new Map<string, ResolvedFolderSelection>();
  let hasUnsupportedNodes = false;

  for (const selectedNode of sourceNodes) {
    if (isNoteNode(selectedNode)) {
      const note = hydrateDraggedNote(selectedNode.note as Note);
      const teamPath = (((note as any).teamPath as string | null | undefined) ?? null);
      notesByKey.set(`${getScopeKey(teamPath)}:${note.id}`, note);
      continue;
    }

    const folder = toResolvedFolderSelection(selectedNode);
    if (folder) {
      foldersByKey.set(`${getScopeKey(folder.teamPath)}:${folder.id}`, folder);
      continue;
    }

    hasUnsupportedNodes = true;
  }

  const selectedFolderIdsByScope = new Map<string, Set<string>>();
  for (const folder of foldersByKey.values()) {
    const key = getScopeKey(folder.teamPath);
    const set = selectedFolderIdsByScope.get(key) || new Set<string>();
    set.add(folder.id);
    selectedFolderIdsByScope.set(key, set);
  }

  const folders = [...foldersByKey.values()].filter((folder) =>
    !hasSelectedAncestorFolder(folder, selectedFolderIdsByScope)
  );

  const rootSelectedFolderIdsByScope = new Map<string, Set<string>>();
  for (const folder of folders) {
    const key = getScopeKey(folder.teamPath);
    const set = rootSelectedFolderIdsByScope.get(key) || new Set<string>();
    set.add(folder.id);
    rootSelectedFolderIdsByScope.set(key, set);
  }

  const notes = [...notesByKey.values()].filter((note) => !isNoteUnderSelectedFolder(note, rootSelectedFolderIdsByScope));

  const scopeSet = new Set<string>();
  for (const note of notes) {
    scopeSet.add(getScopeKey(((note as any).teamPath as string | null | undefined) ?? null));
  }
  for (const folder of folders) {
    scopeSet.add(getScopeKey(folder.teamPath));
  }

  return {
    notes,
    folders,
    hasUnsupportedNodes,
    hasSingleScope: scopeSet.size <= 1,
  };
}

function isSameNoteScope(left: Note, right: Note): boolean {
  return (left.teamPath || null) === (right.teamPath || null);
}

function isSameNoteNode(left: any, right: any): boolean {
  return isNoteNode(left)
    && isNoteNode(right)
    && left.note.id === right.note.id
    && isSameNoteScope(left.note, right.note);
}

function resolveCommandSelection(node: any, selectedNodes?: any[]): any[] {
  if (!selectedNodes || selectedNodes.length === 0) {
    return [];
  }

  if (selectedNodes.some((selectedNode) => selectedNode === node || isSameNoteNode(selectedNode, node))) {
    return selectedNodes;
  }

  if (selectedNodes.length > 1) {
    return selectedNodes;
  }

  return node ? [node] : selectedNodes;
}

function getTreeSelectionForNode(node: any, selectedNodes?: any[]): readonly any[] {
  const resolvedSelection = resolveCommandSelection(node, selectedNodes);
  if (resolvedSelection.length > 0) {
    return resolvedSelection;
  }

  const selections = [
    getMyNotesTreeView()?.selection || [],
    getTeamNotesTreeView()?.selection || [],
    getHistoryTreeView()?.selection || [],
  ];

  for (const selection of selections) {
    if (selection.some((selectedNode) => selectedNode === node || isSameNoteNode(selectedNode, node))) {
      return selection;
    }

    if (selection.length > 1) {
      return selection;
    }
  }

  return node ? [node] : [];
}

async function performFolderMove(folder: ResolvedFolderSelection, targetFolderId: string | null): Promise<void> {
  const normalizedFolderId = normalizeFolderId(folder.id);
  const pendingContainerId = normalizedFolderId ? `folder-${normalizedFolderId}` : undefined;
  const normalizedTargetFolderId = normalizeFolderId(targetFolderId) || null;
  const payload = {
    parentFolderId: normalizedTargetFolderId,
  };

  if (folder.teamPath) {
    const provider = getTeamNotesProvider();
    if (pendingContainerId) {
      provider?.setPendingContainer(pendingContainerId);
    }
    try {
      await recordUsage(API.updateTeamFolder(folder.teamPath, folder.id, payload, { unwrapData: false }));
      provider?.moveFolderInCache(folder.teamPath, folder.id, normalizedTargetFolderId);
    } finally {
      if (pendingContainerId) {
        provider?.clearPendingContainer(pendingContainerId);
      }
    }
  } else {
    const provider = getMyNotesProvider();
    if (pendingContainerId) {
      provider?.setPendingContainer(pendingContainerId);
    }
    try {
      await recordUsage(API.updateFolder(folder.id, payload, { unwrapData: false }));
      provider?.moveFolderInCache(folder.id, normalizedTargetFolderId);
    } finally {
      if (pendingContainerId) {
        provider?.clearPendingContainer(pendingContainerId);
      }
    }
  }
}

async function closeTabsForNote(note: Note): Promise<boolean> {
  const targetUri = generateResourceUri(note.title || (note as any).shortId || 'Untitled', note.id, note.teamPath, (note as any).folderPaths);
  const targetUriString = targetUri.toString();
  const tabsToClose: vscode.Tab[] = [];

  console.log('[closeTabsForNote] targetUri:', targetUriString);

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const input = tab.input as any;
      if (input.viewType === "mainThreadWebview-markdown.preview"
        || input?.uri?.toString() === targetUriString) {
        tabsToClose.push(tab);
      }
    }
  }

  return await vscode.window.tabGroups.close(tabsToClose);
}

// Helper function to reveal and select a note after creation
async function revealNote(treeView: vscode.TreeView<any> | undefined, noteNode: any) {
  if (!treeView || !noteNode) return;

  try {
    // Reveal and select the note
    // VS Code will automatically expand all parents (team, folders) as needed
    // using getParent() to find the path
    await treeView.reveal(noteNode, { select: true, focus: true, expand: 1 });
  } catch (error) {
    console.error('Failed to reveal note:', error);
  }
}

async function openNoteEditorByUri(uri: vscode.Uri): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.One,
  });
}

async function openMarkdownPreview(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand(
    'markdown.showPreview',
    uri
  );
}

async function openSideBySideForUri(uri: vscode.Uri): Promise<void> {
  // Let VS Code decide editor tab placement/reuse naturally.
  await openNoteEditorByUri(uri);

  // Open preview beside and let VS Code handle preview-tab behavior.
  await vscode.commands.executeCommand(
    'markdown.showPreviewToSide',
    uri
  );
}

interface MoveTargetQuickPickItem extends vscode.QuickPickItem {
  folderId: string;
  folderPaths: any[];
}

const NOTE_DRAG_MIME_TYPE = 'text/uri-list';

/**
 * Shared implementation for moving a note to a specific folder.
 * Used by both the "Move to..." command and the drag-and-drop controller.
 */
async function performMove(note: Note, targetFolderId: string, targetFolderPaths: any[]): Promise<void> {
  const myProv = getMyNotesProvider();
  const teamProv = getTeamNotesProvider();
  const histProv = getHistoryProvider();
  const treeView = note.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
  const noteId = note.id;
  const teamPath = note.teamPath;
  let pendingCleared = false;

  if (teamPath) {
    teamProv?.setPendingNote(noteId, note);
  } else {
    myProv?.setPendingNote(noteId, note);
  }
  histProv?.setPendingNote(noteId, note);

  let noteForClear: Note = note;

  try {
    const payload = { parentFolderId: targetFolderId };
    if (teamPath) {
      await recordUsage(API.updateTeamNote(teamPath, noteId, payload, { unwrapData: false }));
    } else {
      await recordUsage(API.updateNote(noteId, payload, { unwrapData: false }));
    }

    const updatedNote = { ...note, parentFolderId: targetFolderId, folderPaths: targetFolderPaths } as Note;
    noteForClear = updatedNote;

    // 1) Clear pending state without emitting refresh events.
    if (teamPath) {
      teamProv?.clearPendingNote(noteId, noteForClear, false);
    } else {
      myProv?.clearPendingNote(noteId, noteForClear, false);
    }
    histProv?.clearPendingNote(noteId, noteForClear, false);
    pendingCleared = true;

    // 2) Update tree model without emitting refresh events.
    const oldNote = teamPath
      ? teamProv?.updateNoteInCache(noteId, updatedNote, teamPath, false)
      : myProv?.updateNoteInCache(noteId, updatedNote, false);
    // Emit update for Recent Notes (if this note is shown there) to clear spinner.
    histProv?.updateNoteInCache(noteId, updatedNote, true);

    // 3) Emit deduplicated tree change events for old/new containers.
    if (teamPath) {
      if (oldNote) teamProv?.emitMoveChangeEvents(oldNote, updatedNote);
    } else {
      if (oldNote) myProv?.emitMoveChangeEvents(oldNote, updatedNote);
    }
    getPropertiesProvider()?.updateCurrentNote(noteId, updatedNote as any);
    await revealNote(treeView, { type: 'note', note: updatedNote });
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to move note: ${error.message || 'Unknown error'}`);
  } finally {
    if (!pendingCleared) {
      if (teamPath) {
        teamProv?.clearPendingNote(noteId, noteForClear);
      } else {
        myProv?.clearPendingNote(noteId, noteForClear);
      }
      histProv?.clearPendingNote(noteId, noteForClear);
    }
  }
}

interface ResolvedDropContainer {
  teamPath: string | null;
  folderId: string | null;
  folderPaths: any[];
}

function getNoteFolderId(note: Note): string | null {
  if (note.folderPaths && note.folderPaths.length > 0) {
    return note.folderPaths[note.folderPaths.length - 1].id;
  }

  return ((note as any).parentFolderId as string | null | undefined) ?? null;
}

function getFolderPathsForContainer(teamPath: string | null, folderId: string | null): any[] {
  if (!folderId) {
    return [];
  }

  if (teamPath) {
    const teamProv = getTeamNotesProvider();
    const targets = teamProv?.getMoveFolderTargetsFromCache(teamPath) || [];
    return targets.find((t) => t.folderId === folderId)?.folderPaths ?? [];
  }

  const myProv = getMyNotesProvider();
  const targets = myProv?.getMoveFolderTargetsFromCache() || [];
  return targets.find((t) => t.folderId === folderId)?.folderPaths ?? [];
}

function hydrateDraggedNote(note: Note): Note {
  const noteId = note.id;
  const noteTeamPath: string | null = ((note as any).teamPath as string | null | undefined) ?? null;
  const myProv = getMyNotesProvider();
  const teamProv = getTeamNotesProvider();
  const historyProv = getHistoryProvider();

  const cached = noteTeamPath
    ? (teamProv?.findNoteInCache(noteId, noteTeamPath) || historyProv?.findNoteInCache(noteId))
    : (myProv?.findNoteInCache(noteId) || teamProv?.findNoteInCache(noteId) || historyProv?.findNoteInCache(noteId));

  if (!cached) {
    return note;
  }

  return {
    ...cached,
    ...note,
    teamPath: ((note as any).teamPath ?? (cached as any).teamPath),
    folderPaths: (note.folderPaths && note.folderPaths.length > 0)
      ? note.folderPaths
      : ((cached as any).folderPaths || []),
  } as Note;
}

async function getDraggedNotesFromDataTransfer(dataTransfer: vscode.DataTransfer): Promise<Note[]> {
  const preferred = dataTransfer.get(NOTE_DRAG_MIME_TYPE);
  if (!preferred) {
    return [];
  }

  const raw = await preferred.asString();

  if (preferred) {
    try {
      const uriList = raw
        .split(/\r\n|\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      const notes: Note[] = [];
      for (const uriText of uriList) {
        try {
          const uri = vscode.Uri.parse(uriText);
          if (uri.scheme !== 'hackmd') {
            continue;
          }

          const noteId = getNoteIdFromUri(uri);
          if (!noteId) {
            continue;
          }

          notes.push({
            id: noteId,
            teamPath: getTeamPathFromUri(uri),
            folderPaths: [],
          } as Note);
        } catch {
          // Skip malformed URI entries.
        }
      }

      if (notes.length > 0) {
        return notes;
      }
    } catch {
      // No valid payload.
    }
  }

  return [];
}

type DraggedFolder = {
  id: string;
  teamPath: string | null;
  name?: string;
};

async function getDraggedFoldersFromDataTransfer(dataTransfer: vscode.DataTransfer): Promise<DraggedFolder[]> {
  const preferred = dataTransfer.get(NOTE_DRAG_MIME_TYPE);
  if (!preferred) {
    return [];
  }

  const raw = await preferred.asString();

  try {
    const uriList = raw
      .split(/\r\n|\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const folders: DraggedFolder[] = [];
    for (const uriText of uriList) {
      try {
        const uri = vscode.Uri.parse(uriText);
        if (uri.scheme !== 'hackmd') {
          continue;
        }

        const folderId = getFolderIdFromUri(uri);
        if (!folderId) {
          continue;
        }

        folders.push({
          id: folderId,
          teamPath: getTeamPathFromUri(uri),
          name: path.basename(uri.path || ''),
        });
      } catch {
        // Skip malformed URI entries.
      }
    }

    return folders;
  } catch {
    return [];
  }
}

function resolveDropContainer(target: any | undefined): ResolvedDropContainer | null {
  if (!target) {
    return null;
  }

  if (target.type === 'folder') {
    const teamPath = target.teamPath ?? null;
    const folderPaths = getFolderPathsForContainer(teamPath, target.id);

    return {
      teamPath,
      folderId: target.id,
      folderPaths,
    };
  }

  if (target.type === 'note') {
    const note = hydrateDraggedNote(target.note as Note);
    const folderId = getNoteFolderId(note);
    return {
      teamPath: ((note as any).teamPath as string | null | undefined) ?? null,
      folderId,
      folderPaths: (note.folderPaths && note.folderPaths.length > 0)
        ? note.folderPaths
        : getFolderPathsForContainer((((note as any).teamPath as string | null | undefined) ?? null), folderId),
    };
  }

  if (target.type === 'team') {
    return {
      teamPath: target.team?.path ?? null,
      folderId: null,
      folderPaths: [],
    };
  }

  return null;
}

function isFolderInTargetPath(draggedFolderId: string, targetFolderPaths: any[]): boolean {
  return targetFolderPaths.some((entry) => entry?.id === draggedFolderId);
}

async function moveFolderToTarget(folder: DraggedFolder, target: ResolvedDropContainer): Promise<void> {
  const normalizedFolderId = normalizeFolderId(folder.id);
  const pendingContainerId = normalizedFolderId ? `folder-${normalizedFolderId}` : undefined;
  const normalizedTargetFolderId = normalizeFolderId(target.folderId) || null;
  const payload = {
    parentFolderId: normalizedTargetFolderId,
  };

  if (folder.teamPath) {
    const provider = getTeamNotesProvider();
    if (pendingContainerId) {
      provider?.setPendingContainer(pendingContainerId);
    }
    try {
      await recordUsage(API.updateTeamFolder(folder.teamPath, folder.id, payload, { unwrapData: false }));
      provider?.moveFolderInCache(folder.teamPath, folder.id, normalizedTargetFolderId);
    } finally {
      if (pendingContainerId) {
        provider?.clearPendingContainer(pendingContainerId);
      }
    }
  } else {
    const provider = getMyNotesProvider();
    if (pendingContainerId) {
      provider?.setPendingContainer(pendingContainerId);
    }
    try {
      await recordUsage(API.updateFolder(folder.id, payload, { unwrapData: false }));
      provider?.moveFolderInCache(folder.id, normalizedTargetFolderId);
    } finally {
      if (pendingContainerId) {
        provider?.clearPendingContainer(pendingContainerId);
      }
    }
  }
}

/**
 * Drag-and-drop controller shared by all HackMD tree views.
 * Note and folder nodes are draggable. Drops on notes resolve to that note's container.
 */
export class NoteDragAndDropController implements vscode.TreeDragAndDropController<any> {
  readonly dragMimeTypes = [NOTE_DRAG_MIME_TYPE];
  readonly dropMimeTypes: string[];

  constructor(allowDrops = true) {
    this.dropMimeTypes = allowDrops ? [NOTE_DRAG_MIME_TYPE] : [];
  }

  handleDrag(source: any[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
    if (source.length === 0) {
      return;
    }

    const allNotes = source.every((node) => node.type === 'note');
    const allFolders = source.every((node) => node.type === 'folder');
    if (!allNotes && !allFolders) {
      return;
    }

    if (allFolders) {
      const folders = source.map((node) => ({
        id: node.id,
        teamPath: node.teamPath ?? null,
        name: node.name,
      })) as DraggedFolder[];

      if (!folders.every((folder) => (folder.teamPath || null) === (folders[0].teamPath || null))) {
        return;
      }

      const uriList = folders
        .map((folder) => {
          const label = folder.name || 'Folder';
          return generateFolderResourceUri(label, folder.id, folder.teamPath).toString();
        })
        .join('\r\n');

      dataTransfer.set(NOTE_DRAG_MIME_TYPE, new vscode.DataTransferItem(uriList));
      return;
    }

    const notes = source.map((node) => node.note);
    if (!notes.every((note) => isSameNoteScope(note, notes[0]))) {
      return;
    }

    const uriList = notes
      .map((note) => {
        const label = note.title || note.shortId || 'Untitled';
        return generateResourceUri(label, note.id, note.teamPath, (note as any).folderPaths).toString();
      })
      .join('\r\n');

    dataTransfer.set(NOTE_DRAG_MIME_TYPE, new vscode.DataTransferItem(uriList));
  }

  async handleDrop(target: any | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    const warnCannotMove = () => {
      vscode.window.showWarningMessage('This note cannot be moved here.');
    };

    const draggedFolders = await getDraggedFoldersFromDataTransfer(dataTransfer);
    if (draggedFolders.length > 0) {
      const resolvedTarget = resolveDropContainer(target);
      if (!resolvedTarget) {
        vscode.window.showWarningMessage('This folder cannot be moved here.');
        return;
      }

      const foldersToMove: DraggedFolder[] = [];
      for (const folder of draggedFolders) {
        if ((folder.teamPath || null) !== (resolvedTarget.teamPath || null)) {
          continue;
        }

        // Prevent folder -> itself and folder -> descendant moves.
        if (resolvedTarget.folderId === folder.id || isFolderInTargetPath(folder.id, resolvedTarget.folderPaths)) {
          continue;
        }

        foldersToMove.push(folder);
      }

      if (foldersToMove.length === 0) {
        vscode.window.showWarningMessage('This folder cannot be moved here.');
        return;
      }

      try {
        await Promise.all(foldersToMove.map((folder) => moveFolderToTarget(folder, resolvedTarget)));
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to move folder: ${error.message || 'Unknown error'}`);
      }
      return;
    }

    const draggedNotes = await getDraggedNotesFromDataTransfer(dataTransfer);
    if (draggedNotes.length === 0) {
      warnCannotMove();
      return;
    }

    const resolvedTarget = resolveDropContainer(target);
    if (!resolvedTarget) {
      warnCannotMove();
      return;
    }

    const notesToMove: Note[] = [];

    for (const dragged of draggedNotes) {
      const hydrated = hydrateDraggedNote(dragged);
      // Recent Notes payloads may omit teamPath. In that case, infer scope from the
      // drop target so valid moves are attempted and backend authorization decides.
      const note = (((hydrated as any).teamPath as string | null | undefined) === undefined || ((hydrated as any).teamPath as string | null | undefined) === null)
        ? ({ ...hydrated, teamPath: resolvedTarget.teamPath } as Note)
        : hydrated;
      const noteTeamPath: string | null = ((note as any).teamPath as string | null | undefined) ?? null;
      const currentFolderId = getNoteFolderId(note);

      // Reject cross-scope drops (personal ↔ team, or different teams).
      if (noteTeamPath !== resolvedTarget.teamPath) {
        warnCannotMove();
        continue;
      }

      // If this note is already in the resolved container, do nothing.
      if (currentFolderId === resolvedTarget.folderId) {
        continue;
      }

      // Moving to root containers is not currently supported by HackMD API behavior.
      if (!resolvedTarget.folderId) {
        warnCannotMove();
        continue;
      }

      const canProceed = await closeTabsForNote(note);
      if (!canProceed) {
        continue;
      }

      notesToMove.push(note);
    }

    if (notesToMove.length === 0 || !resolvedTarget.folderId) {
      return;
    }

    await Promise.all(notesToMove.map((note) =>
      performMove(note, resolvedTarget.folderId as string, resolvedTarget.folderPaths)
    ));
  }
}

export async function registerTreeViewCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshMyNotes', async () => {
      const provider = getMyNotesProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshHistory', async () => {
      const provider = getHistoryProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshTeamNotes', async () => {
      const provider = getTeamNotesProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshSelectedTeam', async (node: any) => {
      if (!node || node.type !== 'team') {
        return;
      }

      const provider = getTeamNotesProvider();
      if (!provider) {
        return;
      }

      const teamId = node.team?.id as string | undefined;
      if (!teamId || !provider.isTeamNotesCached(teamId)) {
        return;
      }

      provider.refreshElement(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.createMyNotes', async () => {
      const provider = getMyNotesProvider();

      // Set pending on "My Notes" root
      provider?.setPendingContainer('root');

      try {
        await vscode.window.withProgress(
          {
            location: { viewId: 'hackmd.tree.my-notes' },
            title: 'Creating note...',
          },
          async () => {
            const note = await recordUsage(API.createNote({}, { unwrapData: false }));

            const uri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
            await openNoteEditorByUri(uri);

            if (provider) {
              const noteNode = await provider.addNoteToCache(note);
              await revealNote(getMyNotesTreeView(), noteNode);
            }
          }
        );
      } finally {
        // Clear pending state
        provider?.clearPendingContainer('root');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.createMyFolder', async () => {
      await createFolderInScope({});
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.importMyNotes', async () => {
      const importDataList = await pickMarkdownImportData();
      if (importDataList.length === 0) {
        return;
      }

      const provider = getMyNotesProvider();
      provider?.setPendingContainer('root');

      try {
        await vscode.window.withProgress(
          {
            location: { viewId: 'hackmd.tree.my-notes' },
            title: `Importing ${importDataList.length} note${importDataList.length === 1 ? '' : 's'}...`,
          },
          async () => {
            for (const importData of importDataList) {
              await createNoteInScope(importData, { openEditor: false });
            }
          }
        );
      } finally {
        provider?.clearPendingContainer('root');
      }
    })
  );

  // HackMD.renameNote
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.renameNote', async (node: any) => {
      if (node && node.type === 'note') {
        const note = node.note;
        const noteId = note.id;
        const currentTitle = note.title || note.shortId || 'Unnamed';

        const oldUriForRename = generateResourceUri(currentTitle, noteId, note.teamPath, (note as any).folderPaths);

        // Close all open tabs (editors and previews) for this note first. If user cancels, abort rename.
        const canClose = await closeTabsForNote(note);
        if (!canClose) {
          return;
        }

        // Ask for the new name only after open tabs are successfully closed.
        const newTitle = await vscode.window.showInputBox({
          prompt: 'Enter new note name',
          value: currentTitle,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Note name cannot be empty';
            }
            return null;
          }
        });

        const trimmedNewTitle = newTitle?.trim();
        if (!trimmedNewTitle || trimmedNewTitle === currentTitle) {
          return; // User cancelled or no change
        }

        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        // Set pending state
        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(noteId, note);
        } else {
          myNotesProvider?.setPendingNote(noteId, note);
        }
        historyProvider?.setPendingNote(noteId, note);

        try {
          // Update note via API - use 'title' field
          // Note: TypeScript types are restrictive but API accepts more fields
          if (note.teamPath) {
            await recordUsage(
              API.updateTeamNote(note.teamPath, noteId, { title: trimmedNewTitle } as any)
            );
          } else {
            await recordUsage(
              API.updateNote(noteId, { title: trimmedNewTitle } as any, { unwrapData: false })
            );
          }

          // Update the title in the cached note object directly
          // API response might not include the updated note, so we update locally
          const updatedNote = { ...note, title: trimmedNewTitle };

          if (note.teamPath) {
            teamNotesProvider?.updateNoteInCache(noteId, updatedNote, note.teamPath);
          } else {
            myNotesProvider?.updateNoteInCache(noteId, updatedNote);
          }
          historyProvider?.updateNoteInCache(noteId, updatedNote);
          getPropertiesProvider()?.updateCurrentNote(noteId, updatedNote as any);

          // Perform virtual FS rename to move URI identity to the new title path.
          const newUri = generateResourceUri(trimmedNewTitle, noteId, note.teamPath, (note as any).folderPaths);
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(oldUriForRename, newUri, { overwrite: true });
          await vscode.workspace.applyEdit(edit);
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to rename note: ${error.message}`);
        } finally {
          // Clear pending state
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, note);
          }
          historyProvider?.clearPendingNote(noteId, note);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.moveNoteTo', async (node: any, selectedNodes?: any[]) => {
      const selection = resolveOperationSelection(node, selectedNodes);
      if (selection.hasUnsupportedNodes || (selection.notes.length === 0 && selection.folders.length === 0)) {
        vscode.window.showInformationMessage('Move is only available for note and folder selections.');
        return;
      }

      if (!selection.hasSingleScope) {
        vscode.window.showInformationMessage('Move is only available when selected items belong to one scope.');
        return;
      }

      const selectedNotes = selection.notes;
      const selectedFolders = selection.folders;
      const teamPath = selectedNotes[0]?.teamPath ?? selectedFolders[0]?.teamPath ?? null;

      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const folderTargets = teamPath
        ? (teamNotesProvider?.getMoveFolderTargetsFromCache(teamPath) || [])
        : (myNotesProvider?.getMoveFolderTargetsFromCache() || []);

      if (folderTargets.length === 0) {
        vscode.window.showInformationMessage('No folders are available in this scope.');
        return;
      }

      const filteredTargets = folderTargets.filter((target) =>
        selectedNotes.some((selectedNote) => getNoteFolderId(selectedNote) !== target.folderId)
        || selectedFolders.some((selectedFolder) => {
          const isSameParent = selectedFolder.parentId === target.folderId;
          const targetInsideDraggedFolder = target.folderPaths.some((entry) => entry?.id === selectedFolder.id);
          return !isSameParent && !targetInsideDraggedFolder;
        })
      );

      if (filteredTargets.length === 0) {
        vscode.window.showInformationMessage('No valid destination folder is available for the current selection.');
        return;
      }

      const pickerItems: MoveTargetQuickPickItem[] = filteredTargets.map((target) => ({
        label: target.label,
        folderId: target.folderId,
        folderPaths: target.folderPaths,
      }));

      const selected = await vscode.window.showQuickPick(pickerItems, {
        placeHolder: 'Move note to...',
        ignoreFocusOut: true,
      });

      if (!selected) {
        return;
      }

      const notesToMove = selectedNotes.filter((selectedNote) => getNoteFolderId(selectedNote) !== selected.folderId);
      const foldersToMove = selectedFolders.filter((selectedFolder) => {
        const isSameParent = selectedFolder.parentId === selected.folderId;
        const targetInsideDraggedFolder = selected.folderPaths.some((entry) => entry?.id === selectedFolder.id);
        return !isSameParent && !targetInsideDraggedFolder;
      });

      if (notesToMove.length === 0 && foldersToMove.length === 0) {
        return;
      }

      for (const selectedNote of notesToMove) {
        const canProceed = await closeTabsForNote(selectedNote);
        if (!canProceed) {
          return;
        }
        await performMove(selectedNote, selected.folderId, selected.folderPaths);
      }

      if (foldersToMove.length > 0) {
        try {
          await Promise.all(foldersToMove.map((folder) => performFolderMove(folder, selected.folderId)));
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to move folder: ${error.message || 'Unknown error'}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.duplicateNote', async (node: any) => {
      if (!node || node.type !== 'note') {
        return;
      }

      const sourceNote = node.note as Note;
      const teamPath = sourceNote.teamPath || null;
      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const historyProvider = getHistoryProvider();

      if (teamPath) {
        teamNotesProvider?.setPendingNote(sourceNote.id, sourceNote);
      } else {
        myNotesProvider?.setPendingNote(sourceNote.id, sourceNote);
      }
      historyProvider?.setPendingNote(sourceNote.id, sourceNote);

      try {
        const fetchedNote = await recordUsage(API.getNote(sourceNote.id, { unwrapData: false }));
        const folderPaths = ((fetchedNote as any).folderPaths || (sourceNote as any).folderPaths || []) as any[];
        const parentFolderId = folderPaths.length > 0
          ? normalizeFolderId(folderPaths[folderPaths.length - 1].id)
          : undefined;

        const payload: Record<string, any> = {
          title: sourceNote.title || fetchedNote.title || 'Untitled',
          content: fetchedNote.content || '',
        };

        if (parentFolderId) {
          payload.parentFolderId = parentFolderId;
        }

        await createNoteInScope(payload, { teamPath, openEditor: false });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to duplicate note: ${error.message}`);
      } finally {
        if (teamPath) {
          teamNotesProvider?.clearPendingNote(sourceNote.id, sourceNote);
        } else {
          myNotesProvider?.clearPendingNote(sourceNote.id, sourceNote);
        }
        historyProvider?.clearPendingNote(sourceNote.id, sourceNote);
      }
    })
  );

  // HackMD.deleteMyNote
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.deleteMyNote', async (node: any, selectedNodes?: any[]) => {
      const selection = resolveOperationSelection(node, selectedNodes);
      if (selection.hasUnsupportedNodes || (selection.notes.length === 0 && selection.folders.length === 0)) {
        vscode.window.showInformationMessage('Delete is only available for note and folder selections.');
        return;
      }

      const selectedNotes = selection.notes;
      const selectedFolders = selection.folders;
      const selectedCount = selectedNotes.length + selectedFolders.length;

      const confirm = await vscode.window.showWarningMessage(
        selectedCount === 1
          ? 'Are you sure to delete this item?'
          : `Are you sure to delete these ${selectedCount} items?`,
        { modal: true },
        'Yes'
      );

      if (!confirm) {
        return;
      }

      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const historyProvider = getHistoryProvider();

      for (const note of selectedNotes) {
        const noteId = note.id;
        const teamPath = note.teamPath;

        if (teamPath) {
          teamNotesProvider?.setPendingNote(noteId, note);
        } else {
          myNotesProvider?.setPendingNote(noteId, note);
        }
        historyProvider?.setPendingNote(noteId, note);
      }

      for (const folder of selectedFolders) {
        const provider = folder.teamPath ? teamNotesProvider : myNotesProvider;
        provider?.setPendingContainer(`folder-${folder.id}`);
      }

      const noteResults = await Promise.allSettled(selectedNotes.map(async (note) => {
        const noteId = note.id;
        const teamPath = note.teamPath;

        if (teamPath) {
          await recordUsage(API.deleteTeamNote(teamPath, noteId, { unwrapData: false }));
        } else {
          await recordUsage(API.deleteNote(noteId, { unwrapData: false }));
        }

        await closeTabsForNote(note);

        if (teamPath) {
          teamNotesProvider?.removeNoteFromCache(noteId, teamPath);
        } else {
          myNotesProvider?.removeNoteFromCache(noteId);
        }
        historyProvider?.removeNoteFromCache(noteId);
      }));

      const folderResults = await Promise.allSettled(selectedFolders.map(async (folder) => {
        if (folder.teamPath) {
          await recordUsage(API.deleteTeamFolder(folder.teamPath, folder.id, { unwrapData: false }));
        } else {
          await recordUsage(API.deleteFolder(folder.id, { unwrapData: false }));
        }
      }));

      folderResults.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
          return;
        }

        const folder = selectedFolders[index];
        if (folder.teamPath) {
          teamNotesProvider?.removeFolderFromCache(folder.teamPath, folder.id);
        } else {
          myNotesProvider?.removeFolderFromCache(folder.id);
        }
      });

      for (const note of selectedNotes) {
        if (note.teamPath) {
          teamNotesProvider?.clearPendingNote(note.id, note);
        } else {
          myNotesProvider?.clearPendingNote(note.id, note);
        }
        historyProvider?.clearPendingNote(note.id, note);
      }

      for (const folder of selectedFolders) {
        const provider = folder.teamPath ? teamNotesProvider : myNotesProvider;
        provider?.clearPendingContainer(`folder-${folder.id}`);
      }

      const failedResults = [
        ...noteResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected'),
        ...folderResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected'),
      ];
      if (failedResults.length > 0) {
        const message = failedResults[0].reason instanceof Error
          ? failedResults[0].reason.message
          : String(failedResults[0].reason);
        vscode.window.showErrorMessage(
          failedResults.length === 1
            ? `Failed to delete item: ${message}`
            : `Failed to delete ${failedResults.length} items. First error: ${message}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clickTreeItem', async (note: any) => {
      if (note) {
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        const noteId = note.id;
        const label = note.title || note.shortId || 'Unnamed';

        // Set pending state BEFORE opening - use note object for immediate granular update
        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(noteId, note);
        } else {
          myNotesProvider?.setPendingNote(noteId, note);
        }
        historyProvider?.setPendingNote(noteId, note);

        try {
          const uri = generateResourceUri(label, noteId, note.teamPath, (note as any).folderPaths);
          await openNoteEditorByUri(uri);
        } finally {
          // Clear pending state
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, note);
          }
          historyProvider?.clearPendingNote(noteId, note);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.editNote', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(note.id, note);
        } else {
          myNotesProvider?.setPendingNote(note.id, note);
        }
        historyProvider?.setPendingNote(note.id, note);

        try {
          const uri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
          await openNoteEditorByUri(uri);
        } finally {
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(note.id, note);
          } else {
            myNotesProvider?.clearPendingNote(note.id, note);
          }
          historyProvider?.clearPendingNote(note.id, note);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.openNoteProperties', async (noteNode: any) => {
      if (!noteNode || noteNode.type !== 'note') {
        return;
      }
      const noteId: string = noteNode.note?.id;
      const teamPath: string | null = noteNode.note?.teamPath || null;
      if (!noteId) {
        return;
      }
      await vscode.commands.executeCommand('hackmd.ui.properties', { noteId, teamPath });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.exportNote', async (noteNode: any, selectedNodes?: any[]) => {
      const selection = resolveOperationSelection(noteNode, selectedNodes);
      if (selection.hasUnsupportedNodes || (selection.notes.length === 0 && selection.folders.length === 0)) {
        vscode.window.showInformationMessage('Export is only available for note and folder selections.');
        return;
      }

      const selectedNotes = selection.notes;
      const selectedFolders = selection.folders;

      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const historyProvider = getHistoryProvider();
      const defaultDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      let targetUri: vscode.Uri | undefined;
      let exportDirectoryUri: vscode.Uri | undefined;

      if (selectedFolders.length === 0 && selectedNotes.length === 1) {
        const exportFileName = getExportFileName(selectedNotes[0]);
        targetUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(defaultDirectory, exportFileName)),
          filters: {
            Markdown: ['md'],
          },
          saveLabel: 'Export Note',
        });
      } else {
        exportDirectoryUri = (await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(defaultDirectory),
          openLabel: 'Export Notes',
        }))?.[0];
      }

      if (!targetUri && !exportDirectoryUri) {
        return;
      }

      for (const note of selectedNotes) {
        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(note.id, note);
        } else {
          myNotesProvider?.setPendingNote(note.id, note);
        }
        historyProvider?.setPendingNote(note.id, note);
      }

      for (const folder of selectedFolders) {
        const provider = folder.teamPath ? teamNotesProvider : myNotesProvider;
        provider?.setPendingContainer(`folder-${folder.id}`);
      }

      try {
        if (targetUri) {
          const note = selectedNotes[0];
          const sourceUri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
          const document = await vscode.workspace.openTextDocument(sourceUri);
          await vscode.workspace.fs.writeFile(targetUri, Buffer.from(document.getText(), 'utf8'));
        } else if (exportDirectoryUri) {
          const usedNames = await getUsedNamesForDirectory(exportDirectoryUri);
          for (const note of selectedNotes) {
            const sourceUri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
            const document = await vscode.workspace.openTextDocument(sourceUri);
            const fileName = getUniqueMarkdownFileName(note.title || note.shortId || 'Untitled', usedNames);
            const fileUri = vscode.Uri.joinPath(exportDirectoryUri, fileName);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(document.getText(), 'utf8'));
          }

          for (const folder of selectedFolders) {
            await exportFolderNotesRecursively({
              folderId: folder.id,
              folderName: folder.name,
              teamPath: folder.teamPath,
              destinationParentUri: exportDirectoryUri,
            });
          }
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to export selection: ${error.message}`);
      } finally {
        for (const note of selectedNotes) {
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(note.id, note);
          } else {
            myNotesProvider?.clearPendingNote(note.id, note);
          }
          historyProvider?.clearPendingNote(note.id, note);
        }

        for (const folder of selectedFolders) {
          const provider = folder.teamPath ? teamNotesProvider : myNotesProvider;
          provider?.clearPendingContainer(`folder-${folder.id}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.selectTeam', async () => {
      const teams = await recordUsage(API.getTeams({ unwrapData: false }));

      const getTeamLabel = (team: Team) => `${team.name} [${team.path}]`;

      await vscode.window.showQuickPick(teams.map(getTeamLabel)).then((selectedTeam) => {
        if (!selectedTeam) {
          return;
        }

        const selectedTeamId = teams.find((team) => getTeamLabel(team) === selectedTeam)?.id;

        const { setSelectedTeamId } = teamNotesStore.getState();
        setSelectedTeamId(selectedTeamId);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.showPreview', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(note.id, note);
        } else {
          myNotesProvider?.setPendingNote(note.id, note);
        }
        historyProvider?.setPendingNote(note.id, note);

        try {
          const uri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
          await openMarkdownPreview(uri);
        } finally {
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(note.id, note);
          } else {
            myNotesProvider?.clearPendingNote(note.id, note);
          }
          historyProvider?.clearPendingNote(note.id, note);
        }
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!checkEditorExist(editor)) {
          return;
        }

        const noteId = getNoteIdFromUri(editor.document.uri);
        if (!checkNoteIdExist(noteId)) {
          return;
        }

        const lastIndex = editor.document.fileName.lastIndexOf('.');
        const fileName = editor.document.fileName.slice(0, lastIndex + 1);
        const uri = generateResourceUri(fileName, noteId);
        await openMarkdownPreview(uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.showPreviewAndEditor', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(note.id, note);
        } else {
          myNotesProvider?.setPendingNote(note.id, note);
        }
        historyProvider?.setPendingNote(note.id, note);

        try {
          const uri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
          await openSideBySideForUri(uri);
        } finally {
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(note.id, note);
          } else {
            myNotesProvider?.clearPendingNote(note.id, note);
          }
          historyProvider?.clearPendingNote(note.id, note);
        }
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!checkEditorExist(editor)) {
          return;
        }

        const noteId = getNoteIdFromUri(editor.document.uri);
        if (!checkNoteIdExist(noteId)) {
          return;
        }

        const lastIndex = editor.document.fileName.lastIndexOf('.');
        const fileName = editor.document.fileName.slice(0, lastIndex + 1);
        const uri = generateResourceUri(fileName, noteId);
        await openSideBySideForUri(uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HacKMD.openNoteOnHackMD', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        vscode.env.openExternal(vscode.Uri.parse(note.publishLink));
      } else {
        const noteId = getNoteIdFromUri(vscode.window.activeTextEditor.document.uri);

        const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));

        if (note && note.publishLink) {
          vscode.env.openExternal(vscode.Uri.parse(note.publishLink));
        }
      }
    })
  );

  // Folder and team commands
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.createNote', async (node: any) => {
      if (node) {
        // Extract properties from node object based on type
        let folderId, teamPath;

        if (node.type === 'folder') {
          folderId = normalizeFolderId(node.id);
          teamPath = node.teamPath;
        } else {
          // Fallback for React tree nodes
          folderId = normalizeFolderId(node.value?.context?.folderId || node.folderId || node.id);
          teamPath = node.value?.context?.teamPath || node.teamPath;
        }
        const payload = folderId ? { parentFolderId: folderId } : {};

        // Determine container ID for pending state
        const containerId = folderId ? `folder-${folderId}` : 'root';

        // Set pending state on appropriate provider
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const provider = teamPath ? teamNotesProvider : myNotesProvider;

        provider?.setPendingContainer(containerId);

        try {
          await createNoteInScope(payload, { teamPath });
        } finally {
          // Clear pending state
          provider?.clearPendingContainer(containerId);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.createFolder', async (node: any) => {
      const { folderId, teamPath } = resolveFolderCommandContext(node);
      await createFolderInScope({ teamPath, parentFolderId: folderId });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.importNote', async (node: any) => {
      if (!node) {
        return;
      }

      let folderId, teamPath;

      if (node.type === 'folder') {
        folderId = normalizeFolderId(node.id);
        teamPath = node.teamPath;
      } else {
        folderId = normalizeFolderId(node.value?.context?.folderId || node.folderId || node.id);
        teamPath = node.value?.context?.teamPath || node.teamPath;
      }

      const importDataList = await pickMarkdownImportData();
      if (importDataList.length === 0) {
        return;
      }

      const payload = folderId ? { parentFolderId: folderId } : {};
      const containerId = folderId ? `folder-${folderId}` : 'root';
      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const provider = teamPath ? teamNotesProvider : myNotesProvider;

      provider?.setPendingContainer(containerId);

      try {
        for (const importData of importDataList) {
          await createNoteInScope({ ...importData, ...payload }, { teamPath, openEditor: false });
        }
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.openOnWeb', async (treeItem: any) => {
      if (treeItem) {
        // For React tree nodes, context is in value.context
        // For TreeDataProvider nodes, properties are directly on the item
        const folderClientId = treeItem.value?.context?.folderClientId || treeItem.folderClientId || treeItem.clientId;
        const teamPath = treeItem.value?.context?.teamPath || treeItem.teamPath;

        if (folderClientId) {
          const url = teamPath
            ? `https://hackmd.io/team/${teamPath}/folders/${folderClientId}`
            : `https://hackmd.io/folders/${folderClientId}`;
          vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          vscode.window.showErrorMessage('Folder client ID not found');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.exportNote', async (node: any) => {
      if (!node) {
        return;
      }

      const folderId = node.type === 'folder'
        ? normalizeFolderId(node.id)
        : normalizeFolderId(node.value?.context?.folderId || node.folderId || node.id);
      const folderName = node.type === 'folder'
        ? node.name
        : (node.value?.context?.name || node.name || 'Folder');
      const teamPath = node.type === 'folder'
        ? node.teamPath
        : (node.value?.context?.teamPath || node.teamPath);

      if (!folderId) {
        vscode.window.showErrorMessage('Folder ID not found');
        return;
      }

      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Export Folder',
      });

      const destinationParentUri = selection?.[0];
      if (!destinationParentUri) {
        return;
      }

      const containerId = `folder-${folderId}`;
      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const provider = teamPath ? teamNotesProvider : myNotesProvider;
      provider?.setPendingContainer(containerId);

      try {
        const result = await exportFolderNotesRecursively({
          folderId,
          folderName,
          teamPath,
          destinationParentUri,
        });

        vscode.window.showInformationMessage(
          `Exported ${result.exportedCount} note${result.exportedCount === 1 ? '' : 's'} to ${result.exportRootUri.fsPath}`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to export folder: ${error.message}`);
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.rename', async (node: any) => {
      const { folderId, folderName, teamPath } = resolveFolderCommandContext(node);
      if (!folderId) {
        vscode.window.showErrorMessage('Folder ID not found');
        return;
      }

      const newName = await promptFolderName(folderName);
      if (!newName || newName === folderName) {
        return;
      }

      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const provider = teamPath ? teamNotesProvider : myNotesProvider;
      const containerId = `folder-${folderId}`;

      provider?.setPendingContainer(containerId);
      try {
        if (teamPath) {
          await recordUsage(API.updateTeamFolder(teamPath, folderId, { name: newName }, { unwrapData: false }));
          teamNotesProvider?.renameFolderInCache(folderId, newName, teamPath);
        } else {
          await recordUsage(API.updateFolder(folderId, { name: newName }, { unwrapData: false }));
          myNotesProvider?.renameFolderInCache(folderId, newName);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to rename folder: ${error.message || 'Unknown error'}`);
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.delete', async (node: any) => {
      const { folderId, folderName, teamPath } = resolveFolderCommandContext(node);
      if (!folderId) {
        vscode.window.showErrorMessage('Folder ID not found');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure to delete folder \"${folderName}\"?`,
        { modal: true },
        'Yes'
      );
      if (!confirm) {
        return;
      }

      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const provider = teamPath ? teamNotesProvider : myNotesProvider;
      const containerId = `folder-${folderId}`;

      provider?.setPendingContainer(containerId);
      try {
        if (teamPath) {
          await recordUsage(API.deleteTeamFolder(teamPath, folderId, { unwrapData: false }));
          teamNotesProvider?.removeFolderFromCache(teamPath, folderId);
        } else {
          await recordUsage(API.deleteFolder(folderId, { unwrapData: false }));
          myNotesProvider?.removeFolderFromCache(folderId);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete folder: ${error.message || 'Unknown error'}`);
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );

  // Team note creation command
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.createNote', async (node: any) => {
      if (node) {
        // Extract teamPath from the node object
        const teamPath = node.team?.path;

        if (teamPath) {
          const provider = getTeamNotesProvider();
          const teamId = provider?.getTeamIdFromPath(teamPath);
          const containerId = `team-${teamId}`;

          // Set pending state on the team
          provider?.setPendingContainer(containerId);

          try {
            await createNoteInScope({}, { teamPath });
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to create team note: ${error.message}`);
          } finally {
            // Clear pending state
            provider?.clearPendingContainer(containerId);
          }
        } else {
          vscode.window.showErrorMessage('Team path not found');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.createFolder', async (node: any) => {
      const teamPath = node?.team?.path;
      if (!teamPath) {
        vscode.window.showErrorMessage('Team path not found');
        return;
      }

      await createFolderInScope({ teamPath });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.importNote', async (node: any) => {
      if (!node) {
        return;
      }

      const teamPath = node.team?.path;
      if (!teamPath) {
        vscode.window.showErrorMessage('Team path not found');
        return;
      }

      const importDataList = await pickMarkdownImportData();
      if (importDataList.length === 0) {
        return;
      }

      const provider = getTeamNotesProvider();
      const teamId = provider?.getTeamIdFromPath(teamPath);
      const containerId = `team-${teamId}`;

      provider?.setPendingContainer(containerId);

      try {
        for (const importData of importDataList) {
          await createNoteInScope(importData, { teamPath, openEditor: false });
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to import team note: ${error.message}`);
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.openOnHackMD', async (node: any) => {
      if (!node) {
        return;
      }
      const teamPath = node.team?.path;
      if (!teamPath) {
        vscode.window.showErrorMessage('Team path not found');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(`https://hackmd.io/team/${teamPath}`));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.exportNotes', async (node: any) => {
      if (!node) {
        return;
      }
      const teamPath = node.team?.path;
      const teamName = node.team?.name || teamPath || 'Team';
      if (!teamPath) {
        vscode.window.showErrorMessage('Team path not found');
        return;
      }

      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Export Team Notes',
      });

      const destinationParentUri = selection?.[0];
      if (!destinationParentUri) {
        return;
      }

      const provider = getTeamNotesProvider();
      const teamId = provider?.getTeamIdFromPath(teamPath);
      const containerId = `team-${teamId}`;
      provider?.setPendingContainer(containerId);

      try {
        const result = await exportTeamNotes({ teamPath, teamName, destinationParentUri });
        vscode.window.showInformationMessage(
          `Exported ${result.exportedCount} note${result.exportedCount === 1 ? '' : 's'} to ${result.exportRootUri.fsPath}`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to export team notes: ${error.message}`);
      } finally {
        provider?.clearPendingContainer(containerId);
      }
    })
  );
}

const checkEditorExist = (editor) => {
  if (editor) {
    return true;
  } else {
    vscode.window.showInformationMessage('Current window is not a text editor. Please open one first.');
    return false;
  }
};

const checkNoteIdExist = (noteId) => {
  if (noteId) {
    return true;
  } else {
    vscode.window.showInformationMessage('Please open a note first');
    return false;
  }
};


