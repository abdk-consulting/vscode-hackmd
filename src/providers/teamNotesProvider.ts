import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScopeSnapshot, ModelTeam } from '../model';

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
  private readonly scopeLoadingPromises = new Map<string, Promise<void>>();
  private lastError: string | null = null;

  private readonly folderByTeamPath = new Map<string, Map<string, ModelFolder>>();
  private readonly folderParentByTeamPath = new Map<string, Map<string, string | null>>();
  private readonly noteParentByTeamPath = new Map<string, Map<string, string | null>>();
  private readonly childOrderSignatureByParent = new Map<string, string>();
  private lastTeamsOrderSignature = '';

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.teamNotesPendingOperation = !!this.model.isPending(this.model.getTeamsEntity());
      this.model.onDidChangeEntity((event) => {
        if (!this.teamsLoaded) {
          return;
        }

        const entity = event.entity;
        if (entity.type === 'team') {
          this.handleTeamEntityChange(entity.id);
        } else if (entity.type === 'folder' && entity.teamPath !== null) {
          this.handleEntityUpsert(entity.teamPath, 'folder', entity.id);
        } else if (entity.type === 'note' && entity.teamPath !== null) {
          this.handleEntityUpsert(entity.teamPath, 'note', entity.id);
        }
      });
      this.model.onDidChangePending((event) => {
        const entity = event.entity;

        if (entity.type === 'teams') {
          if (this.teamNotesPendingOperation !== event.pending) {
            this.teamNotesPendingOperation = event.pending;
            this._onDidChangePendingState.fire(event.pending);
          }
          return;
        }

        if (entity.type === 'team') {
          this.fireTeamPendingRefresh(entity.path);
          return;
        }

        if (entity.type === 'folder' && entity.teamPath !== null) {
          this.fireFolderPendingRefresh(entity.teamPath, entity.id);
          return;
        }

        if (entity.type === 'note' && entity.teamPath !== null) {
          this.fireNotePendingRefresh(entity.teamPath, entity.id);
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
        this.lastTeamsOrderSignature = this.computeTeamsOrderSignature();
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

    const existing = this.scopeLoadingPromises.get(team.path);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        await this.model!.refresh(team);
      } finally {
        this.scopeLoadingPromises.delete(team.path);
      }
    })();

    this.scopeLoadingPromises.set(team.path, promise);
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

    this.folderByTeamPath.set(team.path, folderMap);
    this.folderParentByTeamPath.set(team.path, parentMap);
    this.noteParentByTeamPath.set(team.path, noteParentMap);

    this.rebuildTeamChildOrderSignatures(team, snapshot);
  }

  private getParentSignatureKey(teamPath: string, parentFolderId: string | null): string {
    return parentFolderId ? `${teamPath}:folder:${parentFolderId}` : `${teamPath}:root`;
  }

  private computeChildOrderSignature(team: ModelTeam, parentFolderId: string | null): string {
    const snapshot = this.model?.getScopeSnapshotSync(team) || null;
    const root = !parentFolderId;
    const folder = parentFolderId ? this.folderByTeamPath.get(team.path)?.get(parentFolderId) : undefined;
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

  private rebuildTeamChildOrderSignatures(team: ModelTeam, snapshot: ModelScopeSnapshot | null): void {
    const prefix = `${team.path}:`;
    for (const key of [...this.childOrderSignatureByParent.keys()]) {
      if (key.startsWith(prefix)) {
        this.childOrderSignatureByParent.delete(key);
      }
    }

    this.childOrderSignatureByParent.set(this.getParentSignatureKey(team.path, null), this.computeChildOrderSignature(team, null));

    if (!snapshot) {
      return;
    }

    const folderMap = this.folderByTeamPath.get(team.path) || new Map<string, ModelFolder>();
    for (const folderId of folderMap.keys()) {
      this.childOrderSignatureByParent.set(
        this.getParentSignatureKey(team.path, folderId),
        this.computeChildOrderSignature(team, folderId)
      );
    }
  }

  private fireParentRefresh(teamPath: string, parentFolderId: string | null): void {
    if (!parentFolderId) {
      const team = this.model?.getTeamByPath(teamPath);
      this._onDidChangeTreeData.fire(team || undefined);
      return;
    }

    const parent = this.folderByTeamPath.get(teamPath)?.get(parentFolderId);
    this._onDidChangeTreeData.fire(parent || undefined);
  }

  private fireFolderPendingRefresh(teamPath: string, folderId: string): void {
    const team = this.model?.getTeamByPath(teamPath);
    const folder = this.folderByTeamPath.get(teamPath)?.get(folderId) || (team ? this.model!.getFolderSync(team, folderId) : undefined);
    this._onDidChangeTreeData.fire(folder || undefined);
  }

  private fireNotePendingRefresh(teamPath: string, noteId: string): void {
    const team = this.model?.getTeamByPath(teamPath);
    const note = team ? this.model!.getNoteSync(team, noteId) : undefined;
    this._onDidChangeTreeData.fire(note || undefined);
  }

  private handleEntityUpsert(teamPath: string, entityType: 'folder' | 'note', entityId: string): void {
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

    const team = this.model?.getTeamByPath(teamPath);
    if (!team) {
      return;
    }
    const snapshot = this.model!.getScopeSnapshotSync(team) || null;
    this.buildTeamIndexes(team, snapshot);

    if (entityType === 'note') {
      const currentParent = this.model?.getNoteSync(team!, entityId)?.parentFolderId || null;
      parentCandidates.add(currentParent);
    }
    if (entityType === 'folder') {
      const currentParent = this.model?.getFolderSync(team!, entityId)?.parentId || null;
      parentCandidates.add(currentParent);
    }

    let parentOrderChanged = false;

    for (const parentId of parentCandidates) {
      const key = this.getParentSignatureKey(teamPath, parentId);
      const previous = previousByParent.get(key) || '';
      const next = this.computeChildOrderSignature(team, parentId);
      this.childOrderSignatureByParent.set(key, next);
      if (previous !== next) {
        this.fireParentRefresh(teamPath, parentId);
        parentOrderChanged = true;
      }
    }

    if (entityType === 'folder' && !parentOrderChanged) {
      const folder = this.folderByTeamPath.get(teamPath)?.get(entityId) || this.model?.getFolderSync(team!, entityId);
      this._onDidChangeTreeData.fire(folder || undefined);
    }

    if (entityType === 'note' && !parentOrderChanged) {
      const note = this.model?.getNoteSync(team!, entityId);
      this._onDidChangeTreeData.fire(note || undefined);
    }
  }

  private computeTeamsOrderSignature(): string {
    const teams = this.model?.getTeams() || [];
    const parts = teams.map((team) => `team:${team.id}`);
    return parts.join('|');
  }

  private fireTeamPendingRefresh(teamPath: string): void {
    if (!this.teamsLoaded) {
      return;
    }

    const team = this.model?.getTeamByPath(teamPath);
    this._onDidChangeTreeData.fire(team || undefined);
  }

  private handleTeamEntityChange(teamId: string): void {
    const previous = this.lastTeamsOrderSignature;
    const next = this.computeTeamsOrderSignature();
    this.lastTeamsOrderSignature = next;
    if (previous !== next) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const team = this.model?.getTeamById(teamId);
    this._onDidChangeTreeData.fire(team || undefined);
  }

  refresh(teamPath?: string): void {
    if (!this.model) {
      return;
    }

    if (!teamPath) {
      this.teamsLoaded = false;
      this.lastTeamsOrderSignature = '';
      void this.ensureTeamsLoaded(true);
      return;
    }

    const team = this.model?.getTeamByPath(teamPath);
    if (team) {
      void this.ensureScopeLoaded(team, true);
    }
  }

  refreshElement(element?: TreeNode): void {
    if (!element || isPlaceholderNode(element)) {
      this.refresh();
      return;
    }

    if (element.type === 'team') {
      void this.ensureScopeLoaded(element, true);
      return;
    }

    if (element.type === 'folder') {
      const team = this.model?.getTeamByPath(element.teamPath || '');
      if (team) {
        void this.ensureScopeLoaded(team, true);
      }
    }
  }

  getTeamIdFromPath(teamPath: string): string | undefined {
    return this.model?.getTeamByPath(teamPath)?.id;
  }

  isTeamLoaded(team: ModelTeam): boolean {
    if (!this.model) {
      return false;
    }
    return this.model.getScopeSnapshotSync(team) !== null;
  }

  findNoteInCache(noteId: string, teamPath?: string): ModelNote | undefined {
    if (!this.model) {
      return undefined;
    }

    if (teamPath) {
      const team = this.model.getTeamByPath(teamPath);
      return team ? (this.model.getNoteSync(team, noteId) || undefined) : undefined;
    }

    for (const team of this.model.getTeams()) {
      const note = this.model.getNoteSync(team, noteId);
      if (note) {
        return note;
      }
    }

    return undefined;
  }

  getMoveFolderTargetsFromCache(teamPath: string): Array<{ label: string; folderId: string; folderPaths: any[] }> {
    const team = this.model?.getTeamByPath(teamPath);
    if (!team) {
      return [];
    }
    const snapshot = this.model!.getScopeSnapshotSync(team);
    if (!snapshot) {
      return [];
    }

    this.buildTeamIndexes(team, snapshot);
    const parentMap = this.folderParentByTeamPath.get(teamPath) || new Map<string, string | null>();
    const folderMap = this.folderByTeamPath.get(teamPath) || new Map<string, ModelFolder>();

    const buildPath = (folderId: string): any[] => {
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

    const targets: Array<{ label: string; folderId: string; folderPaths: any[] }> = [];
    for (const folder of folderMap.values()) {
      const folderPaths = buildPath(folder.id);
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
    if (isPlaceholderNode(element) || element.type === 'team') {
      return undefined;
    }

    if (element.type === 'note') {
      const teamPath = element.teamPath || null;
      if (!teamPath) {
        return undefined;
      }

      const parentFolderId = element.parentFolderId || null;
      if (parentFolderId) {
        const folder = this.folderByTeamPath.get(teamPath)?.get(parentFolderId);
        if (folder) {
          return folder;
        }
      }

      return this.model?.getTeamByPath(teamPath);
    }

    const parentId = this.folderParentByTeamPath.get(element.teamPath || '')?.get(element.id) || null;
    if (parentId) {
      return this.folderByTeamPath.get(element.teamPath || '')?.get(parentId);
    }

    return this.model?.getTeamByPath(element.teamPath || '');
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
    const teamPath = folder.teamPath || '';
    const cached = this.folderByTeamPath.get(teamPath)?.get(folder.id) || folder;

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
    (item as any).teamPath = team.path;
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
    (item as any).folderId = folder.id;
    (item as any).folderName = folder.name;
    (item as any).parentId = this.folderParentByTeamPath.get(folder.teamPath || '')?.get(folder.id) || undefined;
    (item as any).folderClientId = folder.clientId || '';
    (item as any).teamPath = folder.teamPath;

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
        arguments: [{ type: 'note', note, preserveFocus: true }],
      };
    } else {
      item.command = undefined;
    }

    (item as any).source = 'model';
    (item as any).noteId = note.id;
    item.contextValue = isPending ? 'file-pending' : 'file';
    item.iconPath = isPending ? ICON_SPINNER : ICON_FILE;
    return item;
  }
}
