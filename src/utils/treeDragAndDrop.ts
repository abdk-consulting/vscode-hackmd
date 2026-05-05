import * as vscode from 'vscode';


import { Note } from '../api/hackmdApiClient';
import type { ModelFolder, ModelMyNotes, ModelNote, ModelTeam } from '../model';
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
  const noteScope = model && (note.teamPath ? model.getTeams().find((t) => t.path === note.teamPath) ?? null : model.getMyNotesEntity());
  const cached = noteScope ? model!.getNoteSync(noteScope, note.id) : null;
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

type DropContainerEntity = ModelMyNotes | ModelTeam | ModelFolder;
type DroppedEntity = ModelNote | ModelFolder;

type DraggedFolder = {
  id: string;
  teamPath: string | null;
  name?: string;
};

function toEntityKey(entity: ModelMyNotes | ModelTeam | ModelFolder | ModelNote): string {
  if (entity.type === 'my-notes') {
    return 'my-notes';
  }
  if (entity.type === 'team') {
    return `team:${entity.path}`;
  }
  const scope = entity.teamPath ?? 'personal';
  return `${entity.type}:${scope}:${entity.id}`;
}

function getScopeEntityForComparison(model: ReturnType<typeof getHackmdModel>, entity: DropContainerEntity | DroppedEntity) {
  return model.getScopeEntityForItem(entity);
}

function getImmediateParent(model: ReturnType<typeof getHackmdModel>, entity: ModelNote | ModelFolder | ModelTeam) {
  return model.getImmediateParentContainer(entity);
}

