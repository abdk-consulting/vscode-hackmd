import * as vscode from 'vscode';

import { forceRefreshAPIClient } from '../api';
import { ACCESS_TOKEN_KEY } from '../constants';
import { getHistoryProvider, getMyNotesProvider, getTeamNotesProvider } from '../extension';

export async function registerUserCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.apiKey', async () => {
      await forceRefreshAPIClient(context);

      // Refresh all tree views
      getHistoryProvider()?.refresh();
      getMyNotesProvider()?.refresh();
      getTeamNotesProvider()?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.upgrade', async () => {
      vscode.env.openExternal(vscode.Uri.parse('https://hackmd.io/settings#api'));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('HackMD.clearApiKey', async () => {
      await context.secrets.delete(ACCESS_TOKEN_KEY);
      await vscode.commands.executeCommand('setContext', 'hackmd.noApiKey', true);
      vscode.window.showInformationMessage('API key cleared. Reload window to see welcome views.');
    })
  );
}
