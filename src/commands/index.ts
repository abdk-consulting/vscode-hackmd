import * as vscode from 'vscode';

import { registerModelCommands } from './model';
import { registerNoteCommands } from './note';
import { registerSnippetCommands } from './snippet';
import { registerTreeViewCommands } from './treeView';
import { registerUserCommands } from './user';

export function registerCommands(context: vscode.ExtensionContext) {
  registerUserCommands(context);
  registerModelCommands(context);
  registerTreeViewCommands(context);
  registerNoteCommands(context);
  registerSnippetCommands(context);
}
