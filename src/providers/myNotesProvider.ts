import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelMyNotes, ModelNote, ModelScopeSnapshot } from '../model';

const ICON_FOLDER = new vscode.ThemeIcon('symbol-folder');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');

type TreeNode = ModelFolder | ModelNote | PlaceholderNode;

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

function compareStrings(a: string, b: string): number {
  const ci = (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
  return ci !== 0 ? ci : (a || '').localeCompare(b || '');
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

export class MyNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangePendingState = new vscode.EventEmitter<boolean>();
  readonly onDidChangePendingState = this._onDidChangePendingState.event;

  private myNotesPendingOperation = false;

  private readonly model: ReturnType<typeof getHackmdModel> | null;
  private loaded = false;
  private loadingPromise: Promise<void> | null = null;
  private lastError: string | null = null;

  private currentSnapshot: ModelScopeSnapshot | null = null;
  private readonly folderById = new Map<string, ModelFolder>();
  private readonly folderParentById = new Map<string, string | null>();
  private readonly noteById = new Map<string, ModelNote>();
  private readonly noteParentFolderById = new Map<string, string | null>();
  private readonly childOrderSignatureByParent = new Map<ModelMyNotes | ModelFolder, Array<ModelFolder | ModelNote>>();

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.myNotesPendingOperation = !!this.model.isPending(this.model.getMyNotesEntity());
      this.model.onDidChangeEntity((event) => {
        if (!this.loaded) {
          return;
        }

        const entity = event.entity;
        if (entity.type === 'note' && entity.teamPath === null) {
          this.handleEntityUpsert(entity);
        } else if (entity.type === 'folder' && entity.teamPath === null) {
          this.handleEntityUpsert(entity);
        }
      });
      this.model.onDidChangePending((event) => {
        const entity = event.entity;

        if (entity.type === 'model-root' || entity.type === 'my-notes') {
          this.myNotesPendingOperation = event.pending;
          this._onDidChangePendingState.fire(event.pending);
          return;
        }

        if (entity.type === 'folder' && entity.teamPath === null) {
          this._onDidChangeTreeData.fire(entity);
          return;
        }

        if (entity.type === 'note' && entity.teamPath === null) {
          this._onDidChangeTreeData.fire(entity);
        }
      });
    } catch {
      this.model = null;
    }
  }

  isPendingOperation(): boolean {
    return this.myNotesPendingOperation;
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
        await this.model!.refresh(this.model!.getMyNotesEntity());
        this.currentSnapshot = this.model!.getScopeSnapshotSync(this.model!.getMyNotesEntity());
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

    this.rebuildAllChildOrderSignatures();
  }

  private rebuildAllChildOrderSignatures(): void {
    this.childOrderSignatureByParent.clear();
    this.childOrderSignatureByParent.set(this.model!.getMyNotesEntity(), this.computeChildOrderSignatureForParent(this.model!.getMyNotesEntity()));
    for (const folder of this.folderById.values()) {
      this.childOrderSignatureByParent.set(folder, this.computeChildOrderSignatureForParent(folder));
    }
  }

  private fireParentRefresh(parent: ModelMyNotes | ModelFolder): void {
    if (parent.type === 'my-notes') {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this._onDidChangeTreeData.fire(parent);
  }

  private handleEntityUpsert(entity: ModelFolder | ModelNote): void {
    if (!this.model) {
      return;
    }

    const parent = this.model.getImmediateParentContainer(entity);
    if (parent.type !== 'my-notes' && parent.type !== 'folder') {
      return;
    }

    const previousSignature = this.childOrderSignatureByParent.get(parent);
    const previousPosition = this.getEntityPositionFromSignature(previousSignature, entity);

    const nextSignature = this.computeChildOrderSignatureForParent(parent);
    this.childOrderSignatureByParent.set(parent, nextSignature);
    const nextPosition = this.getEntityPositionFromSignature(nextSignature, entity);

    if (previousPosition !== nextPosition) {
      this.fireParentRefresh(parent);
      return;
    }

    if (entity.type === 'folder') {
      this._onDidChangeTreeData.fire(entity);
      return;
    }

    this._onDidChangeTreeData.fire(entity);
  }

  private computeChildOrderSignatureForParent(parent: ModelMyNotes | ModelFolder): Array<ModelFolder | ModelNote> {
    const folders = parent.type === 'my-notes'
      ? sortedFolders(this.currentSnapshot?.rootFolders || [])
      : sortedFolders(parent.children);
    const notes = parent.type === 'my-notes'
      ? sortedNotes(this.currentSnapshot?.rootNotes || [])
      : sortedNotes(parent.notes);

    return [...folders, ...notes];
  }

  private getEntityPositionFromSignature(
    signature: Array<ModelFolder | ModelNote> | undefined,
    entity: ModelFolder | ModelNote
  ): number {
    if (!signature || signature.length === 0) {
      return -1;
    }
    return signature.indexOf(entity);
  }

  findNoteInCache(noteId: string): ModelNote | undefined {
    return this.noteById.get(noteId) || this.model?.getNoteSync(this.model.getMyNotesEntity(), noteId) || undefined;
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
        clientId: folder.clientId || '',
      });

      currentId = this.folderParentById.get(currentId) || null;
    }

    return path;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isPlaceholderNode(element)) {
      return new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
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

    await this.ensureLoaded();
    if (this.lastError) {
      return [{ type: 'placeholder', message: `Error: ${this.lastError}` }];
    }

    const snapshot = this.model.getScopeSnapshotSync(this.model.getMyNotesEntity());
    this.currentSnapshot = snapshot;
    this.rebuildIndexes(snapshot);

    if (!snapshot) {
      return [{ type: 'placeholder', message: 'No notes' }];
    }

    if (!element) {
      const rootFolders = sortedFolders(snapshot.rootFolders);
      const rootNotes = sortedNotes(snapshot.rootNotes);
      if (rootFolders.length === 0 && rootNotes.length === 0) {
        return [{ type: 'placeholder', message: 'No notes' }];
      }
      return [...rootFolders, ...rootNotes];
    }

    if (isPlaceholderNode(element) || element.type === 'note') {
      return [];
    }

    const folder = this.folderById.get(element.id);
    if (!folder) {
      return [];
    }

    return [
      ...sortedFolders(folder.children),
      ...sortedNotes(folder.notes),
    ];
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    if (!this.model || isPlaceholderNode(element)) {
      return undefined;
    }

    const parent = this.model.getImmediateParentContainer(element);
    if (parent.type === 'folder') {
      return parent;
    }

    return undefined;
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
    (item as any).parentId = this.folderParentById.get(folder.id) || undefined;
    (item as any).folderClientId = folder.clientId || '';
    (item as any).teamPath = null;

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
