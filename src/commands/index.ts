import * as vscode from 'vscode';

import { registerModelCommands } from './model';
import { registerNoteCommands } from './note';
import { registerSnippetCommands } from './snippet';
import { registerTreeViewCommands } from './treeView';
import { registerUiCommands } from './ui';
import { registerUserCommands } from './user';

export function registerCommands(context: vscode.ExtensionContext) {
  registerUserCommands(context);
  registerModelCommands(context);
  registerUiCommands(context);
  registerTreeViewCommands(context);
  registerNoteCommands(context);
  registerSnippetCommands(context);
}
