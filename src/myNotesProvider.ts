import { Note } from '@hackmd/api/dist/type';
import * as path from 'path';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './treeReactApp/store';

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

    // Fire onChange on the specific parent node (folder or root)
    if (note.folderPaths && note.folderPaths.length > 0) {
      // Note is in a folder - fire onChange on the deepest folder
      const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
      const folderNode = this.foldersCache.get(deepestFolder.id);
      if (folderNode) {
        // Fire onChange on the cached folder object (stable reference)
        this._onDidChangeTreeData.fire(folderNode);
      } else {
        // Fallback to root if folder not found in cache
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

        // Fire onChange on the specific parent node (folder or root)
        if (note.folderPaths && note.folderPaths.length > 0) {
          const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
          const folderNode = this.foldersCache.get(deepestFolder.id);
          if (folderNode) {
            // Fire onChange on the cached folder object (stable reference)
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
    item.contextValue = 'folder';
    item.tooltip = folderNode.name;

    // Store context on the item for command handlers
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = folderNode.clientId;
    (item as any).teamPath = folderNode.teamPath;

    // Set icon if available
    if (folderNode.icon) {
      item.iconPath = new vscode.ThemeIcon(folderNode.icon);
    }

    return item;
  }

  private getNoteTreeItem(noteNode: NoteNode): vscode.TreeItem {
    const note = noteNode.note;
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `note-${note.id}`; // Stable ID for VS Code to track this item

    item.command = {
      command: 'clickTreeItem',
      title: 'Open Note',
      arguments: [label, note.id],
    };

    // Store note ID for commands
    (item as any).noteId = note.id;

    // Set icon and context based on ownership
    const isOwner = meStore.getState().checkIsOwner(note);
    if (isOwner) {
      item.contextValue = 'file-owned';
      item.iconPath = {
        light: path.join(this.extensionPath, 'images/icon/light/file-text.svg'),
        dark: path.join(this.extensionPath, 'images/icon/dark/file-text.svg'),
      };
    } else {
      item.contextValue = 'file';
      item.iconPath = {
        light: path.join(this.extensionPath, 'images/icon/light/gist-secret.svg'),
        dark: path.join(this.extensionPath, 'images/icon/dark/gist-secret.svg'),
      };
    }

    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
    return item;
  }

  private organizeNotesIntoFolders(notes: Note[]): { rootFolders: FolderNode[]; rootNotes: Note[] } {
    const rootNotes: Note[] = [];

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

    return { rootFolders, rootNotes };
  }
}
