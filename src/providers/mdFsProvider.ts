import * as vscode from 'vscode';

import { getHackmdModel } from '../model';

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

function getModel() {
  try {
    return getHackmdModel();
  } catch {
    throw vscode.FileSystemError.Unavailable('HackMD model is not initialized. Connect your account first.');
  }
}

export class HackMDFsProvider implements vscode.FileSystemProvider {
  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    throw new Error('createDirectory Method not implemented.');
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean }): never {
    throw vscode.FileSystemError.NoPermissions('Renaming is not supported.');
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const model = getModel();
    const entity = await model.getEntityByUri(uri);
    if (!entity || entity.type !== 'note') {
      throw vscode.FileSystemError.FileNotFound();
    }
    const file = new File(entity.title || entity.shortId || 'Untitled', true);
    file.data = Buffer.from(entity.content || '');
    return file;
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    throw new Error('readDirectory Method not implemented.');
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const model = getModel();
      const entity = await model.getEntityByUri(uri);
      if (!entity || entity.type !== 'note') {
        throw vscode.FileSystemError.FileNotFound();
      }
      const content = await model.getNoteContent(entity);

      return Buffer.from(content || '');
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
    const model = getModel();
    const entity = await model.getEntityByUri(uri);
    if (!entity || entity.type !== 'note') {
      throw vscode.FileSystemError.FileNotFound();
    }

    // model.saveNoteContent wraps the call with per-note pending operation, which the tree
    // providers observe via model.onDidChangePending — no manual setPendingNote needed.
    try {
      const contentString = Buffer.from(content).toString();
      await model.updateNote(entity, { content: contentString });
    } catch (e) {
      console.error('Error saving note:', e);

      throw vscode.FileSystemError.Unavailable(
        `Failed to save: ${e.message || 'Unknown error'}. Try to save again when the internet connection is back. You can save a local copy on your computer for restoration.`
      );
    }
  }

  delete(_uri: vscode.Uri, _options: { readonly recursive: boolean }): never {
    throw vscode.FileSystemError.NoPermissions('Deleting is not supported.');
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
