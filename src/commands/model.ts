import * as vscode from 'vscode';

import {
  CreateFolderInput,
  CreateNoteInput,
  getHackmdModel,
  ModelFolder,
  ModelNote,
  ModelScope,
  MoveFolderInput,
  MoveNoteInput,
  UpdateFolderInput,
  UpdateNoteInput,
} from '../model';

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    vscode.window.showErrorMessage('HackMD is not connected. Please configure your API key first.');
    return undefined;
  }
}

function isNullOrUndefined<T>(value: T | null | undefined): value is null | undefined {
  return value === null || value === undefined;
}

type ScopeQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  scope?: ModelScope;
  isCustom?: boolean;
};

type FolderQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  folderId?: string | null;
  isCustom?: boolean;
};

type NoteQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  note?: ModelNote;
  isCustom?: boolean;
};

const REFRESH_HINT = 'Run "HackMD Model: Refresh Scope" to load data.';

async function pickScope(model: ReturnType<typeof getHackmdModel>, placeHolder: string): Promise<ModelScope | undefined> {
  const personalLoaded = model.getScopeSnapshotSync(null) !== null;
  const teamItems: ScopeQuickPickItem[] = model.getTeams().map((team) => {
    const loaded = model.getScopeSnapshotSync(team.path) !== null;
    return {
      label: team.name,
      description: team.path,
      detail: loaded ? undefined : `Not loaded — ${REFRESH_HINT}`,
      scope: team.path as ModelScope,
    };
  });

  const selected = await vscode.window.showQuickPick<ScopeQuickPickItem>(
    [
      {
        label: 'My Notes',
        description: 'Personal workspace',
        detail: personalLoaded ? undefined : `Not loaded — ${REFRESH_HINT}`,
        scope: null,
      },
      ...teamItems,
      {
        label: 'Custom Team Path...',
        description: 'Enter a team path manually',
        isCustom: true,
      },
    ],
    {
      placeHolder,
      ignoreFocusOut: true,
    }
  );

  if (!selected) {
    return undefined;
  }

  if (selected.isCustom) {
    const custom = await promptOptionalInput('Team path (leave empty for My Notes)');
    return custom && custom.trim().length > 0 ? custom.trim() : null;
  }

  return selected.scope;
}

function collectFolders(rootFolders: readonly ModelFolder[]): ModelFolder[] {
  const result: ModelFolder[] = [];
  const walk = (folder: ModelFolder) => {
    result.push(folder);
    for (const child of folder.children) {
      walk(child);
    }
  };

  for (const root of rootFolders) {
    walk(root);
  }

  return result;
}

function collectNotes(rootFolders: readonly ModelFolder[], rootNotes: readonly ModelNote[]): ModelNote[] {
  const result: ModelNote[] = [...rootNotes];
  const walk = (folder: ModelFolder) => {
    for (const note of folder.notes) {
      result.push(note);
    }
    for (const child of folder.children) {
      walk(child);
    }
  };

  for (const root of rootFolders) {
    walk(root);
  }

  return result;
}

async function pickFolder(
  model: ReturnType<typeof getHackmdModel>,
  teamPath: ModelScope,
  placeHolder: string,
  includeRoot = false
): Promise<{ folderId: string | null; teamPath: ModelScope } | undefined> {
  const snapshot = model.getScopeSnapshotSync(teamPath);
  const folders = snapshot ? collectFolders(snapshot.rootFolders) : [];

  const scopeNotLoaded = snapshot === null;
  const customDetail = scopeNotLoaded
    ? `No local data — ${REFRESH_HINT}`
    : folders.length === 0 && !includeRoot
      ? 'No folders in this scope'
      : undefined;

  const items: FolderQuickPickItem[] = folders.map((folder) => ({
    label: folder.name,
    description: folder.path || folder.id,
    folderId: folder.id,
  }));

  if (includeRoot) {
    items.unshift({
      label: 'Root',
      description: 'No parent folder',
      folderId: null,
    });
  }

  items.push({
    label: 'Custom Folder ID...',
    description: 'Enter a folder ID manually',
    detail: customDetail,
    isCustom: true,
  });

  if (items.length === 1 && !includeRoot) {
    const customFolderId = await promptRequiredInput('Folder ID');
    if (!customFolderId) {
      return undefined;
    }
    return { folderId: customFolderId, teamPath };
  }

  const selected = await vscode.window.showQuickPick<FolderQuickPickItem>(items, { placeHolder, ignoreFocusOut: true });
  if (!selected) {
    return undefined;
  }

  if (selected.isCustom) {
    if (includeRoot) {
      const customFolderId = await promptOptionalInput('Folder ID (leave empty for Root)');
      return { folderId: customFolderId && customFolderId.trim().length > 0 ? customFolderId.trim() : null, teamPath };
    }
    const customFolderId = await promptRequiredInput('Folder ID');
    if (!customFolderId) {
      return undefined;
    }
    return { folderId: customFolderId, teamPath };
  }

  return { folderId: selected.folderId ?? null, teamPath };
}

