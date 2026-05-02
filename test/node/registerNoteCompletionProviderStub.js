'use strict';

/**
 * Module._load stub for noteCompletionProvider tests.
 *
 * Intercepts:
 *   - require('vscode')         → lightweight vscode stub
 *   - require('…/model/index')  → controllable model mock
 *
 * src/commands/pickers.ts is compiled and loaded as real code because
 * collectNotes is a pure function that does not need any vscode symbols.
 */

const Module = require('module');
const nodePath = require('path');

const originalLoad = Module._load;

// ── vscode stub ───────────────────────────────────────────────────────────────

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
    this.detail = undefined;
    this.filterText = undefined;
    this.insertText = undefined;
    this.range = undefined;
    this.sortText = undefined;
    this.documentation = undefined;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

const vscodeStub = {
  CompletionItem,
  CompletionItemKind: {
    Reference: 9,
  },
  Range,
  MarkdownString,
};

// ── model stub ────────────────────────────────────────────────────────────────

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

// ── Module._load patch ────────────────────────────────────────────────────────

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
    // Ignore resolution errors and fall through to the original loader.
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ── State helpers ─────────────────────────────────────────────────────────────

function resetState() {
  _model = null;
}

module.exports = {
  vscodeStub,
  CompletionItem,
  Range,
  MarkdownString,
  setModel(mock) {
    _model = mock;
  },
  clearModel() {
    _model = null;
  },
  resetState,
};
