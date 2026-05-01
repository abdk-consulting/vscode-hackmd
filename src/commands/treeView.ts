import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Note, Team } from '@hackmd/api/dist/type';

import { getHistoryProvider, getMyNotesProvider, getMyNotesTreeView, getPropertiesProvider, getTeamNotesProvider, getTeamNotesTreeView } from '../extension';
import { generateResourceUri } from '../mdFsProvider';
import { recordUsage, teamNotesStore } from '../store';
import { API } from './../api';

function getNoteIdFromFragment(fragment: string): string {
  if (!fragment) {
    return '';
  }
  const questionIndex = fragment.indexOf('?');
  if (questionIndex >= 0) {
    return fragment.slice(0, questionIndex);
  }
  const encodedQuestionIndex = fragment.toLowerCase().indexOf('%3f');
  if (encodedQuestionIndex >= 0) {
    return fragment.slice(0, encodedQuestionIndex);
  }
  return fragment;
}

function getTeamPathFromUri(uri: vscode.Uri): string | null {
  return uri.query ? new URLSearchParams(uri.query).get('teamPath') : null;
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
      noteNode = await teamNotesProvider.addNoteToCache(note, teamPath);
    }
  } else {
    note = await recordUsage(API.createNote(payload as any, { unwrapData: false }));
    if (myNotesProvider) {
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
  const uriNoteId = getNoteIdFromFragment(uri.fragment);
  const uriTeamPath = getTeamPathFromUri(uri);
  return uriNoteId === noteId && (uriTeamPath || null) === (teamPath || null);
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
      await recordUsage(API.updateTeamNote(teamPath, noteId, payload));
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
    getPropertiesProvider()?.updateCurrentNote(noteId, updatedNote);

    // 4) Reveal + select moved note at the new location.
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

          const noteId = getNoteIdFromFragment(uri.fragment);
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

/**
 * Drag-and-drop controller shared by all HackMD tree views.
 * Only note nodes are draggable. Drops on notes resolve to that note's container.
 */
export class NoteDragAndDropController implements vscode.TreeDragAndDropController<any> {
  readonly dragMimeTypes = [NOTE_DRAG_MIME_TYPE];
  readonly dropMimeTypes: string[];

  constructor(allowDrops = true) {
    this.dropMimeTypes = allowDrops ? [NOTE_DRAG_MIME_TYPE] : [];
  }

  handleDrag(source: any[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
    // Strictly reject drag if any selected item is not a note.
    if (source.length === 0 || source.some((node) => node.type !== 'note')) {
      return;
    }

    const notes = source.map((node) => node.note);

    const uriList = notes
      .map((note) => {
        const label = note.title || note.shortId || 'Untitled';
        return generateResourceUri(label, note.id, note.teamPath, (note as any).folderPaths).toString();
      })
      .join('\r\n');

    dataTransfer.set(NOTE_DRAG_MIME_TYPE, new vscode.DataTransferItem(uriList));
  }

  async handleDrop(target: any | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    const warnCannotMove = (reason: string, details?: Record<string, unknown>) => {
      vscode.window.showWarningMessage('This note cannot be moved here.');
    };

    const draggedNotes = await getDraggedNotesFromDataTransfer(dataTransfer);
    if (draggedNotes.length === 0) {
      warnCannotMove('no-dragged-notes-extracted');
      return;
    }

    const resolvedTarget = resolveDropContainer(target);
    if (!resolvedTarget) {
      warnCannotMove('target-could-not-be-resolved', {
        draggedNoteIds: draggedNotes.map((n) => n.id),
      });
      return;
    }

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
        warnCannotMove('scope-mismatch', {
          noteId: note.id,
          noteTeamPath: noteTeamPath ?? 'personal',
          targetTeamPath: resolvedTarget.teamPath ?? 'personal',
        });
        continue;
      }

      // If this note is already in the resolved container, do nothing.
      if (currentFolderId === resolvedTarget.folderId) {
        continue;
      }

      // Moving to root containers is not currently supported by HackMD API behavior.
      if (!resolvedTarget.folderId) {
        warnCannotMove('root-target-not-supported', {
          noteId: note.id,
          noteTeamPath: noteTeamPath ?? 'personal',
        });
        continue;
      }

      const canProceed = await closeTabsForNote(note);
      if (!canProceed) {
        continue;
      }

      await performMove(note, resolvedTarget.folderId, resolvedTarget.folderPaths);
    }
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
          getPropertiesProvider()?.updateCurrentNote(noteId, updatedNote);

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
    vscode.commands.registerCommand('HackMD.moveNoteTo', async (node: any) => {
      if (!node || node.type !== 'note') {
        return;
      }

      const note = node.note as Note;
      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();

      const treeView = note.teamPath ? getTeamNotesTreeView() : getMyNotesTreeView();
      const folderTargets = note.teamPath
        ? (teamNotesProvider?.getMoveFolderTargetsFromCache(note.teamPath) || [])
        : (myNotesProvider?.getMoveFolderTargetsFromCache() || []);

      if (folderTargets.length === 0) {
        vscode.window.showInformationMessage('No folders are available in this note scope.');
        return;
      }

      const currentFolderId = note.folderPaths && note.folderPaths.length > 0
        ? note.folderPaths[note.folderPaths.length - 1].id
        : null;

      const filteredTargets = folderTargets.filter((target) => target.folderId !== currentFolderId);

      if (filteredTargets.length === 0) {
        vscode.window.showInformationMessage('This note is already in the only available folder.');
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

      const canProceed = await closeTabsForNote(note);
      if (!canProceed) {
        return;
      }

      await performMove(note, selected.folderId, selected.folderPaths);
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

      let containerId: string | undefined;
      if (parentFolderId) {
        containerId = `folder-${parentFolderId}`;
      } else if (teamPath) {
        const teamId = teamNotesProvider?.getTeamIdFromPath(teamPath);
        if (teamId) {
          containerId = `team-${teamId}`;
        }
      } else {
        containerId = 'root';
      }

      const provider = teamPath ? teamNotesProvider : myNotesProvider;
      if (containerId) {
        provider?.setPendingContainer(containerId);
      }

      try {
        await createNoteInScope(payload, { teamPath, openEditor: false });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to duplicate note: ${error.message}`);
      } finally {
        if (containerId) {
          provider?.clearPendingContainer(containerId);
        }
      }
    })
  );

  // HackMD.deleteMyNote
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.deleteMyNote', async (node: any) => {
      if (node) {
        // Extract noteId from the node object
        const noteId = node.note?.id;

        if (!noteId) {
          vscode.window.showErrorMessage('Note ID not found');
          return;
        }

        // prompt
        const confirm = await vscode.window.showWarningMessage(
          'Are you sure to delete this note?',
          { modal: true },
          'Yes'
        );

        if (!confirm) {
          return;
        }

        // Set pending state only in providers that contain this note
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();
        const teamPath = node.note?.teamPath;

        // Personal notes appear in My Notes + History
        // Team notes appear in Team Notes + History
        if (teamPath) {
          teamNotesProvider?.setPendingNote(noteId, node.note);
        } else {
          myNotesProvider?.setPendingNote(noteId, node.note);
        }
        historyProvider?.setPendingNote(noteId, node.note);

        try {
          // Check if it's a team note and use the appropriate API
          if (teamPath) {
            await recordUsage(API.deleteTeamNote(teamPath, noteId, { unwrapData: false }));
          } else {
            await recordUsage(API.deleteNote(noteId, { unwrapData: false }));
          }

          // Close all open tabs (editors and previews) for this note.
          await closeTabsForNote(node.note);

          // After successful deletion, remove from caches
          // (removeNoteFromCache will also fire tree change events)
          if (teamPath) {
            teamNotesProvider?.removeNoteFromCache(noteId, teamPath);
          } else {
            myNotesProvider?.removeNoteFromCache(noteId);
          }
          historyProvider?.removeNoteFromCache(noteId);
        } catch (error) {
          // On error, clear pending state to restore note
          if (teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, node.note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, node.note);
          }
          historyProvider?.clearPendingNote(noteId, node.note);
          throw error;
        }
        // No need to clear pending - note was removed from cache
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

      const propertiesProvider = getPropertiesProvider();
      if (!propertiesProvider) {
        return;
      }

      await vscode.commands.executeCommand('hackmd.properties.focus');
      await propertiesProvider.openNote(noteNode.note, noteNode.note.id, noteNode.note.teamPath || null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.exportNote', async (noteNode: any) => {
      if (!noteNode || noteNode.type !== 'note') {
        return;
      }

      const note = noteNode.note as Note;
      const myNotesProvider = getMyNotesProvider();
      const teamNotesProvider = getTeamNotesProvider();
      const historyProvider = getHistoryProvider();
      const exportFileName = getExportFileName(note);
      const defaultDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const targetUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDirectory, exportFileName)),
        filters: {
          Markdown: ['md'],
        },
        saveLabel: 'Export Note',
      });

      if (!targetUri) {
        return;
      }

      if (note.teamPath) {
        teamNotesProvider?.setPendingNote(note.id, note);
      } else {
        myNotesProvider?.setPendingNote(note.id, note);
      }
      historyProvider?.setPendingNote(note.id, note);

      try {
        const sourceUri = generateResourceUri(note.title, note.id, note.teamPath, (note as any).folderPaths);
        const document = await vscode.workspace.openTextDocument(sourceUri);
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(document.getText(), 'utf8'));
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to export note: ${error.message}`);
      } finally {
        if (note.teamPath) {
          teamNotesProvider?.clearPendingNote(note.id, note);
        } else {
          myNotesProvider?.clearPendingNote(note.id, note);
        }
        historyProvider?.clearPendingNote(note.id, note);
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

        const noteId = getNoteIdFromFragment(editor.document.uri.fragment);
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

        const noteId = getNoteIdFromFragment(editor.document.uri.fragment);
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
        const noteId = getNoteIdFromFragment(vscode.window.activeTextEditor.document.uri.fragment);

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


