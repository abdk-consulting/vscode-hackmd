const Module = require('module');

const originalLoad = Module._load;

const vscodeStub = {
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  Uri: {
    from(parts) {
      const scheme = parts.scheme || '';
      const path = parts.path || '';
      const query = parts.query || '';
      const fragment = parts.fragment || '';
      return {
        scheme,
        path,
        query,
        fragment,
        toString() {
          const q = query ? `?${query}` : '';
          const f = fragment ? `#${fragment}` : '';
          return `${scheme}:${path}${q}${f}`;
        },
      };
    },
    parse(value) {
      const [schemePart, restPart = ''] = String(value).split(':');
      const [pathAndQuery, fragment = ''] = restPart.split('#');
      const [path = '', query = ''] = pathAndQuery.split('?');
      return {
        scheme: schemePart,
        path,
        query,
        fragment,
        toString() {
          const q = query ? `?${query}` : '';
          const f = fragment ? `#${fragment}` : '';
          return `${schemePart}:${path}${q}${f}`;
        },
      };
    },
  },
  MarkdownString: class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  },
  Disposable: class Disposable {
    constructor(fn) {
      this._fn = fn;
    }

    dispose() {
      if (this._fn) {
        this._fn();
      }
    }
  },
  EventEmitter: class EventEmitter {
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
  },
  window: {
    createStatusBarItem() {
      return {
        text: '',
        tooltip: undefined,
        command: undefined,
        show() { },
        hide() { },
      };
    },
    showWarningMessage() {
      return Promise.resolve(undefined);
    },
    showErrorMessage() {
      return Promise.resolve(undefined);
    },
    showInformationMessage() {
      return Promise.resolve(undefined);
    },
  },
  env: {
    openExternal() {
      return Promise.resolve(true);
    },
  },
  commands: {
    executeCommand() {
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get() {
          return undefined;
        },
      };
    },
    onDidChangeConfiguration() {
      return {
        dispose() { },
      };
    },
    onDidChangeTextDocument() {
      return {
        dispose() { },
      };
    },
  },
  extensions: {
    getExtension() {
      return {
        exports: {
          context: {},
        },
      };
    },
  },
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};
