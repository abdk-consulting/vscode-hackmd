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

function fsError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

const textDocumentListeners = new Set();

const window = {
  showErrorMessage: async () => undefined,
};

const workspaceState = {
  registerFsCalls: [],
};

const workspace = {
  onDidChangeTextDocument(listener) {
    textDocumentListeners.add(listener);
    return {
      dispose() {
        textDocumentListeners.delete(listener);
      },
    };
  },
  registerFileSystemProvider(scheme, provider, options) {
    workspaceState.registerFsCalls.push([scheme, provider, options]);
    return { dispose() { } };
  },
};

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return {
        dispose: () => this._listeners.delete(listener),
      };
    };
  }

  fire(payload) {
    for (const listener of [...this._listeners]) {
      listener(payload);
    }
  }
}

const vscodeStub = {
  window,
  workspace,
  EventEmitter,
  Disposable: class {
    constructor(fn) {
      this._fn = fn;
    }
    dispose() {
      if (this._fn) {
        this._fn();
      }
    }
  },
  FileType: {
    File: 1,
    Directory: 2,
  },
  FilePermission: {
    Readonly: 1,
  },
  FileChangeType: {
    Changed: 1,
    Created: 2,
    Deleted: 3,
  },
  FileSystemError: {
    FileNotFound: (message) => fsError('FileNotFound', message),
    NoPermissions: (message) => fsError('NoPermissions', message),
    Unavailable: (message) => fsError('Unavailable', message),
  },
  Uri: {
    from(parts) {
      return makeUri(parts.scheme || '', parts.path || '', parts.query || '', undefined);
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
  },
};

let _model = null;
let _myNotesProvider = null;
let _teamNotesProvider = null;
let _historyProvider = null;

const modelModule = {
  getHackmdModel() {
    if (!_model) {
      throw new Error('HackmdModel not initialized');
    }
    return _model;
  },
};

const extensionModule = {
  getMyNotesProvider() {
    return _myNotesProvider;
  },
  getTeamNotesProvider() {
    return _teamNotesProvider;
  },
  getHistoryProvider() {
    return _historyProvider;
  },
};

const MODEL_INDEX_PATH = nodePath.resolve(__dirname, '../../out/model/index.js');
const EXTENSION_PATH = nodePath.resolve(__dirname, '../../out/extension.js');

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
    // no-op
  }
  return originalLoad.call(this, request, parent, isMain);
};

function createPendingProvider() {
  return {
    setPendingCalls: [],
    clearPendingCalls: [],
    setPendingNote(noteId) {
      this.setPendingCalls.push(noteId);
    },
    clearPendingNote(noteId) {
      this.clearPendingCalls.push(noteId);
    },
  };
}

function resetState() {
  workspaceState.registerFsCalls.length = 0;
  textDocumentListeners.clear();
  _model = null;
  _myNotesProvider = null;
  _teamNotesProvider = null;
  _historyProvider = null;
}

function fireTextDocumentChange(event) {
  for (const listener of [...textDocumentListeners]) {
    listener(event);
  }
}

module.exports = {
  vscodeStub,
  workspaceState,
  makeUri,
  createPendingProvider,
  setModel(model) {
    _model = model;
  },
  clearModel() {
    _model = null;
  },
  setProviders({ myNotesProvider, teamNotesProvider, historyProvider }) {
    _myNotesProvider = myNotesProvider || null;
    _teamNotesProvider = teamNotesProvider || null;
    _historyProvider = historyProvider || null;
  },
  fireTextDocumentChange,
  resetState,
};
