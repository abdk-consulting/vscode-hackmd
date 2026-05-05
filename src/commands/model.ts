import * as vscode from 'vscode';

import * as extensionApi from '../extension';

import {
  getHackmdModel,
  ModelFolder,
  ModelMyNotes,
  ModelNote,
  ModelScope,
  ModelScopeSnapshot,
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

async function promptJson<T>(prompt: string, initialValue: T): Promise<T | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt,
    value: JSON.stringify(initialValue, null, 2),
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        JSON.parse(value);
        return null;
      } catch {
        return 'Invalid JSON';
      }
    },
  });

  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as T;
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

/** Extract scope context (teamPath + optional parentFolderId) from any tree node. */
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
  // Team node: wrapper or direct model team object.
  if (node.team !== undefined) { return { teamPath: node.team?.path ?? null }; }
  if (node.type === 'team' && typeof node.path === 'string') { return { teamPath: node.path }; }
  // Folder node can be a direct provider node or a wrapped context-menu node.
  if (node.type === 'folder') {
    const rawParentFolderId = node.folderId
      || node.id
      || node.value?.context?.folderId
      || node.value?.context?.folderClientId;
    const parentFolderId = typeof rawParentFolderId === 'string' && rawParentFolderId.startsWith('folder-')
      ? rawParentFolderId.slice('folder-'.length)
      : rawParentFolderId;
    const teamPath = node.teamPath
      ?? node.value?.context?.teamPath
      ?? null;
    return {
      teamPath,
      parentFolderId: parentFolderId || undefined,
    };
  }
  // Note node: inherit scope only
  const note = extractNote(node);
  if (note) { return { teamPath: note.teamPath ?? null }; }
  return {};
}

function inferTeamPathFromFolderId(
  model: ReturnType<typeof getHackmdModel>,
  parentFolderId: string,
  explicitTeamPath?: string | null
): string | null | undefined {
  if (explicitTeamPath !== undefined && explicitTeamPath !== null) {
    return explicitTeamPath;
  }

  const personalSnapshot = model.getScopeSnapshotSync(model.getMyNotesEntity());
  if (personalSnapshot && collectFolders(personalSnapshot.rootFolders).some((folder) => folder.id === parentFolderId)) {
    return null;
  }

  for (const team of model.getTeams()) {
    const teamSnapshot = model.getScopeSnapshotSync(team);
    if (!teamSnapshot) {
      continue;
    }
    if (collectFolders(teamSnapshot.rootFolders).some((folder) => folder.id === parentFolderId)) {
      return team.path;
    }
  }

  return explicitTeamPath ?? null;
}

type MoveItem = {
  kind: 'note' | 'folder';
  id: string;
  teamPath: ModelScope;
  parentFolderId: string | null;
};

type MoveTarget = {
  teamPath: ModelScope;
  folderId: string | null;
};

type ScopeIndex = {
  snapshot: ModelScopeSnapshot | null;
  folderById: Map<string, ModelFolder>;
  noteById: Map<string, ModelNote>;
  folderParentById: Map<string, string | null>;
  noteParentById: Map<string, string | null>;
};

function asScope(scope: string | null | undefined): ModelScope {
  return scope ?? null;
}

function dedupeMoveItems(items: MoveItem[]): MoveItem[] {
  const seen = new Set<string>();
  const unique: MoveItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.teamPath ?? '__personal__'}:${item.id}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function toMoveItem(node: any): MoveItem | undefined {
  const note = extractNote(node);
  if (note?.id) {
    return {
      kind: 'note',
      id: note.id,
      teamPath: asScope(note.teamPath),
      parentFolderId: note.parentFolderId ?? note.parentForderId ?? null,
    };
  }

  const folder = extractFolder(node);
  if (folder?.id) {
    return {
      kind: 'folder',
      id: folder.id,
      teamPath: asScope(folder.teamPath),
      parentFolderId: folder.parentId ?? null,
    };
  }

  return undefined;
}