async function pickNote(
  model: ReturnType<typeof getHackmdModel>,
  requestedScope?: ModelScope
): Promise<{ noteId: string; teamPath: ModelScope; note?: ModelNote } | undefined> {
  let scope = requestedScope;
  if (isNullOrUndefined(scope)) {
    scope = await pickScope(model, 'Choose scope for note operation');
    if (scope === undefined) {
      return undefined;
    }
  }

  const snapshot = model.getScopeSnapshotSync(scope);
  const notes = snapshot ? collectNotes(snapshot.rootFolders, snapshot.rootNotes) : [];

  const scopeNotLoaded = snapshot === null;
  const customNoteDetail = scopeNotLoaded
    ? `No local data — ${REFRESH_HINT}`
    : notes.length === 0
      ? 'No notes in this scope'
      : undefined;

  const items: NoteQuickPickItem[] = notes.map((note) => ({
    label: note.title || note.shortId || note.id,
    description: note.id,
    note,
  }));
  items.push({
    label: 'Custom Note ID...',
    description: 'Enter a note ID manually',
    detail: customNoteDetail,
    isCustom: true,
  });

  const selected = await vscode.window.showQuickPick<NoteQuickPickItem>(items, {
    placeHolder: 'Choose a note',
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  if (selected.isCustom) {
    const customNoteId = await promptRequiredInput('Note ID');
    if (!customNoteId) {
      return undefined;
    }

    return {
      noteId: customNoteId,
      teamPath: scope,
    };
  }

  if (!selected.note) {
    return undefined;
  }

  return {
    noteId: selected.note.id,
    teamPath: scope,
    note: selected.note,
  };
}

async function promptRequiredInput(prompt: string, value = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Value cannot be empty' : null),
  });

  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function promptOptionalInput(prompt: string, value = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
  });
  return input;
}

async function promptJson<T>(prompt: string, initialValue: T): Promise<T | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt,
    value: JSON.stringify(initialValue, null, 2),
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        JSON.parse(value);
        return null;
      } catch {
        return 'Invalid JSON';
      }
    },
  });

  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as T;
}

