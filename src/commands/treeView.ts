import * as vscode from 'vscode';

import { Team } from '@hackmd/api/dist/type';

import { getHistoryProvider, getMyNotesProvider, getMyNotesTreeView, getTeamNotesProvider, getTeamNotesTreeView } from '../extension';
import { generateResourceUri } from '../mdFsProvider';
import { recordUsage, teamNotesStore } from '../store';
import { API } from './../api';

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
      const provider = getMyNotesProvider();

      // Set pending on "My Notes" root
      provider?.setPendingContainer('root');

      try {
        const note = await recordUsage(API.createNote({}, { unwrapData: false }));

        const uri = generateResourceUri(note.title, note.id, note.teamPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });

        if (provider) {
          const noteNode = await provider.addNoteToCache(note);
          await revealNote(getMyNotesTreeView(), noteNode);
        }
      } finally {
        // Clear pending state
        provider?.clearPendingContainer('root');
      }
    })
  );

  // HackMD.renameNote
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.renameNote', async (node: any) => {
      if (node && node.type === 'note') {
        const note = node.note;
        const noteId = note.id;
        const currentTitle = note.title || note.shortId || 'Unnamed';

        // Show input box to get new name
        const newTitle = await vscode.window.showInputBox({
          prompt: 'Enter new note name',
          value: currentTitle,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Note name cannot be empty';
            }
            return null;
          }
        });

        if (!newTitle || newTitle === currentTitle) {
          return; // User cancelled or no change
        }

        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        // Set pending state
        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(noteId, note);
        } else {
          myNotesProvider?.setPendingNote(noteId, note);
        }
        historyProvider?.setPendingNote(noteId, note);

        try {
          // Update note via API - use 'title' field
          // Note: TypeScript types are restrictive but API accepts more fields
          if (note.teamPath) {
            await recordUsage(
              API.updateTeamNote(note.teamPath, noteId, { title: newTitle } as any)
            );
          } else {
            await recordUsage(
              API.updateNote(noteId, { title: newTitle } as any, { unwrapData: false })
            );
          }

          // Update the title in the cached note object directly
          // API response might not include the updated note, so we update locally
          const updatedNote = { ...note, title: newTitle };

          if (note.teamPath) {
            teamNotesProvider?.updateNoteInCache(noteId, updatedNote, note.teamPath);
          } else {
            myNotesProvider?.updateNoteInCache(noteId, updatedNote);
          }
          historyProvider?.updateNoteInCache(noteId, updatedNote);
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to rename note: ${error.message}`);
        } finally {
          // Clear pending state
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, note);
          }
          historyProvider?.clearPendingNote(noteId, note);
        }
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

        // Set pending state only in providers that contain this note
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();
        const teamPath = node.note?.teamPath;

        // Personal notes appear in My Notes + History
        // Team notes appear in Team Notes + History
        if (teamPath) {
          teamNotesProvider?.setPendingNote(noteId, node.note);
        } else {
          myNotesProvider?.setPendingNote(noteId, node.note);
        }
        historyProvider?.setPendingNote(noteId, node.note);

        try {
          // Check if it's a team note and use the appropriate API
          if (teamPath) {
            await recordUsage(API.deleteTeamNote(teamPath, noteId, { unwrapData: false }));
          } else {
            await recordUsage(API.deleteNote(noteId, { unwrapData: false }));
          }

          // Close the editor if it's open
          const label = node.note.title || node.note.shortId || 'Unnamed';
          const uri = generateResourceUri(label, noteId, teamPath);

          // Find and close the tab
          for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
              if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
                await vscode.window.tabGroups.close(tab);
                break;
              }
            }
          }

          // After successful deletion, remove from caches
          // (removeNoteFromCache will also fire tree change events)
          if (teamPath) {
            teamNotesProvider?.removeNoteFromCache(noteId, teamPath);
          } else {
            myNotesProvider?.removeNoteFromCache(noteId);
          }
          historyProvider?.removeNoteFromCache(noteId);
        } catch (error) {
          // On error, clear pending state to restore note
          if (teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, node.note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, node.note);
          }
          historyProvider?.clearPendingNote(noteId, node.note);
          throw error;
        }
        // No need to clear pending - note was removed from cache
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clickTreeItem', async (note: any) => {
      if (note) {
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const historyProvider = getHistoryProvider();

        const noteId = note.id;
        const label = note.title || note.shortId || 'Unnamed';

        // Set pending state BEFORE opening - use note object for immediate granular update
        if (note.teamPath) {
          teamNotesProvider?.setPendingNote(noteId, note);
        } else {
          myNotesProvider?.setPendingNote(noteId, note);
        }
        historyProvider?.setPendingNote(noteId, note);

        try {
          const uri = generateResourceUri(label, noteId, note.teamPath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } finally {
          // Clear pending state
          if (note.teamPath) {
            teamNotesProvider?.clearPendingNote(noteId, note);
          } else {
            myNotesProvider?.clearPendingNote(noteId, note);
          }
          historyProvider?.clearPendingNote(noteId, note);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.editNote', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const uri = generateResourceUri(note.title, note.id, note.teamPath);
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
    vscode.commands.registerCommand('HackMD.showPreview', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const uri = generateResourceUri(note.title, note.id, note.teamPath);
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
    vscode.commands.registerCommand('HackMD.showPreviewAndEditor', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        const uri = generateResourceUri(note.title, note.id, note.teamPath);
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
    vscode.commands.registerCommand('HacKMD.openNoteOnHackMD', async (noteNode: any) => {
      if (noteNode && noteNode.type === 'note') {
        const note = noteNode.note;
        vscode.env.openExternal(vscode.Uri.parse(note.publishLink));
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

        // Determine container ID for pending state
        const containerId = folderId ? `folder-${folderId}` : 'root';

        // Set pending state on appropriate provider
        const myNotesProvider = getMyNotesProvider();
        const teamNotesProvider = getTeamNotesProvider();
        const provider = teamPath ? teamNotesProvider : myNotesProvider;

        provider?.setPendingContainer(containerId);

        try {
          let note: any;
          if (teamPath) {
            // Team note in folder
            const teamId = teamNotesProvider?.getTeamIdFromPath(teamPath);
            const areNotesLoaded = teamId && teamNotesProvider?.isTeamNotesCached(teamId);

            if (!areNotesLoaded && teamNotesProvider) {
              // Team notes not loaded - execute both API calls in parallel
              const [createdNote, loadedNotes] = await Promise.all([
                recordUsage(API.createTeamNote(teamPath, payload as any, { unwrapData: false })),
                recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }))
              ]);
              note = createdNote;
              // Cache the loaded notes manually
              if (teamId && loadedNotes) {
                teamNotesProvider.cacheTeamNotes(teamId, loadedNotes);
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
            if (teamNotesProvider) {
              noteNode = await teamNotesProvider.addNoteToCache(note, teamPath);
            }
          } else {
            if (myNotesProvider) {
              noteNode = await myNotesProvider.addNoteToCache(note);
            }
          }

          // Open in editor after cache is updated
          const uri = generateResourceUri(note.title, note.id, note.teamPath);
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
        } finally {
          // Clear pending state
          provider?.clearPendingContainer(containerId);
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
          const provider = getTeamNotesProvider();
          const teamId = provider?.getTeamIdFromPath(teamPath);
          const containerId = `team-${teamId}`;

          // Set pending state on the team
          provider?.setPendingContainer(containerId);

          try {
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
            const uri = generateResourceUri(note.title, note.id, note.teamPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });

            // Reveal and select the note
            if (noteNode) {
              await revealNote(getTeamNotesTreeView(), noteNode);
            }
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to create team note: ${error.message}`);
          } finally {
            // Clear pending state
            provider?.clearPendingContainer(containerId);
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
