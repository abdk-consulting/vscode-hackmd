import { Note, Team } from '@hackmd/api/dist/type';
import * as vscode from 'vscode';
import { API } from './api';
import { meStore, recordUsage } from './store';

// Cache ThemeIcon instances to prevent layout shifts during updates
const ICON_FOLDER = new vscode.ThemeIcon('folder');
const ICON_SPINNER = new vscode.ThemeIcon('sync~spin');
const ICON_FILE = new vscode.ThemeIcon('file');
const ICON_LOCK = new vscode.ThemeIcon('lock');
const ICON_ORGANIZATION = new vscode.ThemeIcon('organization');

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
  // Track pending operations
  private pendingNotes = new Set<string>(); // Note IDs being opened/deleted/saved
  private pendingContainers = new Set<string>(); // Folder/team IDs where notes are being created

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
      // Team notes already loaded - add the new note at the beginning (if not already present)
      if (!notes.find(n => n.id === note.id)) {
        notes.unshift(note);
      }
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

    // Manually determine where to fire event based on the note's location
    if (note.folderPaths && note.folderPaths.length > 0) {
      // Note is in a folder - fire onChange on the deepest folder
      const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
      const folderCache = this.teamFoldersCache.get(teamId);
      const folderNode = folderCache?.get(deepestFolder.id);
      if (folderNode) {
        this._onDidChangeTreeData.fire(folderNode);
      } else {
        // Fallback to team if folder not found
        const teamNode = this.teamNodesCache.get(teamId);
        if (teamNode) {
          this._onDidChangeTreeData.fire(teamNode);
        }
      }
    } else {
      // Note is at team root level - fire onChange on team
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

            // Manually determine where to fire event based on the note's location
            if (note.folderPaths && note.folderPaths.length > 0) {
              // Note was in a folder - fire onChange on the deepest folder
              const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
              const folderCache = this.teamFoldersCache.get(teamId);
              const folderNode = folderCache?.get(deepestFolder.id);
              if (folderNode) {
                this._onDidChangeTreeData.fire(folderNode);
              } else {
                // Folder might have been deleted - refresh team
                const teamNode = this.teamNodesCache.get(teamId);
                if (teamNode) {
                  this._onDidChangeTreeData.fire(teamNode);
                }
              }
            } else {
              // Note was at team root level - fire onChange on team
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

          // Manually determine where to fire event based on the note's location
          if (note.folderPaths && note.folderPaths.length > 0) {
            // Note was in a folder - fire onChange on the deepest folder
            const deepestFolder = note.folderPaths[note.folderPaths.length - 1];
            const folderCache = this.teamFoldersCache.get(teamId);
            const folderNode = folderCache?.get(deepestFolder.id);
            if (folderNode) {
              this._onDidChangeTreeData.fire(folderNode);
            } else {
              // Folder might have been deleted - refresh team
              const teamNode = this.teamNodesCache.get(teamId);
              if (teamNode) {
                this._onDidChangeTreeData.fire(teamNode);
              }
            }
          } else {
            // Note was at team root level - fire onChange on team
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

  // Find a note in cache and return it
  findNoteInCache(noteId: string, teamPath?: string): Note | undefined {
    // If teamPath is provided, look in that specific team first
    if (teamPath) {
      const teamId = this.getTeamIdFromPath(teamPath);
      if (teamId) {
        const notes = this.teamNotesCache.get(teamId);
        if (notes) {
          const note = notes.find(n => n.id === noteId);
          if (note) {
            return note;
          }
        }
      }
    }

    // Search all teams
    for (const notes of this.teamNotesCache.values()) {
      const note = notes.find(n => n.id === noteId);
      if (note) {
        return note;
      }
    }
    return undefined;
  }

  // Pending operation management
  setPendingNote(noteId: string, noteObject?: Note): void {
    this.pendingNotes.add(noteId);
    // Try to find the note
    let note = noteObject;
    if (!note) {
      // Search all team caches
      for (const notes of this.teamNotesCache.values()) {
        note = notes.find(n => n.id === noteId);
        if (note) break;
      }
    }
    if (note && note.teamPath) {
      // Fire event on the PARENT (team node) to trigger refresh
      const teamId = this.getTeamIdFromPath(note.teamPath);
      if (teamId) {
        const teamNode = this.teamNodesCache.get(teamId);
        if (teamNode) {
          this._onDidChangeTreeData.fire(teamNode);
        }
      }
    }
  }

  clearPendingNote(noteId: string, noteObject?: Note): void {
    this.pendingNotes.delete(noteId);
    // Try to find the note
    let note = noteObject;
    if (!note) {
      // Search all team caches
      for (const notes of this.teamNotesCache.values()) {
        note = notes.find(n => n.id === noteId);
        if (note) break;
      }
    }
    if (note && note.teamPath) {
      // Fire event on the PARENT (team node) to trigger refresh
      const teamId = this.getTeamIdFromPath(note.teamPath);
      if (teamId) {
        const teamNode = this.teamNodesCache.get(teamId);
        if (teamNode) {
          this._onDidChangeTreeData.fire(teamNode);
        }
      }
    }
  }

  setPendingContainer(containerId: string): void {
    this.pendingContainers.add(containerId);
    // Fire granular event based on container type
    if (containerId.startsWith('team-')) {
      const teamId = containerId.substring('team-'.length);
      const teamNode = this.teamNodesCache.get(teamId);
      if (teamNode) {
        this._onDidChangeTreeData.fire(teamNode);
      }
    } else if (containerId.startsWith('folder-')) {
      const folderId = containerId.substring('folder-'.length);
      // Search all team folder caches
      for (const folderCache of this.teamFoldersCache.values()) {
        const folder = folderCache.get(folderId);
        if (folder) {
          this._onDidChangeTreeData.fire(folder);
          break;
        }
      }
    }
  }

  clearPendingContainer(containerId: string): void {
    this.pendingContainers.delete(containerId);
    // Fire granular event based on container type
    if (containerId.startsWith('team-')) {
      const teamId = containerId.substring('team-'.length);
      const teamNode = this.teamNodesCache.get(teamId);
      if (teamNode) {
        this._onDidChangeTreeData.fire(teamNode);
      }
    } else if (containerId.startsWith('folder-')) {
      const folderId = containerId.substring('folder-'.length);
      // Search all team folder caches
      for (const folderCache of this.teamFoldersCache.values()) {
        const folder = folderCache.get(folderId);
        if (folder) {
          this._onDidChangeTreeData.fire(folder);
          break;
        }
      }
    }
  }

  updateNoteInCache(noteId: string, updatedNote: Note, teamPath?: string): void {
    // If we have a teamPath, only search that team's cache
    if (teamPath) {
      const teamId = this.getTeamIdFromPath(teamPath);
      if (teamId) {
        const notes = this.teamNotesCache.get(teamId);
        if (notes) {
          const index = notes.findIndex(n => n.id === noteId);
          if (index !== -1) {
            notes[index] = updatedNote;

            // Ensure the note has teamPath set
            if (!updatedNote.teamPath) {
              (updatedNote as any).teamPath = teamPath;
            }

            // Rebuild tree to update folder objects
            this.organizeNotesIntoFolders(notes, teamId);

            // Manually determine where to fire event based on the note's location
            if (updatedNote.folderPaths && updatedNote.folderPaths.length > 0) {
              // Note is in a folder - fire onChange on the deepest folder
              const deepestFolder = updatedNote.folderPaths[updatedNote.folderPaths.length - 1];
              const folderCache = this.teamFoldersCache.get(teamId);
              const folderNode = folderCache?.get(deepestFolder.id);
              if (folderNode) {
                this._onDidChangeTreeData.fire(folderNode);
              } else {
                // Fallback to team if folder not found
                const teamNode = this.teamNodesCache.get(teamId);
                if (teamNode) {
                  this._onDidChangeTreeData.fire(teamNode);
                }
              }
            } else {
              // Note is at team root level - fire onChange on team
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
          notes[index] = updatedNote;

          // Ensure the note has teamPath set if it's not already
          if (!updatedNote.teamPath && notes[0]?.teamPath) {
            (updatedNote as any).teamPath = notes[0].teamPath;
          }

          // Rebuild tree to update folder objects
          this.organizeNotesIntoFolders(notes, teamId);

          // Manually determine where to fire event based on the note's location
          if (updatedNote.folderPaths && updatedNote.folderPaths.length > 0) {
            // Note is in a folder - fire onChange on the deepest folder
            const deepestFolder = updatedNote.folderPaths[updatedNote.folderPaths.length - 1];
            const folderCache = this.teamFoldersCache.get(teamId);
            const folderNode = folderCache?.get(deepestFolder.id);
            if (folderNode) {
              this._onDidChangeTreeData.fire(folderNode);
            } else {
              // Fallback to team if folder not found
              const teamNode = this.teamNodesCache.get(teamId);
              if (teamNode) {
                this._onDidChangeTreeData.fire(teamNode);
              }
            }
          } else {
            // Note is at team root level - fire onChange on team
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
    const isPending = this.pendingContainers.has(`team-${teamNode.team.id}`);
    item.contextValue = isPending ? 'team-pending' : 'team';

    // Set icon - spinner when pending, otherwise team icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else {
      item.iconPath = ICON_ORGANIZATION;
    }

    // Show team path in description
    item.description = teamNode.team.path;

    // Store team path for command handlers
    (item as any).teamPath = teamNode.team.path;

    return item;
  }

  private getFolderTreeItem(folderNode: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(folderNode.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `folder-${folderNode.id}`; // Stable ID for VS Code to track this item
    const isPending = this.pendingContainers.has(`folder-${folderNode.id}`);
    item.contextValue = isPending ? 'folder-pending' : 'folder';
    item.tooltip = folderNode.name;

    // Store context on the item for command handlers
    (item as any).folderId = folderNode.id;
    (item as any).folderName = folderNode.name;
    (item as any).parentId = folderNode.parentId;
    (item as any).folderClientId = folderNode.clientId;
    (item as any).teamPath = folderNode.teamPath;

    // Set icon - spinner when pending, otherwise folder icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else if (folderNode.icon) {
      item.iconPath = new vscode.ThemeIcon(folderNode.icon);
    } else {
      item.iconPath = ICON_FOLDER;
    }

    return item;
  }

  private getNoteTreeItem(noteNode: NoteNode): vscode.TreeItem {
    const note = noteNode.note;
    const label = note.title || note.shortId || 'Unnamed';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `note-${note.id}`; // Stable ID for VS Code to track this item

    const isPending = this.pendingNotes.has(note.id);

    if (!isPending) {
      item.command = {
        command: 'clickTreeItem',
        title: 'Open Note',
        arguments: [note], // Pass the note object directly
      };
    }

    // Store note ID for commands
    (item as any).noteId = note.id;

    // Set icon and context based on ownership
    const isOwner = meStore.getState().checkIsOwner(note);

    if (isPending) {
      item.contextValue = isOwner ? 'file-owned-pending' : 'file-pending';
    } else {
      item.contextValue = isOwner ? 'file-owned' : 'file';
    }

    // Set icon - spinner when pending, otherwise file icon
    if (isPending) {
      item.iconPath = ICON_SPINNER;
    } else if (isOwner) {
      item.iconPath = ICON_FILE;
    } else {
      item.iconPath = ICON_LOCK;
    }

    return item;
  }

  private getPlaceholderTreeItem(placeholderNode: PlaceholderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(placeholderNode.message, vscode.TreeItemCollapsibleState.None);
    return item;
  }

  private organizeNotesIntoFolders(notes: Note[], teamId: string): { rootFolders: FolderNode[]; rootNotes: Note[]; changedFolders: Set<FolderNode>; teamRootChanged: boolean } {
    // Get or create folder cache for this team
    let folderCache = this.teamFoldersCache.get(teamId);
    if (!folderCache) {
      folderCache = new Map<string, FolderNode>();
      this.teamFoldersCache.set(teamId, folderCache);
    }

    const rootNotes: Note[] = [];
    const changedFolders = new Set<FolderNode>();

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

    // Snapshot current state before clearing
    const oldState = new Map<string, { childIds: Set<string>; noteIds: Set<string> }>();
    const oldNotesInFolders = new Set<string>();
    for (const [folderId, folder] of folderCache.entries()) {
      const noteIds = new Set(folder.notes.map(n => n.id));
      oldState.set(folderId, {
        childIds: new Set(folder.children.map(c => c.id)),
        noteIds,
      });
      // Track which notes were in folders
      for (const noteId of noteIds) {
        oldNotesInFolders.add(noteId);
      }
    }
    // Old root notes are notes that weren't in any folder
    const oldRootNoteIds = new Set(notes.filter(n => !oldNotesInFolders.has(n.id)).map(n => n.id));

    // Count old root folders
    const oldRootFoldersCount = [...folderCache.values()].filter(f => !f.parentId).length;

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

    // Detect which folders changed by comparing with old state
    for (const [folderId, folder] of folderCache.entries()) {
      const old = oldState.get(folderId);
      const newChildIds = new Set(folder.children.map(c => c.id));
      const newNoteIds = new Set(folder.notes.map(n => n.id));

      // Check if children or notes changed
      const childrenChanged = !old ||
        old.childIds.size !== newChildIds.size ||
        ![...old.childIds].every(id => newChildIds.has(id));

      const notesChanged = !old ||
        old.noteIds.size !== newNoteIds.size ||
        ![...old.noteIds].every(id => newNoteIds.has(id));

      if (childrenChanged || notesChanged) {
        changedFolders.add(folder);
      }
    }

    // Check if team root notes changed
    const newRootNoteIds = new Set(rootNotes.map(n => n.id));
    const teamRootChanged =
      oldRootNoteIds.size !== newRootNoteIds.size ||
      ![...oldRootNoteIds].every(id => newRootNoteIds.has(id)) ||
      // Also check if root folders changed (this happens when folders are added/removed)
      rootFolders.length !== oldRootFoldersCount;

    return { rootFolders, rootNotes, changedFolders, teamRootChanged };
  }
}
