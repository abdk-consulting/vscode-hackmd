import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScopeSnapshot, ModelTeam } from '../model';

const ICON_FOLDER = new vscode.ThemeIcon('folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_ORGANIZATION = new vscode.ThemeIcon('organization');

type TreeNode = TeamNode | FolderNode | NoteNode | PlaceholderNode;

interface TeamNode {
  type: 'team';
  source: 'model';
  team: ModelTeam;
}

interface FolderNode {
  type: 'folder';
  source: 'model';
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId: string;
  teamPath: string;
  children: FolderNode[];
  notes: ModelNote[];
}

interface NoteNode {
  type: 'note';
  source: 'model';
  note: ModelNote;
}

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

export class TeamNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly model: ReturnType<typeof getHackmdModel> | null;
  private teamsLoaded = false;
  private teamsLoadingPromise: Promise<void> | null = null;
  private readonly scopeLoadingPromises = new Map<string, Promise<void>>();
  private lastError: string | null = null;

  private readonly teamNodesCache = new Map<string, TeamNode>();
  private readonly folderByTeamPath = new Map<string, Map<string, ModelFolder>>();
  private readonly folderParentByTeamPath = new Map<string, Map<string, string | null>>();
  private readonly noteParentByTeamPath = new Map<string, Map<string, string | null>>();
  private readonly childOrderSignatureByParent = new Map<string, string>();

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.model.onDidChangeState((event) => {
        if (event.reason === 'refreshTeams' || event.reason === 'refreshScope' || event.reason === 'refreshAll') {
          if (event.reason === 'refreshTeams' || event.reason === 'refreshAll') {
            this.teamsLoaded = true;
          }
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangeEntity((event) => {
        if (event.scope !== null && event.changeType === 'upsert' && this.teamsLoaded) {
          this.handleEntityUpsert(event.scope, event.entityType, event.id);
          return;
        }
        if (event.scope !== null) {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangePending((event) => {
        if (event.targetType === 'container' || event.targetType === 'team' || event.targetType === 'folder' || event.targetType === 'note') {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
    } catch {
      this.model = null;
    }
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
        await this.model!.refreshTeams();
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

  private async ensureScopeLoaded(teamPath: string, force = false): Promise<void> {
    if (!this.model) {
      return;
    }
    if (!force && this.model.getScopeSnapshotSync(teamPath)) {
      return;
    }

    const existing = this.scopeLoadingPromises.get(teamPath);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        await this.model!.refreshScope({ teamPath });
      } finally {
        this.scopeLoadingPromises.delete(teamPath);
      }
    })();

    this.scopeLoadingPromises.set(teamPath, promise);
    return promise;
  }

  private buildTeamIndexes(teamPath: string, snapshot: ModelScopeSnapshot | null): void {
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

    this.folderByTeamPath.set(teamPath, folderMap);
    this.folderParentByTeamPath.set(teamPath, parentMap);
    this.noteParentByTeamPath.set(teamPath, noteParentMap);
    this.rebuildTeamChildOrderSignatures(teamPath, snapshot);
  }

  private getParentSignatureKey(teamPath: string, parentFolderId: string | null): string {
    return parentFolderId ? `${teamPath}:folder:${parentFolderId}` : `${teamPath}:root`;
  }

  private computeChildOrderSignature(teamPath: string, parentFolderId: string | null): string {
    const snapshot = this.model?.getScopeSnapshotSync(teamPath) || null;
    const root = !parentFolderId;
    const folder = parentFolderId ? this.folderByTeamPath.get(teamPath)?.get(parentFolderId) : undefined;
    const folders = root
      ? sortedFolders(snapshot?.rootFolders || [])
      : sortedFolders(folder?.children || []);
    const notes = root
      ? sortedNotes(snapshot?.rootNotes || [])
      : sortedNotes(folder?.notes || []);

    const parts = [
      ...folders.map((f) => `folder:${f.id}`),
      ...notes.map((n) => `note:${n.id}`),
    ];
    return parts.join('|');
  }

  private rebuildTeamChildOrderSignatures(teamPath: string, snapshot: ModelScopeSnapshot | null): void {
    const prefix = `${teamPath}:`;
    for (const key of [...this.childOrderSignatureByParent.keys()]) {
      if (key.startsWith(prefix)) {
        this.childOrderSignatureByParent.delete(key);
      }
    }

    this.childOrderSignatureByParent.set(this.getParentSignatureKey(teamPath, null), this.computeChildOrderSignature(teamPath, null));

    if (!snapshot) {
      return;
    }

    const folderMap = this.folderByTeamPath.get(teamPath) || new Map<string, ModelFolder>();
    for (const folderId of folderMap.keys()) {
      this.childOrderSignatureByParent.set(
        this.getParentSignatureKey(teamPath, folderId),
        this.computeChildOrderSignature(teamPath, folderId)
      );
    }
  }

  private fireParentRefresh(teamPath: string, parentFolderId: string | null): void {
    if (!parentFolderId) {
      const team = this.model?.getTeamByPath(teamPath);
      this._onDidChangeTreeData.fire(team ? this.getCachedTeamNode(team) : undefined);
      return;
    }

    const parent = this.folderByTeamPath.get(teamPath)?.get(parentFolderId);
    this._onDidChangeTreeData.fire(parent ? this.toFolderNode(parent, teamPath) : undefined);
  }

  private handleEntityUpsert(teamPath: string, entityType: 'team' | 'folder' | 'note', entityId: string): void {
    const previousParentMap = this.folderParentByTeamPath.get(teamPath) || new Map<string, string | null>();
    const previousNoteParent = this.noteParentByTeamPath.get(teamPath)?.get(entityId) || null;
    const previousFolderParent = previousParentMap.get(entityId) || null;

    const parentCandidates = new Set<string | null>();
    if (entityType === 'note') {
      parentCandidates.add(previousNoteParent);
    }
    if (entityType === 'folder') {
      parentCandidates.add(previousFolderParent);
    }

    const previousByParent = new Map<string, string>();
    for (const parentId of parentCandidates) {
      const key = this.getParentSignatureKey(teamPath, parentId);
      previousByParent.set(key, this.childOrderSignatureByParent.get(key) || '');
    }

    const snapshot = this.model?.getScopeSnapshotSync(teamPath) || null;
    this.buildTeamIndexes(teamPath, snapshot);

    if (entityType === 'note') {
      const currentParent = this.model?.getNoteById(entityId, teamPath)?.parentFolderId || null;
      parentCandidates.add(currentParent);
    }
    if (entityType === 'folder') {
      const currentParent = this.model?.getFolderById(entityId, teamPath)?.parentId || null;
      parentCandidates.add(currentParent);
    }

    for (const parentId of parentCandidates) {
      const key = this.getParentSignatureKey(teamPath, parentId);
      const previous = previousByParent.get(key) || '';
      const next = this.computeChildOrderSignature(teamPath, parentId);
      this.childOrderSignatureByParent.set(key, next);
      if (previous !== next) {
        this.fireParentRefresh(teamPath, parentId);
      }
    }
  }

  private getCachedTeamNode(team: ModelTeam): TeamNode {
    const existing = this.teamNodesCache.get(team.id);
    if (existing) {
      existing.team = team;
      return existing;
    }

    const created: TeamNode = {
      type: 'team',
      source: 'model',
      team,
    };
    this.teamNodesCache.set(team.id, created);
    return created;
  }

  refresh(): void {
    this.teamsLoaded = false;
    void this.ensureTeamsLoaded(true);
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshTeam(teamId: string): void {
    const team = this.model?.getTeamById(teamId);
    if (!team) {
      return;
    }
    void this.ensureScopeLoaded(team.path, true);
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshElement(element: TreeNode): void {
    if (!this.model) {
      return;
    }

    if (element.type === 'team') {
      void this.ensureScopeLoaded(element.team.path, true);
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    if (element.type === 'folder') {
      void this.ensureScopeLoaded(element.teamPath, true);
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getTeamIdFromPath(teamPath: string): string | undefined {
    return this.model?.getTeamByPath(teamPath)?.id;
  }

  isTeamNotesCached(teamId: string): boolean {
    if (!this.model) {
      return false;
    }
    const team = this.model.getTeamById(teamId);
    if (!team) {
      return false;
    }
    return this.model.getScopeSnapshotSync(team.path) !== null;
  }

  cacheTeamNotes(_teamId: string, _notes: any[]): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  findNoteInCache(noteId: string, teamPath?: string): ModelNote | undefined {
    if (!this.model) {
      return undefined;
    }

    if (teamPath) {
      return this.model.getNoteSync(noteId, teamPath) || undefined;
    }

    for (const team of this.model.getTeams()) {
      const note = this.model.getNoteSync(noteId, team.path);
      if (note) {
        return note;
      }
    }
    return undefined;
  }

  getMoveFolderTargetsFromCache(teamPath: string): Array<{ label: string; folderId: string; folderPaths: any[] }> {
    const snapshot = this.model?.getScopeSnapshotSync(teamPath);
    if (!snapshot) {
      return [];
    }

    this.buildTeamIndexes(teamPath, snapshot);
    const parentMap = this.folderParentByTeamPath.get(teamPath) || new Map<string, string | null>();
    const folderMap = this.folderByTeamPath.get(teamPath) || new Map<string, ModelFolder>();

    const targets: Array<{ label: string; folderId: string; folderPaths: any[] }> = [];

    const buildFolderPath = (folderId: string): any[] => {
      const path: any[] = [];
      let currentId: string | null | undefined = folderId;

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

    for (const folder of folderMap.values()) {
      const folderPaths = buildFolderPath(folder.id);
      if (folderPaths.length === 0) {
        continue;
      }

      targets.push({
        label: folderPaths.map((entry) => entry.name).join(' / '),
        folderId: folder.id,
        folderPaths,
      });
    }

    return targets;
  }

  setPendingNote(_noteId: string, _noteObject?: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingNote(_noteId: string, _noteObject?: any, emitEvent = true): void {
    if (emitEvent) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  setPendingContainer(_containerId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingContainer(_containerId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  renameFolderInCache(_folderId: string, _newName: string, _teamPath?: string | null): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  addFolderToCache(_teamPath: string, _folderData: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  moveFolderInCache(_teamPath: string, _folderId: string, _parentFolderId: string | null): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  removeFolderFromCache(_teamPath: string, _folderId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async addNoteToCache(note: any, _teamPath: string): Promise<NoteNode | undefined> {
    this._onDidChangeTreeData.fire(undefined);
    return { type: 'note', source: 'model', note };
  }

  removeNoteFromCache(_noteId: string, _teamPath?: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  updateNoteInCache(_noteId: string, _updatedNote: any, _teamPath?: string, emitEvents = true): any {
    if (emitEvents) {
      this._onDidChangeTreeData.fire(undefined);
    }
    return undefined;
  }

  emitMoveChangeEvents(_oldNote: any, _updatedNote: any, _explicitTeamId?: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'team':
        return this.getTeamTreeItem(element);
      case 'folder':
        return this.getFolderTreeItem(element);
      case 'note':
        return this.getNoteTreeItem(element);
      case 'placeholder':
        return this.getPlaceholderTreeItem(element);
    }
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

      return teams.map((team) => this.getCachedTeamNode(team));
    }

    if (element.type === 'team') {
      return this.getTeamChildren(element);
    }

    if (element.type === 'folder') {
      return this.getFolderChildren(element);
    }

    return [];
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    if (element.type === 'team' || element.type === 'placeholder') {
      return undefined;
    }

    if (element.type === 'note') {
      const teamPath = element.note.teamPath || null;
      if (!teamPath) {
        return undefined;
      }

      const parentFolderId = element.note.parentFolderId || null;
      if (parentFolderId) {
        const folder = this.folderByTeamPath.get(teamPath)?.get(parentFolderId);
        if (folder) {
          return this.toFolderNode(folder, teamPath);
        }
      }

      const team = this.model?.getTeamByPath(teamPath);
      return team ? this.getCachedTeamNode(team) : undefined;
    }

    const parentId = element.parentId || null;
    if (parentId) {
      const parent = this.folderByTeamPath.get(element.teamPath)?.get(parentId);
      if (parent) {
        return this.toFolderNode(parent, element.teamPath);
      }
    }

    const team = this.model?.getTeamByPath(element.teamPath);
    return team ? this.getCachedTeamNode(team) : undefined;
  }

  private async getTeamChildren(teamNode: TeamNode): Promise<TreeNode[]> {
    const teamPath = teamNode.team.path;
    const snapshot = this.model?.getScopeSnapshotSync(teamPath) || null;
    if (!snapshot) {
      void this.ensureScopeLoaded(teamPath);
      return [{ type: 'placeholder', message: 'Loading notes...' }];
    }

    this.buildTeamIndexes(teamPath, snapshot);

    const rootFolders = sortedFolders(snapshot.rootFolders).map((folder) => this.toFolderNode(folder, teamPath));
    const rootNotes = sortedNotes(snapshot.rootNotes).map((note) => ({ type: 'note', source: 'model', note } as NoteNode));

    if (rootFolders.length === 0 && rootNotes.length === 0) {
      return [{ type: 'placeholder', message: 'No notes' }];
    }

    return [...rootFolders, ...rootNotes];
  }

  private getFolderChildren(folderNode: FolderNode): TreeNode[] {
    const teamPath = folderNode.teamPath;
    const folder = this.folderByTeamPath.get(teamPath)?.get(folderNode.id);
    if (!folder) {
      return [];
    }

    const children: TreeNode[] = [];
    children.push(...sortedFolders(folder.children).map((child) => this.toFolderNode(child, teamPath)));
    children.push(...sortedNotes(folder.notes).map((note) => ({ type: 'note', source: 'model', note } as NoteNode)));
    return children;
  }

  private toFolderNode(folder: ModelFolder, teamPath: string): FolderNode {
    const parentId = this.folderParentByTeamPath.get(teamPath)?.get(folder.id) || undefined;
    return {
      type: 'folder',
      source: 'model',
      id: folder.id,
      name: folder.name,
      icon: undefined,
      color: undefined,
      parentId,
      clientId: folder.clientId || '',
      teamPath,
      children: folder.children.map((child) => this.toFolderNode(child, teamPath)),
      notes: [...folder.notes],
    };
  }

  private getTeamTreeItem(teamNode: TeamNode): vscode.TreeItem {
    const item = new vscode.TreeItem(teamNode.team.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `team-${teamNode.team.id}`;

    const isLoaded = (this.model?.getScopeSnapshotSync(teamNode.team.path) || null) !== null;
    const isPending = !!teamNode.team.pendingOperation;

    if (isPending) {
      item.contextValue = isLoaded ? 'team-loaded-pending' : 'team-pending';
      item.iconPath = ICON_SPINNER;
    } else {
      item.contextValue = isLoaded ? 'team-loaded' : 'team';
      item.iconPath = ICON_ORGANIZATION;
    }

    item.description = teamNode.team.path;
    (item as any).teamPath = teamNode.team.path;
    return item;
  }

  private getFolderTreeItem(folderNode: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folderNode.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder-${folderNode.id}`;

    const isPending = this.model?.isFolderPendingOperation(folderNode.id, folderNode.teamPath) || false;
    const hasClientId = !!folderNode.clientId;
    item.contextValue = hasClientId
      ? (isPending ? 'folder-pending' : 'folder')
      : (isPending ? 'folder-no-client-id-pending' : 'folder-no-client-id');
    item.tooltip = folderNode.name;

    (item as any).source = 'model';
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = folderNode.clientId || '';
    (item as any).teamPath = folderNode.teamPath;

    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else {
      item.iconPath = folderNode.icon ? new vscode.ThemeIcon(folderNode.icon) : ICON_FOLDER;
    }

    return item;
  }

  private getNoteTreeItem(noteNode: NoteNode): vscode.TreeItem {
    const note = noteNode.note;
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `note-${note.id}`;

    const isPending = !!note.pendingOperation;

    if (!isPending) {
      item.command = {
        command: 'hackmd.ui.edit',
        title: 'Open Note',
        arguments: [{ type: 'note', note }],
      };
    }

    (item as any).source = 'model';
    (item as any).noteId = note.id;
    item.contextValue = isPending ? 'file-pending' : 'file';
    item.iconPath = isPending ? ICON_SPINNER : ICON_FILE;
    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    return new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
  }
}
