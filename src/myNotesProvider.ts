import * as vscode from 'vscode';


import { API } from './api';
import { Note } from './hackmdApiClient';
import { recordUsage } from './store';

// Cache ThemeIcon instances to prevent layout shifts during updates
const ICON_FOLDER = new vscode.ThemeIcon('folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');

function resolveFolderParentId(folderLike: any): string | undefined {
  const rawParentId = folderLike?.parentFolderId || folderLike?.parentForderId || folderLike?.parentId;
  if (!rawParentId) {
    return undefined;
  }

  const value = String(rawParentId);
  if (value === 'null') {
    return undefined;
  }
  return value.startsWith('folder-') ? value.slice('folder-'.length) : value;
}

type TreeNode = FolderNode | NoteNode | PlaceholderNode;

interface FolderNode {
  type: 'folder';
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId: string;
  teamPath: string | null;
  children: FolderNode[];
  notes: Note[];
}

interface NoteNode {
  type: 'note';
  note: Note;
}

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

export class MyNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private notesCache: Note[] | null = null;
  private foldersApiCache: any[] | null = null;
  // Cache folder objects to maintain stable references for change events
  private foldersCache = new Map<string, FolderNode>();
  // Track pending operations
  private pendingNotes = new Set<string>(); // Note IDs being opened/deleted/saved
  private pendingContainers = new Set<string>(); // Folder IDs or 'root' where notes are being created

  constructor(private extensionPath: string) { }

  refresh(): void {
    this.notesCache = null;
    this.foldersApiCache = null;
    this.foldersCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshElement(element?: TreeNode): void {
    // For personal notes, always refresh from root
    this.notesCache = null;
    this.foldersApiCache = null;
    this.foldersCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  // Find a note in cache and return it
  findNoteInCache(noteId: string): Note | undefined {
    if (!this.notesCache) {
      return undefined;
    }
    return this.notesCache.find(n => n.id === noteId);
  }

  getMoveFolderTargetsFromCache(): Array<{ label: string; folderId: string; folderPaths: any[] }> {
    const targets: Array<{ label: string; folderId: string; folderPaths: any[] }> = [];

    for (const folder of this.foldersCache.values()) {
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
    let currentId: string | undefined = folderId;

    while (currentId) {
      const folder = this.foldersCache.get(currentId);
      if (!folder) {
        return [];
      }

      path.unshift({
        id: folder.id,
        name: folder.name,
        icon: folder.icon,
        color: folder.color,
        parentId: folder.parentId,
        clientId: folder.clientId,
      });
      currentId = folder.parentId;
    }

    return path;
  }

  // Pending operation management
  setPendingNote(noteId: string, noteObject?: Note): void {
    this.pendingNotes.add(noteId);

    // Find the note to determine its parent
    let note = noteObject;
    if (!note && this.notesCache) {
      note = this.notesCache.find(n => n.id === noteId);
    }

    if (note) {
      // Fire event on the PARENT (folder or root) to trigger refresh
      if (note.folderPaths && note.folderPaths.length > 0) {
        const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
        const folderNode = this.foldersCache.get(deepestFolder.id);
        if (folderNode) {
          this._onDidChangeTreeData.fire(folderNode);
        } else {
          this._onDidChangeTreeData.fire(undefined);
        }
      } else {
        // Note is at root level
        this._onDidChangeTreeData.fire(undefined);
      }
    }
  }

  clearPendingNote(noteId: string, noteObject?: Note, emitEvent = true): void {
    this.pendingNotes.delete(noteId);

    if (!emitEvent) {
      return;
    }

    // Find the note to determine its parent
    let note = noteObject;
    if (!note && this.notesCache) {
      note = this.notesCache.find(n => n.id === noteId);
    }

    if (note) {
      // Fire event on the PARENT (folder or root) to trigger refresh
      if (note.folderPaths && note.folderPaths.length > 0) {
        const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
        const folderNode = this.foldersCache.get(deepestFolder.id);
        if (folderNode) {
          this._onDidChangeTreeData.fire(folderNode);
        } else {
          this._onDidChangeTreeData.fire(undefined);
        }
      } else {
        // Note is at root level
        this._onDidChangeTreeData.fire(undefined);
      }
    }
  }

  setPendingContainer(containerId: string): void {
    this.pendingContainers.add(containerId);
    // For containers, fire granular event if we can find the folder
    if (containerId === 'root') {
      // For root, refresh whole tree
      this._onDidChangeTreeData.fire(undefined);
    } else if (containerId.startsWith('folder-')) {
      const folderId = containerId.substring('folder-'.length);
      const folder = this.foldersCache.get(folderId);
      if (folder) {
        this._onDidChangeTreeData.fire(folder);
      }
    }
  }

  clearPendingContainer(containerId: string): void {
    this.pendingContainers.delete(containerId);
    // For containers, fire granular event if we can find the folder
    if (containerId === 'root') {
      // For root, refresh whole tree
      this._onDidChangeTreeData.fire(undefined);
    } else if (containerId.startsWith('folder-')) {
      const folderId = containerId.substring('folder-'.length);
      const folder = this.foldersCache.get(folderId);
      if (folder) {
        this._onDidChangeTreeData.fire(folder);
      }
    }
  }

  renameFolderInCache(folderId: string, newName: string): void {
    const folder = this.foldersCache.get(folderId);
    if (!folder) {
      return;
    }

    folder.name = newName;

    if (this.foldersApiCache) {
      const apiFolder = this.foldersApiCache.find((entry) => entry?.id === folderId);
      if (apiFolder) {
        apiFolder.name = newName;
      }
    }

    if (this.notesCache) {
      for (const note of this.notesCache) {
        if (!note.folderPaths || note.folderPaths.length === 0) {
          continue;
        }
        for (const folderPath of note.folderPaths) {
          if (folderPath.id === folderId) {
            folderPath.name = newName;
          }
        }
      }
    }

    this._onDidChangeTreeData.fire(folder);
  }

  addFolderToCache(folderData: any): void {
    const folderId = folderData?.id;
    if (!folderId) {
      return;
    }

    const parentId = folderData.parentId || folderData.parentFolderId;

    if (!this.foldersApiCache) {
      this.foldersApiCache = [];
    }
    const existingApiFolderIndex = this.foldersApiCache.findIndex((entry) => entry?.id === folderId);
    if (existingApiFolderIndex >= 0) {
      this.foldersApiCache[existingApiFolderIndex] = {
        ...this.foldersApiCache[existingApiFolderIndex],
        ...folderData,
        parentId,
      };
    } else {
      this.foldersApiCache.push({
        ...folderData,
        parentId,
      });
    }

    const existingFolder = this.foldersCache.get(folderId);
    if (existingFolder) {
      existingFolder.name = folderData.name || existingFolder.name;
      existingFolder.icon = folderData.icon || existingFolder.icon;
      existingFolder.color = folderData.color || existingFolder.color;
      existingFolder.parentId = parentId;
      existingFolder.clientId = folderData.clientId || existingFolder.clientId || '';
    } else {
      this.foldersCache.set(folderId, {
        type: 'folder',
        id: folderId,
        name: folderData.name || 'Folder',
        icon: folderData.icon,
        color: folderData.color,
        parentId,
        clientId: folderData.clientId || '',
        teamPath: null,
        children: [],
        notes: [],
      });
    }

    this.rebuildFolderHierarchyFromCache();
    this.syncNoteFolderPathsFromCache();
    this.fireFolderOrRoot(parentId || null);
  }

  moveFolderInCache(folderId: string, parentFolderId: string | null): void {
    const folder = this.foldersCache.get(folderId);
    if (!folder) {
      return;
    }

    const oldParentId = folder.parentId || null;
    folder.parentId = parentFolderId || undefined;

    if (this.foldersApiCache) {
      const apiFolder = this.foldersApiCache.find((entry) => entry?.id === folderId);
      if (apiFolder) {
        apiFolder.parentId = parentFolderId || undefined;
      }
    }

    this.rebuildFolderHierarchyFromCache();
    this.syncNoteFolderPathsFromCache();

    this.fireFolderOrRoot(oldParentId);
    if (oldParentId !== (parentFolderId || null)) {
      this.fireFolderOrRoot(parentFolderId || null);
    }
  }

  removeFolderFromCache(folderId: string): void {
    const subtreeIds = this.collectFolderSubtreeIds(folderId);
    if (subtreeIds.size === 0) {
      return;
    }

    const removedFolder = this.foldersCache.get(folderId);
    const oldParentId = removedFolder?.parentId || null;

    for (const id of subtreeIds) {
      this.foldersCache.delete(id);
    }

    if (this.foldersApiCache) {
      this.foldersApiCache = this.foldersApiCache.filter((entry) => !subtreeIds.has(entry?.id));
    }

    if (this.notesCache) {
      for (const note of this.notesCache) {
        if (!note.folderPaths || note.folderPaths.length === 0) {
          continue;
        }

        const filteredPaths = note.folderPaths.filter((folderPath) => !subtreeIds.has(folderPath.id));
        if (filteredPaths.length !== note.folderPaths.length) {
          (note as any).folderPaths = filteredPaths;
          (note as any).parentFolderId = filteredPaths.length > 0
            ? filteredPaths[filteredPaths.length - 1].id
            : null;
        }
      }
    }

    this.rebuildFolderHierarchyFromCache();
    this.syncNoteFolderPathsFromCache();
    this.fireFolderOrRoot(oldParentId);
  }

  private rebuildFolderHierarchyFromCache(): void {
    this.organizeNotesIntoFolders(this.notesCache || [], this.foldersApiCache || []);
  }

  private syncNoteFolderPathsFromCache(): void {
    if (!this.notesCache) {
      return;
    }

    for (const note of this.notesCache) {
      const currentPaths = ((note as any).folderPaths || []) as any[];
      if (currentPaths.length === 0) {
        (note as any).parentFolderId = null;
        continue;
      }

      const deepestFolderId = currentPaths[currentPaths.length - 1].id;
      const rebuiltPath = this.buildFolderPath(deepestFolderId);
      (note as any).folderPaths = rebuiltPath;
      (note as any).parentFolderId = rebuiltPath.length > 0
        ? rebuiltPath[rebuiltPath.length - 1].id
        : null;
    }
  }

  private collectFolderSubtreeIds(folderId: string): Set<string> {
    const ids = new Set<string>();
    const stack: string[] = [folderId];

    while (stack.length > 0) {
      const currentId = stack.pop() as string;
      if (ids.has(currentId)) {
        continue;
      }
      ids.add(currentId);

      for (const folder of this.foldersCache.values()) {
        if (folder.parentId === currentId) {
          stack.push(folder.id);
        }
      }
    }

    return ids;
  }

  private fireFolderOrRoot(folderId: string | null): void {
    if (!folderId) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const folder = this.foldersCache.get(folderId);
    if (folder) {
      this._onDidChangeTreeData.fire(folder);
      return;
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  async addNoteToCache(note: Note): Promise<NoteNode> {
    let notes = this.notesCache;

    if (!notes) {
      // Notes not loaded yet - load them
      try {
        notes = await recordUsage(API.getNoteList({ unwrapData: false }));
        try {
          this.foldersApiCache = await recordUsage(API.getFolders({ unwrapData: false }));
        } catch {
          this.foldersApiCache = [];
        }
        // Check if note is already in the list
        if (!notes.find(n => n.id === note.id)) {
          notes.unshift(note); // Add at beginning (newer notes first)
        }
        this.notesCache = notes;
      } catch (error) {
        // If loading fails, just add the single note
        notes = [note];
        this.notesCache = notes;
      }
    } else {
      // Notes already loaded - add the new note at the beginning
      notes.unshift(note);
    }

    // Build the tree structure (same as getChildren does)
    const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes, this.foldersApiCache || []);
    const children: TreeNode[] = [
      ...rootFolders,
      ...rootNotes.map(n => ({ type: 'note' as const, note: n }))
    ];

    // Find the note in the tree structure
    const findNoteInTree = (items: TreeNode[]): NoteNode | undefined => {
      for (const item of items) {
        if (item.type === 'note' && item.note.id === note.id) {
          return item;
        }
        if (item.type === 'folder') {
          const folderChildren = this.getFolderChildren(item);
          const found = findNoteInTree(folderChildren);
          if (found) return found;
        }
      }
      return undefined;
    };

    const noteNode = findNoteInTree(children);

    // Manually determine where to fire event based on the note's location
    if (note.folderPaths && note.folderPaths.length > 0) {
      // Note is in a folder - fire onChange on the deepest folder
      const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
      const folderNode = this.foldersCache.get(deepestFolder.id);
      if (folderNode) {
        this._onDidChangeTreeData.fire(folderNode);
      } else {
        // Fallback to root if folder not found
        this._onDidChangeTreeData.fire(undefined);
      }
    } else {
      // Note is at root level - fire onChange on root
      this._onDidChangeTreeData.fire(undefined);
    }

    // Return the note node (or create one if not found, which shouldn't happen)
    return noteNode || { type: 'note', note };
  }

  removeNoteFromCache(noteId: string): void {
    if (this.notesCache) {
      const index = this.notesCache.findIndex(n => n.id === noteId);
      if (index !== -1) {
        const note = this.notesCache[index];
        this.notesCache.splice(index, 1);

        // Rebuild tree to update folder objects
        this.organizeNotesIntoFolders(this.notesCache, this.foldersApiCache || []);

        // Manually determine where to fire event based on the note's location
        if (note.folderPaths && note.folderPaths.length > 0) {
          // Note was in a folder - fire onChange on the deepest folder
          const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
          const folderNode = this.foldersCache.get(deepestFolder.id);
          if (folderNode) {
            this._onDidChangeTreeData.fire(folderNode);
          } else {
            // Folder might have been deleted - refresh root
            this._onDidChangeTreeData.fire(undefined);
          }
        } else {
          // Note was at root level - fire onChange on root
          this._onDidChangeTreeData.fire(undefined);
        }
      }
    }
  }

  updateNoteInCache(noteId: string, updatedNote: Note, emitEvents = true): Note | undefined {
    if (this.notesCache) {
      const index = this.notesCache.findIndex(n => n.id === noteId);
      if (index !== -1) {
        const oldNote = this.notesCache[index];
        this.notesCache[index] = updatedNote;

        // Rebuild tree to update folder objects
        this.organizeNotesIntoFolders(this.notesCache, this.foldersApiCache || []);

        if (emitEvents) {
          this.emitMoveChangeEvents(oldNote, updatedNote);
        }

        return oldNote;
      }
    }

    return undefined;
  }

  emitMoveChangeEvents(oldNote: Note, updatedNote: Note): void {
    const oldTarget = this.getContainerTargetFromNote(oldNote);
    const newTarget = this.getContainerTargetFromNote(updatedNote);

    if (oldTarget.key === newTarget.key) {
      this.fireContainerTarget(oldTarget);
      return;
    }

    // Overlapping containers (root/folder or ancestor/descendant): emit only the ancestor container.
    if (oldTarget.folderId && newTarget.folderId) {
      if (this.isFolderAncestor(oldTarget.folderId, newTarget.folderId)) {
        this.fireContainerTarget(oldTarget);
        return;
      }
      if (this.isFolderAncestor(newTarget.folderId, oldTarget.folderId)) {
        this.fireContainerTarget(newTarget);
        return;
      }
    } else if (!oldTarget.folderId || !newTarget.folderId) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    // Independent containers: refresh old then new.
    this.fireContainerTarget(oldTarget);
    this.fireContainerTarget(newTarget);
  }

  private getContainerTargetFromNote(note: Note): { key: string; folderId?: string } {
    const folderId = note.folderPaths && note.folderPaths.length > 0
      ? note.folderPaths[note.folderPaths.length - 1].id
      : undefined;

    return folderId ? { key: `folder-${folderId}`, folderId } : { key: 'root' };
  }

  private fireContainerTarget(target: { key: string; folderId?: string }): void {
    if (!target.folderId) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const folderNode = this.foldersCache.get(target.folderId);
    if (folderNode) {
      this._onDidChangeTreeData.fire(folderNode);
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private isFolderAncestor(ancestorId: string, descendantId: string): boolean {
    let currentId: string | undefined = descendantId;

    while (currentId) {
      if (currentId === ancestorId) {
        return true;
      }

      const currentFolder = this.foldersCache.get(currentId);
      currentId = currentFolder?.parentId;
    }

    return false;
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
    if (!element) {
      // Root level - show folders and notes
      try {
        let notes = this.notesCache;
        let folders = this.foldersApiCache;
        if (!notes) {
          notes = await recordUsage(API.getNoteList({ unwrapData: false }));
          try {
            folders = await recordUsage(API.getFolders({ unwrapData: false }));
          } catch {
            folders = [];
          }
          this.notesCache = notes;
          this.foldersApiCache = folders;
        } else if (!folders) {
          try {
            folders = await recordUsage(API.getFolders({ unwrapData: false }));
          } catch {
            folders = [];
          }
          this.foldersApiCache = folders;
        }

        if (notes.length === 0 && (!folders || folders.length === 0)) {
          return [{ type: 'placeholder', message: 'No notes' }];
        }

        const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes, folders || []);

        const children: TreeNode[] = [];
        children.push(...rootFolders);
        children.push(...rootNotes.map(note => ({ type: 'note' as const, note })));

        return children;
      } catch (error) {
        return [{ type: 'placeholder', message: `Error: ${error.message}` }];
      }
    }

    switch (element.type) {
      case 'folder':
        return this.getFolderChildren(element);
      default:
        return [];
    }
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    switch (element.type) {
      case 'placeholder':
        return undefined;

      case 'note':
        // Find the parent folder
        if (element.note.folderPaths && element.note.folderPaths.length > 0) {
          const deepestFolder = element.note.folderPaths[element.note.folderPaths.length - 1];
          // Return the cached folder object
          const cachedFolder = this.foldersCache.get(deepestFolder.id);
          if (cachedFolder) {
            return cachedFolder;
          }
        }
        // Root level note
        return undefined;

      case 'folder':
        // Find parent folder
        if (element.parentId) {
          // Return the cached parent folder
          const parentFolder = this.foldersCache.get(element.parentId);
          if (parentFolder) {
            return parentFolder;
          }
        }
        // Root level folder
        return undefined;
    }
  }

  private getFolderChildren(folderNode: FolderNode): TreeNode[] {
    const children: TreeNode[] = [];
    children.push(...folderNode.children);
    children.push(...folderNode.notes.map(note => ({ type: 'note' as const, note })));
    return children;
  }

  private getFolderTreeItem(folderNode: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folderNode.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder-${folderNode.id}`; // Stable ID for VS Code to track this item
    const isPending = this.pendingContainers.has(`folder-${folderNode.id}`);
    const hasClientId = !!folderNode.clientId;
    if (isPending) {
      item.contextValue = hasClientId ? 'folder-pending' : 'folder-no-client-id-pending';
    } else {
      item.contextValue = hasClientId ? 'folder' : 'folder-no-client-id';
    }
    item.tooltip = folderNode.name;

    // Store context on the item for command handlers
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = folderNode.clientId;
    (item as any).teamPath = folderNode.teamPath;

    // Set icon - spinner when pending, otherwise folder icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else if (folderNode.icon) {
      item.iconPath = new vscode.ThemeIcon(folderNode.icon);
    } else {
      item.iconPath = ICON_FOLDER;
    }

    return item;
  }

  private getNoteTreeItem(noteNode: NoteNode): vscode.TreeItem {
    const note = noteNode.note;
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `note-${note.id}`; // Stable ID for VS Code to track this item

    const isPending = this.pendingNotes.has(note.id);

    if (!isPending) {
      item.command = {
        command: 'clickTreeItem',
        title: 'Open Note',
        arguments: [note], // Pass the note object directly
      };
    }

    // Store note ID for commands
    (item as any).noteId = note.id;

    if (isPending) {
      item.contextValue = 'file-pending';
    } else {
      item.contextValue = 'file';
    }

    // Set icon - spinner when pending, otherwise file icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else {
      item.iconPath = ICON_FILE;
    }

    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
    return item;
  }

  private organizeNotesIntoFolders(notes: Note[], apiFolders: any[]): { rootFolders: FolderNode[]; rootNotes: Note[]; changedFolders: Set<FolderNode>; rootChanged: boolean } {
    const rootNotes: Note[] = [];
    const changedFolders = new Set<FolderNode>();

    const noteFolderById = new Map<string, any>();
    for (const note of notes) {
      if (note.folderPaths && note.folderPaths.length > 0) {
        for (const folderPath of note.folderPaths) {
          noteFolderById.set(folderPath.id, folderPath);
        }
      }
    }

    const desiredFolderIds = new Set<string>();
    for (const folderPath of noteFolderById.values()) {
      desiredFolderIds.add(folderPath.id);
      const parentId = resolveFolderParentId(folderPath);
      const existing = this.foldersCache.get(folderPath.id);
      if (!existing) {
        this.foldersCache.set(folderPath.id, {
          type: 'folder',
          id: folderPath.id,
          name: folderPath.name,
          icon: folderPath.icon,
          color: folderPath.color,
          parentId,
          clientId: folderPath.clientId || '',
          teamPath: null,
          children: [],
          notes: [],
        });
      } else {
        existing.name = folderPath.name;
        existing.icon = folderPath.icon;
        existing.color = folderPath.color;
        existing.parentId = parentId;
        existing.clientId = folderPath.clientId || existing.clientId || '';
      }
    }

    for (const folder of apiFolders || []) {
      const folderId = folder.id;
      if (!folderId) {
        continue;
      }
      desiredFolderIds.add(folderId);

      const noteFolder = noteFolderById.get(folderId);
      const parentId = resolveFolderParentId(noteFolder) || resolveFolderParentId(folder);
      const existing = this.foldersCache.get(folderId);
      if (!existing) {
        this.foldersCache.set(folderId, {
          type: 'folder',
          id: folderId,
          name: folder.name,
          icon: folder.icon,
          color: folder.color,
          parentId,
          clientId: noteFolder?.clientId || '',
          teamPath: null,
          children: [],
          notes: [],
        });
      } else {
        existing.name = folder.name;
        existing.icon = folder.icon;
        existing.color = folder.color;
        if (parentId !== undefined || !existing.parentId) {
          existing.parentId = parentId;
        }
        if (!existing.clientId && noteFolder?.clientId) {
          existing.clientId = noteFolder.clientId;
        }
      }
    }

    for (const folderId of [...this.foldersCache.keys()]) {
      if (!desiredFolderIds.has(folderId)) {
        this.foldersCache.delete(folderId);
      }
    }

    // Snapshot current state before clearing
    const oldState = new Map<string, { childIds: Set<string>; noteIds: Set<string> }>();
    const oldNotesInFolders = new Set<string>();
    const oldNoteIds = new Set<string>(); // All notes that existed in old state
    for (const [folderId, folder] of this.foldersCache.entries()) {
      const noteIds = new Set(folder.notes.map(n => n.id));
      oldState.set(folderId, {
        childIds: new Set(folder.children.map(c => c.id)),
        noteIds,
      });
      // Track which notes were in folders and which notes existed
      for (const noteId of noteIds) {
        oldNotesInFolders.add(noteId);
        oldNoteIds.add(noteId);
      }
    }
    // Old root notes are notes that:
    // 1. Existed in the old state (in oldNoteIds OR weren't in any folder but existed)
    // 2. Weren't in any folder
    // We need to exclude NEW notes that weren't in the old state
    const oldRootNoteIds = new Set(
      notes
        .filter(n => !oldNotesInFolders.has(n.id) && oldNoteIds.has(n.id))
        .map(n => n.id)
    );

    const oldRootFoldersCount = [...this.foldersCache.values()].filter((folder) => !folder.parentId).length;

    // Clear children and notes arrays in all cached folders
    for (const folder of this.foldersCache.values()) {
      folder.children = [];
      folder.notes = [];
    }

    // Build folder hierarchy using cached objects
    const rootFolders: FolderNode[] = [];
    for (const folder of this.foldersCache.values()) {
      if (folder.parentId) {
        const parent = this.foldersCache.get(folder.parentId);
        if (parent) {
          parent.children.push(folder);
        } else {
          rootFolders.push(folder);
        }
      } else {
        rootFolders.push(folder);
      }
    }

    // Assign notes to their deepest folder
    for (const note of notes) {
      if (note.folderPaths && note.folderPaths.length > 0) {
        const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
        const folder = this.foldersCache.get(deepestFolder.id);
        if (folder) {
          folder.notes.push(note);
        } else {
          rootNotes.push(note);
        }
      } else {
        rootNotes.push(note);
      }
    }

    // Detect which folders changed by comparing with old state
    for (const [folderId, folder] of this.foldersCache.entries()) {
      const old = oldState.get(folderId);
      const newChildIds = new Set(folder.children.map(c => c.id));
      const newNoteIds = new Set(folder.notes.map(n => n.id));

      // Check if children or notes changed
      const childrenChanged = !old ||
        old.childIds.size !== newChildIds.size ||
        ![...old.childIds].every(id => newChildIds.has(id));

      const notesChanged = !old ||
        old.noteIds.size !== newNoteIds.size ||
        ![...old.noteIds].every(id => newNoteIds.has(id));

      if (childrenChanged || notesChanged) {
        changedFolders.add(folder);
      }
    }

    // Check if root notes changed
    const newRootNoteIds = new Set(rootNotes.map(n => n.id));
    const rootChanged =
      oldRootNoteIds.size !== newRootNoteIds.size ||
      ![...oldRootNoteIds].every(id => newRootNoteIds.has(id)) ||
      // Also check if root folders changed (this happens when folders are added/removed)
      rootFolders.length !== oldRootFoldersCount;

    return { rootFolders, rootNotes, changedFolders, rootChanged };
  }
}
