import * as vscode from 'vscode';


import type { ModelFolder, ModelMyNotes, ModelNote, ModelTeam } from '../model';
import { getHackmdModel } from '../model';

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    return undefined;
  }
}

const NOTE_DRAG_MIME_TYPE = 'text/uri-list';

type DropContainerEntity = ModelMyNotes | ModelTeam | ModelFolder;
type DroppedEntity = ModelNote | ModelFolder;

function getScopeEntityForComparison(model: ReturnType<typeof getHackmdModel>, entity: DropContainerEntity | DroppedEntity) {
  return model.getScopeEntityForItem(entity);
}

function getImmediateParent(model: ReturnType<typeof getHackmdModel>, entity: ModelNote | ModelFolder | ModelTeam) {
  return model.getImmediateParentContainer(entity);
}

function areEntitiesInSameScope(model: ReturnType<typeof getHackmdModel>, entities: Array<ModelFolder | ModelNote>): boolean {
  if (entities.length === 0) {
    return true;
  }
  const scope = model.getScopeEntityForItem(entities[0]);
  return entities.every((entity) => model.getScopeEntityForItem(entity) === scope);
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
  const deduped = new Map<DroppedEntity, DroppedEntity>();
  for (const entity of dropped) {
    if (entity.type !== 'note' && entity.type !== 'folder') {
      throw new Error('Only note and folder entities can be dropped.');
    }
    deduped.set(entity, entity);
  }

  const droppedEntities = [...deduped.values()];
  const targetScope = getScopeEntityForComparison(model, target);
  for (const entity of droppedEntities) {
    const scope = getScopeEntityForComparison(model, entity);
    if (scope !== targetScope) {
      throw new Error('Dropped entities and target must be in the same scope.');
    }
  }

  const droppedEntitiesSet = new Set(droppedEntities);
  if (droppedEntitiesSet.has(target as DroppedEntity)) {
    throw new Error('Target cannot be among dropped entities.');
  }

  // Walk target ancestors and reject drops from an ancestor folder.
  let targetCursor: ModelFolder | ModelTeam | ModelMyNotes | { type: 'teams' } = target;
  while (targetCursor.type === 'folder' || targetCursor.type === 'team') {
    const parent = getImmediateParent(model, targetCursor);
    if (parent.type === 'folder' && droppedEntitiesSet.has(parent)) {
      throw new Error('Cannot move into a descendant of a dropped folder.');
    }
    targetCursor = parent;
  }

  // Remove entities already directly inside target.
  let filtered = droppedEntities.filter((entity) => {
    const parent = getImmediateParent(model, entity);
    return parent !== target;
  });

  // Remove entities with another dropped folder in their ancestor chain.
  const filteredSet = new Set(filtered);
  filtered = filtered.filter((entity) => {
    let cursor = getImmediateParent(model, entity);
    while (cursor.type === 'folder') {
      if (filteredSet.has(cursor)) {
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
      const folders = source as ModelFolder[];

      if (!areEntitiesInSameScope(model, folders)) {
        return;
      }

      const uriList = folders
        .map((folder) => model.toUri(folder).toString())
        .join('\r\n');

      dataTransfer.set(NOTE_DRAG_MIME_TYPE, new vscode.DataTransferItem(uriList));
      return;
    }

    const notes = source as ModelNote[];
    if (!areEntitiesInSameScope(model, notes)) {
      return;
    }

    const uriList = notes
      .map((note) => model.toUri(note as ModelNote).toString())
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

    await vscode.commands.executeCommand(
      'hackmd.model.move',
      entitiesToMove[0],
      entitiesToMove,
      targetContainer,
    );
  }
}

