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

const clipboardCalls = [];

const window = {
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  setStatusBarMessage: () => ({ dispose() { } }),
};

const env = {
  clipboard: {
    async writeText(text) {
      clipboardCalls.push(text);
    },
  },
};

const vscodeStub = {
  window,
  env,
  Uri: {
    from(parts) {
      return makeUri(parts.scheme || '', parts.path || '', parts.query || '');
    },
    joinPath(base, ...segments) {
      const joined = nodePath.posix.join(base.path || '/', ...segments);
      return makeUri(base.scheme, joined, base.query || '');
    },
  },
};

let _model = null;

const modelModule = {
  getHackmdModel() {
    if (!_model) {
      throw new Error('HackmdModel not initialized');
    }
    return _model;
  },
};

const MODEL_INDEX_PATH = nodePath.resolve(__dirname, '../../out/model/index.js');

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === MODEL_INDEX_PATH) {
      return modelModule;
    }
  } catch (_) {
    // Ignore resolution errors and use original loader.
  }
  return originalLoad.call(this, request, parent, isMain);
};

function resetState() {
  window.showWarningMessage = async () => undefined;
  window.showErrorMessage = async () => undefined;
  window.setStatusBarMessage = () => ({ dispose() { } });
  clipboardCalls.length = 0;
  _model = null;
}

module.exports = {
  vscodeStub,
  window,
  env,
  clipboardCalls,
  setModel(mock) { _model = mock; },
  clearModel() { _model = null; },
  resetState,
  makeUri,
};
