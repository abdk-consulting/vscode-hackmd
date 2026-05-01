import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelNote, ModelScope } from '../model';

export const REFRESH_HINT = 'Run "HackMD Model: Refresh Scope" to load data.';

export type ScopeQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  scope?: ModelScope;
  isCustom?: boolean;
};

export type FolderQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  folderId?: string | null;
  isCustom?: boolean;
};

export type NoteQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  note?: ModelNote;
  isCustom?: boolean;
};

export type PickedEntity =
  | { kind: 'note'; noteId: string; teamPath: ModelScope; note?: ModelNote }
  | { kind: 'folder'; folderId: string; teamPath: ModelScope; name: string };

export function collectFolders(rootFolders: readonly ModelFolder[]): ModelFolder[] {
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

export function collectNotes(rootFolders: readonly ModelFolder[], rootNotes: readonly ModelNote[]): ModelNote[] {
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

export async function promptRequiredInput(prompt: string, value = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Value cannot be empty' : null),
  });
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export async function promptOptionalInput(prompt: string, value = ''): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    ignoreFocusOut: true,
  });
  return input;
}

export async function pickScope(
  model: ReturnType<typeof getHackmdModel>,
  placeHolder: string
): Promise<ModelScope | undefined> {
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

export async function pickFolder(
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

  const selected = await vscode.window.showQuickPick<FolderQuickPickItem>(items, {
    placeHolder,
    ignoreFocusOut: true,
  });
  if (!selected) {
    return undefined;
  }

  if (selected.isCustom) {
    if (includeRoot) {
      const customFolderId = await promptOptionalInput('Folder ID (leave empty for Root)');
      return {
        folderId: customFolderId && customFolderId.trim().length > 0 ? customFolderId.trim() : null,
        teamPath,
      };
    }
    const customFolderId = await promptRequiredInput('Folder ID');
    if (!customFolderId) {
      return undefined;
    }
    return { folderId: customFolderId, teamPath };
  }

  return { folderId: selected.folderId ?? null, teamPath };
}

export async function pickNote(
  model: ReturnType<typeof getHackmdModel>,
  requestedScope?: ModelScope
): Promise<{ noteId: string; teamPath: ModelScope; note?: ModelNote } | undefined> {
  let scope = requestedScope;
  if (scope === undefined) {
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
    return { noteId: customNoteId, teamPath: scope };
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

/**
 * Presents a combined note + folder picker for a chosen scope.
 * Used by export to let the user select one entity interactively.
 */
export async function pickEntity(
  model: ReturnType<typeof getHackmdModel>,
  placeHolder: string
): Promise<PickedEntity | undefined> {
  const scope = await pickScope(model, 'Choose scope');
  if (scope === undefined) {
    return undefined;
  }

  const snapshot = model.getScopeSnapshotSync(scope);
  if (!snapshot) {
    vscode.window.showWarningMessage(`Scope data is not loaded. ${REFRESH_HINT}`);
    return undefined;
  }

  type EntityItem = vscode.QuickPickItem & {
    entityKind: 'note' | 'folder';
    noteId?: string;
    folderId?: string;
    note?: ModelNote;
    folderName?: string;
  };

  const folders = collectFolders(snapshot.rootFolders);
  const notes = collectNotes(snapshot.rootFolders, snapshot.rootNotes);

  const items: EntityItem[] = [
    ...folders.map((f): EntityItem => ({
      label: `$(folder) ${f.name}`,
      description: f.id,
      entityKind: 'folder',
      folderId: f.id,
      folderName: f.name,
    })),
    ...notes.map((n): EntityItem => ({
      label: `$(note) ${n.title || n.shortId || n.id}`,
      description: n.id,
      entityKind: 'note',
      noteId: n.id,
      note: n,
    })),
  ];

  if (items.length === 0) {
    vscode.window.showInformationMessage('No notes or folders found in this scope.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder,
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  if (selected.entityKind === 'folder') {
    return {
      kind: 'folder',
      folderId: selected.folderId!,
      teamPath: scope,
      name: selected.folderName!,
    };
  }

  return {
    kind: 'note',
    noteId: selected.noteId!,
    teamPath: scope,
    note: selected.note,
  };
}
