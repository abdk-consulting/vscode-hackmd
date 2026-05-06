import * as vscode from 'vscode';

import { getHackmdModel, ModelNote } from '../model';

const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');

type TreeNode = ModelNote | PlaceholderNode;

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

function getLastUpdateTimestamp(note: ModelNote): number {
  const ts = Date.parse(note.lastChangedAt || note.createdAt || '');
  return Number.isFinite(ts) ? ts : 0;
}

function compareHistoryNotes(a: ModelNote, b: ModelNote): number {
  const byUpdatedAtDesc = getLastUpdateTimestamp(b) - getLastUpdateTimestamp(a);
  if (byUpdatedAtDesc !== 0) {
    return byUpdatedAtDesc;
  }
  return (a.id || '').localeCompare(b.id || '');
}

function isPlaceholderNode(node: TreeNode): node is PlaceholderNode {
  return node.type === 'placeholder';
}

export class HistoryProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly _onDidChangePendingState = new vscode.EventEmitter<boolean>();
  readonly onDidChangePendingState = this._onDidChangePendingState.event;
  private loadingPromise: Promise<void> | null = null;
  private loaded = false;
  private historyPendingOperation = false;
  private lastError: string | null = null;
  private readonly model: ReturnType<typeof getHackmdModel> | null;
  private lastOrderSignature: ModelNote[] = [];

  constructor(private extensionPath: string) {
    try {
      this.model = getHackmdModel();
      this.historyPendingOperation = !!this.model.isPending(this.model.getRecentNotesEntity());
      this.model.onDidChangeEntity((event) => {
        if (!this.loaded) {
          return;
        }

        const entity = event.entity;
        if (entity.type === 'note') {
          this.handleNoteUpsert(entity);
        }
      });
      this.model.onDidChangePending((event) => {
        const entity = event.entity;

        if (entity.type === 'model-root' || entity.type === 'recent-notes') {
          this.historyPendingOperation = event.pending;
          this._onDidChangePendingState.fire(event.pending);
          return;
        }

        if (entity.type === 'note') {
          this._onDidChangeTreeData.fire(entity);
        }
      });
    } catch {
      this.model = null;
    }
  }

  isPendingOperation(): boolean {
    return this.historyPendingOperation;
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
        await this.model!.refresh(this.model!.getRecentNotesEntity());
        this.loaded = true;
        this.lastOrderSignature = this.computeOrderSignature();
        this.lastError = null;
      } catch (error: any) {
        this.lastError = error?.message || 'Unknown error';
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  private computeOrderSignature(): ModelNote[] {
    if (!this.model) {
      return [];
    }
    return [...this.model.getHistoryNotes()].sort(compareHistoryNotes);
  }

  private getEntityPositionFromSignature(signature: ModelNote[] | undefined, note: ModelNote): number {
    if (!signature || signature.length === 0) {
      return -1;
    }
    return signature.indexOf(note);
  }

  private handleNoteUpsert(note: ModelNote): void {
    const previousSignature = this.lastOrderSignature;
    const previousPosition = this.getEntityPositionFromSignature(previousSignature, note);

    const nextSignature = this.computeOrderSignature();
    this.lastOrderSignature = nextSignature;
    const nextPosition = this.getEntityPositionFromSignature(nextSignature, note);

    if (previousPosition !== nextPosition) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this.fireNoteRefresh(note);
  }

  private fireNoteRefresh(note: ModelNote): void {
    this._onDidChangeTreeData.fire(note);
  }

  removeNoteFromCache(note: ModelNote): void {
    // No-op: cache invalidation is driven by model events
  }

  updateNoteInCache(note: ModelNote, updatedNote: any, emitEvent = true): void {
    // No-op: cache invalidation is driven by model events
  }

  findNoteInCache(note: ModelNote): ModelNote | undefined {
    if (!this.model) {
      return undefined;
    }
    return this.model.getHistoryNotes().find((n) => n === note);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isPlaceholderNode(element)) {
      return new vscode.TreeItem(element.message, vscode.TreeItemCollapsibleState.None);
    }
    return this.getNoteTreeItem(element);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (!this.model) {
        return [{ type: 'placeholder', message: 'HackMD is not connected.' }];
      }

      try {
        await this.ensureHistoryLoaded();
        if (this.lastError) {
          return [{ type: 'placeholder', message: `Error: ${this.lastError}` }];
        }

        const notes = [...this.model.getHistoryNotes()].sort(compareHistoryNotes);
        this.lastOrderSignature = notes;

        if (notes.length === 0) {
          return [{ type: 'placeholder', message: 'No history' }];
        }
        return notes;
      } catch (error: any) {
        return [{ type: 'placeholder', message: `Error: ${error.message}` }];
      }
    }

    return [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return undefined;
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
        arguments: [note, { preserveFocus: true }],
      };
    } else {
      item.command = undefined;
    }

    item.contextValue = isPending ? 'file-pending' : 'file';
    item.iconPath = isPending ? ICON_SPINNER : ICON_FILE;

    return item;
  }
}