export function registerModelCommands(context: vscode.ExtensionContext): void {
  const register = <T extends any[]>(id: string, handler: (...args: T) => Promise<any>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('hackmd.model.refreshAll', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    await model.refreshAll();
    return true;
  });

  register('hackmd.model.refreshTeams', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return model.refreshTeams();
  });

  register('hackmd.model.refreshHistory', async () => {
    const model = getModel();
    if (!model) {
      return;
    }
    return model.refreshHistory();
  });

  register('hackmd.model.refreshScope', async (args?: { teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath = args?.teamPath;
    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope to refresh');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    await model.refreshScope({ teamPath });
    return true;
  });

  register('hackmd.model.getScopeSnapshot', async (args?: { teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath = args?.teamPath;
    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    return model.getScopeSnapshot(teamPath);
  });

  register('hackmd.model.getNote', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    return model.getNote(noteId, teamPath);
  });

  register('hackmd.model.getNoteContent', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    return model.getNoteContent(noteId, teamPath);
  });

  register('hackmd.model.getEntityByUri', async (args?: { uri?: string | vscode.Uri }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let uri: vscode.Uri | undefined;
    if (typeof args?.uri === 'string') {
      uri = vscode.Uri.parse(args.uri);
    } else if (args?.uri) {
      uri = args.uri;
    } else {
      const input = await promptRequiredInput('Enter hackmd URI');
      if (!input) {
        return;
      }
      uri = vscode.Uri.parse(input);
    }

    return model.getEntityByUri(uri);
  });

  register('hackmd.model.createNote', async (args?: CreateNoteInput) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath = args?.teamPath;
    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope for new note');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    let parentFolderId = args?.parentFolderId;
    if (parentFolderId === undefined) {
      const destination = await pickFolder(model, teamPath || null, 'Choose parent folder (Root = top level)', true);
      if (!destination) {
        return;
      }
      parentFolderId = destination.folderId;
    }

    let title = args?.title;
    if (!title) {
      title = await promptRequiredInput('Note title');
      if (!title) {
        return;
      }
    }

    let content = args?.content;
    if (content === undefined) {
      content = await promptOptionalInput('Initial note content (optional)');
    }

    return model.createNote({ teamPath, title, content, parentFolderId });
  });

  register('hackmd.model.createFolder', async (args?: CreateFolderInput) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let teamPath = args?.teamPath;
    if (teamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose scope for new folder');
      if (selectedScope === undefined) {
        return;
      }
      teamPath = selectedScope;
    }

    let parentFolderId = args?.parentFolderId;
    if (parentFolderId === undefined) {
      const destination = await pickFolder(model, teamPath || null, 'Choose parent folder (Root = top level)', true);
      if (!destination) {
        return;
      }
      parentFolderId = destination.folderId;
    }

    let name = args?.name;
    if (!name) {
      name = await promptRequiredInput('Folder name');
      if (!name) {
        return;
      }
    }

    return model.createFolder({ teamPath, name, parentFolderId });
  });

  register('hackmd.model.loadNoteContent', async (args?: { noteId?: string; teamPath?: string | null }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    return model.loadNoteContent(noteId, teamPath);
  });

  register('hackmd.model.saveNoteContent', async (args?: { noteId?: string; teamPath?: string | null; content?: string }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;
    let content = args?.content;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    if (content === undefined) {
      content = await promptRequiredInput('New note content');
      if (content === undefined) {
        return;
      }
    }

    return model.saveNoteContent(noteId, content, teamPath);
  });

  register('hackmd.model.updateNoteProperties', async (args?: { noteId?: string; teamPath?: string | null; update?: UpdateNoteInput }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;
    let update = args?.update;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    if (!update) {
      update = await promptJson<UpdateNoteInput>('Update payload as JSON', {});
      if (!update) {
        return;
      }
    }

    return model.updateNoteProperties(noteId, update, teamPath);
  });

  register('hackmd.model.renameNote', async (args?: { noteId?: string; teamPath?: string | null; newTitle?: string }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;
    let newTitle = args?.newTitle;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
      if (!newTitle) {
        newTitle = await promptRequiredInput('New note title', picked.note?.title || '');
      }
    }

    if (!newTitle) {
      newTitle = await promptRequiredInput('New note title');
      if (!newTitle) {
        return;
      }
    }

    return model.renameNote(noteId, newTitle, teamPath);
  });

  register('hackmd.model.renameFolder', async (args?: { folderId?: string; teamPath?: string | null; newName?: string }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let folderId = args?.folderId;
    let teamPath = args?.teamPath;
    let newName = args?.newName;

    if (!folderId) {
      if (teamPath === undefined) {
        const selectedScope = await pickScope(model, 'Choose scope for folder');
        if (selectedScope === undefined) {
          return;
        }
        teamPath = selectedScope;
      }
      const selectedFolder = await pickFolder(model, teamPath || null, 'Choose folder to rename');
      if (!selectedFolder || !selectedFolder.folderId) {
        return;
      }
      folderId = selectedFolder.folderId;
    }

    if (!newName) {
      newName = await promptRequiredInput('New folder name');
      if (!newName) {
        return;
      }
    }

    return model.renameFolder(folderId, newName, teamPath);
  });

  register('hackmd.model.updateFolder', async (args?: { folderId?: string; teamPath?: string | null; update?: UpdateFolderInput }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let folderId = args?.folderId;
    let teamPath = args?.teamPath;
    let update = args?.update;

    if (!folderId) {
      if (teamPath === undefined) {
        const selectedScope = await pickScope(model, 'Choose scope for folder');
        if (selectedScope === undefined) {
          return;
        }
        teamPath = selectedScope;
      }

      const selectedFolder = await pickFolder(model, teamPath || null, 'Choose folder to update');
      if (!selectedFolder || !selectedFolder.folderId) {
        return;
      }
      folderId = selectedFolder.folderId;
    }

    if (!update) {
      update = await promptJson<UpdateFolderInput>('Folder update payload as JSON', {});
      if (!update) {
        return;
      }
    }

    return model.updateFolder(folderId, update, teamPath);
  });

  register('hackmd.model.moveNote', async (args?: MoveNoteInput) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let sourceTeamPath = args?.sourceTeamPath;
    let targetTeamPath = args?.targetTeamPath;
    let targetParentFolderId = args?.targetParentFolderId;

    if (!noteId) {
      const picked = await pickNote(model, sourceTeamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      sourceTeamPath = picked.teamPath;
    }

    if (targetTeamPath === undefined) {
      const selectedScope = await pickScope(model, 'Choose destination scope');
      if (selectedScope === undefined) {
        return;
      }
      targetTeamPath = selectedScope;
    }

    if (targetParentFolderId === undefined) {
      const selectedFolder = await pickFolder(model, targetTeamPath || null, 'Choose destination folder', true);
      if (!selectedFolder) {
        return;
      }
      targetParentFolderId = selectedFolder.folderId;
    }

    return model.moveNote({
      noteId,
      sourceTeamPath,
      targetTeamPath,
      targetParentFolderId,
    });
  });

  register('hackmd.model.moveFolder', async (args?: MoveFolderInput) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let folderId = args?.folderId;
    let teamPath = args?.teamPath;
    let targetParentFolderId = args?.targetParentFolderId;

    if (!folderId) {
      if (teamPath === undefined) {
        const selectedScope = await pickScope(model, 'Choose folder scope');
        if (selectedScope === undefined) {
          return;
        }
        teamPath = selectedScope;
      }

      const sourceFolder = await pickFolder(model, teamPath || null, 'Choose folder to move');
      if (!sourceFolder || !sourceFolder.folderId) {
        return;
      }
      folderId = sourceFolder.folderId;
    }

    if (targetParentFolderId === undefined) {
      const targetFolder = await pickFolder(model, teamPath || null, 'Choose destination parent folder', true);
      if (!targetFolder) {
        return;
      }
      targetParentFolderId = targetFolder.folderId;
    }

    return model.moveFolder({
      folderId,
      teamPath,
      targetParentFolderId,
    });
  });

  register('hackmd.model.deleteNote', async (args?: { noteId?: string; teamPath?: string | null; force?: boolean }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let noteId = args?.noteId;
    let teamPath = args?.teamPath;

    if (!noteId) {
      const picked = await pickNote(model, teamPath);
      if (!picked) {
        return;
      }
      noteId = picked.noteId;
      teamPath = picked.teamPath;
    }

    if (!args?.force) {
      const confirm = await vscode.window.showWarningMessage('Delete this note?', { modal: true }, 'Delete');
      if (confirm !== 'Delete') {
        return;
      }
    }

    await model.deleteNote(noteId, teamPath);
    return true;
  });

  register('hackmd.model.deleteFolder', async (args?: { folderId?: string; teamPath?: string | null; force?: boolean }) => {
    const model = getModel();
    if (!model) {
      return;
    }

    let folderId = args?.folderId;
    let teamPath = args?.teamPath;

    if (!folderId) {
      if (teamPath === undefined) {
        const selectedScope = await pickScope(model, 'Choose folder scope');
        if (selectedScope === undefined) {
          return;
        }
        teamPath = selectedScope;
      }

      const selectedFolder = await pickFolder(model, teamPath || null, 'Choose folder to delete');
      if (!selectedFolder || !selectedFolder.folderId) {
        return;
      }
      folderId = selectedFolder.folderId;
    }

    if (!args?.force) {
      const confirm = await vscode.window.showWarningMessage('Delete this folder?', { modal: true }, 'Delete');
      if (confirm !== 'Delete') {
        return;
      }
    }

    await model.deleteFolder(folderId, teamPath);
    return true;
  });
}