function buildScopeIndex(model: ReturnType<typeof getHackmdModel>, teamPath: ModelScope): ScopeIndex {
  const scopeEntity = teamPath ? model.getTeamByPath(teamPath) : model.getMyNotesEntity();
  const snapshot = scopeEntity ? model.getScopeSnapshotSync(scopeEntity) : null;
  const folderById = new Map<string, ModelFolder>();
  const noteById = new Map<string, ModelNote>();
  const folderParentById = new Map<string, string | null>();
  const noteParentById = new Map<string, string | null>();

  if (snapshot) {
    const folders = collectFolders(snapshot.rootFolders);
    for (const folder of folders) {
      folderById.set(folder.id, folder);
      folderParentById.set(folder.id, folder.parentId ?? null);
      for (const note of folder.notes) {
        noteById.set(note.id, note);
        noteParentById.set(note.id, note.parentFolderId ?? note.parentForderId ?? folder.id ?? null);
      }
    }
    for (const note of snapshot.rootNotes) {
      noteById.set(note.id, note);
      noteParentById.set(note.id, note.parentFolderId ?? note.parentForderId ?? null);
    }
  }

  return { snapshot, folderById, noteById, folderParentById, noteParentById };
}

function hasAncestorFolder(
  parentFolderId: string | null,
  ancestorFolderIds: Set<string>,
  index: ScopeIndex,
  skipFolderId?: string
): boolean {
  let current = parentFolderId;
  while (current) {
    if (ancestorFolderIds.has(current) && current !== skipFolderId) {
      return true;
    }
    current = index.folderParentById.get(current) ?? null;
  }
  return false;
}

function isFolderDescendantOf(folderId: string, ancestorFolderId: string, index: ScopeIndex): boolean {
  let current = index.folderParentById.get(folderId) ?? null;
  while (current) {
    if (current === ancestorFolderId) {
      return true;
    }
    current = index.folderParentById.get(current) ?? null;
  }
  return false;
}

function refineMoveItems(items: MoveItem[], scopeIndexes: Map<ModelScope, ScopeIndex>): MoveItem[] {
  const folderIdsByScope = new Map<ModelScope, Set<string>>();
  for (const item of items) {
    if (item.kind !== 'folder') { continue; }
    if (!folderIdsByScope.has(item.teamPath)) {
      folderIdsByScope.set(item.teamPath, new Set<string>());
    }
    folderIdsByScope.get(item.teamPath)!.add(item.id);
  }

  return items.filter((item) => {
    const scopeFolderIds = folderIdsByScope.get(item.teamPath);
    if (!scopeFolderIds || scopeFolderIds.size === 0) {
      return true;
    }
    const index = scopeIndexes.get(item.teamPath);
    if (!index) {
      return true;
    }
    if (item.kind === 'folder') {
      return !hasAncestorFolder(item.parentFolderId, scopeFolderIds, index, item.id);
    }
    return !hasAncestorFolder(item.parentFolderId, scopeFolderIds, index);
  });
}

function hydrateMoveItems(items: MoveItem[], scopeIndexes: Map<ModelScope, ScopeIndex>): MoveItem[] {
  return items.map((item) => {
    const index = scopeIndexes.get(item.teamPath);
    if (!index) {
      return item;
    }
    if (item.kind === 'note') {
      const fromSnapshot = index.noteParentById.get(item.id);
      return {
        ...item,
        parentFolderId: item.parentFolderId ?? fromSnapshot ?? null,
      };
    }
    const fromSnapshot = index.folderParentById.get(item.id);
    return {
      ...item,
      parentFolderId: item.parentFolderId ?? fromSnapshot ?? null,
    };
  });
}

function isValidMoveDestination(item: MoveItem, target: MoveTarget, scopeIndexes: Map<ModelScope, ScopeIndex>): boolean {
  if (item.teamPath !== target.teamPath) {
    return false;
  }
  if (item.kind === 'note') {
    return true;
  }
  if (target.folderId === item.id) {
    return false;
  }
  if (!target.folderId) {
    return true;
  }
  const index = scopeIndexes.get(item.teamPath);
  if (!index) {
    return true;
  }
  return !isFolderDescendantOf(target.folderId, item.id, index);
}

function parseTargetFolder(targetFolder: any, defaultScope: ModelScope): MoveTarget | undefined {
  if (targetFolder === undefined) {
    return undefined;
  }
  if (!targetFolder || typeof targetFolder !== 'object') {
    return {
      teamPath: defaultScope,
      folderId: null,
    };
  }
  const teamPath = asScope(targetFolder.teamPath ?? targetFolder.scope ?? defaultScope);
  const folderId = targetFolder.folderId ?? targetFolder.id ?? null;
  return { teamPath, folderId };
}

