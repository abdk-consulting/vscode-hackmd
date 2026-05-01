import * as vscode from 'vscode';

import { API } from './api';
import { getHistoryProvider, getMyNotesProvider, getTeamNotesProvider } from './extension';
import { recordUsage } from './store';

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

function getTeamPathFromUri(uri: vscode.Uri): string | null {
  return uri.query ? new URLSearchParams(uri.query).get('teamPath') : null;
}

function getNoteIdFromUri(uri: vscode.Uri): string {
  const params = new URLSearchParams(uri.query || '');
  return params.get('noteId') || '';
}

export class HackMDFsProvider implements vscode.FileSystemProvider {
  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    throw new Error('createDirectory Method not implemented.');
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
    const oldNoteId = getNoteIdFromUri(oldUri);
    const newNoteId = getNoteIdFromUri(newUri);
    const oldTeamPath = getTeamPathFromUri(oldUri);
    const newTeamPath = getTeamPathFromUri(newUri);

    if (!oldNoteId || !newNoteId) {
      throw vscode.FileSystemError.FileNotFound();
    }

    if (oldUri.toString() === newUri.toString()) {
      return;
    }

    // A HackMD note's identity is the note id (+ team path for team notes).
    // Renaming changes only the URI path/title, not the underlying note.
    if (oldNoteId !== newNoteId || oldTeamPath !== newTeamPath) {
      throw vscode.FileSystemError.NoPermissions('HackMD notes can only be renamed to another URI for the same note.');
    }

    await recordUsage(API.getNote(oldNoteId, { unwrapData: false }));

    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    ]);
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this._lookup(uri, false);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    throw new Error('readDirectory Method not implemented.');
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const noteId = getNoteIdFromUri(uri);

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
    const noteId = getNoteIdFromUri(uri);

    if (!noteId) {
      throw vscode.FileSystemError.FileNotFound();
    }

    const myNotesProvider = getMyNotesProvider();
    const teamNotesProvider = getTeamNotesProvider();
    const historyProvider = getHistoryProvider();

    // Extract teamPath from URI query string (encoded when note was opened)
    const teamPath = getTeamPathFromUri(uri);

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
        await recordUsage(API.updateTeamNote(teamPath, noteId, { content: contentString }, { unwrapData: false }));
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
    const noteId = getNoteIdFromUri(uri);

    try {
      const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));

      const file = new File(note.title || note.shortId || 'Untitled', true);
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

interface FolderPath {
  id: string;
  name: string;
  parentId?: string;
  icon?: string;
  color?: string;
  clientId: string;
}

export function generateResourceUri(
  label: string,
  noteId: string,
  teamPath?: string | null,
  folderPaths?: FolderPath[]
) {
  const sanitizedTitle = (label || 'Untitled').replace(/[\\/:*?"<>|#]/g, '-');

  // Build folder path from folderPaths array
  let folderPath = '';
  if (folderPaths && folderPaths.length > 0) {
    folderPath = folderPaths.map(f => f.name.replace(/[\\/:*?"<>|#]/g, '-')).join('/');
  }

  // Create hierarchical path for breadcrumbs:
  // Personal notes: My Notes/{folders}/{title}
  // Team notes: Teams/{teamPath}/{folders}/{title}
  const folderPrefix = folderPath ? `/${folderPath}` : '';
  let path: string;
  if (teamPath) {
    path = `/Teams/${teamPath}${folderPrefix}/${sanitizedTitle}`;
  } else {
    path = `/My Notes${folderPrefix}/${sanitizedTitle}`;
  }

  // Keep resource identity in query params for both notes and folders.
  const params = new URLSearchParams();
  params.set('noteId', noteId);
  if (teamPath) {
    params.set('teamPath', teamPath);
  }

  return vscode.Uri.from({
    scheme: 'hackmd',
    path,
    query: params.toString(),
    fragment: '',
  });
}

export function generateFolderResourceUri(
  label: string,
  folderId: string,
  teamPath?: string | null,
  folderPaths?: FolderPath[]
) {
  const sanitizedTitle = (label || 'Folder').replace(/[\\/:*?"<>|#]/g, '-');

  let folderPath = '';
  if (folderPaths && folderPaths.length > 0) {
    folderPath = folderPaths.map((f) => f.name.replace(/[\\/:*?"<>|#]/g, '-')).join('/');
  }

  const folderPrefix = folderPath ? `/${folderPath}` : '';
  const path = teamPath
    ? `/Teams/${teamPath}${folderPrefix}/${sanitizedTitle}`
    : `/My Notes${folderPrefix}/${sanitizedTitle}`;

  const params = new URLSearchParams();
  params.set('folderId', folderId);
  if (teamPath) {
    params.set('teamPath', teamPath);
  }

  return vscode.Uri.from({
    scheme: 'hackmd',
    path,
    query: params.toString(),
    fragment: '',
  });
}
