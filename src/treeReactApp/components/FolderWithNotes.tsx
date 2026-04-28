import { FolderNode, NoteWithFolders } from '../utils/folderUtils';
import { FolderTreeItem } from './FolderTreeItem';
import { NoteTreeItem } from './NoteTreeItem';

export const FolderWithNotes = ({ folder }: { folder: FolderNode }) => {
  return (
    <FolderTreeItem folder={folder}>
      {/* Render subfolders first */}
      {folder.children.map((childFolder) => (
        <FolderWithNotes key={childFolder.id} folder={childFolder} />
      ))}

      {/* Then render notes in this folder */}
      {folder.notes.map((note: NoteWithFolders) => (
        <NoteTreeItem key={note.id} note={note} />
      ))}
    </FolderTreeItem>
  );
};
