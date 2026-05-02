import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScopeSnapshot } from './model';

const ICON_FOLDER = new vscode.ThemeIcon('folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');

type TreeNode = FolderNode | NoteNode | PlaceholderNode;

interface FolderNode {
  type: 'folder';
  source: 'model';
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId: string;
  teamPath: string | null;
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

export class MyNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly pendingContainers = new Set<string>();

  private readonly model: ReturnType<typeof getHackmdModel> | null;
  private loaded = false;
  private loadingPromise: Promise<void> | null = null;
  private lastError: string | null = null;

  private currentSnapshot: ModelScopeSnapshot | null = null;
  private readonly folderById = new Map<string, ModelFolder>();
  private readonly folderParentById = new Map<string, string | null>();
  private readonly noteById = new Map<string, ModelNote>();
  private readonly noteParentFolderById = new Map<string, string | null>();

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.model.onDidChangeState((event) => {
        if (event.scope === null || event.reason === 'refreshAll') {
          this.loaded = false;
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangeEntity((event) => {
        if (event.scope === null) {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangePending((event) => {
        if (
          (event.targetType === 'container' && event.container === 'my-notes')
          || (event.targetType === 'folder' && event.scope === null)
          || (event.targetType === 'note' && event.scope === null)
        ) {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
    } catch {
      this.model = null;
    }
  }

  private async ensureLoaded(force = false): Promise<void> {
    if (!this.model) {
      return;
    }
    if (!force && this.loaded) {
      return;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      try {
        await this.model!.refreshScope({ teamPath: null });
        this.currentSnapshot = this.model!.getScopeSnapshotSync(null);
        this.rebuildIndexes(this.currentSnapshot);
        this.loaded = true;
        this.lastError = null;
      } catch (error: any) {
        this.lastError = error?.message || 'Unknown error';
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  private rebuildIndexes(snapshot: ModelScopeSnapshot | null): void {
    this.folderById.clear();
    this.folderParentById.clear();
    this.noteById.clear();
    this.noteParentFolderById.clear();

    if (!snapshot) {
      return;
    }

    const walk = (folder: ModelFolder, parentId: string | null) => {
      this.folderById.set(folder.id, folder);
      this.folderParentById.set(folder.id, parentId);

      for (const note of folder.notes) {
        this.noteById.set(note.id, note);
        this.noteParentFolderById.set(note.id, folder.id);
      }

      for (const child of folder.children) {
        walk(child, folder.id);
      }
    };

    for (const root of snapshot.rootFolders) {
      walk(root, null);
    }

    for (const note of snapshot.rootNotes) {
      this.noteById.set(note.id, note);
      this.noteParentFolderById.set(note.id, null);
    }
  }

  refresh(): void {
    this.loaded = false;
    void this.ensureLoaded(true);
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshElement(_element?: TreeNode): void {
    this.refresh();
  }

  findNoteInCache(noteId: string): ModelNote | undefined {
    return this.noteById.get(noteId) || this.model?.getNoteSync(noteId, null) || undefined;
  }

  getMoveFolderTargetsFromCache(): Array<{ label: string; folderId: string; folderPaths: any[] }> {
    const targets: Array<{ label: string; folderId: string; folderPaths: any[] }> = [];
    for (const folder of this.folderById.values()) {
      const folderPaths = this.buildFolderPath(folder.id);
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

  private buildFolderPath(folderId: string): any[] {
    const path: any[] = [];
    let currentId: string | null | undefined = folderId;

    while (currentId) {
      const folder = this.folderById.get(currentId);
      if (!folder) {
        return [];
      }

      path.unshift({
        id: folder.id,
        name: folder.name,
        parentId: this.folderParentById.get(folder.id) || undefined,
        clientId: '',
      });

      currentId = this.folderParentById.get(currentId) || null;
    }

    return path;
  }

  setPendingNote(_noteId: string, _noteObject?: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingNote(_noteId: string, _noteObject?: any, emitEvent = true): void {
    if (emitEvent) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  setPendingContainer(containerId: string): void {
    this.pendingContainers.add(containerId);
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingContainer(containerId: string): void {
    this.pendingContainers.delete(containerId);
    this._onDidChangeTreeData.fire(undefined);
  }

  renameFolderInCache(_folderId: string, _newName: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  addFolderToCache(_folderData: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  moveFolderInCache(_folderId: string, _parentFolderId: string | null): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  removeFolderFromCache(_folderId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async addNoteToCache(note: ModelNote): Promise<NoteNode> {
    this._onDidChangeTreeData.fire(undefined);
    return { type: 'note', source: 'model', note };
  }

  removeNoteFromCache(_noteId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  updateNoteInCache(_noteId: string, _updatedNote: any, emitEvents = true): ModelNote | undefined {
    if (emitEvents) {
      this._onDidChangeTreeData.fire(undefined);
    }
    return undefined;
  }

  emitMoveChangeEvents(_oldNote: any, _updatedNote: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  private toFolderNode(folder: ModelFolder): FolderNode {
    return {
      type: 'folder',
      source: 'model',
      id: folder.id,
      name: folder.name,
      icon: undefined,
      color: undefined,
      parentId: this.folderParentById.get(folder.id) || undefined,
      clientId: '',
      teamPath: null,
      children: folder.children.map((child) => this.toFolderNode(child)),
      notes: [...folder.notes],
    };
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
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

    await this.ensureLoaded();
    if (this.lastError) {
      return [{ type: 'placeholder', message: `Error: ${this.lastError}` }];
    }

    const snapshot = this.model.getScopeSnapshotSync(null);
    this.currentSnapshot = snapshot;
    this.rebuildIndexes(snapshot);

    if (!snapshot) {
      return [{ type: 'placeholder', message: 'No notes' }];
    }

    if (!element) {
      const rootFolders = snapshot.rootFolders.map((folder) => this.toFolderNode(folder));
      const rootNotes = snapshot.rootNotes.map((note) => ({ type: 'note', source: 'model', note } as NoteNode));
      if (rootFolders.length === 0 && rootNotes.length === 0) {
        return [{ type: 'placeholder', message: 'No notes' }];
      }
      return [...rootFolders, ...rootNotes];
    }

    if (element.type === 'folder') {
      const folder = this.folderById.get(element.id);
      if (!folder) {
        return [];
      }
      const children: TreeNode[] = [];
      children.push(...folder.children.map((child) => this.toFolderNode(child)));
      children.push(...folder.notes.map((note) => ({ type: 'note', source: 'model', note } as NoteNode)));
      return children;
    }

    return [];
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    if (element.type === 'placeholder') {
      return undefined;
    }

    if (element.type === 'note') {
      const parentId = this.noteParentFolderById.get(element.note.id) || null;
      if (!parentId) {
        return undefined;
      }
      const parentFolder = this.folderById.get(parentId);
      return parentFolder ? this.toFolderNode(parentFolder) : undefined;
    }

    const parentId = this.folderParentById.get(element.id) || null;
    if (!parentId) {
      return undefined;
    }
    const parentFolder = this.folderById.get(parentId);
    return parentFolder ? this.toFolderNode(parentFolder) : undefined;
  }

  private getFolderTreeItem(folderNode: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folderNode.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder-${folderNode.id}`;

    const modelPending = this.model?.isFolderPendingOperation(folderNode.id, null) || false;
    const isPending = modelPending || this.pendingContainers.has(`folder-${folderNode.id}`);

    item.contextValue = isPending ? 'folder-no-client-id-pending' : 'folder-no-client-id';
    item.tooltip = folderNode.name;

    (item as any).source = 'model';
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = '';
    (item as any).teamPath = null;

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
        arguments: [{ noteId: note.id, teamPath: note.teamPath || null }],
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
