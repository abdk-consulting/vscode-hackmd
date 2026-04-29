import { Note } from '@hackmd/api/dist/type';

export interface FolderPath {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId?: string;
}

export interface NoteWithFolders extends Note {
  folderPaths?: FolderPath[];
}

export interface FolderNode {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId?: string;
  teamPath?: string | null;
  children: FolderNode[];
  notes: NoteWithFolders[];
}

/**
 * Organizes notes into a hierarchical folder structure
 * @param notes Array of notes from HackMD API
 * @returns Object with root folders and notes without folders
 */
export function organizeNotesIntoFolders(notes: NoteWithFolders[]): {
  rootFolders: FolderNode[];
  rootNotes: NoteWithFolders[];
} {
  const folderMap = new Map<string, FolderNode>();
  const rootFolders: FolderNode[] = [];
  const rootNotes: Note[] = [];

  // First, collect all unique folders from all notes
  notes.forEach((note) => {
    if (note.folderPaths && note.folderPaths.length > 0) {
      note.folderPaths.forEach((folderPath: FolderPath) => {
        if (!folderMap.has(folderPath.id)) {
          folderMap.set(folderPath.id, {
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
      });
    }
  });

  // Build the folder hierarchy
  folderMap.forEach((folder) => {
    if (folder.parentId) {
      const parentFolder = folderMap.get(folder.parentId);
      if (parentFolder) {
        parentFolder.children.push(folder);
      } else {
        // Parent doesn't exist in our map, treat as root
        rootFolders.push(folder);
      }
    } else {
      // No parent, this is a root folder
      rootFolders.push(folder);
    }
  });

  // Assign notes to their folders
  notes.forEach((note) => {
    if (note.folderPaths && note.folderPaths.length > 0) {
      // Use the last folder in the path (the most specific one)
      const lastFolder = note.folderPaths[note.folderPaths.length - 1];
      const folder = folderMap.get(lastFolder.id);
      if (folder) {
        folder.notes.push(note);
      } else {
        // Folder not found, add to root
        rootNotes.push(note);
      }
    } else {
      // Note has no folder, add to root
      rootNotes.push(note);
    }
  });

  // Sort folders and notes alphabetically
  const sortByName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  rootFolders.sort(sortByName);
  rootNotes.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  // Recursively sort children
  const sortFolderChildren = (folder: FolderNode) => {
    folder.children.sort(sortByName);
    folder.notes.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    folder.children.forEach(sortFolderChildren);
  };
  rootFolders.forEach(sortFolderChildren);

  return { rootFolders, rootNotes };
}
