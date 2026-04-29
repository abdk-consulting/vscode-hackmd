import { Note, Team } from '@hackmd/api/dist/type';
import * as path from 'path';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './treeReactApp/store';

type TreeNode = TeamNode | FolderNode | NoteNode | PlaceholderNode;

interface TeamNode {
  type: 'team';
  team: Team;
}

interface FolderNode {
  type: 'folder';
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId: string;
  teamPath: string;
  children: FolderNode[];
  notes: Note[];
}

interface NoteNode {
  type: 'note';
  note: Note;
}

interface PlaceholderNode {
  type: 'placeholder';
  message: string;
}

export class TeamNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private teams: Team[] = [];
  private teamNotesCache = new Map<string, Note[]>();
  // Cache folder objects to maintain stable references for change events
  private teamFoldersCache = new Map<string, Map<string, FolderNode>>();
  // Cache team node objects to maintain stable references for change events
  private teamNodesCache = new Map<string, TeamNode>();

  constructor(private extensionPath: string) { }

  refresh(): void {
    this.teamNotesCache.clear();
    this.teamFoldersCache.clear();
    this.teamNodesCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshTeam(teamId: string): void {
    this.teamNotesCache.delete(teamId);
    this.teamFoldersCache.delete(teamId);
    // Don't delete from teamNodesCache - we want to keep the same object reference
  }

  refreshElement(element: TreeNode): void {
    // If it's a folder, find and refresh the parent team
    if (element.type === 'folder') {
      const teamId = this.getTeamIdFromPath(element.teamPath);
      if (teamId) {
        this.teamNotesCache.delete(teamId);
        // Find the team node and fire refresh for it
        const teamNode = this.teamNodesCache.get(teamId);
        if (teamNode) {
          this._onDidChangeTreeData.fire(teamNode);
          return;
        }
      }
    } else if (element.type === 'team') {
      this.teamNotesCache.delete(element.team.id);
      this._onDidChangeTreeData.fire(element);
    }
  }

  async addNoteToCache(note: Note, teamPath: string): Promise<NoteNode | undefined> {
    const teamId = this.getTeamIdFromPath(teamPath);
    if (!teamId) return undefined;

    let notes = this.teamNotesCache.get(teamId);

    if (!notes) {
      // Team notes not loaded yet - load them
      try {
        notes = await recordUsage(API.getTeamNotes(teamPath, { unwrapData: false }));
        // Check if note is already in the list (might have been added by server)
        if (!notes.find(n => n.id === note.id)) {
          notes.unshift(note); // Add at beginning (newer notes first)
        }
        this.teamNotesCache.set(teamId, notes);
      } catch (error) {
        // If loading fails, just add the single note
        notes = [note];
        this.teamNotesCache.set(teamId, notes);
      }
    } else {
      // Team notes already loaded - add the new note at the beginning
      notes.unshift(note);
    }

    // Ensure the note has teamPath set (API might not return it)
    if (!note.teamPath) {
      (note as any).teamPath = teamPath;
    }

    // Build the tree structure (same as getChildren does)
    const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes, teamId);
    const children: TreeNode[] = [
      ...rootFolders,
      ...rootNotes.map(n => ({ type: 'note' as const, note: n }))
    ];

    // Find the note in the tree structure
    const findNoteInTree = (items: TreeNode[]): NoteNode | undefined => {
      for (const item of items) {
        if (item.type === 'note' && item.note.id === note.id) {
          return item;
        }
        if (item.type === 'folder') {
          const folderChildren = this.getFolderChildren(item);
          const found = findNoteInTree(folderChildren);
          if (found) return found;
        }
      }
      return undefined;
    };

    const noteNode = findNoteInTree(children);

    // Fire onChange on the specific parent node (folder or team)
    if (note.folderPaths && note.folderPaths.length > 0) {
      // Note is in a folder - fire onChange on the deepest folder
      const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
      const folderCache = this.teamFoldersCache.get(teamId);
      const folderNode = folderCache?.get(deepestFolder.id);
      if (folderNode) {
        // Fire onChange on the cached folder object (stable reference)
        this._onDidChangeTreeData.fire(folderNode);
      } else {
        // Fallback to team if folder not found in cache
        const teamNode = this.teamNodesCache.get(teamId);
        if (teamNode) {
          this._onDidChangeTreeData.fire(teamNode);
        }
      }
    } else {
      // Note is at root level - fire onChange on the team
      const teamNode = this.teamNodesCache.get(teamId);
      if (teamNode) {
        this._onDidChangeTreeData.fire(teamNode);
      }
    }

    return noteNode;
  }

  removeNoteFromCache(noteId: string, teamPath?: string): void {
    // If we have a teamPath, only search that team's cache
    if (teamPath) {
      const teamId = this.getTeamIdFromPath(teamPath);
      if (teamId) {
        const notes = this.teamNotesCache.get(teamId);
        if (notes) {
          const index = notes.findIndex(n => n.id === noteId);
          if (index !== -1) {
            const note = notes[index];
            notes.splice(index, 1);

            // Rebuild tree to update folder objects
            this.organizeNotesIntoFolders(notes, teamId);

            // Fire onChange on the specific parent node (folder or team)
            if (note.folderPaths && note.folderPaths.length > 0) {
              const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
              const folderCache = this.teamFoldersCache.get(teamId);
              const folderNode = folderCache?.get(deepestFolder.id);
              if (folderNode) {
                // Fire onChange on the cached folder object (stable reference)
                this._onDidChangeTreeData.fire(folderNode);
              } else {
                // Folder might have been deleted - refresh team
                const team = this.teams.find(t => t.id === teamId);
                if (team) {
                  this._onDidChangeTreeData.fire({ type: 'team', team });
                }
              }
            } else {
              // Note was at root level - fire onChange on the team
              const teamNode = this.teamNodesCache.get(teamId);
              if (teamNode) {
                this._onDidChangeTreeData.fire(teamNode);
              }
            }
            return;
          }
        }
      }
    } else {
      // Search all teams' caches
      for (const [teamId, notes] of this.teamNotesCache.entries()) {
        const index = notes.findIndex(n => n.id === noteId);
        if (index !== -1) {
          const note = notes[index];
          notes.splice(index, 1);

          // Rebuild tree to update folder objects
          this.organizeNotesIntoFolders(notes, teamId);

          // Fire onChange on the specific parent node (folder or team)
          if (note.folderPaths && note.folderPaths.length > 0) {
            const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
            const folderCache = this.teamFoldersCache.get(teamId);
            const folderNode = folderCache?.get(deepestFolder.id);
            if (folderNode) {
              // Fire onChange on the cached folder object (stable reference)
              this._onDidChangeTreeData.fire(folderNode);
            } else {
              // Folder might have been deleted - refresh team
              const teamNode = this.teamNodesCache.get(teamId);
              if (teamNode) {
                this._onDidChangeTreeData.fire(teamNode);
              }
            }
          } else {
            // Note was at root level - fire onChange on the team
            const teamNode = this.teamNodesCache.get(teamId);
            if (teamNode) {
              this._onDidChangeTreeData.fire(teamNode);
            }
          }
          return;
        }
      }
    }
  }

  getTeamIdFromPath(teamPath: string): string | undefined {
    const team = this.teams.find(t => t.path === teamPath);
    return team?.id;
  }

  isTeamNotesCached(teamId: string): boolean {
    return this.teamNotesCache.has(teamId);
  }

  cacheTeamNotes(teamId: string, notes: Note[]): void {
    this.teamNotesCache.set(teamId, notes);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'team':
        return this.getTeamTreeItem(element);
      case 'folder':
        return this.getFolderTreeItem(element);
      case 'note':
        return this.getNoteTreeItem(element);
      case 'placeholder':
        return this.getPlaceholderTreeItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // Root level - show teams
      try {
        this.teams = await recordUsage(API.getTeams({ unwrapData: false }));
        if (this.teams.length === 0) {
          return [{ type: 'placeholder', message: 'No teams' }];
        }
        // Return cached team nodes to maintain stable object references
        return this.teams.map(team => {
          let teamNode = this.teamNodesCache.get(team.id);
          if (!teamNode) {
            teamNode = { type: 'team', team };
            this.teamNodesCache.set(team.id, teamNode);
          }
          return teamNode;
        });
      } catch (error) {
        return [{ type: 'placeholder', message: `Error: ${error.message}` }];
      }
    }

    switch (element.type) {
      case 'team':
        return this.getTeamChildren(element);
      case 'folder':
        return this.getFolderChildren(element);
      default:
        return [];
    }
  }

  async getParent(element: TreeNode): Promise<TreeNode | undefined> {
    switch (element.type) {
      case 'team':
      case 'placeholder':
        return undefined;

      case 'note':
        // Find the parent folder or team
        if (element.note.folderPaths && element.note.folderPaths.length > 0) {
          const deepestFolder = element.note.folderPaths[element.note.folderPaths.length - 1];
          // Return the cached folder object
          const teamId = this.getTeamIdFromPath(element.note.teamPath);
          if (teamId) {
            const folderCache = this.teamFoldersCache.get(teamId);
            const cachedFolder = folderCache?.get(deepestFolder.id);
            if (cachedFolder) {
              return cachedFolder;
            }
          }
        }
        // Root level note - find the team
        const team = this.teams.find(t => t.path === element.note.teamPath);
        if (team) {
          return this.teamNodesCache.get(team.id);
        }
        return undefined;

      case 'folder':
        // Find parent folder or team
        if (element.parentId) {
          // Return the cached parent folder
          const teamId = this.getTeamIdFromPath(element.teamPath);
          if (teamId) {
            const folderCache = this.teamFoldersCache.get(teamId);
            const parentFolder = folderCache?.get(element.parentId);
            if (parentFolder) {
              return parentFolder;
            }
          }
        } else {
          // Root level folder - find the team
          const team = this.teams.find(t => t.path === element.teamPath);
          if (team) {
            return this.teamNodesCache.get(team.id);
          }
          return undefined;
        }
    }
    return undefined;
  }

  private async getTeamChildren(teamNode: TeamNode): Promise<TreeNode[]> {
    try {
      // Lazy load - only fetch notes when team is expanded
      let notes = this.teamNotesCache.get(teamNode.team.id);
      if (!notes) {
        notes = await recordUsage(API.getTeamNotes(teamNode.team.path, { unwrapData: false }));
        this.teamNotesCache.set(teamNode.team.id, notes);
      }

      if (notes.length === 0) {
        return [{ type: 'placeholder', message: 'No notes' }];
      }

      const { rootFolders, rootNotes } = this.organizeNotesIntoFolders(notes, teamNode.team.id);

      const children: TreeNode[] = [];
      children.push(...rootFolders);
      children.push(...rootNotes.map(note => ({ type: 'note' as const, note })));

      return children;
    } catch (error) {
      return [{ type: 'placeholder', message: `Error loading notes: ${error.message}` }];
    }
  }

  private getFolderChildren(folderNode: FolderNode): TreeNode[] {
    const children: TreeNode[] = [];
    children.push(...folderNode.children);
    children.push(...folderNode.notes.map(note => ({ type: 'note' as const, note })));
    return children;
  }

  private getTeamTreeItem(teamNode: TeamNode): vscode.TreeItem {
    const item = new vscode.TreeItem(teamNode.team.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `team-${teamNode.team.id}`; // Stable ID for VS Code to track this item
    item.description = teamNode.team.path;
    item.contextValue = 'team';
    item.iconPath = {
      light: path.join(this.extensionPath, 'images/icon/light/users.svg'),
      dark: path.join(this.extensionPath, 'images/icon/dark/users.svg'),
    };

    // Store team path for command handlers
    (item as any).teamPath = teamNode.team.path;

    return item;
  }

  private getFolderTreeItem(folderNode: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folderNode.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder-${folderNode.id}`; // Stable ID for VS Code to track this item
    item.contextValue = 'folder';
    item.tooltip = folderNode.name;

    // Store context on the item for command handlers
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = folderNode.clientId;
    (item as any).teamPath = folderNode.teamPath;

    // Set icon if available
    if (folderNode.icon) {
      item.iconPath = new vscode.ThemeIcon(folderNode.icon);
    }

    return item;
  }

  private getNoteTreeItem(noteNode: NoteNode): vscode.TreeItem {
    const note = noteNode.note;
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `note-${note.id}`; // Stable ID for VS Code to track this item

    item.command = {
      command: 'clickTreeItem',
      title: 'Open Note',
      arguments: [label, note.id],
    };

    // Store note ID for commands
    (item as any).noteId = note.id;

    // Set icon and context based on ownership
    const isOwner = meStore.getState().checkIsOwner(note);
    if (isOwner) {
      item.contextValue = 'file-owned';
      item.iconPath = {
        light: path.join(this.extensionPath, 'images/icon/light/file-text.svg'),
        dark: path.join(this.extensionPath, 'images/icon/dark/file-text.svg'),
      };
    } else {
      item.contextValue = 'file';
      item.iconPath = {
        light: path.join(this.extensionPath, 'images/icon/light/gist-secret.svg'),
        dark: path.join(this.extensionPath, 'images/icon/dark/gist-secret.svg'),
      };
    }

    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
    return item;
  }

  private organizeNotesIntoFolders(notes: Note[], teamId: string): { rootFolders: FolderNode[]; rootNotes: Note[] } {
    // Get or create folder cache for this team
    let folderCache = this.teamFoldersCache.get(teamId);
    if (!folderCache) {
      folderCache = new Map<string, FolderNode>();
      this.teamFoldersCache.set(teamId, folderCache);
    }

    const rootNotes: Note[] = [];

    // Collect all unique folders from notes, reusing cached folder objects
    for (const note of notes) {
      if (note.folderPaths && note.folderPaths.length > 0) {
        for (const folderPath of note.folderPaths) {
          if (!folderCache.has(folderPath.id)) {
            // Create new folder object and cache it
            folderCache.set(folderPath.id, {
              type: 'folder',
              id: folderPath.id,
              name: folderPath.name,
              icon: folderPath.icon,
              color: folderPath.color,
              parentId: folderPath.parentId,
              clientId: folderPath.clientId,
              teamPath: note.teamPath,
              children: [],
              notes: [],
            });
          }
        }
      }
    }

    // Clear children and notes arrays in all cached folders
    for (const folder of folderCache.values()) {
      folder.children = [];
      folder.notes = [];
    }

    // Build folder hierarchy using cached objects
    const rootFolders: FolderNode[] = [];
    for (const folder of folderCache.values()) {
      if (folder.parentId) {
        const parent = folderCache.get(folder.parentId);
        if (parent) {
          parent.children.push(folder);
        } else {
          rootFolders.push(folder);
        }
      } else {
        rootFolders.push(folder);
      }
    }

    // Assign notes to their deepest folder
    for (const note of notes) {
      if (note.folderPaths && note.folderPaths.length > 0) {
        const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
        const folder = folderCache.get(deepestFolder.id);
        if (folder) {
          folder.notes.push(note);
        } else {
          rootNotes.push(note);
        }
      } else {
        rootNotes.push(note);
      }
    }

    return { rootFolders, rootNotes };
  }
}
