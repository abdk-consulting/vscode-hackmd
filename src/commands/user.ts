import * as vscode from 'vscode';

import { forceRefreshAPIClient } from '../api';
import { ACCESS_TOKEN_KEY } from '../constants';
import { getHackmdModel } from '../model';

export async function registerUserCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('hackmd.user.apiKey', async () => {
      await forceRefreshAPIClient(context);

      const model = getHackmdModel();
      await model.refresh(model.getModelRootEntity());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hackmd.user.upgrade', async () => {
      vscode.env.openExternal(vscode.Uri.parse('https://hackmd.io/settings#api'));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hackmd.user.clearApiKey', async () => {
      await context.secrets.delete(ACCESS_TOKEN_KEY);
      await vscode.commands.executeCommand('setContext', 'hackmd.noApiKey', true);
      vscode.window.showInformationMessage('API key cleared. Reload window to see welcome views.');
    })
  );
}
