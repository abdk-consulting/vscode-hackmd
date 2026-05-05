import * as vscode from 'vscode';

import * as extensionApi from '../extension';

import {
  getHackmdModel,
  ModelFolder,
  ModelMyNotes,
  ModelNote,
  ModelTeam
} from '../model';
import {
  collectFolders,
  collectNotes,
  pickEntity,
  pickNote,
  pickScope,
  promptRequiredInput
} from './pickers';

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    vscode.window.showErrorMessage('HackMD is not connected. Please configure your API key first.');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree node helpers
// ---------------------------------------------------------------------------

/** Extract the raw note object from a tree node `{ type: 'note', note: {...} }` or a bare note. */
function extractNote(node: any): any | undefined {
  if (!node) { return undefined; }
  if (node.type === 'note' && node.note) { return node.note; }
  // Bare note: has id but is not a folder or team node
  if (node.id && node.type !== 'folder' && node.type !== 'team' && node.team === undefined) { return node; }
  return undefined;
}

/** Extract the folder object from a tree folder node `{ type: 'folder', id, ... }`. */
function extractFolder(node: any): any | undefined {
  if (!node) { return undefined; }
  if (node.type === 'folder' && node.id) { return node; }
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

/** Check if a folder is a descendant of an ancestor folder by traversing the parent chain. */
function isFolderDescendantOf(
  model: ReturnType<typeof getHackmdModel>,
  folderId: string,
  ancestorFolderId: string,
  scopeEntity: ModelMyNotes | ModelTeam
): boolean {
  let current = model.getFolderSync(scopeEntity, folderId);
  while (current && current.parentId) {
    if (current.parentId === ancestorFolderId) {
      return true;
    }
    current = model.getFolderSync(scopeEntity, current.parentId);
  }
  return false;
}

type RenameQuickPickItem = vscode.QuickPickItem & {
  entity: ModelNote | ModelFolder;
};

type CreateContainer = ModelMyNotes | ModelTeam | ModelFolder;

type CreateContainerQuickPickItem = vscode.QuickPickItem & {
  container: CreateContainer;
};

async function pickCreateContainer(
  model: ReturnType<typeof getHackmdModel>,
  placeHolder: string
): Promise<CreateContainer | undefined> {
  const items: CreateContainerQuickPickItem[] = [];

  items.push({
    label: '$(home) My Notes',
    description: 'Root',
    container: model.getMyNotesEntity(),
  });

  const personalSnapshot = model.getScopeSnapshotSync(model.getMyNotesEntity());
  if (personalSnapshot) {
    for (const folder of collectFolders(personalSnapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name}`,
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

    for (const folder of collectFolders(snapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name}`,
        description: `${team.name || team.path}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        container: folder,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.container;
}

async function pickRenameTarget(
  model: ReturnType<typeof getHackmdModel>
): Promise<ModelNote | ModelFolder | undefined> {
  const scopes: Array<{ entity: ModelMyNotes | ModelTeam; scopeLabel: string }> = [
    { entity: model.getMyNotesEntity(), scopeLabel: 'My Notes' },
    ...model.getTeams().map((team) => ({ entity: team, scopeLabel: team.name || team.path })),
  ];

  const items: RenameQuickPickItem[] = [];

  for (const scope of scopes) {
    const snapshot = model.getScopeSnapshotSync(scope.entity);
    if (!snapshot) {
      continue;
    }

    for (const folder of collectFolders(snapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name}`,
        description: `${scope.scopeLabel}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        entity: folder,
      });
    }

    for (const note of collectNotes(snapshot.rootFolders, snapshot.rootNotes)) {
      const title = note.title || note.shortId || note.id;
      items.push({
        label: `$(note) ${title}`,
        description: `${scope.scopeLabel} • ${note.id}`,
        detail: note.title ? undefined : note.id,
        entity: note,
      });
    }
  }

  items.sort((a, b) => {
    const descriptionA = a.description || '';
    const descriptionB = b.description || '';
    const byScope = descriptionA.localeCompare(descriptionB);
    if (byScope !== 0) {
      return byScope;
    }
    return a.label.localeCompare(b.label);
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a note or folder to rename',
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.entity;
}

/**
 * Show a quick pick to select a move target folder.
 * Returns null for root, undefined for cancelled/error, or the ModelFolder entity.
 */
async function pickMoveTargetFolder(
  model: ReturnType<typeof getHackmdModel>,
  itemsToMove: (ModelNote | ModelFolder)[],
  scopeEntity: ModelMyNotes | ModelTeam
): Promise<ModelFolder | null | undefined> {
  const snapshot = model.getScopeSnapshotSync(scopeEntity);

  if (!snapshot) {
    vscode.window.showErrorMessage('Scope data is not loaded. Please refresh the scope first.');
    return undefined;
  }

  // Collect folder targets with their entities
  type TargetOption = { id: string | null; label: string; description: string; entity: ModelFolder | null };
  const folderTargets: TargetOption[] = [{ id: null, label: 'Root', description: 'No parent folder', entity: null }]
    .concat(collectFolders(snapshot.rootFolders).map((folder) => ({
      id: folder.id,
      label: folder.name,
      description: folder.path || folder.id,
      entity: folder,
    })));

  const validTargets = folderTargets.filter((target) => {
    // Check if target is valid for all items
    const validForAll = itemsToMove.every((item) => {
      const itemAsAny = item as any;
      // Can move notes anywhere in scope
      if (itemAsAny.type === 'note') {
        return true;
      }
      // Can't move folder into itself
      if (target.id === itemAsAny.id) {
        return false;
      }
      // Can't move folder into its own descendant
      if (target.id) {
        const isDescendant = isFolderDescendantOf(model, target.id, itemAsAny.id, scopeEntity);
        if (isDescendant) {
          return false;
        }
      }
      return true;
    });

    // Target must differ from current parent for at least one item
    const differsForAtLeastOne = itemsToMove.some((item) => {
      const itemAsAny = item as any;
      const currentParent = itemAsAny.parentFolderId ?? itemAsAny.parentId ?? null;
      return currentParent !== target.id;
    });

    return validForAll && differsForAtLeastOne;
  });

  if (validTargets.length === 0) {
    vscode.window.showErrorMessage('No valid destination folder is available for the selected items.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    validTargets.map((target) => ({ label: target.label, description: target.description, id: target.id })),
    {
      placeHolder: 'Choose destination folder',
      ignoreFocusOut: true,
    }
  );

  if (!picked) {
    return undefined;
  }

  const selectedTarget = validTargets.find((t) => t.id === picked.id);
  return selectedTarget?.entity ?? undefined;
}

export function registerModelCommands(context: vscode.ExtensionContext): void {
  const register = <T extends any[]>(id: string, handler: (...args: T) => Promise<any>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('hackmd.model.refreshMyNotes', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    await model.refresh(model.getMyNotesEntity());
    return true;
  });

  register('hackmd.model.refreshTeams', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return model.refresh(model.getTeamsEntity());
  });

  register('hackmd.model.refreshRecentNotes', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return model.refresh(model.getRecentNotesEntity());
  });

  register('hackmd.model.refreshTeam', async (team?: ModelTeam) => {
    const model = getModel();
    if (!model) {
      return;
    }

    if (team === undefined) {
      const selectedScope = await pickScope(model, 'Choose team scope to refresh', { includeMyNotes: false });
      if (selectedScope === undefined) {
        return;
      }
      await model.refresh(selectedScope);
      return true;
    }

    await model.refresh(team);
    return true;
  });

  register('hackmd.model.createNote', async (containerArg?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let container: CreateContainer | any;
    if (containerArg?.type === 'note') {
      container = model.getImmediateParentContainer(containerArg as ModelNote);
    } else {
      container = containerArg;
    }

    if (container === undefined) {
      container = await pickCreateContainer(model, 'Choose where to create the new note');
      if (!container) {
        return;
      }
    }

    const created = await model.createNote(container, {});
    await vscode.commands.executeCommand('hackmd.ui.reveal', { type: 'note', note: created });
    await vscode.commands.executeCommand('hackmd.ui.edit', { type: 'note', note: created });
    return created;
  });

  register('hackmd.model.createFolder', async (containerArg?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let container: CreateContainer | any;
    if (containerArg?.type === 'note') {
      container = model.getImmediateParentContainer(containerArg as ModelNote);
    } else {
      container = containerArg;
    }

    if (container === undefined) {
      container = await pickCreateContainer(model, 'Choose where to create the new folder');
      if (!container) {
        return;
      }
    }

    const name = await promptRequiredInput('Folder name');
    if (!name) {
      return;
    }

    const created = await model.createFolder(container, { name });
    await vscode.commands.executeCommand('hackmd.ui.reveal', created);
    return created;
  });

  // Scoped variants for command palette discoverability
  register('hackmd.model.createMyNote', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return vscode.commands.executeCommand('hackmd.model.createNote', model.getMyNotesEntity());
  });

  register('hackmd.model.createMyFolder', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return vscode.commands.executeCommand('hackmd.model.createFolder', model.getMyNotesEntity());
  });

  register('hackmd.model.rename', async (entity?: ModelNote | ModelFolder) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const target = entity ?? await pickRenameTarget(model);
    if (!target) {
      return;
    }

    if (target.type === 'note') {
      const newTitle = await promptRequiredInput('New note title', target.title || '');
      if (!newTitle) {
        return;
      }
      return model.updateNote(target, { title: newTitle });
    }

    const newName = await promptRequiredInput('New folder name', target.name || '');
    if (!newName) {
      return;
    }
    return model.updateFolder(target, { name: newName });
  });

  const runMove = async (
    activeEntity?: ModelNote | ModelFolder,
    selectedEntities?: (ModelNote | ModelFolder)[],
    targetEntity?: ModelFolder | ModelMyNotes | ModelTeam
  ) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Step 1-4: Determine move candidates with priority: selected > active > picker
    let candidates: (ModelNote | ModelFolder)[];
    if (selectedEntities && selectedEntities.length > 0) {
      candidates = selectedEntities;
    } else if (activeEntity !== undefined) {
      candidates = [activeEntity];
    } else {
      const picked = await pickEntity(model, 'Choose an item to move');
      if (!picked) {
        return;
      }
      candidates = [picked.kind === 'folder' ? picked.folder : picked.note] as (ModelNote | ModelFolder)[];
    }

    // Step 6: Validate that all candidates are notes or folders
    for (const candidate of candidates) {
      const c = candidate as any;
      if (c.type !== 'note' && c.type !== 'folder') {
        throw new Error(`Invalid move candidate type: ${c.type}. Only notes and folders can be moved.`);
      }
    }

    // Step 7: Validate all candidates are from the same scope
    const scopeEntity = model.getScopeEntityForItem(candidates[0]);
    const hasMixedScopes = candidates.some((item) => model.getScopeEntityForItem(item) !== scopeEntity);
    if (hasMixedScopes) {
      throw new Error('Selected items are from different scopes and cannot be moved together.');
    }

    // Step 10: Remove duplicates from candidates
    const seen = new Set<string>();
    const dedupedCandidates: (ModelNote | ModelFolder)[] = [];
    for (const candidate of candidates) {
      const c = candidate as any;
      const key = `${c.type}:${c.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedupedCandidates.push(candidate);
      }
    }

    // Step 11: Remove candidates that are descendants of other candidates
    const candidateIds = new Set(dedupedCandidates.map((c) => (c as any).id));
    const itemsToMove = dedupedCandidates.filter((candidate) => {
      const c = candidate as any;
      if (c.type === 'note') {
        return true; // notes have no descendants
      }
      // For folders, check if its parent is another move candidate
      if (!c.parentId) {
        return true;
      }
      return !candidateIds.has(c.parentId);
    });

    // Step 8: If target is undefined, show picker to select destination
    let dest: ModelFolder | ModelMyNotes | ModelTeam;
    if (targetEntity === undefined) {
      const pickedDest = await pickMoveTargetFolder(model, itemsToMove, scopeEntity);
      if (pickedDest === undefined) {
        return; // user cancelled
      }
      dest = pickedDest ?? scopeEntity; // null means root (scopeEntity)
    } else {
      dest = targetEntity;
    }

    // Step 9: Validate target entity against conditions a, b, c
    const targetAsAny = dest as any;
    // a) Target is not equal to any move candidate
    if (candidateIds.has(targetAsAny.id)) {
      throw new Error('Target entity cannot be one of the items being moved.');
    }
    // b) Target is not a descendant of any move candidate
    if (targetAsAny.type === 'folder') {
      for (const candidate of itemsToMove) {
        const candAsAny = candidate as any;
        if (candAsAny.type === 'folder' && isFolderDescendantOf(model, targetAsAny.id, candAsAny.id, scopeEntity)) {
          throw new Error('Target cannot be a descendant of items being moved.');
        }
      }
    }
    // c) Target is in the same scope as move candidates
    const targetScopeEntity = model.getScopeEntityForItem(dest);
    if (targetScopeEntity !== scopeEntity) {
      throw new Error('Target entity is not in the same scope as items being moved.');
    }

    // Step 12: Remove immediate children of the target
    const targetId = (dest as any).id ?? null;
    const actionableItems = itemsToMove.filter((item) => {
      const i = item as any;
      const currentParent = i.parentFolderId ?? i.parentId ?? null;
      return currentParent !== targetId;
    });

    // Step 13: If set of move candidates is now empty, silently do nothing
    if (actionableItems.length === 0) {
      return;
    }

    // Step 14: Execute moves in parallel
    await Promise.all(actionableItems.map(async (item) => {
      const i = item as any;
      if (i.type === 'note') {
        const noteEntity = model.getNoteSync(scopeEntity, i.id);
        if (!noteEntity) { return; }
        return model.moveNote(noteEntity, dest);
      } else if (i.type === 'folder') {
        const folderEntity = model.getFolderSync(scopeEntity, i.id);
        if (!folderEntity) { return; }
        return model.moveFolder(folderEntity, dest);
      }
    }));

    return true;
  };

  register('hackmd.model.move', runMove);

  register('hackmd.model.duplicateNote', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const targetNode = node ?? getSelectedTreeNodeFallback();
    let note = extractNote(targetNode);
    if (!note) {
      if (targetNode !== undefined) {
        return;
      }
      const picked = await pickNote(model);
      if (!picked) { return; }
      note = picked;
    }

    try {
      const content = await model.getNoteContent(note);
      const noteScopeEntity: ModelMyNotes | ModelTeam = model.getScopeEntityForItem(note);
      const container: ModelMyNotes | ModelTeam | ModelFolder = note.parentFolderId
        ? (model.getFolderSync(noteScopeEntity, note.parentFolderId) ?? noteScopeEntity)
        : noteScopeEntity;
      return model.createNote(container, {
        title: note.title || note.shortId || 'Untitled',
        content: content ?? '',
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to duplicate note: ${error.message || 'Unknown error'}`);
    }
  });

  register('hackmd.model.delete', async (node?: any, selectedNodes?: any[]) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const fallbackSelection = (!node && (!selectedNodes || selectedNodes.length === 0))
      ? getSelectedTreeNodesFallback()
      : [];
    const effectiveNodes = selectedNodes?.length
      ? selectedNodes
      : node
        ? [node]
        : fallbackSelection;
    const hasTreeSelectionContext = effectiveNodes.length > 0;
    const notes: any[] = [];
    const folders: any[] = [];
    for (const n of effectiveNodes) {
      const note = extractNote(n);
      if (note) { notes.push(note); continue; }
      const folder = extractFolder(n);
      if (folder) { folders.push(folder); }
    }

    // Command-palette fallback: pick a single note
    if (notes.length === 0 && folders.length === 0) {
      if (hasTreeSelectionContext) {
        return;
      }
      const picked = await pickNote(model);
      if (!picked) { return; }
      notes.push(picked);
    }

    const totalCount = notes.length + folders.length;
    const confirm = await vscode.window.showWarningMessage(
      totalCount === 1 ? 'Delete this item?' : `Delete these ${totalCount} items?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    await Promise.all([
      ...notes.map((n) => {
        const scopeEntity = model.getScopeEntityForItem(n);
        const noteEntity = model.getNoteSync(scopeEntity, n.id);
        return noteEntity ? model.deleteNote(noteEntity) : undefined;
      }),
      ...folders.map((f) => {
        const scopeEntity = model.getScopeEntityForItem(f);
        const folderEntity = model.getFolderSync(scopeEntity, f.id);
        return folderEntity ? model.deleteFolder(folderEntity) : undefined;
      }),
    ]);
    return true;
  });
}
