import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScope } from '../model';
import { collectNotes, pickEntity, pickFolder, pickNote, pickScope } from './pickers';

// ---------------------------------------------------------------------------
// Internal guard
// ---------------------------------------------------------------------------

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    vscode.window.showErrorMessage('HackMD is not connected. Please configure your API key first.');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// VS Code UI helpers
// ---------------------------------------------------------------------------

async function openEditor(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false,
    viewColumn: vscode.ViewColumn.One,
  });
}

async function openPreview(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

async function openSideBySide(uri: vscode.Uri): Promise<void> {
  await openEditor(uri);
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function sanitizePathSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled';
}

function getUniqueMarkdownFileName(baseName: string, usedNames: Set<string>): string {
  const safe = sanitizePathSegment(baseName);
  let index = 1;
  let candidate = `${safe}.md`;
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${safe} (${index}).md`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function getUsedNamesForDirectory(uri: vscode.Uri): Promise<Set<string>> {
  const usedNames = new Set<string>();
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    for (const [name] of entries) {
      usedNames.add(name.toLowerCase());
    }
  } catch {
    // Directory may not exist yet; callers create it first.
  }
  return usedNames;
}

function findFolderById(rootFolders: readonly ModelFolder[], folderId: string): ModelFolder | undefined {
  for (const folder of rootFolders) {
    if (folder.id === folderId) {
      return folder;
    }
    const found = findFolderById(folder.children, folderId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function exportFolderRecursive(
  model: ReturnType<typeof getHackmdModel>,
  folder: ModelFolder,
  destParentUri: vscode.Uri
): Promise<number> {
  const dirUri = vscode.Uri.joinPath(destParentUri, sanitizePathSegment(folder.name || 'Folder'));
  await vscode.workspace.fs.createDirectory(dirUri);

  const usedNames = await getUsedNamesForDirectory(dirUri);
  let count = 0;

  for (const note of folder.notes) {
    const content = await model.getNoteContent(note.id, folder.teamPath);
    const fileName = getUniqueMarkdownFileName(note.title || note.shortId || 'Untitled', usedNames);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dirUri, fileName),
      Buffer.from(content ?? '', 'utf8')
    );
    count += 1;
  }

  for (const child of folder.children) {
    count += await exportFolderRecursive(model, child, dirUri);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Note URI resolution
// ---------------------------------------------------------------------------

/** Builds a minimal hackmd: URI when the note is not in the local model cache. */
function buildFallbackNoteUri(noteId: string, teamPath: string | null): vscode.Uri {
  const params = new URLSearchParams();
  params.set('noteId', noteId);
  if (teamPath) {
    params.set('teamPath', teamPath);
  }
  return vscode.Uri.from({
    scheme: 'hackmd',
    path: teamPath ? `/Teams/${teamPath}/Note` : `/My Notes/Note`,
    query: params.toString(),
  });
}

async function resolveNoteUri(
  model: ReturnType<typeof getHackmdModel>,
  args: { noteId?: string; teamPath?: string | null } | undefined
): Promise<vscode.Uri | undefined> {
  let noteId = args?.noteId;
  let teamPath: ModelScope = args?.teamPath;
  let note: ModelNote | undefined;

  if (!noteId) {
    const picked = await pickNote(model, teamPath);
    if (!picked) {
      return undefined;
    }
    noteId = picked.noteId;
    teamPath = picked.teamPath;
    note = picked.note;
  } else {
    if (teamPath === undefined) {
      teamPath = null;
    }
    const snapshot = model.getScopeSnapshotSync(teamPath ?? null);
    if (snapshot) {
      note = collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === noteId);
    }
  }

  return note ? model.toNoteUri(note) : buildFallbackNoteUri(noteId!, teamPath ?? null);
}

// ---------------------------------------------------------------------------
// Export target types (public — usable by callers and tests)
// ---------------------------------------------------------------------------

export type ExportNoteTarget = {
  type: 'note';
  noteId: string;
  teamPath: string | null;
};

export type ExportFolderTarget = {
  type: 'folder';
  folderId: string;
  name?: string;
  teamPath: string | null;
};

export type ExportTarget = ExportNoteTarget | ExportFolderTarget;

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerUiCommands(context: vscode.ExtensionContext): void {
  const register = <T extends any[]>(id: string, handler: (...args: T) => Promise<any>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  // ── hackmd.ui.edit ───────────────────────────────────────────────────────
  // Opens the note in a text editor (column 1, non-preview tab).
  // Args: { noteId?, teamPath? } — interactive picker when noteId is absent.
  register('hackmd.ui.edit', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, args);
    if (!uri) {
      return;
    }

    await openEditor(uri);
  });

  // ── hackmd.ui.preview ────────────────────────────────────────────────────
  // Opens the note in VS Code's built-in Markdown preview.
  // Args: { noteId?, teamPath? } — interactive picker when noteId is absent.
  register('hackmd.ui.preview', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, args);
    if (!uri) {
      return;
    }

    await openPreview(uri);
  });

  // ── hackmd.ui.sideBySide ─────────────────────────────────────────────────
  // Opens the note with the editor on the left and Markdown preview on the right.
  // Args: { noteId?, teamPath? } — interactive picker when noteId is absent.
  register('hackmd.ui.sideBySide', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, args);
    if (!uri) {
      return;
    }

    await openSideBySide(uri);
  });

  // ── hackmd.ui.openOnHackMD ───────────────────────────────────────────────
  // Opens the note on hackmd.io using its publish link.
  // Args: { noteId?, teamPath? } — interactive picker when noteId is absent.
  register('hackmd.ui.openOnHackMD', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath: ModelScope = args?.teamPath;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    } else if (teamPath === undefined) {
      teamPath = null;
    }

    // Try sync cache first to avoid an extra API call.
    let publishLink: string | undefined;
    const snapshot = model.getScopeSnapshotSync(teamPath ?? null);
    if (snapshot) {
      const cached = collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === noteId);
      publishLink = cached?.publishLink;
    }

    // Fall back to a full fetch when the link is not cached.
    if (!publishLink) {
      const fetched = await model.getNote(noteId!, teamPath ?? null);
      publishLink = fetched?.publishLink ?? undefined;
    }

    if (!publishLink) {
      vscode.window.showErrorMessage('No publish link is available for this note.');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(publishLink));
  });

  // ── hackmd.ui.import ─────────────────────────────────────────────────────
  // Imports one or more Markdown files as HackMD notes.
  //
  // Args:
  //   teamPath?      — target scope (null = My Notes). Picked interactively when absent.
  //   parentFolderId?— destination folder id (null = root). Picked interactively when absent.
  //   files?         — pre-loaded file data. A file-open dialog is shown when absent.
  register('hackmd.ui.import', async (args?: {
    teamPath?: string | null;
    parentFolderId?: string | null;
    files?: { title: string; content: string }[];
  }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // 1. Resolve file list.
    let files = args?.files;
    if (!files) {
      const selection = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { Markdown: ['md'] },
        openLabel: 'Import Notes',
      });
      if (!selection || selection.length === 0) {
        return;
      }

      files = [];
      for (const fileUri of selection) {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const title = path.parse(fileUri.fsPath).name || 'Untitled';
        files.push({ title, content: Buffer.from(bytes).toString('utf8') });
      }
    }

    if (files.length === 0) {
      return;
    }

    // 2. Resolve scope.
    let teamPath: ModelScope = args?.teamPath;
    if (teamPath === undefined) {
      teamPath = await pickScope(model, 'Choose scope to import notes into');
      if (teamPath === undefined) {
        return;
      }
    }

    // 3. Resolve destination folder (undefined means "ask", null means "root").
    let parentFolderId: string | null | undefined = args?.parentFolderId;
    if (parentFolderId === undefined) {
      const dest = await pickFolder(model, teamPath, 'Choose parent folder (Root = top level)', true);
      if (!dest) {
        return;
      }
      parentFolderId = dest.folderId;
    }

    // 4. Create notes.
    const resolvedFiles = files;
    const resolvedTeamPath = teamPath;
    const resolvedFolderId = parentFolderId;

    const createdNotes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${resolvedFiles.length} note${resolvedFiles.length === 1 ? '' : 's'}…`,
        cancellable: false,
      },
      async () => {
        const results: ModelNote[] = [];
        for (const file of resolvedFiles) {
          const note = await model.createNote({
            teamPath: resolvedTeamPath,
            title: file.title,
            content: file.content,
            parentFolderId: resolvedFolderId,
          });
          results.push(note);
        }
        return results;
      }
    );

    // 5. Refresh the relevant tree view so new notes appear.
    const refreshCmd = resolvedTeamPath ? 'treeView.refreshTeamNotes' : 'treeView.refreshMyNotes';
    try {
      await vscode.commands.executeCommand(refreshCmd);
    } catch {
      // Tree view may not be registered during testing.
    }

    vscode.window.showInformationMessage(
      `Imported ${createdNotes.length} note${createdNotes.length === 1 ? '' : 's'} successfully.`
    );
  });

  // ── hackmd.ui.export ─────────────────────────────────────────────────────
  // Exports notes and/or folders to Markdown files on disk.
  //
  // Programmatic use: pass { targets } with one or more ExportTarget objects.
  // Command-palette use (no args): shows a picker to select ONE note or folder.
  //
  // Single-note export  → showSaveDialog  → writes <title>.md
  // Multi-entity export → showOpenDialog  → writes into the chosen directory
  register('hackmd.ui.export', async (args?: { targets?: ExportTarget[] }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Resolve target list — interactive when absent.
    let targets: ExportTarget[] | undefined = args?.targets;
    if (!targets || targets.length === 0) {
      const picked = await pickEntity(model, 'Choose a note or folder to export');
      if (!picked) {
        return;
      }
      if (picked.kind === 'note') {
        targets = [{ type: 'note', noteId: picked.noteId, teamPath: picked.teamPath ?? null }];
      } else {
        targets = [{ type: 'folder', folderId: picked.folderId, name: picked.name, teamPath: picked.teamPath ?? null }];
      }
    }

    const noteTargets = targets.filter((t): t is ExportNoteTarget => t.type === 'note');
    const folderTargets = targets.filter((t): t is ExportFolderTarget => t.type === 'folder');
    const defaultDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    let targetFileUri: vscode.Uri | undefined;
    let exportDirUri: vscode.Uri | undefined;

    if (folderTargets.length === 0 && noteTargets.length === 1) {
      // Single note → ask where to save the .md file.
      // Use sync cache so no async call happens before the dialog.
      const nt = noteTargets[0];
      const ntSnapshot = model.getScopeSnapshotSync(nt.teamPath);
      const ntCached = ntSnapshot
        ? collectNotes(ntSnapshot.rootFolders, ntSnapshot.rootNotes).find((n) => n.id === nt.noteId)
        : undefined;
      const baseName = sanitizePathSegment(ntCached?.title || ntCached?.shortId || nt.noteId) + '.md';
      targetFileUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDirectory, baseName)),
        filters: { Markdown: ['md'] },
        saveLabel: 'Export Note',
      });
    } else {
      // Multiple entities or at least one folder → pick an output directory.
      exportDirUri = (await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(defaultDirectory),
        openLabel: 'Export to Folder',
      }))?.[0];
    }

    if (!targetFileUri && !exportDirUri) {
      return;
    }

    try {
      if (targetFileUri) {
        const nt = noteTargets[0];
        const content = await model.getNoteContent(nt.noteId, nt.teamPath);
        await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(content ?? '', 'utf8'));
      } else if (exportDirUri) {
        const usedNames = await getUsedNamesForDirectory(exportDirUri);

        // Export individual notes first.
        for (const nt of noteTargets) {
          const content = await model.getNoteContent(nt.noteId, nt.teamPath);
          const snapshot = model.getScopeSnapshotSync(nt.teamPath);
          const cached = snapshot
            ? collectNotes(snapshot.rootFolders, snapshot.rootNotes).find((n) => n.id === nt.noteId)
            : undefined;
          const baseName = cached?.title || cached?.shortId || nt.noteId;
          const fileName = getUniqueMarkdownFileName(baseName, usedNames);
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(exportDirUri, fileName),
            Buffer.from(content ?? '', 'utf8')
          );
        }

        // Export folders recursively.
        for (const ft of folderTargets) {
          const snapshot = model.getScopeSnapshotSync(ft.teamPath);
          if (!snapshot) {
            vscode.window.showWarningMessage(
              `Scope data for "${ft.name ?? ft.folderId}" is not loaded. Refresh the scope first.`
            );
            continue;
          }
          const folder = findFolderById(snapshot.rootFolders, ft.folderId);
          if (!folder) {
            vscode.window.showWarningMessage(
              `Folder "${ft.name ?? ft.folderId}" was not found in scope. Skipping.`
            );
            continue;
          }
          await exportFolderRecursive(model, folder, exportDirUri);
        }
      }

      vscode.window.showInformationMessage('Export completed successfully.');
    } catch (error: any) {
      vscode.window.showErrorMessage(`Export failed: ${error.message ?? 'Unknown error'}`);
    }
  });
}
