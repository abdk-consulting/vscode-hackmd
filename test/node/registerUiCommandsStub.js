'use strict';

const Module = require('module');
const nodePath = require('path');

const originalLoad = Module._load;

function makeUri(scheme, path, query = '', source) {
  const uri = {
    scheme,
    path,
    query,
    fsPath: scheme === 'file' ? path : undefined,
    toString() {
      if (source) {
        return source;
      }
      if (scheme === 'file') {
        return `file://${path}`;
      }
      return `${scheme}:${path}${query ? `?${query}` : ''}`;
    },
  };
  return uri;
}

const window = {
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showTextDocument: async () => undefined,
  withProgress: async (_opts, task) => task(),
};

const workspaceState = {
  docsByUri: new Map(),
  fileBytesByUri: new Map(),
  directoryEntriesByUri: new Map(),
  writeFileCalls: [],
  createDirectoryCalls: [],
  openTextDocumentCalls: [],
};

const commandsState = {
  executeCalls: [],
};

const registeredHandlers = new Map();

const commands = {
  registerCommand(id, handler) {
    registeredHandlers.set(id, handler);
    return { dispose() { registeredHandlers.delete(id); } };
  },
  async executeCommand(id, ...args) {
    commandsState.executeCalls.push([id, ...args]);
    return undefined;
  },
};

const workspace = {
  workspaceFolders: [{ uri: makeUri('file', '/workspace') }],
  fs: {
    async readFile(uri) {
      const key = uri.toString();
      if (workspaceState.fileBytesByUri.has(key)) {
        return workspaceState.fileBytesByUri.get(key);
      }
      return Buffer.from('', 'utf8');
    },
    async writeFile(uri, bytes) {
      workspaceState.writeFileCalls.push([uri, bytes]);
      workspaceState.fileBytesByUri.set(uri.toString(), bytes);
    },
    async readDirectory(uri) {
      const key = uri.toString();
      if (workspaceState.directoryEntriesByUri.has(key)) {
        return workspaceState.directoryEntriesByUri.get(key);
      }
      return [];
    },
    async createDirectory(uri) {
      workspaceState.createDirectoryCalls.push(uri);
    },
  },
  async openTextDocument(uri) {
    workspaceState.openTextDocumentCalls.push(uri);
    const key = uri.toString();
    const text = workspaceState.docsByUri.has(key)
      ? workspaceState.docsByUri.get(key)
      : Buffer.from(workspaceState.fileBytesByUri.get(key) || Buffer.from('', 'utf8')).toString('utf8');
    return {
      uri,
      getText() { return text || ''; },
    };
  },
};

const env = {
  openExternalCalls: [],
  async openExternal(uri) {
    env.openExternalCalls.push(uri);
    return true;
  },
};

const vscodeStub = {
  Uri: {
    from(parts) {
      return makeUri(parts.scheme || '', parts.path || '', parts.query || '');
    },
    parse(value) {
      const str = String(value);
      if (str.startsWith('file://')) {
        return makeUri('file', str.slice('file://'.length), '', str);
      }
      const colonIdx = str.indexOf(':');
      const scheme = colonIdx >= 0 ? str.slice(0, colonIdx) : '';
      const rest = colonIdx >= 0 ? str.slice(colonIdx + 1) : str;
      const qIdx = rest.indexOf('?');
      const p = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
      const query = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
      return makeUri(scheme, p, query, str);
    },
    file(fsPath) {
      return makeUri('file', fsPath);
    },
    joinPath(base, ...segments) {
      if (base.scheme === 'file') {
        return makeUri('file', nodePath.join(base.fsPath || base.path, ...segments));
      }
      const joined = nodePath.posix.join(base.path || '/', ...segments);
      return makeUri(base.scheme, joined, base.query || '');
    },
  },
  window,
  commands,
  workspace,
  env,
  ProgressLocation: {
    Notification: 15,
  },
  ViewColumn: {
    One: 1,
  },
};

let _currentModel = null;

const modelModule = {
  getHackmdModel() {
    if (!_currentModel) {
      throw new Error('HackmdModel not initialized');
    }
    return _currentModel;
  },
};

const MODEL_INDEX_PATH = nodePath.resolve(__dirname, '../../out/model/index.js');
const EXTENSION_PATH = nodePath.resolve(__dirname, '../../out/extension.js');

let _propertiesProvider = null;

const extensionModule = {
  getPropertiesProvider() { return _propertiesProvider; },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === MODEL_INDEX_PATH) {
      return modelModule;
    }
    if (resolved === EXTENSION_PATH) {
      return extensionModule;
    }
  } catch (_) {
    // Ignore resolution errors and use original loader.
  }
  return originalLoad.call(this, request, parent, isMain);
};

function resetState() {
  window.showQuickPick = async () => undefined;
  window.showInputBox = async () => undefined;
  window.showWarningMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  window.showInformationMessage = async () => undefined;
  window.showOpenDialog = async () => undefined;
  window.showSaveDialog = async () => undefined;
  window.showTextDocument = async () => undefined;
  window.withProgress = async (_opts, task) => task();

  workspace.workspaceFolders = [{ uri: makeUri('file', '/workspace') }];

  workspaceState.docsByUri.clear();
  workspaceState.fileBytesByUri.clear();
  workspaceState.directoryEntriesByUri.clear();
  workspaceState.writeFileCalls.length = 0;
  workspaceState.createDirectoryCalls.length = 0;
  workspaceState.openTextDocumentCalls.length = 0;

  commandsState.executeCalls.length = 0;
  env.openExternalCalls.length = 0;
  _propertiesProvider = null;
}

module.exports = {
  vscodeStub,
  window,
  workspace,
  workspaceState,
  commandsState,
  env,
  registeredHandlers,
  setModel(mock) { _currentModel = mock; },
  clearModel() { _currentModel = null; },
  setPropertiesProvider(mock) { _propertiesProvider = mock; },
  clearPropertiesProvider() { _propertiesProvider = null; },
  resetState,
  makeUri,
};
