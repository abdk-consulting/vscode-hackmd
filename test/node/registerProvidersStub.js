'use strict';

const Module = require('module');
const nodePath = require('path');

const originalLoad = Module._load;

let currentModel = null;

function setMockModel(model) {
  currentModel = model;
}

function resetMockModel() {
  currentModel = null;
}

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
  }

  fire(payload) {
    for (const listener of [...this._listeners]) {
      listener(payload);
    }
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const vscodeStub = {
  ThemeIcon,
  TreeItem,
  EventEmitter,
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
};

const OUT_MODEL_INDEX = nodePath.resolve(__dirname, '../../out/model/index.js');

const modelModule = {
  getHackmdModel() {
    if (!currentModel) {
      throw new Error('Model not initialized');
    }
    return currentModel;
  },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }

  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === OUT_MODEL_INDEX) {
      return modelModule;
    }
  } catch (_) {
    // Ignore and fall back.
  }

  return originalLoad.call(this, request, parent, isMain);
};

module.exports = {
  setMockModel,
  resetMockModel,
};
