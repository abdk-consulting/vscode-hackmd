'use strict';

const Module = require('module');
const nodePath = require('path');

const originalLoad = Module._load;

function makeUri(scheme, path, query = '', source) {
  return {
    scheme,
    path,
    query,
    fsPath: scheme === 'file' ? path : undefined,
    toString() {
      if (source) return source;
      if (scheme === 'file') return `file://${path}`;
      return `${scheme}:${path}${query ? `?${query}` : ''}`;
    },
  };
}

const registeredHandlers = new Map();
const commandsState = {
  executeCalls: [],
  executeResults: new Map(),
};

const commands = {
  registerCommand(id, handler) {
    registeredHandlers.set(id, handler);
    return { dispose() { registeredHandlers.delete(id); } };
  },
  async executeCommand(id, ...args) {
    commandsState.executeCalls.push([id, ...args]);
    if (!commandsState.executeResults.has(id)) {
      return undefined;
    }
    const value = commandsState.executeResults.get(id);
    if (typeof value === 'function') {
      return value(...args);
    }
    return value;
  },
};

const window = {
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  withProgress: async (_opts, task) => task(),
  tabGroups: {
    all: [],
    close: async () => true,
  },
};

const workspace = {
  workspaceFolders: [{ uri: makeUri('file', '/workspace') }],
  fs: {
    async readDirectory() { return []; },
    async createDirectory() { },
    async writeFile() { },
  },
};

const env = {
  async openExternal() { return true; },
};

const vscodeStub = {
  commands,
  window,
  workspace,
  env,
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  Uri: {
    parse(value) {
      const str = String(value);
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
      return makeUri(base.scheme, nodePath.posix.join(base.path || '/', ...segments), base.query || '');
    },
  },
  DataTransferItem: class DataTransferItem {
    constructor(value) {
      this.value = value;
    }
    async asString() {
      return String(this.value || '');
    }
  },
  EventEmitter: class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() { } });
    }
    fire() { }
    dispose() { }
  },
  windowState: {},
  WorkspaceEdit: class WorkspaceEdit {
    renameFile() { }
  },
};

const providers = {
  my: {
    refresh() { },
    findNoteInCache() { return undefined; },
    getMoveFolderTargetsFromCache() {
      return [{ label: 'Dest', folderId: 'dest', folderPaths: [{ id: 'dest', name: 'Dest' }] }];
    },
  },
  team: {
    refresh() { },
    findNoteInCache() { return undefined; },
    getMoveFolderTargetsFromCache() { return []; },
    isTeamNotesCached() { return false; },
    getTeamIdFromPath() { return 't1'; },
  },
  history: {
    refresh() { },
    findNoteInCache() { return undefined; },
  },
};

const extensionModule = {
  getHistoryProvider: () => providers.history,
  getHistoryTreeView: () => ({ reveal: async () => { } }),
  getMyNotesProvider: () => providers.my,
  getMyNotesTreeView: () => ({ reveal: async () => { } }),
  getPropertiesProvider: () => null,
  getTeamNotesProvider: () => providers.team,
  getTeamNotesTreeView: () => ({ reveal: async () => { } }),
};

const mdFsProviderModule = {
  generateFolderResourceUri(name, folderId, teamPath) {
    return makeUri('hackmd', `/${name}`, `folderId=${folderId}${teamPath ? `&teamPath=${teamPath}` : ''}`);
  },
  generateResourceUri(name, noteId, teamPath) {
    return makeUri('hackmd', `/${name}`, `noteId=${noteId}${teamPath ? `&teamPath=${teamPath}` : ''}`);
  },
};

const storeModule = {
  async recordUsage(value) {
    return value;
  },
  teamNotesStore: {
    setState() { },
  },
};

const apiModule = {
  API: {
    getNoteList: async () => [],
  },
};

const EXTENSION_PATH = nodePath.resolve(__dirname, '../../out/extension.js');
const MDFS_PATH = nodePath.resolve(__dirname, '../../out/mdFsProvider.js');
const STORE_PATH = nodePath.resolve(__dirname, '../../out/store.js');
const API_PATH = nodePath.resolve(__dirname, '../../out/api.js');

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === EXTENSION_PATH) return extensionModule;
    if (resolved === MDFS_PATH) return mdFsProviderModule;
    if (resolved === STORE_PATH) return storeModule;
    if (resolved === API_PATH) return apiModule;
  } catch (_) {
    // Ignore and fallback.
  }
  return originalLoad.call(this, request, parent, isMain);
};

function resetState() {
  commandsState.executeCalls.length = 0;
  commandsState.executeResults.clear();
  window.showQuickPick = async () => undefined;
  window.showInformationMessage = async () => undefined;
  window.showWarningMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
}

module.exports = {
  registeredHandlers,
  commandsState,
  resetState,
  setExecuteResult(id, valueOrFn) {
    commandsState.executeResults.set(id, valueOrFn);
  },
};
