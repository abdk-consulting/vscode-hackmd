import vscode from 'vscode';

import useSWR from 'swr';

import { API } from '../../api';
import { ErrorListItem } from '../components/ErrorListItem';
import { FolderWithNotes } from '../components/FolderWithNotes';
import { NoteTreeItem } from '../components/NoteTreeItem';
import { refreshMyNotesEvent, useEventEmitter } from '../events';
import { recordUsage } from '../store';
import { organizeNotesIntoFolders } from '../utils/folderUtils';

export const MyNotes = () => {
  const {
    data = [],
    mutate,
    error,
  } = useSWR(
    '/my-notes',
    () =>
      vscode.window.withProgress(
        {
          location: { viewId: 'hackmd.tree.my-notes' },
        },
        () => recordUsage(API.getNoteList({ unwrapData: false }))
      ) as ReturnType<typeof API.getNoteList>
  );

  useEventEmitter(refreshMyNotesEvent, () => {
    mutate();
  });

  const { rootFolders, rootNotes } = organizeNotesIntoFolders(data);

  return (
    <>
      <ErrorListItem error={error} />

      {!error && (
        <>
          {/* Render folders first */}
          {rootFolders.map((folder) => (
            <FolderWithNotes key={folder.id} folder={folder} />
          ))}

          {/* Then render notes without folders */}
          {rootNotes.map((note) => (
            <NoteTreeItem key={note.id} note={note} />
          ))}
        </>
      )}
    </>
  );
};
