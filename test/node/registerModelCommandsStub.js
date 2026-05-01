/**
 * Module-load interceptor for modelCommands tests.
 *
 * Patches Module._load so that:
 *  - require('vscode')            → a controllable vscode stub
 *  - require('…/model/index.js') → a lightweight model-module mock
 *
 * The stub objects are mutable; individual tests replace methods on
 * `window` (showQuickPick, showInputBox, showWarningMessage) before
 * each invocation.
 */
'use strict';

const Module = require('module');
const path = require('path');

const originalLoad = Module._load;

// ---------------------------------------------------------------------------
// VS Code window — mutated per test via the Interactions helper
// ---------------------------------------------------------------------------
const window = {
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
};

// ---------------------------------------------------------------------------
// VS Code commands — registerCommand stores handlers so tests can invoke them
// ---------------------------------------------------------------------------
const registeredHandlers = new Map();

const commands = {
  registerCommand(id, handler) {
    registeredHandlers.set(id, handler);
    return { dispose() { registeredHandlers.delete(id); } };
  },
  executeCommand: async () => undefined,
};

// ---------------------------------------------------------------------------
// Model singleton — replaced per test via setModel()
// ---------------------------------------------------------------------------
let _currentModel = null;

const modelModule = {
  getHackmdModel() {
    if (!_currentModel) {
      throw new Error('HackmdModel not initialized');
    }
    return _currentModel;
  },
};

// ---------------------------------------------------------------------------
// Full vscode stub
// ---------------------------------------------------------------------------
const vscodeStub = {
  Uri: {
    from(parts) {
      const scheme = parts.scheme || '';
      const p = parts.path || '';
      const query = parts.query || '';
      return {
        scheme, path: p, query,
        toString() { return `${scheme}:${p}${query ? '?' + query : ''}`; },
      };
    },
    parse(value) {
      const str = String(value);
      const colonIdx = str.indexOf(':');
      const scheme = colonIdx >= 0 ? str.slice(0, colonIdx) : '';
      const rest = colonIdx >= 0 ? str.slice(colonIdx + 1) : str;
      const qIdx = rest.indexOf('?');
      const p = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
      const query = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
      return {
        scheme, path: p, query,
        toString() { return str; },
      };
    },
  },
  window,
  commands,
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() { } }),
    onDidChangeTextDocument: () => ({ dispose() { } }),
  },
  EventEmitter: class {
    constructor() {
      this._listeners = [];
      this.event = (l) => { this._listeners.push(l); return { dispose: () => { } }; };
    }
    fire(payload) { this._listeners.forEach((l) => l(payload)); }
  },
  Disposable: class {
    constructor(fn) { this._fn = fn; }
    dispose() { if (this._fn) this._fn(); }
  },
  MarkdownString: class { constructor(v) { this.value = v; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
};

// ---------------------------------------------------------------------------
// Module._load interception
// ---------------------------------------------------------------------------
const MODEL_INDEX_PATH = path.resolve(__dirname, '../../out/model/index.js');

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
    // unresolvable — fall through to original
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Public API for test files
// ---------------------------------------------------------------------------
module.exports = {
  /** The shared vscode stub (window / commands / etc.) */
  vscodeStub,
  /** The window sub-object — tests replace its methods */
  window,
  /** Map of commandId → registered handler */
  registeredHandlers,
  /** Replace the mock model returned by getHackmdModel() */
  setModel(mock) { _currentModel = mock; },
  /** Cause getHackmdModel() to throw (simulates uninitialized state) */
  clearModel() { _currentModel = null; },
};
