import { Note } from '@hackmd/api/dist/type';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './store';

// Cache ThemeIcon instances to prevent layout shifts during updates
const ICON_FOLDER = new vscode.ThemeIcon('folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_LOCK = new vscode.ThemeIcon('lock');

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
  // Cache folder objects to maintain stable references for change events
  private foldersCache = new Map<string, FolderNode>();
  // Track pending operations
  private pendingNotes = new Set<string>(); // Note IDs being opened/deleted/saved
  private pendingContainers = new Set<string>(); // Folder IDs or 'root' where notes are being created

  constructor(private extensionPath: string) { }

  refresh(): void {
    this.notesCache = null;
    this.foldersCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshElement(element?: TreeNode): void {
    // For personal notes, always refresh from root
    this.notesCache = null;
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

  clearPendingNote(noteId: string, noteObject?: Note): void {
    this.pendingNotes.delete(noteId);

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

  async addNoteToCache(note: Note): Promise<NoteNode> {
    let notes = this.notesCache;

    if (!notes) {
      // Notes not loaded yet - load them
      try {
        notes = await recordUsage(API.getNoteList({ unwrapData: false }));
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
    const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes);
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
        this.organizeNotesIntoFolders(this.notesCache);

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

  updateNoteInCache(noteId: string, updatedNote: Note): void {
    if (this.notesCache) {
      const index = this.notesCache.findIndex(n => n.id === noteId);
      if (index !== -1) {
        const oldNote = this.notesCache[index];
        this.notesCache[index] = updatedNote;

        // Rebuild tree to update folder objects
        this.organizeNotesIntoFolders(this.notesCache);

        // Manually determine where to fire event based on the note's location
        if (updatedNote.folderPaths && updatedNote.folderPaths.length > 0) {
          // Note is in a folder - fire onChange on the deepest folder
          const deepestFolder = updatedNote.folderPaths[updatedNote.folderPaths.length - 1];
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
      }
    }
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
        if (!notes) {
          notes = await recordUsage(API.getNoteList({ unwrapData: false }));
          this.notesCache = notes;
        }

        if (notes.length === 0) {
          return [{ type: 'placeholder', message: 'No notes' }];
        }

        const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes);

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
    item.contextValue = isPending ? 'folder-pending' : 'folder';
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

    // Set icon and context based on ownership
    const isOwner = meStore.getState().checkIsOwner(note);

    if (isPending) {
      item.contextValue = isOwner ? 'file-owned-pending' : 'file-pending';
    } else {
      item.contextValue = isOwner ? 'file-owned' : 'file';
    }

    // Set icon - spinner when pending, otherwise file icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else if (isOwner) {
      item.iconPath = ICON_FILE;
    } else {
      item.iconPath = ICON_LOCK;
    }

    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
    return item;
  }

  private organizeNotesIntoFolders(notes: Note[]): { rootFolders: FolderNode[]; rootNotes: Note[]; changedFolders: Set<FolderNode>; rootChanged: boolean } {
    const rootNotes: Note[] = [];
    const changedFolders = new Set<FolderNode>();

    // Collect all unique folders from notes, reusing cached folder objects
    for (const note of notes) {
      if (note.folderPaths && note.folderPaths.length > 0) {
        for (const folderPath of note.folderPaths) {
          if (!this.foldersCache.has(folderPath.id)) {
            // Create new folder object and cache it
            this.foldersCache.set(folderPath.id, {
              type: 'folder',
              id: folderPath.id,
              name: folderPath.name,
              icon: folderPath.icon,
              color: folderPath.color,
              parentId: folderPath.parentId,
              clientId: folderPath.clientId,
              teamPath: note.teamPath,
              children: [],
              notes: [],
            });
          }
        }
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
