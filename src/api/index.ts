import * as vscode from 'vscode';

import { ACCESS_TOKEN_KEY } from '../constants';
import { meStore } from '../store';
import { HackMdApiClient } from './hackmdApiClient';

let API: HackMdApiClient;

export async function initializeAPIClient(context: vscode.ExtensionContext, forceShowInputBox = false) {
  let accessToken = await context.secrets.get(ACCESS_TOKEN_KEY);
  const apiEndPoint = vscode.workspace.getConfiguration('Hackmd').get('apiEndPoint') as string;

  if (!accessToken || forceShowInputBox) {
    const input = await vscode.window.showInputBox({
      prompt: 'Please input your HackMD access token',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Access Token',
      title: 'HackMD Access Token',
      value: accessToken,
    });

    if (!input) {
      return;
    }

    await context.secrets.store(ACCESS_TOKEN_KEY, input);
    accessToken = input;
  }

  API = new HackMdApiClient(accessToken, apiEndPoint);
  await meStore.getState().refreshLogin();

  // Clear the 'no API key' flag to hide welcome views
  await vscode.commands.executeCommand('setContext', 'hackmd.noApiKey', false);
}

export async function forceRefreshAPIClient(context: vscode.ExtensionContext) {
  await initializeAPIClient(context, true);
}

vscode.workspace.onDidChangeConfiguration(async (e) => {
  if (e.affectsConfiguration('Hackmd')) {
    const extension = vscode.extensions.getExtension<{ context: vscode.ExtensionContext }>('HackMD.vscode-hackmd');
    await initializeAPIClient(extension.exports.context);
  }
});

export { API };
