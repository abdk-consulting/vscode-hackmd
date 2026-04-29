import { Note } from '@hackmd/api/dist/type';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './store';

// Cache ThemeIcon instances to prevent layout shifts during updates
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_LOCK = new vscode.ThemeIcon('lock');

type TreeNode = NoteNode | PlaceholderNode;

interface NoteNode {
  type: 'note';
  note: Note;
}

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

export class HistoryProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private notesCache: Note[] | null = null;
  // Track pending operations
  private pendingNotes = new Set<string>(); // Note IDs being opened/deleted/saved

  constructor(private extensionPath: string) { }

  refresh(): void {
    this.notesCache = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  removeNoteFromCache(noteId: string): void {
    if (this.notesCache) {
      const index = this.notesCache.findIndex(n => n.id === noteId);
      if (index !== -1) {
        this.notesCache.splice(index, 1);
        // Fire onChange to refresh the tree
        this._onDidChangeTreeData.fire(undefined);
      }
    }
  }

  updateNoteInCache(noteId: string, updatedNote: Note): void {
    if (this.notesCache) {
      const index = this.notesCache.findIndex(n => n.id === noteId);
      if (index !== -1) {
        this.notesCache[index] = updatedNote;
        // Fire onChange to refresh the tree
        this._onDidChangeTreeData.fire(undefined);
      }
    }
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
    // Fire event on root to trigger refresh (all history notes are at root level)
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingNote(noteId: string, noteObject?: Note): void {
    this.pendingNotes.delete(noteId);
    // Fire event on root to trigger refresh (all history notes are at root level)
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'note':
        return this.getNoteTreeItem(element);
      case 'placeholder':
        return this.getPlaceholderTreeItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // Root level - show history notes
      try {
        let notes = this.notesCache;
        if (!notes) {
          notes = await recordUsage(API.getHistory({ unwrapData: false }));
          this.notesCache = notes;
        }

        if (notes.length === 0) {
          return [{ type: 'placeholder', message: 'No history' }];
        }
        return notes.map(note => ({ type: 'note' as const, note }));
      } catch (error) {
        return [{ type: 'placeholder', message: `Error: ${error.message}` }];
      }
    }

    return [];
  }
  getParent(element: TreeNode): TreeNode | undefined {
    // History view is flat - all notes are at root level
    return undefined;
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
    const canEdit = meStore.getState().checkCanEdit(note);

    if (isPending) {
      item.contextValue = isOwner ? 'file-owned-pending' : 'file-pending';
    } else {
      item.contextValue = isOwner ? 'file-owned' : 'file';
    }

    // Set icon - spinner when pending, otherwise file icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else if (canEdit) {
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
}
