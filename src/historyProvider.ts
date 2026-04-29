import { Note } from '@hackmd/api/dist/type';
import * as path from 'path';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './treeReactApp/store';

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
}
