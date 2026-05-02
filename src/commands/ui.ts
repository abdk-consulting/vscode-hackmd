import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { getPropertiesProvider } from '../extension';
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
// Tree node helpers (mirrored from model.ts — no shared module to avoid coupling)
// ---------------------------------------------------------------------------

function extractNote(node: any): any | undefined {
  if (!node) { return undefined; }
  if (node.type === 'note' && node.note) { return node.note; }
  if (node.id && node.type !== 'folder' && node.type !== 'team' && node.team === undefined) { return node; }
  return undefined;
}

function extractFolderWebContext(node: any): { folderId?: string; teamPath: string | null } | undefined {
  if (!node || node.type !== 'folder') {
    return undefined;
  }

  const rawFolderId = node.value?.context?.folderClientId
    || node.value?.context?.folderId
    || node.folderClientId
    || node.clientId
    || node.id;

  if (!rawFolderId) {
    return undefined;
  }

  const folderId = String(rawFolderId).startsWith('folder-')
    ? String(rawFolderId).slice('folder-'.length)
    : String(rawFolderId);

  return {
    folderId,
    teamPath: (node.value?.context?.teamPath || node.teamPath || null) as string | null,
  };
}

function extractScopeContext(node: any): { teamPath?: string | null; parentFolderId?: string } {
  if (!node) { return {}; }
  if (node.team !== undefined) { return { teamPath: node.team?.path ?? null }; }
  if (node.type === 'folder') { return { teamPath: node.teamPath ?? null, parentFolderId: node.id }; }
  const note = extractNote(node);
  if (note) { return { teamPath: note.teamPath ?? null }; }
  return {};
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
  node: any | undefined
): Promise<vscode.Uri | undefined> {
  const noteFromNode = extractNote(node);
  let noteId: string | undefined = noteFromNode?.id;
  let teamPath: ModelScope = noteFromNode ? (noteFromNode.teamPath ?? null) : undefined;
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
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.edit', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openEditor(uri);
  });

  // ── hackmd.ui.preview ────────────────────────────────────────────────────
  // Opens the note in VS Code's built-in Markdown preview.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.preview', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openPreview(uri);
  });

  // ── hackmd.ui.sideBySide ─────────────────────────────────────────────────
  // Opens the note with the editor on the left and Markdown preview on the right.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.sideBySide', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const uri = await resolveNoteUri(model, node);
    if (!uri) {
      return;
    }

    await openSideBySide(uri);
  });

  // ── hackmd.ui.openOnHackMD ───────────────────────────────────────────────
  // Opens the note (or team) on hackmd.io.
  // Arg: tree note/team node or undefined (interactive picker when absent).
  register('hackmd.ui.openOnHackMD', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Folder node: open folder URL directly.
    const folder = extractFolderWebContext(node);
    if (folder) {
      const url = folder.teamPath
        ? `https://hackmd.io/team/${folder.teamPath}/folders/${folder.folderId}`
        : `https://hackmd.io/folders/${folder.folderId}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }

    if (node?.type === 'folder') {
      vscode.window.showErrorMessage('Folder ID not found');
      return;
    }

    // Team node: open the team workspace URL
    if (node?.team?.path) {
      await vscode.env.openExternal(vscode.Uri.parse(`https://hackmd.io/team/${node.team.path}`));
      return;
    }

    const noteFromNode = extractNote(node);
    let noteId: string | undefined = noteFromNode?.id;
    let teamPath: ModelScope = noteFromNode ? (noteFromNode.teamPath ?? null) : undefined;

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
  // Arg: tree folder/team node to pre-populate scope, or undefined (interactive).
  register('hackmd.ui.import', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // 1. Resolve file list.
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Markdown: ['md'] },
      openLabel: 'Import Notes',
    });
    if (!selection || selection.length === 0) {
      return;
    }

    const files: { title: string; content: string }[] = [];
    for (const fileUri of selection) {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const title = path.parse(fileUri.fsPath).name || 'Untitled';
      files.push({ title, content: Buffer.from(bytes).toString('utf8') });
    }

    if (files.length === 0) {
      return;
    }

    // 2. Resolve scope from node (folder or team) or interactive picker.
    const scope = extractScopeContext(node);
    let teamPath: ModelScope = scope.teamPath;
    let parentFolderId: string | null | undefined = scope.parentFolderId ?? null;

    if (teamPath === undefined) {
      teamPath = await pickScope(model, 'Choose scope to import notes into');
      if (teamPath === undefined) {
        return;
      }
    }

    if (parentFolderId === undefined) {
      const dest = await pickFolder(model, teamPath, 'Choose parent folder (Root = top level)', true);
      if (!dest) {
        return;
      }
      parentFolderId = dest.folderId;
    }

    // 3. Create notes.
    const resolvedTeamPath = teamPath;
    const resolvedFolderId = parentFolderId;

    const createdNotes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${files.length} note${files.length === 1 ? '' : 's'}…`,
        cancellable: false,
      },
      async () => {
        const results: ModelNote[] = [];
        for (const file of files) {
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

    // 4. Refresh the relevant scope so provider updates are model-event-driven.
    try {
      await vscode.commands.executeCommand('hackmd.model.refreshScope', { teamPath: resolvedTeamPath ?? null });
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
  // Arg: tree note/folder/team node (pre-populates targets), or undefined (shows picker).
  // Second arg: selected nodes array for multi-selection (from VS Code context menu).
  //
  // Single-note export  → showSaveDialog  → writes <title>.md
  // Multi-entity export → showOpenDialog  → writes into the chosen directory
  register('hackmd.ui.export', async (node?: any, selectedNodes?: any[]) => {
    const model = getModel();
    if (!model) {
      return;
    }

    // Resolve targets from node / selectedNodes, or fall back to interactive picker.
    let targets: ExportTarget[] | undefined;

    if (node || (selectedNodes && selectedNodes.length > 0)) {
      const effectiveNodes = selectedNodes?.length ? selectedNodes : node ? [node] : [];
      const noteTargets: ExportNoteTarget[] = [];
      const folderTargets: ExportFolderTarget[] = [];

      for (const n of effectiveNodes) {
        // Team node: export all root notes + folders for that team
        if (n?.team?.path) {
          const teamPath: string = n.team.path;
          const snapshot = await vscode.commands.executeCommand('hackmd.model.getScopeSnapshot', { teamPath }) as any;
          const rootNotes: any[] = snapshot?.rootNotes ?? [];
          const rootFolders: any[] = snapshot?.rootFolders ?? [];
          for (const rn of rootNotes) { noteTargets.push({ type: 'note', noteId: rn.id, teamPath }); }
          for (const rf of rootFolders) { folderTargets.push({ type: 'folder', folderId: rf.id, name: rf.name, teamPath }); }
          continue;
        }
        const note = extractNote(n);
        if (note) { noteTargets.push({ type: 'note', noteId: note.id, teamPath: note.teamPath ?? null }); continue; }
        const folder = n?.type === 'folder' ? n : undefined;
        if (folder) { folderTargets.push({ type: 'folder', folderId: folder.id, name: folder.name, teamPath: folder.teamPath ?? null }); }
      }

      if (noteTargets.length > 0 || folderTargets.length > 0) {
        targets = [...noteTargets, ...folderTargets];
      }
    }

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

  // ── hackmd.ui.properties ─────────────────────────────────────────────────
  // Opens the Properties panel for a given note.
  // Arg: tree note node or undefined (interactive picker when absent).
  register('hackmd.ui.properties', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const noteFromNode = extractNote(node);
    let noteId: string | undefined = noteFromNode?.id;
    let teamPath: string | null = noteFromNode ? (noteFromNode.teamPath ?? null) : null;

    if (!noteId) {
      const picked = await pickNote(model, undefined, { allowCustom: false });
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath ?? null;
    }

    const note = model.getNoteSync(noteId, teamPath);
    if (!note) {
      vscode.window.showErrorMessage(`Note "${noteId}" is not loaded. Please refresh the scope first.`);
      return;
    }

    const propertiesProvider = getPropertiesProvider();
    if (!propertiesProvider) {
      return;
    }

    await vscode.commands.executeCommand('hackmd.properties.focus');
    await propertiesProvider.openNote(note);
  });

  // ── hackmd.ui.importToMyNotes ───────────────────────────────────────────
  // Scoped variant: import files directly to My Notes (no team picker)
  register('hackmd.ui.importToMyNotes', async (node?: any) => {
    // Override scope to null (My Notes) regardless of node
    const model = getModel();
    if (!model) {
      return;
    }

    const selection = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Markdown: ['md'] },
      openLabel: 'Import Notes',
    });
    if (!selection || selection.length === 0) {
      return;
    }

    const files: { title: string; content: string }[] = [];
    for (const fileUri of selection) {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const title = path.parse(fileUri.fsPath).name || 'Untitled';
      files.push({ title, content: Buffer.from(bytes).toString('utf8') });
    }
    if (files.length === 0) { return; }

    const dest = await pickFolder(model, null, 'Choose parent folder (Root = top level)', true);
    if (!dest) { return; }

    const createdNotes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing ${files.length} note${files.length === 1 ? '' : 's'}…`, cancellable: false },
      async () => {
        const results: ModelNote[] = [];
        for (const file of files) {
          results.push(await model.createNote({ teamPath: null, title: file.title, content: file.content, parentFolderId: dest.folderId }));
        }
        return results;
      }
    );

    try { await vscode.commands.executeCommand('hackmd.model.refreshScope', { teamPath: null }); } catch { /* ok */ }
    vscode.window.showInformationMessage(`Imported ${createdNotes.length} note${createdNotes.length === 1 ? '' : 's'} successfully.`);
  });

  // ── hackmd.ui.importToTeam ──────────────────────────────────────────────
  // Scoped variant: import files with team picker (or team node pre-populates)
  register('hackmd.ui.importToTeam', async (node?: any) => {
    const model = getModel();
    if (!model) {
      return;
    }

    const scope = extractScopeContext(node);
    let teamPath = scope.teamPath;

    if (!teamPath) {
      const selectedTeam = await pickScope(model, 'Choose team to import notes into');
      if (selectedTeam === undefined || selectedTeam === null) {
        vscode.window.showInformationMessage('Please select a team.');
        return;
      }
      teamPath = selectedTeam;
    }

    // Delegate to ui.import with the resolved team node context
    await vscode.commands.executeCommand('hackmd.ui.import', { team: { path: teamPath }, type: 'team' });
  });
}
