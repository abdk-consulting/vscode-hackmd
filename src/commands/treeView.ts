import * as vscode from 'vscode';

import { Team } from '@hackmd/api/dist/type';

import { getHistoryProvider, getMyNotesProvider, getMyNotesTreeView, getTeamNotesProvider, getTeamNotesTreeView } from '../extension';
import { generateResourceUri } from '../mdFsProvider';
import { recordUsage, teamNotesStore } from '../treeReactApp/store';
import { API } from './../api';
import { ReactVSCTreeNode } from './../tree/nodes';

// Helper function to reveal and select a note after creation
async function revealNote(treeView: vscode.TreeView<any> | undefined, noteNode: any) {
  if (!treeView || !noteNode) return;

  try {
    // Reveal and select the note
    // VS Code will automatically expand all parents (team, folders) as needed
    // using getParent() to find the path
    await treeView.reveal(noteNode, { select: true, focus: true, expand: 1 });
  } catch (error) {
    console.error('Failed to reveal note:', error);
  }
}

export async function registerTreeViewCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshMyNotes', async () => {
      const provider = getMyNotesProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshHistory', async () => {
      const provider = getHistoryProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.refreshTeamNotes', async () => {
      const provider = getTeamNotesProvider();
      if (provider) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('treeView.createMyNotes', async () => {
      const note = await recordUsage(API.createNote({}, { unwrapData: false }));

      const uri = generateResourceUri(note.title, note.id);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });

      const provider = getMyNotesProvider();
      if (provider) {
        const noteNode = await provider.addNoteToCache(note);
        await revealNote(getMyNotesTreeView(), noteNode);
      }
    })
  );

  // HackMD.deleteMyNote
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.deleteMyNote', async (node: any) => {
      if (node) {
        // Extract noteId from the node object
        const noteId = node.note?.id;

        if (!noteId) {
          vscode.window.showErrorMessage('Note ID not found');
          return;
        }

        // prompt
        const confirm = await vscode.window.showWarningMessage(
          'Are you sure to delete this note?',
          { modal: true },
          'Yes'
        );

        if (!confirm) {
          return;
        }

        // Check if it's a team note and use the appropriate API
        const teamPath = node.note?.teamPath;
        if (teamPath) {
          await recordUsage(API.deleteTeamNote(teamPath, noteId, { unwrapData: false }));
        } else {
          await recordUsage(API.deleteNote(noteId, { unwrapData: false }));
        }

        // Synchronously remove from all caches
        const myNotesProvider = getMyNotesProvider();
        if (myNotesProvider) {
          myNotesProvider.removeNoteFromCache(noteId);
        }

        const historyProvider = getHistoryProvider();
        if (historyProvider) {
          historyProvider.removeNoteFromCache(noteId);
        }

        const teamNotesProvider = getTeamNotesProvider();
        if (teamNotesProvider) {
          teamNotesProvider.removeNoteFromCache(noteId, teamPath);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clickTreeItem', async (label, noteId) => {
      if (noteId) {
        const uri = generateResourceUri(label || 'Unnamed', noteId);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.editNote', async (noteNode: ReactVSCTreeNode) => {
      if (noteNode) {
        const { noteId } = noteNode.value.context;
        const { label } = noteNode.value;

        const uri = generateResourceUri(label.toString(), noteId);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.selectTeam', async () => {
      const teams = await recordUsage(API.getTeams({ unwrapData: false }));

      const getTeamLabel = (team: Team) => `${team.name} [${team.path}]`;

      await vscode.window.showQuickPick(teams.map(getTeamLabel)).then((selectedTeam) => {
        if (!selectedTeam) {
          return;
        }

        const selectedTeamId = teams.find((team) => getTeamLabel(team) === selectedTeam)?.id;

        const { setSelectedTeamId } = teamNotesStore.getState();
        setSelectedTeamId(selectedTeamId);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.showPreview', async (noteNode: ReactVSCTreeNode) => {
      if (noteNode) {
        const { noteId } = noteNode.value.context;
        const { label } = noteNode.value;

        const uri = generateResourceUri(label.toString(), noteId);
        vscode.commands.executeCommand('markdown.showPreview', uri);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!checkEditorExist(editor)) {
          return;
        }

        const noteId = editor.document.uri.fragment;
        if (!checkNoteIdExist(noteId)) {
          return;
        }

        const lastIndex = editor.document.fileName.lastIndexOf('.');
        const fileName = editor.document.fileName.slice(0, lastIndex + 1);
        const uri = generateResourceUri(fileName, noteId);
        vscode.commands.executeCommand('markdown.showPreview', uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.showPreviewAndEditor', async (noteNode: ReactVSCTreeNode) => {
      if (noteNode) {
        const { noteId } = noteNode.value.context;
        const { label } = noteNode.value;

        const uri = generateResourceUri(label.toString(), noteId);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!checkEditorExist(editor)) {
          return;
        }

        const noteId = editor.document.uri.fragment;
        if (!checkNoteIdExist(noteId)) {
          return;
        }

        const { content } = await recordUsage(API.getNote(noteId, { unwrapData: false }));
        if (!checkNoteExist(content)) {
          return;
        }

        const lastIndex = editor.document.fileName.lastIndexOf('.');
        const fileName = editor.document.fileName.slice(0, lastIndex + 1);
        const uri = generateResourceUri(fileName, noteId);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HacKMD.openNoteOnHackMD', async (noteNode: ReactVSCTreeNode) => {
      if (noteNode) {
        const publishLink = noteNode.value.context.publishLink;
        vscode.env.openExternal(vscode.Uri.parse(publishLink));
      } else {
        const noteId = vscode.window.activeTextEditor.document.uri.fragment;

        const note = await recordUsage(API.getNote(noteId, { unwrapData: false }));

        if (note && note.publishLink) {
          vscode.env.openExternal(vscode.Uri.parse(note.publishLink));
        }
      }
    })
  );

  // Folder and team commands
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.createNote', async (node: any) => {
      if (node) {
        // Extract properties from node object based on type
        let folderId, teamPath;

        if (node.type === 'folder') {
          folderId = node.id;
          teamPath = node.teamPath;
        } else {
          // Fallback for React tree nodes
          folderId = node.value?.context?.folderId || node.folderId;
          teamPath = node.value?.context?.teamPath || node.teamPath;
        }
        const payload = folderId ? { parentFolderId: folderId } : {};

        let note: any;
        if (teamPath) {
          // Team note in folder
          const provider = getTeamNotesProvider();
          const teamId = provider?.getTeamIdFromPath(teamPath);
          const areNotesLoaded = teamId && provider?.isTeamNotesCached(teamId);

          if (!areNotesLoaded && provider) {
            // Team notes not loaded - execute both API calls in parallel
            const [createdNote, loadedNotes] = await Promise.all([
              recordUsage(API.createTeamNote(teamPath, payload as any, { unwrapData: false })),
              recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }))
            ]);
            note = createdNote;
            // Cache the loaded notes manually
            if (teamId && loadedNotes) {
              provider.cacheTeamNotes(teamId, loadedNotes);
            }
          } else {
            // Team notes already loaded - just create the note
            note = await recordUsage(
              API.createTeamNote(teamPath, payload as any, { unwrapData: false })
            );
          }
        } else {
          // Personal note
          note = await recordUsage(
            API.createNote(payload as any, { unwrapData: false })
          );
        }

        // Add to cache first, then open editor
        let noteNode: any;
        if (teamPath) {
          const provider = getTeamNotesProvider();
          if (provider) {
            noteNode = await provider.addNoteToCache(note, teamPath);
          }
        } else {
          const provider = getMyNotesProvider();
          if (provider) {
            noteNode = await provider.addNoteToCache(note);
          }
        }

        // Open in editor after cache is updated
        const uri = generateResourceUri(note.title, note.id);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });

        // Reveal and select the note
        if (noteNode) {
          if (teamPath) {
            await revealNote(getTeamNotesTreeView(), noteNode);
          } else {
            await revealNote(getMyNotesTreeView(), noteNode);
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.folder.openOnWeb', async (treeItem: any) => {
      if (treeItem) {
        // For React tree nodes, context is in value.context
        // For TreeDataProvider nodes, properties are directly on the item
        const folderId = treeItem.value?.context?.folderId || treeItem.folderId;

        if (folderId) {
          // Open HackMD - the exact URL structure for folders may need to be adjusted
          vscode.env.openExternal(vscode.Uri.parse('https://hackmd.io'));
        }
      }
    })
  );

  // Team note creation command
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.team.createNote', async (node: any) => {
      if (node) {
        // Extract teamPath from the node object
        const teamPath = node.team?.path;

        if (teamPath) {
          try {
            const provider = getTeamNotesProvider();
            const teamId = provider?.getTeamIdFromPath(teamPath);
            const areNotesLoaded = teamId && provider?.isTeamNotesCached(teamId);

            let note: any;
            if (!areNotesLoaded && provider) {
              // Team notes not loaded - execute both API calls in parallel
              const [createdNote, loadedNotes] = await Promise.all([
                recordUsage(API.createTeamNote(teamPath, {} as any, { unwrapData: false })),
                recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }))
              ]);
              note = createdNote;
              // Cache the loaded notes manually (set teamId directly)
              if (teamId && loadedNotes) {
                provider.cacheTeamNotes(teamId, loadedNotes);
              }
            } else {
              // Team notes already loaded or provider unavailable - just create the note
              note = await recordUsage(
                API.createTeamNote(teamPath, {} as any, { unwrapData: false })
              );
            }

            // Add to cache (won't trigger additional API call as notes are now loaded)
            let noteNode: any;
            if (provider) {
              noteNode = await provider.addNoteToCache(note, teamPath);
            }

            // Open in editor only after cache is updated
            const uri = generateResourceUri(note.title, note.id);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });

            // Reveal and select the note
            if (noteNode) {
              await revealNote(getTeamNotesTreeView(), noteNode);
            }
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to create team note: ${error.message}`);
          }
        } else {
          vscode.window.showErrorMessage('Team path not found');
        }
      }
    })
  );
}

const checkEditorExist = (editor) => {
  if (editor) {
    return true;
  } else {
    vscode.window.showInformationMessage('Current window is not a text editor. Please open one first.');
    return false;
  }
};

const checkNoteIdExist = (noteId) => {
  if (noteId) {
    return true;
  } else {
    vscode.window.showInformationMessage('Please open a note first');
    return false;
  }
};

const checkNoteExist = (content) => {
  if (content) {
    return true;
  } else {
    vscode.window.showInformationMessage("Can't find the note from HackMD. Make sure it's still exist.");
    return false;
  }
};
