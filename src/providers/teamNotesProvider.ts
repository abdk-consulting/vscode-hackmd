import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScopeSnapshot, ModelTeam, ModelTeams } from '../model';

const ICON_FOLDER = new vscode.ThemeIcon('symbol-folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_ORGANIZATION = new vscode.ThemeIcon('organization');

type TreeNode = ModelTeam | ModelFolder | ModelNote | PlaceholderNode;

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

function compareStrings(a: string, b: string): number {
  const ci = (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
  return ci !== 0 ? ci : (a || '').localeCompare(b || '');
}

function compareTeamEntities(a: ModelTeam, b: ModelTeam): number {
  const byName = compareStrings(a.name || '', b.name || '');
  if (byName !== 0) {
    return byName;
  }
  return (a.id || '').localeCompare(b.id || '');
}

function compareFolderEntities(a: ModelFolder, b: ModelFolder): number {
  const byName = compareStrings(a.name || '', b.name || '');
  if (byName !== 0) {
    return byName;
  }
  return (a.id || '').localeCompare(b.id || '');
}

function getNoteDisplayName(note: ModelNote): string {
  return note.title || note.shortId || '';
}

function compareNoteEntities(a: ModelNote, b: ModelNote): number {
  const byName = compareStrings(getNoteDisplayName(a), getNoteDisplayName(b));
  if (byName !== 0) {
    return byName;
  }
  return (a.id || '').localeCompare(b.id || '');
}

function sortedFolders(folders: readonly ModelFolder[]): ModelFolder[] {
  return [...folders].sort(compareFolderEntities);
}

function sortedNotes(notes: readonly ModelNote[]): ModelNote[] {
  return [...notes].sort(compareNoteEntities);
}

function isPlaceholderNode(node: TreeNode): node is PlaceholderNode {
  return node.type === 'placeholder';
}

export class TeamNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangePendingState = new vscode.EventEmitter<boolean>();
  readonly onDidChangePendingState = this._onDidChangePendingState.event;

  private readonly model: ReturnType<typeof getHackmdModel> | null;
  private teamNotesPendingOperation = false;
  private teamsLoaded = false;
  private teamsLoadingPromise: Promise<void> | null = null;
  private readonly scopeLoadingPromises = new Map<ModelTeam, Promise<void>>();
  private lastError: string | null = null;

  private readonly folderByTeam = new Map<ModelTeam, Map<string, ModelFolder>>();
  private readonly folderParentByTeam = new Map<ModelTeam, Map<string, string | null>>();
  private readonly noteParentByTeam = new Map<ModelTeam, Map<string, string | null>>();
  private readonly childOrderSignatureByParent = new Map<ModelTeam | ModelFolder | ModelTeams, Array<ModelFolder | ModelNote | ModelTeam>>();

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.teamNotesPendingOperation = !!this.model.isPending(this.model.getTeamsEntity());
      this.model.onDidChangeEntity((event) => {
        if (!this.teamsLoaded) {
          return;
        }

        const entity = event.entity;
        // If Teams container changed, invalidate whole tree
        if (entity.type === 'teams') {
          this._onDidChangeTreeData.fire(undefined);
          return;
        }

        if (entity.type === 'team') {
          this.handleEntityUpsert(entity);
        } else if (entity.type === 'folder' && this.isTeamScopedEntity(entity)) {
          this.handleEntityUpsert(entity);
        } else if (entity.type === 'note' && this.isTeamScopedEntity(entity)) {
          this.handleEntityUpsert(entity);
        }
      });
      this.model.onDidChangePending((event) => {
        const entity = event.entity;

        if (entity.type === 'model-root' || entity.type === 'teams') {
          this.teamNotesPendingOperation = event.pending;
          this._onDidChangePendingState.fire(event.pending);
          return;
        }

        if (entity.type === 'team') {
          this._onDidChangeTreeData.fire(entity);
          return;
        }

        if (entity.type === 'folder' && this.isTeamScopedEntity(entity)) {
          this._onDidChangeTreeData.fire(entity);
          return;
        }

        if (entity.type === 'note' && this.isTeamScopedEntity(entity)) {
          this._onDidChangeTreeData.fire(entity);
        }
      });
    } catch {
      this.model = null;
    }
  }

  isPendingOperation(): boolean {
    return this.teamNotesPendingOperation;
  }

  private async ensureTeamsLoaded(force = false): Promise<void> {
    if (!this.model) {
      return;
    }
    if (!force && this.teamsLoaded) {
      return;
    }
    if (this.teamsLoadingPromise) {
      return this.teamsLoadingPromise;
    }

    this.teamsLoadingPromise = (async () => {
      try {
        await this.model!.refresh(this.model!.getTeamsEntity());
        this.teamsLoaded = true;
        this.lastError = null;
      } catch (error: any) {
        this.lastError = error?.message || 'Unknown error';
      } finally {
        this.teamsLoadingPromise = null;
      }
    })();

    return this.teamsLoadingPromise;
  }

  private async ensureScopeLoaded(team: ModelTeam, force = false): Promise<void> {
    if (!this.model) {
      return;
    }
    if (!force && this.model.getScopeSnapshotSync(team)) {
      return;
    }

    const existing = this.scopeLoadingPromises.get(team);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        await this.model!.refresh(team);
      } finally {
        this.scopeLoadingPromises.delete(team);
      }
    })();

    this.scopeLoadingPromises.set(team, promise);
    return promise;
  }

  private buildTeamIndexes(team: ModelTeam, snapshot: ModelScopeSnapshot | null): void {
    const folderMap = new Map<string, ModelFolder>();
    const parentMap = new Map<string, string | null>();
    const noteParentMap = new Map<string, string | null>();

    if (snapshot) {
      const walk = (folder: ModelFolder, parentId: string | null) => {
        folderMap.set(folder.id, folder);
        parentMap.set(folder.id, parentId);
        for (const note of folder.notes) {
          noteParentMap.set(note.id, folder.id);
        }
        for (const child of folder.children) {
          walk(child, folder.id);
        }
      };

      for (const root of snapshot.rootFolders) {
        walk(root, null);
      }
      for (const rootNote of snapshot.rootNotes) {
        noteParentMap.set(rootNote.id, null);
      }
    }

    this.folderByTeam.set(team, folderMap);
    this.folderParentByTeam.set(team, parentMap);
    this.noteParentByTeam.set(team, noteParentMap);

    this.childOrderSignatureByParent.set(team, this.computeChildOrderSignatureForParent(team));
    for (const folder of folderMap.values()) {
      this.childOrderSignatureByParent.set(folder, this.computeChildOrderSignatureForParent(folder));
    }
  }

  private computeChildOrderSignatureForParent(parent: ModelTeam | ModelFolder | ModelTeams): Array<ModelFolder | ModelNote | ModelTeam> {
    if (parent.type === 'teams') {
      return [...(this.model?.getTeams() || [])].sort(compareTeamEntities);
    }

    const folders = parent.type === 'team'
      ? sortedFolders(parent.rootFolders)
      : sortedFolders(parent.children);
    const notes = parent.type === 'team'
      ? sortedNotes(parent.rootNotes)
      : sortedNotes(parent.notes);

    return [...folders, ...notes];
  }

  private fireParentRefresh(team: ModelTeam, parentFolderId: string | null): void {
    if (!parentFolderId) {
      this._onDidChangeTreeData.fire(team);
      return;
    }

    const parent = this.folderByTeam.get(team)?.get(parentFolderId);
    this._onDidChangeTreeData.fire(parent || undefined);
  }

  private isTeamScopedEntity(entity: ModelFolder | ModelNote): boolean {
    if (!this.model) {
      return false;
    }
    return this.model.getScopeEntityForItem(entity).type === 'team';
  }

  private getEntityPositionFromSignature(
    signature: Array<ModelFolder | ModelNote | ModelTeam> | undefined,
    entity: ModelFolder | ModelNote | ModelTeam
  ): number {
    if (!signature || signature.length === 0) {
      return -1;
    }
    return signature.indexOf(entity);
  }

  private handleEntityUpsert(entity: ModelFolder | ModelNote | ModelTeam): void {
    if (!this.model) {
      return;
    }

    const parent = this.model.getImmediateParentContainer(entity);
    if (parent.type !== 'teams' && parent.type !== 'team' && parent.type !== 'folder') {
      return;
    }

    const previousSignature = this.childOrderSignatureByParent.get(parent);
    const previousPosition = this.getEntityPositionFromSignature(previousSignature, entity);

    const nextSignature = this.computeChildOrderSignatureForParent(parent);
    this.childOrderSignatureByParent.set(parent, nextSignature);
    const nextPosition = this.getEntityPositionFromSignature(nextSignature, entity);

    if (previousPosition !== nextPosition) {
      this._onDidChangeTreeData.fire(parent.type === 'teams' ? undefined : parent);
      return;
    }

    if (entity.type === 'team') {
      this._onDidChangeTreeData.fire(entity);
      return;
    }

    if (entity.type === 'folder') {
      this._onDidChangeTreeData.fire(entity);
      return;
    }

    this._onDidChangeTreeData.fire(entity);
  }

  isTeamLoaded(team: ModelTeam): boolean {
    if (!this.model) {
      return false;
    }
    return this.model.getScopeSnapshotSync(team) !== null;
  }

  findNoteInCache(note: ModelNote, team?: ModelTeam): ModelNote | undefined {
    if (!this.model) {
      return undefined;
    }

    if (team) {
      return this.model.getScopeEntityForItem(note) === team ? note : undefined;
    }

    for (const team of this.model.getTeams()) {
      if (this.model.getScopeEntityForItem(note) === team) {
        return note;
      }
    }

    return undefined;
  }

  getMoveFolderTargetsFromCache(team: ModelTeam): Array<{ label: string; folder: ModelFolder; folderPaths: any[] }> {
    if (!this.model) {
      return [];
    }
    const snapshot = this.model!.getScopeSnapshotSync(team);
    if (!snapshot) {
      return [];
    }

    this.buildTeamIndexes(team, snapshot);
    const parentMap = this.folderParentByTeam.get(team) || new Map<string, string | null>();
    const folderMap = this.folderByTeam.get(team) || new Map<string, ModelFolder>();

    const buildPath = (folderKey: string): any[] => {
      const path: any[] = [];
      let currentId: string | null | undefined = folderKey;
      while (currentId) {
        const folder = folderMap.get(currentId);
        if (!folder) {
          return [];
        }
        path.unshift({
          id: folder.id,
          name: folder.name,
          parentId: parentMap.get(folder.id) || undefined,
          clientId: folder.clientId || '',
        });
        currentId = parentMap.get(currentId) || null;
      }
      return path;
    };

    const targets: Array<{ label: string; folder: ModelFolder; folderPaths: any[] }> = [];
    for (const folder of folderMap.values()) {
      const folderPaths = buildPath(folder.id);
      if (folderPaths.length === 0) {
        continue;
      }
      targets.push({
        label: folderPaths.map((entry) => entry.name).join(' / '),
        folder,
        folderPaths,
      });
    }

    return targets;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isPlaceholderNode(element)) {
      return new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
    }

    if (element.type === 'team') {
      return this.getTeamTreeItem(element);
    }

    if (element.type === 'folder') {
      return this.getFolderTreeItem(element);
    }

    return this.getNoteTreeItem(element);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!this.model) {
      return [{ type: 'placeholder', message: 'HackMD is not connected.' }];
    }

    if (!element) {
      await this.ensureTeamsLoaded();
      if (this.lastError) {
        return [{ type: 'placeholder', message: `Error: ${this.lastError}` }];
      }

      const teams = [...this.model.getTeams()].sort(compareTeamEntities);
      if (teams.length === 0) {
        return [{ type: 'placeholder', message: 'No teams' }];
      }

      return teams;
    }

    if (isPlaceholderNode(element) || element.type === 'note') {
      return [];
    }

    if (element.type === 'team') {
      return this.getTeamChildren(element);
    }

    return this.getFolderChildren(element);
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    if (!this.model || isPlaceholderNode(element) || element.type === 'team') {
      return undefined;
    }

    const parent = this.model.getImmediateParentContainer(element);
    if (parent.type === 'team' || parent.type === 'folder') {
      return parent;
    }

    return undefined;
  }

  private async getTeamChildren(team: ModelTeam): Promise<TreeNode[]> {
    const snapshot = this.model?.getScopeSnapshotSync(team) || null;
    if (!snapshot) {
      void this.ensureScopeLoaded(team);
      return [{ type: 'placeholder', message: 'Loading notes...' }];
    }

    this.buildTeamIndexes(team, snapshot);

    const rootFolders = sortedFolders(snapshot.rootFolders);
    const rootNotes = sortedNotes(snapshot.rootNotes);

    if (rootFolders.length === 0 && rootNotes.length === 0) {
      return [{ type: 'placeholder', message: 'No notes' }];
    }

    return [...rootFolders, ...rootNotes];
  }

  private getFolderChildren(folder: ModelFolder): TreeNode[] {
    const scope = this.model?.getScopeEntityForItem(folder);
    const cached = scope?.type === 'team'
      ? (this.folderByTeam.get(scope)?.get(folder.id) || folder)
      : folder;

    return [
      ...sortedFolders(cached.children),
      ...sortedNotes(cached.notes),
    ];
  }

  private getTeamTreeItem(team: ModelTeam): vscode.TreeItem {
    const item = new vscode.TreeItem(team.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.label = team.name;
    item.id = `team-${team.id}`;

    const isLoaded = (this.model?.getScopeSnapshotSync(team) || null) !== null;
    const isPending = !!this.model?.isPending(team);

    if (isPending) {
      item.contextValue = isLoaded ? 'team-loaded-pending' : 'team-pending';
      item.iconPath = ICON_SPINNER;
    } else {
      item.contextValue = isLoaded ? 'team-loaded' : 'team';
      item.iconPath = ICON_ORGANIZATION;
    }

    item.description = team.path;
    (item as any).team = team;
    return item;
  }

  private getFolderTreeItem(folder: ModelFolder): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.label = folder.name;
    item.id = `folder-${folder.id}`;

    const isPending = !!this.model?.isPending(folder);
    const hasClientId = !!folder.clientId;
    item.contextValue = hasClientId
      ? (isPending ? 'folder-pending' : 'folder')
      : (isPending ? 'folder-no-client-id-pending' : 'folder-no-client-id');
    item.tooltip = folder.name;

    (item as any).source = 'model';
    (item as any).folderName = folder.name;
    const scope = this.model?.getScopeEntityForItem(folder);
    const parentId = scope?.type === 'team'
      ? this.folderParentByTeam.get(scope)?.get(folder.id)
      : undefined;
    (item as any).parentId = parentId || undefined;
    (item as any).folderClientId = folder.clientId || '';

    item.iconPath = isPending ? ICON_SPINNER : ICON_FOLDER;

    return item;
  }

  private getNoteTreeItem(note: ModelNote): vscode.TreeItem {
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.label = label;
    item.id = `note-${note.id}`;

    const isPending = !!this.model?.isPending(note);

    if (!isPending) {
      item.command = {
        command: 'hackmd.ui.edit',
        title: 'Open Note',
        arguments: [note, { preserveFocus: true }],
      };
    } else {
      item.command = undefined;
    }

    (item as any).source = 'model';
    item.contextValue = isPending ? 'file-pending' : 'file';
    item.iconPath = isPending ? ICON_SPINNER : ICON_FILE;
    return item;
  }
}
