import * as vscode from 'vscode';

import { getHackmdModel, ModelFolder, ModelMyNotes, ModelNote, ModelTeam } from '../model';

export const REFRESH_HINT = 'Run "HackMD Model: Refresh Scope" to load data.';

export type ScopeQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  scope?: ModelMyNotes | ModelTeam;
};

export type FolderQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  folder?: ModelFolder | null;
};

export type NoteQuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  note: ModelNote;
};

export type PickedEntity =
  | { kind: 'note'; note: ModelNote }
  | { kind: 'folder'; folder: ModelFolder };

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
  placeHolder: string,
  options?: { includeMyNotes?: boolean }
): Promise<ModelMyNotes | ModelTeam | undefined> {
  const includeMyNotes = options?.includeMyNotes ?? true;
  const myNotes = model.getMyNotesEntity();
  const personalLoaded = model.getScopeSnapshotSync(model.getMyNotesEntity()) !== null;
  const teamItems: ScopeQuickPickItem[] = model.getTeams().map((team) => {
    const loaded = model.getScopeSnapshotSync(team) !== null;
    return {
      label: team.name,
      description: team.path,
      detail: loaded ? undefined : `Not loaded — ${REFRESH_HINT}`,
      scope: team,
    };
  });

  const selected = await vscode.window.showQuickPick<ScopeQuickPickItem>(
    [
      ...(includeMyNotes
        ? [{
          label: 'My Notes',
          description: 'Personal workspace',
          detail: personalLoaded ? undefined : `Not loaded — ${REFRESH_HINT}`,
          scope: myNotes,
        }]
        : []),
      ...teamItems,
    ],
    {
      placeHolder,
      ignoreFocusOut: true,
    }
  );

  if (!selected) {
    return undefined;
  }

  return selected.scope;
}

export async function pickFolder(
  model: ReturnType<typeof getHackmdModel>,
  scope: ModelMyNotes | ModelTeam,
  placeHolder: string,
  includeRoot = false
): Promise<ModelFolder | null | undefined> {
  const snapshot = model.getScopeSnapshotSync(scope);
  const folders = snapshot ? collectFolders(snapshot.rootFolders) : [];

  const items: FolderQuickPickItem[] = folders.map((folder) => ({
    label: folder.name,
    description: folder.path || folder.id,
    folder,
  }));

  if (includeRoot) {
    items.unshift({
      label: 'Root',
      description: 'No parent folder',
      folder: null,
    });
  }

  if (items.length === 0) {
    const message = snapshot === null
      ? `No local folder data. ${REFRESH_HINT}`
      : 'No folders found in this scope.';
    vscode.window.showInformationMessage(message);
    return undefined;
  }

  const selected = await vscode.window.showQuickPick<FolderQuickPickItem>(items, {
    placeHolder,
    ignoreFocusOut: true,
  });
  if (!selected) {
    return undefined;
  }

  return selected.folder ?? null;
}

export async function pickNote(
  model: ReturnType<typeof getHackmdModel>,
  requestedScope?: ModelMyNotes | ModelTeam
): Promise<ModelNote | undefined> {
  let scope = requestedScope;
  if (scope === undefined) {
    scope = await pickScope(model, 'Choose scope for note operation');
    if (scope === undefined) {
      return undefined;
    }
  }

  const snapshot = model.getScopeSnapshotSync(scope);
  const notes = snapshot ? collectNotes(snapshot.rootFolders, snapshot.rootNotes) : [];

  const items: NoteQuickPickItem[] = notes.map((note) => ({
    label: note.title || note.shortId || note.id,
    description: note.id,
    note,
  }));

  if (items.length === 0) {
    const message = snapshot === null
      ? `No local note data. ${REFRESH_HINT}`
      : 'No notes found in this scope.';
    vscode.window.showInformationMessage(message);
    return undefined;
  }

  const selected = await vscode.window.showQuickPick<NoteQuickPickItem>(items, {
    placeHolder: 'Choose a note',
    ignoreFocusOut: true,
  });

  if (!selected) {
    return undefined;
  }

  return selected.note;
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
    note?: ModelNote;
    folder?: ModelFolder;
  };

  const folders = collectFolders(snapshot.rootFolders);
  const notes = collectNotes(snapshot.rootFolders, snapshot.rootNotes);

  const items: EntityItem[] = [
    ...folders.map((f): EntityItem => ({
      label: `$(folder) ${f.name}`,
      description: f.id,
      entityKind: 'folder',
      folder: f,
    })),
    ...notes.map((n): EntityItem => ({
      label: `$(note) ${n.title || n.shortId || n.id}`,
      description: n.id,
      entityKind: 'note',
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
      folder: selected.folder!,
    };
  }

  return {
    kind: 'note',
    note: selected.note!,
  };
}
