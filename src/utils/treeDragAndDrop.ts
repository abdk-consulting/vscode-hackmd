import * as vscode from 'vscode';


import { Note } from '../api/hackmdApiClient';
import { getHistoryProvider, getMyNotesProvider, getTeamNotesProvider } from '../extension';
import { getHackmdModel } from '../model';

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    return undefined;
  }
}

function isSameNoteScope(left: Note, right: Note): boolean {
  return (left.teamPath || null) === (right.teamPath || null);
}

async function closeTabsForNote(note: Note): Promise<boolean> {
  const model = getModel();
  const cached = model?.getNoteById(note.id, note.teamPath ?? null);
  const target = cached || (note as any);
  const tabsToClose: vscode.Tab[] = [];

  for (const tabGroup of vscode.window.tabGroups.all) {
    for (const tab of tabGroup.tabs) {
      const input = tab.input as any;
      const tabUri: vscode.Uri | undefined = input?.uri;

      let matchesTarget = false;
      if (model && tabUri && tabUri.scheme === 'hackmd') {
        const entity = model.getEntityByUriSync(tabUri);
        matchesTarget = !!entity && entity.type === 'note'
          && entity.id === target.id
          && ((entity.teamPath ?? null) === (target.teamPath ?? null));
      }

      if (input.viewType === "mainThreadWebview-markdown.preview"
        || matchesTarget) {
        tabsToClose.push(tab);
      }
    }
  }

  return await vscode.window.tabGroups.close(tabsToClose);
}

const NOTE_DRAG_MIME_TYPE = 'text/uri-list';

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
    const model = getModel();
    if (!model) {
      return [];
    }

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

          const entity = await model.getEntityByUri(uri);
          if (!entity || entity.type !== 'note') {
            continue;
          }

          notes.push({
            id: entity.id,
            teamPath: entity.teamPath ?? null,
            folderPaths: (entity.folderPaths || []) as any,
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
  const model = getModel();
  if (!model) {
    return [];
  }

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

        const entity = await model.getEntityByUri(uri);
        if (!entity || entity.type !== 'folder') {
          continue;
        }

        folders.push({
          id: entity.id,
          teamPath: entity.teamPath ?? null,
          name: entity.name,
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

    const model = getModel();
    if (!model) {
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
          const cachedFolder = model.getFolderById(folder.id, folder.teamPath) || {
            type: 'folder',
            id: folder.id,
            name: folder.name || 'Folder',
            teamPath: folder.teamPath ?? null,
            children: [],
            notes: [],
          };
          return model.toFolderUri(cachedFolder as any).toString();
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
        const cachedNote = model.getNoteById(note.id, note.teamPath) || {
          type: 'note',
          id: note.id,
          title: note.title || note.shortId || 'Untitled',
          shortId: note.shortId,
          teamPath: note.teamPath ?? null,
          folderPaths: (note as any).folderPaths || [],
        };
        return model.toNoteUri(cachedNote as any).toString();
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

      const selectedNodes = foldersToMove.map((folder) => ({
        type: 'folder',
        id: folder.id,
        name: folder.name,
        teamPath: folder.teamPath || null,
        source: 'model',
      }));

      await vscode.commands.executeCommand(
        'hackmd.model.move',
        selectedNodes[0],
        selectedNodes,
        {
          folderId: resolvedTarget.folderId,
          folderPaths: resolvedTarget.folderPaths,
          teamPath: resolvedTarget.teamPath,
        }
      );
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

    const selectedNodes = notesToMove.map((note) => ({ type: 'note', note }));
    await vscode.commands.executeCommand(
      'hackmd.model.move',
      selectedNodes[0],
      selectedNodes,
      {
        folderId: resolvedTarget.folderId,
        folderPaths: resolvedTarget.folderPaths,
        teamPath: resolvedTarget.teamPath,
      }
    );
  }
}

