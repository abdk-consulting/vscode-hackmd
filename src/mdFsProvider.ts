import * as vscode from 'vscode';

import { API } from './api';
import { getHistoryProvider, getMyNotesProvider, getTeamNotesProvider } from './extension';
import { meStore, recordUsage } from './store';

export class File implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;

  name: string;
  data?: Uint8Array;
  permissions?: vscode.FilePermission;

  constructor(name: string, canEdit = false) {
    this.type = vscode.FileType.File;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    if (!canEdit) {
      this.permissions = vscode.FilePermission.Readonly;
    }
  }
}

export class Directory implements vscode.FileStat {
  type: vscode.FileType;
  ctime: number;
  mtime: number;
  size: number;

  name: string;
  entries: Map<string, File | Directory>;

  constructor(name: string) {
    this.type = vscode.FileType.Directory;
    this.ctime = Date.now();
    this.mtime = Date.now();
    this.size = 0;
    this.name = name;
    this.entries = new Map();
  }
}

export type Entry = File | Directory;

export class HackMDFsProvider implements vscode.FileSystemProvider {
  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    throw new Error('createDirectory Method not implemented.');
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): void | Thenable<void> {
    throw new Error('rename Method not implemented.');
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this._lookup(uri, false);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    throw new Error('readDirectory Method not implemented.');
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const noteId = uri.fragment;

    try {
      const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));
      const content = note.content;

      return Buffer.from(content);
    } catch (e) {
      console.error(e);
      throw vscode.FileSystemError.FileNotFound();
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const noteId = uri.fragment;

    if (!noteId) {
      throw vscode.FileSystemError.FileNotFound();
    }

    const myNotesProvider = getMyNotesProvider();
    const teamNotesProvider = getTeamNotesProvider();
    const historyProvider = getHistoryProvider();

    // Extract teamPath from URI query string (encoded when note was opened)
    const teamPath = uri.query ? new URLSearchParams(uri.query).get('teamPath') : null;

    // Set pending state BEFORE any API calls
    if (teamPath) {
      teamNotesProvider?.setPendingNote(noteId);
    } else {
      myNotesProvider?.setPendingNote(noteId);
    }
    historyProvider?.setPendingNote(noteId);

    try {
      const contentString = Buffer.from(content).toString();

      // Use appropriate API method based on teamPath
      if (teamPath) {
        // Team note update - use updateTeamNote with content in payload
        await recordUsage(API.updateTeamNote(teamPath, noteId, { content: contentString }));
      } else {
        await recordUsage(API.updateNoteContent(noteId, contentString, { unwrapData: false }));
      }

      // Don't block here - set up async listener to clear pending state after dirty flag clears
      // This must happen AFTER writeFile returns so VS Code can clear the dirty flag
      setImmediate(() => {
        const timeout = setTimeout(() => {
          disposable.dispose();
          // Clear pending state on timeout
          if (teamPath) {
            teamNotesProvider?.clearPendingNote(noteId);
          } else {
            myNotesProvider?.clearPendingNote(noteId);
          }
          historyProvider?.clearPendingNote(noteId);
        }, 5000);

        const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
          if (event.document.uri.toString() === uri.toString() && !event.document.isDirty) {
            clearTimeout(timeout);
            disposable.dispose();
            // Clear pending state when dirty flag clears
            if (teamPath) {
              teamNotesProvider?.clearPendingNote(noteId);
            } else {
              myNotesProvider?.clearPendingNote(noteId);
            }
            historyProvider?.clearPendingNote(noteId);
          }
        });
      });
    } catch (e) {
      console.error('Error saving note:', e);

      // Try to clear pending state on error (best effort)
      myNotesProvider?.clearPendingNote(noteId);
      teamNotesProvider?.clearPendingNote(noteId);
      historyProvider?.clearPendingNote(noteId);

      throw vscode.FileSystemError.Unavailable(
        `Failed to save: ${e.message || 'Unknown error'}. Try to save again when the internet connection is back. You can save a local copy on your computer for restoration.`
      );
    }
  }

  delete(uri: vscode.Uri, options: { readonly recursive: boolean }): void | Thenable<void> {
    throw new Error('Delete not implemented.');
  }

  private async _lookup(uri: vscode.Uri, silent: false): Promise<Entry>;
  private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | undefined>;
  private async _lookup(uri: vscode.Uri, silent: boolean): Promise<Entry | undefined> {
    const noteId = uri.fragment;

    try {
      const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));

      const isOwner = meStore.getState().checkIsOwner(note);
      const file = new File(`${note.title}.md#${noteId}`, isOwner);
      file.data = Buffer.from(note.content);

      // TODO: ctime and size

      return file;
    } catch (e) {
      console.error(e);
      throw vscode.FileSystemError.FileNotFound();
    }
  }

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

  watch(_resource: vscode.Uri): vscode.Disposable {
    // ignore, fires for all changes...
    return new vscode.Disposable(() => {
      /* noop */
    });
  }
}

let provider: HackMDFsProvider;

export function activate(context: vscode.ExtensionContext) {
  provider = new HackMDFsProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('hackmd', provider, { isCaseSensitive: true })
  );
}
export function getProvider() {
  return provider;
}

export function generateResourceUri(label: string, noteId: string, teamPath?: string) {
  const base = `hackmd:/${encodeURIComponent(label)}.md#${noteId}`;
  if (teamPath) {
    return vscode.Uri.parse(`${base}?teamPath=${encodeURIComponent(teamPath)}`);
  }
  return vscode.Uri.parse(base);
}
