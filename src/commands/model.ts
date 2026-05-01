import * as vscode from 'vscode';

import {
  CreateFolderInput,
  CreateNoteInput,
  getHackmdModel,
  MoveFolderInput,
  MoveNoteInput,
  UpdateFolderInput,
  UpdateNoteInput
} from '../model';
import {
  pickFolder,
  pickNote,
  pickScope,
  promptOptionalInput,
  promptRequiredInput
} from './pickers';

function getModel(): ReturnType<typeof getHackmdModel> | undefined {
  try {
    return getHackmdModel();
  } catch {
    vscode.window.showErrorMessage('HackMD is not connected. Please configure your API key first.');
    return undefined;
  }
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
