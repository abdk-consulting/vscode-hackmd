import * as vscode from 'vscode';

import { API } from './api';
import { getHistoryProvider, getMyNotesProvider, getPropertiesProvider, getTeamNotesProvider } from './extension';
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

function getNoteIdFromFragment(fragment: string): string {
  if (!fragment) {
    return '';
  }
  const questionIndex = fragment.indexOf('?');
  if (questionIndex >= 0) {
    return fragment.slice(0, questionIndex);
  }
  const encodedQuestionIndex = fragment.toLowerCase().indexOf('%3f');
  if (encodedQuestionIndex >= 0) {
    return fragment.slice(0, encodedQuestionIndex);
  }
  return fragment;
}

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
    const noteId = getNoteIdFromFragment(uri.fragment);

    try {
      const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));
      const content = note.content;

      // Update properties provider with the fetched note
      const teamPath = uri.query ? new URLSearchParams(uri.query).get('teamPath') : null;
      const propertiesProvider = getPropertiesProvider();
      if (propertiesProvider) {
        propertiesProvider.updateNote(note, noteId, teamPath);
      }

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
    const noteId = getNoteIdFromFragment(uri.fragment);

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

      // Check if there are pending property changes to save
      const propertiesProvider = getPropertiesProvider();
      const pendingChanges = propertiesProvider?.getPendingChanges() || {};
      const hasPropertyChanges = Object.keys(pendingChanges).length > 0;

      // Prepare the update payload
      const updatePayload: any = { content: contentString };

      // Add pending property changes to the payload
      if (hasPropertyChanges) {
        Object.assign(updatePayload, pendingChanges);
      }

      // Use appropriate API method based on teamPath
      if (teamPath) {
        // Team note update
        await recordUsage(API.updateTeamNote(teamPath, noteId, updatePayload));
      } else {
        // Personal note update
        if (hasPropertyChanges) {
          // Use updateNote to save both content and properties
          await recordUsage(API.updateNote(noteId, updatePayload, { unwrapData: false }));
        } else {
          // Use updateNoteContent for content-only updates
          await recordUsage(API.updateNoteContent(noteId, contentString, { unwrapData: false }));
        }
      }

      // If title or other metadata was changed, update the note in cache locally
      if (hasPropertyChanges) {
        // Find the current note in cache
        let note;
        if (teamPath && teamNotesProvider) {
          note = teamNotesProvider.findNoteInCache(noteId, teamPath);
        } else if (myNotesProvider) {
          note = myNotesProvider.findNoteInCache(noteId);
        }
        if (!note && historyProvider) {
          note = historyProvider.findNoteInCache(noteId);
        }

        // If we found the note, create an updated version with the changed properties
        if (note) {
          const updatedNote = { ...note };
          const oldTitle = note.title;

          // Apply the pending changes to the cached note
          Object.keys(pendingChanges).forEach((key) => {
            (updatedNote as any)[key] = pendingChanges[key];
          });

          // Update the note in all relevant caches
          if (teamPath && teamNotesProvider) {
            teamNotesProvider.updateNoteInCache(noteId, updatedNote, teamPath);
          } else if (myNotesProvider) {
            myNotesProvider.updateNoteInCache(noteId, updatedNote);
          }
          if (historyProvider) {
            historyProvider.updateNoteInCache(noteId, updatedNote);
          }

          // Update the properties provider with the new note
          propertiesProvider?.updateNote(updatedNote, noteId, teamPath);

          // If title changed, close and reopen editor with new URI (breadcrumb path changes)
          if (pendingChanges.title && pendingChanges.title !== oldTitle) {
            const oldUri = uri;
            const newUri = generateResourceUri(updatedNote.title, noteId, teamPath, (updatedNote as any).folderPaths);

            // Close the old document and open with new URI
            setImmediate(async () => {
              // Find and close the old editor
              const editors = vscode.window.visibleTextEditors;
              for (const editor of editors) {
                if (editor.document.uri.toString() === oldUri.toString()) {
                  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
                  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                  break;
                }
              }

              // Open with new URI
              const doc = await vscode.workspace.openTextDocument(newUri);
              await vscode.window.showTextDocument(doc, { preview: false });
            });
          }
        }

        // Clear pending property changes after successful save
        propertiesProvider?.clearPendingChanges();
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
    const noteId = getNoteIdFromFragment(uri.fragment);

    try {
      const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));

      // Update properties provider with the fetched note
      const teamPath = uri.query ? new URLSearchParams(uri.query).get('teamPath') : null;
      const propertiesProvider = getPropertiesProvider();
      if (propertiesProvider) {
        propertiesProvider.updateNote(note, noteId, teamPath);
      }

      const isOwner = meStore.getState().checkIsOwner(note);
      const file = new File(note.title || note.shortId || 'Untitled', isOwner);
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

  // Keep noteId in fragment for identification, and teamPath in query for API calls.
  // Use Uri.from to guarantee proper URI component ordering: scheme:path?query#fragment
  return vscode.Uri.from({
    scheme: 'hackmd',
    path,
    query: teamPath ? `teamPath=${encodeURIComponent(teamPath)}` : '',
    fragment: noteId,
  });
}
