import * as vscode from 'vscode';

import { getHackmdModel, ModelNote } from './model';

// Cache ThemeIcon instances to prevent layout shifts during updates
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');

type TreeNode = NoteNode | PlaceholderNode;

interface NoteNode {
  type: 'note';
  note: ModelNote;
}

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

export class HistoryProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private lastError: string | null = null;
  private readonly model: ReturnType<typeof getHackmdModel> | null;

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.model.onDidChangeState((event) => {
        if (event.reason === 'refreshHistory' || event.reason === 'refreshScope') {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangeEntity((event) => {
        if (event.entityType === 'note') {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
      this.model.onDidChangePending((event) => {
        if (event.targetType === 'note') {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
    } catch {
      this.model = null;
    }
  }

  private async ensureHistoryLoaded(force = false): Promise<void> {
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
        await this.model!.refreshHistory();
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

  refresh(): void {
    this.loaded = false;
    void this.ensureHistoryLoaded(true);
    this._onDidChangeTreeData.fire(undefined);
  }

  removeNoteFromCache(noteId: string): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  updateNoteInCache(noteId: string, updatedNote: any, emitEvent = true): void {
    if (emitEvent) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  // Find a note in cache and return it
  findNoteInCache(noteId: string): ModelNote | undefined {
    if (!this.model) {
      return undefined;
    }
    return this.model.getHistoryNotes().find(n => n.id === noteId);
  }

  // Pending operation management
  setPendingNote(noteId: string, noteObject?: any): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clearPendingNote(noteId: string, noteObject?: any, emitEvent = true): void {
    if (emitEvent) {
      this._onDidChangeTreeData.fire(undefined);
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
      if (!this.model) {
        return [{ type: 'placeholder', message: 'HackMD is not connected.' }];
      }

      try {
        await this.ensureHistoryLoaded();
        if (this.lastError) {
          return [{ type: 'placeholder', message: `Error: ${this.lastError}` }];
        }

        const notes = this.model.getHistoryNotes();

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

    const isPending = !!note.pendingOperation;

    if (!isPending) {
      item.command = {
        command: 'hackmd.ui.edit',
        title: 'Open Note',
        arguments: [{ noteId: note.id, teamPath: note.teamPath || null }],
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
}
