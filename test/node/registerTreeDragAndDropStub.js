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
      if (source) {
        return source;
      }
      if (scheme === 'file') {
        return `file://${path}`;
      }
      return `${scheme}:${path}${query ? `?${query}` : ''}`;
    },
  };
}

class DataTransferItem {
  constructor(value) {
    this.value = value;
  }

  async asString() {
    return String(this.value || '');
  }
}

class DataTransfer {
  constructor() {
    this._items = new Map();
  }

  get(type) {
    return this._items.get(type);
  }

  set(type, value) {
    this._items.set(type, value);
  }
}

const commandsState = {
  executeCalls: [],
};

const windowState = {
  warningMessages: [],
  closedTabs: [],
};

const providers = {
  my: null,
  team: null,
  history: null,
};

let currentModel = null;

const commands = {
  async executeCommand(id, ...args) {
    commandsState.executeCalls.push([id, ...args]);
    return undefined;
  },
};

const window = {
  tabGroups: {
    all: [],
    async close(tabs) {
      windowState.closedTabs.push(tabs);
      return true;
    },
  },
  async showWarningMessage(message) {
    windowState.warningMessages.push(message);
    return undefined;
  },
};

const vscodeStub = {
  commands,
  window,
  DataTransfer,
  DataTransferItem,
  Uri: {
    parse(value) {
      const str = String(value);
      if (str.startsWith('file://')) {
        return makeUri('file', str.slice('file://'.length), '', str);
      }

      const colonIdx = str.indexOf(':');
      const scheme = colonIdx >= 0 ? str.slice(0, colonIdx) : '';
      const rest = colonIdx >= 0 ? str.slice(colonIdx + 1) : str;
      const qIdx = rest.indexOf('?');
      const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
      const query = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
      return makeUri(scheme, path, query, str);
    },
  },
};

const modelModule = {
  getHackmdModel() {
    if (!currentModel) {
      throw new Error('HackmdModel not initialized');
    }
    return currentModel;
  },
};

const extensionModule = {
  getMyNotesProvider() {
    return providers.my;
  },
  getTeamNotesProvider() {
    return providers.team;
  },
  getHistoryProvider() {
    return providers.history;
  },
};

const OUT_MODEL_INDEX = nodePath.resolve(__dirname, '../../out/model/index.js');
const OUT_EXTENSION = nodePath.resolve(__dirname, '../../out/extension.js');

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === OUT_MODEL_INDEX) {
      return modelModule;
    }
    if (resolved === OUT_EXTENSION) {
      return extensionModule;
    }
  } catch (_) {
    // Ignore and fall back.
  }

  return originalLoad.call(this, request, parent, isMain);
};

function resetState() {
  commandsState.executeCalls.length = 0;
  windowState.warningMessages.length = 0;
  windowState.closedTabs.length = 0;
  window.tabGroups.all = [];
  currentModel = null;
  providers.my = null;
  providers.team = null;
  providers.history = null;
}

module.exports = {
  vscodeStub,
  commandsState,
  windowState,
  makeUri,
  resetState,
  setModel(model) {
    currentModel = model;
  },
  setProviders(nextProviders) {
    providers.my = nextProviders.my || null;
    providers.team = nextProviders.team || null;
    providers.history = nextProviders.history || null;
  },
};