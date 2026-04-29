import path from 'path';
import vscode from 'vscode';

import { Team } from '@hackmd/api/dist/type';
import { TreeItem } from '@hackmd/react-vsc-treeview';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

import { API } from '../../api';
import { useAppContext } from '../AppContainer';
import { ErrorListItem } from '../components/ErrorListItem';
import { NoteTreeItem } from '../components/NoteTreeItem';
import { refreshTeamNotesEvent, useEventEmitter } from '../events';
import { recordUsage } from '../store';
import { loadedTeams, loadTeamNotesEvent, markTeamAsLoaded } from '../teamLoadState';



import { FolderWithNotes } from '../components/FolderWithNotes';
import { organizeNotesIntoFolders } from '../utils/folderUtils';

const TeamTreeItem = ({ team }: { team: Team }) => {
  const shouldLoad = loadedTeams.has(team.id);

  // Automatically mark as loaded when this component is rendered (i.e., when team is expanded)
  useEffect(() => {
    if (!shouldLoad) {
      markTeamAsLoaded(team.id);
    }
  }, [team.id, shouldLoad]);

  const { data: notes = [], mutate } = useSWR(
    () => (shouldLoad ? `/teams/${team.id}/notes` : null),
    () =>
      vscode.window.withProgress(
        {
          location: { viewId: 'hackmd.tree.team-notes' },
        },
        () => recordUsage(API.getTeamNotes(team.path, { unwrapData: false }))
      ) as ReturnType<typeof API.getTeamNotes>
  );

  const { extensionPath } = useAppContext();
  const iconPath = useMemo(() => {
    if (extensionPath) {
      return {
        light: path.join(extensionPath, 'images/icon/light/users.svg'),
        dark: path.join(extensionPath, 'images/icon/dark/users.svg'),
      };
    } else {
      return undefined;
    }
  }, [extensionPath]);

  useEventEmitter(refreshTeamNotesEvent, () => {
    mutate();
  });

  const { rootFolders, rootNotes } = organizeNotesIntoFolders(notes);

  return (
    <TreeItem
      label={team.name}
      collapsibleState={1}
      iconPath={iconPath}
      description={team.path}
    >
      {/* Render folders first */}
      {rootFolders.map((folder) => (
        <FolderWithNotes key={folder.id} folder={folder} />
      ))}

      {/* Then render notes without folders */}
      {rootNotes.map((note) => (
        <NoteTreeItem key={note.id} note={note} />
      ))}

      {shouldLoad && notes.length === 0 && <TreeItem label="No notes" />}
      {!shouldLoad && <TreeItem label="Loading..." />}
    </TreeItem>
  );
};

export const TeamNotes = () => {
  const { data: teams = [], mutate, error } = useSWR('/teams', () => recordUsage(API.getTeams({ unwrapData: false })));
  const [, forceUpdate] = useState({});

  useEventEmitter(refreshTeamNotesEvent, () => {
    mutate();
  });

  // Force re-render when a team is loaded
  useEventEmitter(loadTeamNotesEvent, () => {
    forceUpdate({});
  });

  return (
    <>
      <ErrorListItem error={error} />

      {!error && teams.map((team) => (
        <TeamTreeItem key={team.id} team={team} />
      ))}

      {!error && teams.length === 0 && <TreeItem label="No teams" />}
    </>
  );
};
