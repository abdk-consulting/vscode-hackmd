import path from 'path';

import { TreeItem } from '@hackmd/react-vsc-treeview';
import { useMemo } from 'react';

import { useAppContext } from '../AppContainer';

export interface FolderData {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  parentId?: string;
  clientId?: string;
  teamPath?: string | null;
}

export const FolderTreeItem = ({ folder, children }: { folder: FolderData; children?: React.ReactNode }) => {
  const { extensionPath } = useAppContext();

  const iconPath = useMemo(() => {
    if (extensionPath) {
      return {
        light: path.join(extensionPath, 'images/icon/light/folder.svg'),
        dark: path.join(extensionPath, 'images/icon/dark/folder.svg'),
      };
    } else {
      return undefined;
    }
  }, [extensionPath]);

  return (
    <TreeItem
      label={folder.name}
      iconPath={iconPath}
      contextValue="folder"
      context={{
        folderId: folder.id,
        folderName: folder.name,
        parentId: folder.parentId,
        folderClientId: folder.clientId,
        teamPath: folder.teamPath,
      }}
    >
      {children}
    </TreeItem>
  );
};
