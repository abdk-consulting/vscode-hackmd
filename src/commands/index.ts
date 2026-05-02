import * as vscode from 'vscode';

import { registerModelCommands } from './model';
import { registerUiCommands } from './ui';
import { registerUserCommands } from './user';

export function registerCommands(context: vscode.ExtensionContext) {
  registerUserCommands(context);
  registerModelCommands(context);
  registerUiCommands(context);
}