type RenameQuickPickItem = vscode.QuickPickItem & {
  targetType: 'note' | 'folder';
  noteId?: string;
  folderId?: string;
  teamPath?: ModelScope;
  currentName?: string;
};

type CreateLocationQuickPickItem = vscode.QuickPickItem & {
  teamPath: ModelScope;
  parentFolderId: string | null;
};

export async function pickCreateLocation(
  model: ReturnType<typeof getHackmdModel>,
  placeHolder: string
): Promise<{ teamPath: ModelScope; parentFolderId: string | null } | undefined> {
  const items: CreateLocationQuickPickItem[] = [];

  // Personal root is always available.
  items.push({
    label: '$(home) My Notes',
    description: 'Root',
    teamPath: null,
    parentFolderId: null,
  });

  const personalSnapshot = model.getScopeSnapshotSync(model.getMyNotesEntity());
  if (personalSnapshot) {
    for (const folder of collectFolders(personalSnapshot.rootFolders)) {
      items.push({
        label: `$(folder) ${folder.name}`,
        description: `My Notes${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        teamPath: null,
        parentFolderId: folder.id,
      });
    }
  }

  for (const team of model.getTeams()) {
    items.push({
      label: `$(organization) ${team.name || team.path}`,
      description: 'Root',
      detail: team.path,
      teamPath: team.path,
      parentFolderId: null,
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
        teamPath: team.path,
        parentFolderId: folder.id,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {
    return undefined;
  }

  return {
    teamPath: selected.teamPath,
    parentFolderId: selected.parentFolderId,
  };
}

async function pickRenameTarget(
  model: ReturnType<typeof getHackmdModel>
): Promise<RenameQuickPickItem | undefined> {
  const scopes: Array<{ entity: ModelMyNotes | ModelTeam; teamPath: ModelScope; scopeLabel: string }> = [
    { entity: model.getMyNotesEntity(), teamPath: null, scopeLabel: 'My Notes' },
    ...model.getTeams().map((team) => ({ entity: team, teamPath: team.path as ModelScope, scopeLabel: team.name || team.path })),
  ];

  const items: RenameQuickPickItem[] = [];

  for (const scope of scopes) {
    const snapshot = model.getScopeSnapshotSync(scope.entity);
    if (!snapshot) {
      continue;
    }

    const folders = collectFolders(snapshot.rootFolders);
    for (const folder of folders) {
      items.push({
        label: `$(folder) ${folder.name}`,
        description: `${scope.scopeLabel}${folder.path ? ` • ${folder.path}` : ''}`,
        detail: folder.id,
        targetType: 'folder',
        folderId: folder.id,
        teamPath: scope.teamPath,
        currentName: folder.name,
      });
    }

    const notes = collectNotes(snapshot.rootFolders, snapshot.rootNotes);
    for (const note of notes) {
      const title = note.title || note.shortId || note.id;
      items.push({
        label: `$(note) ${title}`,
        description: `${scope.scopeLabel} • ${note.id}`,
        detail: note.title ? undefined : note.id,
        targetType: 'note',
        noteId: note.id,
        teamPath: scope.teamPath,
        currentName: note.title || '',
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

  return selected;
}

async function resolveMoveCandidates(
  model: ReturnType<typeof getHackmdModel>,
  activeItem?: any,
  selectedItems?: any[]
): Promise<MoveItem[] | undefined> {
  if (Array.isArray(selectedItems) && selectedItems.length > 0) {
    const selected = dedupeMoveItems(selectedItems.map(toMoveItem).filter((v): v is MoveItem => !!v));
    return selected.length > 0 ? selected : undefined;
  }

  if (activeItem !== undefined) {
    const active = toMoveItem(activeItem);
    return active ? [active] : undefined;
  }

  const picked = await pickEntity(model, 'Choose an item to move');
  if (!picked) {
    return undefined;
  }

  if (picked.kind === 'folder') {
    return [{ kind: 'folder', id: picked.folderId, teamPath: asScope(picked.teamPath), parentFolderId: null }];
  }

  return [{
    kind: 'note',
    id: picked.noteId,
    teamPath: asScope(picked.teamPath),
    parentFolderId: picked.note?.parentFolderId ?? picked.note?.parentForderId ?? null,
  }];
}

async function pickMoveTargetFolder(
  model: ReturnType<typeof getHackmdModel>,
  itemsToMove: MoveItem[],
  scopeIndexes: Map<ModelScope, ScopeIndex>
): Promise<MoveTarget | undefined> {
  const scope = itemsToMove[0]?.teamPath ?? null;
  const index = scopeIndexes.get(scope);
  const snapshot = index?.snapshot;

  if (!snapshot) {
    vscode.window.showErrorMessage('Scope data is not loaded. Please refresh the scope first.');
    return undefined;
  }

  const folderTargets = [{ id: null as string | null, label: 'Root', description: 'No parent folder' }]
    .concat(collectFolders(snapshot.rootFolders).map((folder) => ({
      id: folder.id,
      label: folder.name,
      description: folder.path || folder.id,
    })));

  const validTargets = folderTargets.filter((target) => {
    const moveTarget: MoveTarget = { teamPath: scope, folderId: target.id };
    const validForAll = itemsToMove.every((item) => isValidMoveDestination(item, moveTarget, scopeIndexes));
    const differsForAtLeastOne = itemsToMove.some((item) => (item.parentFolderId ?? null) !== target.id);
    return validForAll && differsForAtLeastOne;
  });

  if (validTargets.length === 0) {
    vscode.window.showErrorMessage('No valid destination folder is available for the selected items.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    validTargets.map((target) => ({ label: target.label, description: target.description, folderId: target.id })),
    {
      placeHolder: 'Choose destination folder',
      ignoreFocusOut: true,
    }
  );

  if (!picked) {
    return undefined;
  }

  return {
    teamPath: scope,
    folderId: picked.folderId ?? null,
  };
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

  register('hackmd.model.refreshScope', async (args?: { teamPath?: string | null; team?: { path?: string }; path?: string } | any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath: string | null | undefined;
    if (args && Object.prototype.hasOwnProperty.call(args, 'teamPath')) {
      teamPath = args.teamPath;
    } else {
      teamPath = args?.team?.path ?? args?.path;
    }

    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope to refresh');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    const scopeEntity = teamPath
      ? (model.getTeamByPath(teamPath) ?? { type: 'team' as const, id: '', path: teamPath, name: teamPath, rootFolders: [], rootNotes: [] })
      : model.getMyNotesEntity();
    await model.refresh(scopeEntity);
    return true;
  });

  register('hackmd.model.refreshTeam', async (args?: { teamPath?: string | null; team?: { path?: string }; path?: string } | any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath: string | null | undefined;
    if (args && Object.prototype.hasOwnProperty.call(args, 'teamPath')) {
      teamPath = args.teamPath;
    } else {
      teamPath = args?.team?.path ?? args?.path;
    }

    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope to refresh');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    const scopeEntity2 = teamPath
      ? (model.getTeamByPath(teamPath) ?? { type: 'team' as const, id: '', path: teamPath, name: teamPath, rootFolders: [], rootNotes: [] })
      : model.getMyNotesEntity();
    await model.refresh(scopeEntity2);
    return true;
  });

  register('hackmd.model.createNote', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const scope = extractScopeContext(node);
    let teamPath = scope.teamPath;
    let parentFolderId = scope.parentFolderId;

    if (parentFolderId) {
      teamPath = inferTeamPathFromFolderId(model, parentFolderId, teamPath);
    }

    if (teamPath === undefined && parentFolderId === undefined) {
      const location = await pickCreateLocation(model, 'Choose where to create the new note');
      if (!location) {
        return;
      }
      teamPath = location.teamPath;
      parentFolderId = location.parentFolderId ?? undefined;
    } else {
      // Node provided: default parentFolderId to root if not set (e.g. team node)
      parentFolderId = parentFolderId ?? undefined;
    }

    const scopeEntity: ModelMyNotes | ModelTeam = teamPath ? model.getTeamByPath(teamPath) ?? model.getMyNotesEntity() : model.getMyNotesEntity();
    const container: ModelMyNotes | ModelTeam | ModelFolder = parentFolderId
      ? (model.getFolderSync(scopeEntity, parentFolderId) ?? scopeEntity)
      : scopeEntity;

    const created = await model.createNote(container, {});
    await vscode.commands.executeCommand('hackmd.ui.reveal', { type: 'note', note: created });
    await vscode.commands.executeCommand('hackmd.ui.edit', { type: 'note', note: created });
    return created;
  });

  register('hackmd.model.createFolder', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const scope = extractScopeContext(node);
    let teamPath = scope.teamPath;
    let parentFolderId = scope.parentFolderId;

    if (parentFolderId) {
      teamPath = inferTeamPathFromFolderId(model, parentFolderId, teamPath);
    }

    if (teamPath === undefined && parentFolderId === undefined) {
      const location = await pickCreateLocation(model, 'Choose where to create the new folder');
      if (!location) {
        return;
      }
      teamPath = location.teamPath;
      parentFolderId = location.parentFolderId ?? undefined;
    } else {
      // Node provided: default parentFolderId to root if not set (e.g. team node)
      parentFolderId = parentFolderId ?? undefined;
    }

    const name = await promptRequiredInput('Folder name');
    if (!name) {
      return;
    }

    const scopeEntity: ModelMyNotes | ModelTeam = teamPath ? model.getTeamByPath(teamPath) ?? model.getMyNotesEntity() : model.getMyNotesEntity();
    const container: ModelMyNotes | ModelTeam | ModelFolder = parentFolderId
      ? (model.getFolderSync(scopeEntity, parentFolderId) ?? scopeEntity)
      : scopeEntity;

    const created = await model.createFolder(container, { name });
    await vscode.commands.executeCommand('hackmd.ui.reveal', {
      type: 'folder',
      id: created.id,
      teamPath: created.teamPath,
    });
    return created;
  });

  // Scoped variants for command palette discoverability
  register('hackmd.model.createMyNote', async () => {
    const targetNode = {
      type: 'container',
      container: 'my-notes',
      viewId: 'hackmd.tree.my-notes',
    };
    return vscode.commands.executeCommand('hackmd.model.createNote', targetNode);
  });

  register('hackmd.model.createMyFolder', async () => {
    const targetNode = {
      type: 'container',
      container: 'my-notes',
      viewId: 'hackmd.tree.my-notes',
    };
    return vscode.commands.executeCommand('hackmd.model.createFolder', targetNode);
  });

  register('hackmd.model.rename', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const targetNode = node ?? getSelectedTreeNodeFallback();
    const noteFromNode = extractNote(targetNode);
    if (noteFromNode?.id) {
      const noteId: string = noteFromNode.id;
      const teamPath: string | null = noteFromNode.teamPath ?? null;
      const initialTitle: string = noteFromNode.title || '';

      const newTitle = await promptRequiredInput('New note title', initialTitle);
      if (!newTitle) {
        return;
      }

      return model.renameNote(noteId, newTitle, teamPath);
    }

    const folderFromNode = extractFolder(targetNode);
    if (folderFromNode?.id) {
      const folderId: string = folderFromNode.id;
      const teamPath: string | null = folderFromNode.teamPath ?? null;
      const initialName: string = folderFromNode.name || '';

      const newName = await promptRequiredInput('New folder name', initialName);
      if (!newName) {
        return;
      }

      return model.updateFolder(folderFromNode, { name: newName });
    }

    if (targetNode !== undefined) {
      return;
    }

    const selected = await pickRenameTarget(model);
    if (!selected) {
      return;
    }

    if (selected.targetType === 'note') {
      const newTitle = await promptRequiredInput('New note title', selected.currentName || '');
      if (!newTitle) {
        return;
      }

      return model.renameNote(selected.noteId!, newTitle, selected.teamPath ?? null);
    }

    if (selected.targetType === 'folder') {
      const newName = await promptRequiredInput('New folder name', selected.currentName || '');
      if (!newName) {
        return;
      }

      const folderScopeEntity = selected.teamPath ? model.getTeamByPath(selected.teamPath) ?? model.getMyNotesEntity() : model.getMyNotesEntity();
      const folderEntity = model.getFolderSync(folderScopeEntity, selected.folderId!);
      if (!folderEntity) {
        return;
      }

      return model.updateFolder(folderEntity, { name: newName });
    }

    return undefined;
  });

  const runMove = async (activeItem?: any, selectedItems?: any[], targetFolder?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const fallbackSelection = (!activeItem && (!selectedItems || selectedItems.length === 0))
      ? getSelectedTreeNodesFallback()
      : [];
    const resolvedActiveItem = activeItem ?? fallbackSelection[0];
    const resolvedSelectedItems = (selectedItems && selectedItems.length > 0)
      ? selectedItems
      : fallbackSelection;
    const hasTreeSelectionContext = resolvedActiveItem !== undefined || resolvedSelectedItems.length > 0;

    const candidates = await resolveMoveCandidates(model, resolvedActiveItem, resolvedSelectedItems);
    if (!candidates || candidates.length === 0) {
      if (hasTreeSelectionContext) {
        return;
      }
      return;
    }

    const scopeIndexes = new Map<ModelScope, ScopeIndex>();
    for (const scope of new Set(candidates.map((item) => item.teamPath))) {
      scopeIndexes.set(scope, buildScopeIndex(model, scope));
    }

    const hydratedCandidates = hydrateMoveItems(candidates, scopeIndexes);
    const itemsToMove = refineMoveItems(hydratedCandidates, scopeIndexes);
    if (itemsToMove.length === 0) {
      return;
    }

    const candidateScopes = new Set(itemsToMove.map((item) => item.teamPath));
    const defaultScope = itemsToMove[0]?.teamPath ?? null;

    let resolvedTarget = parseTargetFolder(targetFolder, defaultScope);
    if (!resolvedTarget) {
      if (candidateScopes.size > 1) {
        vscode.window.showErrorMessage('Selected items are from different scopes and cannot be moved together.');
        return;
      }
      resolvedTarget = await pickMoveTargetFolder(model, itemsToMove, scopeIndexes);
      if (!resolvedTarget) {
        return;
      }
    }

    const validItems = itemsToMove.filter((item) => isValidMoveDestination(item, resolvedTarget!, scopeIndexes));
    if (validItems.length === 0) {
      vscode.window.showErrorMessage('Target folder is not a valid move destination for selected items.');
      return;
    }

    const actionableItems = validItems.filter((item) => (item.parentFolderId ?? null) !== resolvedTarget!.folderId);
    if (actionableItems.length === 0) {
      return;
    }

    await Promise.all(actionableItems.map(async (item) => {
      const itemScopeIndex = scopeIndexes.get(item.teamPath)!;
      const targetScopeIndex = scopeIndexes.get(resolvedTarget!.teamPath)!;
      const destFolder = resolvedTarget!.folderId ? targetScopeIndex.folderById.get(resolvedTarget!.folderId) : undefined;
      if (!destFolder) {
        return;
      }

      if (item.kind === 'note') {
        const noteEntity = itemScopeIndex.noteById.get(item.id);
        if (!noteEntity) { return; }
        return model.moveNote(noteEntity, destFolder);
      }

      const folderEntity = itemScopeIndex.folderById.get(item.id);
      if (!folderEntity) { return; }
      return model.moveFolder(folderEntity, destFolder);
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
      note = picked.note ?? { id: picked.noteId, teamPath: picked.teamPath ?? null };
    }

    try {
      const content = await model.getNoteContent(note);
      const noteScopeEntity: ModelMyNotes | ModelTeam = note.teamPath ? model.getTeamByPath(note.teamPath) ?? model.getMyNotesEntity() : model.getMyNotesEntity();
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
      notes.push({ id: picked.noteId, teamPath: picked.teamPath ?? null });
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
        const scopeEntity = n.teamPath ? (model.getTeamByPath(n.teamPath) ?? model.getMyNotesEntity()) : model.getMyNotesEntity();
        const noteEntity = model.getNoteSync(scopeEntity, n.id);
        return noteEntity ? model.deleteNote(noteEntity) : undefined;
      }),
      ...folders.map((f) => {
        const scopeEntity = f.teamPath ? (model.getTeamByPath(f.teamPath) ?? model.getMyNotesEntity()) : model.getMyNotesEntity();
        const folderEntity = model.getFolderSync(scopeEntity, f.id);
        return folderEntity ? model.deleteFolder(folderEntity) : undefined;
      }),
    ]);
    return true;
  });
}