function getDroppedEntitiesFromDataTransfer(dataTransfer: vscode.DataTransfer): Array<ModelNote | ModelFolder | ModelTeam> {
  const preferred = dataTransfer.get(NOTE_DRAG_MIME_TYPE);
  if (!preferred) {
    return [];
  }

  const raw = preferred.value as string;
  if (typeof raw !== 'string') {
    return [];
  }

  const model = getModel();
  if (!model) {
    return [];
  }

  try {
    const uriList = raw
      .split(/\r\n|\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const entities: Array<ModelNote | ModelFolder | ModelTeam> = [];
    for (const uriText of uriList) {
      try {
        const uri = vscode.Uri.parse(uriText);
        if (uri.scheme !== 'hackmd') {
          continue;
        }

        const entity = model.getEntityByUriSync(uri);
        if (!entity) {
          continue;
        }

        entities.push(entity);
      } catch {
        // Skip malformed URI entries.
      }
    }

    return entities;
  } catch {
    return [];
  }
}

function validateAndFilterDroppedEntities(
  model: ReturnType<typeof getHackmdModel>,
  dropped: Array<ModelNote | ModelFolder | ModelTeam>,
  target: DropContainerEntity,
): DroppedEntity[] {
  const deduped = new Map<string, DroppedEntity>();
  for (const entity of dropped) {
    if (entity.type !== 'note' && entity.type !== 'folder') {
      throw new Error('Only note and folder entities can be dropped.');
    }
    deduped.set(toEntityKey(entity), entity);
  }

  const droppedEntities = [...deduped.values()];
  const targetScope = getScopeEntityForComparison(model, target);
  for (const entity of droppedEntities) {
    const scope = getScopeEntityForComparison(model, entity);
    if (scope !== targetScope) {
      throw new Error('Dropped entities and target must be in the same scope.');
    }
  }

  const droppedKeys = new Set(droppedEntities.map((entity) => toEntityKey(entity)));
  const targetKey = toEntityKey(target);
  if (droppedKeys.has(targetKey)) {
    throw new Error('Target cannot be among dropped entities.');
  }

  // Walk target ancestors and reject drops from an ancestor folder.
  let targetCursor: ModelFolder | ModelTeam | ModelMyNotes | { type: 'teams' } = target;
  while (targetCursor.type === 'folder' || targetCursor.type === 'team') {
    const parent = getImmediateParent(model, targetCursor);
    if (parent.type === 'folder' && droppedKeys.has(toEntityKey(parent))) {
      throw new Error('Cannot move into a descendant of a dropped folder.');
    }
    targetCursor = parent;
  }

  // Remove entities already directly inside target.
  let filtered = droppedEntities.filter((entity) => {
    const parent = getImmediateParent(model, entity);
    return toEntityKey(parent as ModelMyNotes | ModelTeam | ModelFolder) !== targetKey;
  });

  // Remove entities with another dropped folder in their ancestor chain.
  const filteredKeys = new Set(filtered.map((entity) => toEntityKey(entity)));
  filtered = filtered.filter((entity) => {
    let cursor = getImmediateParent(model, entity);
    while (cursor.type === 'folder') {
      if (filteredKeys.has(toEntityKey(cursor))) {
        return false;
      }
      cursor = getImmediateParent(model, cursor);
    }
    return true;
  });

  return filtered;
}

/**
 * Drag-and-drop controller shared by all HackMD tree views.
 * Note and folder nodes are draggable. Drops on notes resolve to that note's container.
 */
export class NoteDragAndDropController implements vscode.TreeDragAndDropController<any> {
  readonly dragMimeTypes = [NOTE_DRAG_MIME_TYPE];
  readonly dropMimeTypes: string[];
  readonly defaultTarget: ModelMyNotes | undefined;

  constructor(allowDrops = true, defaultTarget?: ModelMyNotes) {
    this.dropMimeTypes = allowDrops ? [NOTE_DRAG_MIME_TYPE] : [];
    this.defaultTarget = defaultTarget;
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
          const folderScope = folder.teamPath ? (model.getTeams().find((t) => t.path === folder.teamPath) ?? null) : model.getMyNotesEntity();
          const cachedFolder = (folderScope ? model.getFolderSync(folderScope, folder.id) : null) || {
            type: 'folder',
            id: folder.id,
            name: folder.name || 'Folder',
            teamPath: folder.teamPath ?? null,
            children: [],
            notes: [],
          };
          return model.toUri(cachedFolder as any).toString();
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
        const noteScope = note.teamPath ? (model.getTeams().find((t) => t.path === note.teamPath) ?? null) : model.getMyNotesEntity();
        const cachedNote = (noteScope ? model.getNoteSync(noteScope, note.id) : null) || {
          type: 'note',
          id: note.id,
          title: note.title || note.shortId || 'Untitled',
          shortId: note.shortId,
          teamPath: note.teamPath ?? null,
          folderPaths: (note as any).folderPaths || [],
        };
        return model.toUri(cachedNote as any).toString();
      })
      .join('\r\n');

    dataTransfer.set(NOTE_DRAG_MIME_TYPE, new vscode.DataTransferItem(uriList));
  }

  async handleDrop(target: any | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
    const model = getModel();
    if (!model) {
      return;
    }

    const effectiveTarget = target ?? this.defaultTarget;
    if (!effectiveTarget) {
      return;
    }

    let targetContainer: DropContainerEntity;
    if (effectiveTarget.type === 'note') {
      const parent = model.getImmediateParentContainer(effectiveTarget);
      if (parent.type !== 'folder' && parent.type !== 'team' && parent.type !== 'my-notes') {
        return;
      }
      targetContainer = parent;
    } else if (effectiveTarget.type === 'folder' || effectiveTarget.type === 'team' || effectiveTarget.type === 'my-notes') {
      targetContainer = effectiveTarget as DropContainerEntity;
    } else {
      return;
    }

    const droppedEntities = getDroppedEntitiesFromDataTransfer(dataTransfer);
    const entitiesToMove = validateAndFilterDroppedEntities(model, droppedEntities, targetContainer);

    // If nothing remains after filtering, this is a no-op.
    if (entitiesToMove.length === 0) {
      return;
    }

    if (targetContainer.type !== 'folder') {
      throw new Error('Moving to non-folder targets is not supported.');
    }

    await Promise.all(entitiesToMove.map(async (entity) => {
      if (entity.type === 'note') {
        const canProceed = await closeTabsForNote(entity as unknown as Note);
        if (!canProceed) {
          return;
        }
        await model.moveNote(entity, targetContainer);
        return;
      }

      await model.moveFolder(entity, targetContainer);
    }));
  }
}

