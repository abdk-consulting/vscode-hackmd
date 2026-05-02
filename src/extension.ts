// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import hljs from 'highlight.js/lib/core';
import { solidity } from 'highlightjs-solidity';
import * as markdownitContainer from 'markdown-it-container';
import * as S from 'string';

import { API, initializeAPIClient } from './api';
import { registerCommands } from './commands';
import { ACCESS_TOKEN_KEY } from './constants';
import { initializeHackmdModel } from './model';
import { HistoryProvider } from './providers/historyProvider';
import { activate as activateFSProvider } from './providers/mdFsProvider';
import { MyNotesProvider } from './providers/myNotesProvider';
import { NoteCompletionProvider } from './providers/noteCompletionProvider';
import { NotePropertiesProvider } from './providers/propertiesProvider';
import { TeamNotesProvider } from './providers/teamNotesProvider';
import { NoteDragAndDropController } from './utils/treeDragAndDrop';

let Prism;
let teamNotesProvider: TeamNotesProvider | undefined;
let myNotesProvider: MyNotesProvider | undefined;
let historyProvider: HistoryProvider | undefined;
let teamNotesTreeView: vscode.TreeView<any> | undefined;
let myNotesTreeView: vscode.TreeView<any> | undefined;
let historyTreeView: vscode.TreeView<any> | undefined;
let propertiesProvider: NotePropertiesProvider | undefined;

export function getTeamNotesProvider(): TeamNotesProvider | undefined {
  return teamNotesProvider;
}

export function getMyNotesProvider(): MyNotesProvider | undefined {
  return myNotesProvider;
}

export function getHistoryProvider(): HistoryProvider | undefined {
  return historyProvider;
}

export function getTeamNotesTreeView(): vscode.TreeView<any> | undefined {
  return teamNotesTreeView;
}

export function getMyNotesTreeView(): vscode.TreeView<any> | undefined {
  return myNotesTreeView;
}

export function getHistoryTreeView(): vscode.TreeView<any> | undefined {
  return historyTreeView;
}

export function getPropertiesProvider(): NotePropertiesProvider | undefined {
  return propertiesProvider;
}

function isSelectedNoteNode(node: any): boolean {
  return node?.type === 'note' && !!node.note?.id;
}

function isSelectedFolderNode(node: any): boolean {
  return node?.type === 'folder' && !!(node.id || node.folderId || node.value?.context?.folderId);
}

function getSelectedNodeTeamPath(node: any): string | null {
  if (isSelectedNoteNode(node)) {
    return (node.note?.teamPath || null);
  }
  if (isSelectedFolderNode(node)) {
    return (node.teamPath || node.value?.context?.teamPath || null);
  }
  return null;
}

function isActionableSelectionNode(node: any): boolean {
  return isSelectedNoteNode(node) || isSelectedFolderNode(node);
}

function updateTreeSelectionContexts(prefix: string, selection: readonly any[]): void {
  const hasSelection = selection.length > 0;
  const hasMixedSelection = selection.length > 1 && selection.some((node) => !isSelectedNoteNode(node));
  const hasMultiNoteSelection = selection.length > 1 && selection.every(isSelectedNoteNode);
  const hasSameScopeMultiNoteSelection = hasMultiNoteSelection && selection.every(
    (node) => (node.note?.teamPath || null) === (selection[0].note?.teamPath || null)
  );
  const hasActionableSelection = hasSelection && selection.every(isActionableSelectionNode);
  const hasSingleScopeActionableSelection = hasActionableSelection && (() => {
    const scopes = new Set<string>();
    for (const node of selection) {
      scopes.add(getSelectedNodeTeamPath(node) || '__personal__');
    }
    return scopes.size <= 1;
  })();

  void vscode.commands.executeCommand('setContext', `${prefix}.hasSelection`, hasSelection);
  void vscode.commands.executeCommand('setContext', `${prefix}.hasMixedSelection`, hasMixedSelection);
  void vscode.commands.executeCommand('setContext', `${prefix}.hasMultiNoteSelection`, hasMultiNoteSelection);
  void vscode.commands.executeCommand('setContext', `${prefix}.hasSameScopeMultiNoteSelection`, hasSameScopeMultiNoteSelection);
  void vscode.commands.executeCommand('setContext', `${prefix}.hasActionableSelection`, hasActionableSelection);
  void vscode.commands.executeCommand('setContext', `${prefix}.hasSingleScopeActionableSelection`, hasSingleScopeActionableSelection);
}

function bindTreeSelectionContexts(treeView: vscode.TreeView<any>, prefix: string, context: vscode.ExtensionContext): void {
  updateTreeSelectionContexts(prefix, treeView.selection);
  context.subscriptions.push(
    treeView.onDidChangeSelection((event) => {
      updateTreeSelectionContexts(prefix, event.selection);
    })
  );
}

if (process.env.RUNTIME !== 'browser') {
  Prism = require('prismjs');
}

if (process.env.RUNTIME !== 'browser') {
  require('prismjs/components/prism-wiki');
  require('prismjs/components/prism-haskell');
  require('prismjs/components/prism-go');
  require('prismjs/components/prism-typescript');
  require('prismjs/components/prism-jsx');
  require('prismjs/components/prism-makefile');
  require('prismjs/components/prism-gherkin');
  require('prismjs/components/prism-sas');
  require('prismjs/components/prism-javascript');
  require('prismjs/components/prism-json');
  require('prismjs/components/prism-c');
  require('prismjs/components/prism-cpp');
  require('prismjs/components/prism-java');
  require('prismjs/components/prism-csharp');
  require('prismjs/components/prism-objectivec');
  require('prismjs/components/prism-scala');
  require('prismjs/components/prism-kotlin');
  require('prismjs/components/prism-groovy');
  require('prismjs/components/prism-r');
  require('prismjs/components/prism-rust');
  require('prismjs/components/prism-yaml');
  require('prismjs/components/prism-pug');
  require('prismjs/components/prism-sass');
}

hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
hljs.registerLanguage('clojure', require('highlight.js/lib/languages/clojure'));
hljs.registerLanguage('coffeescript', require('highlight.js/lib/languages/coffeescript'));
hljs.registerLanguage('cs', require('highlight.js/lib/languages/csharp'));
hljs.registerLanguage('css', require('highlight.js/lib/languages/css'));
hljs.registerLanguage('elm', require('highlight.js/lib/languages/elm'));
hljs.registerLanguage('xml', require('highlight.js/lib/languages/xml'));
hljs.registerLanguage('handlebars', require('highlight.js/lib/languages/handlebars'));
hljs.registerLanguage('http', require('highlight.js/lib/languages/http'));
hljs.registerLanguage('ini', require('highlight.js/lib/languages/ini'));
hljs.registerLanguage('prolog', require('highlight.js/lib/languages/prolog'));
hljs.registerLanguage('python', require('highlight.js/lib/languages/python'));
hljs.registerLanguage('ruby', require('highlight.js/lib/languages/ruby'));
hljs.registerLanguage('sql', require('highlight.js/lib/languages/sql'));
hljs.registerLanguage('swift', require('highlight.js/lib/languages/swift'));
hljs.registerLanguage('diff', require('highlight.js/lib/languages/diff'));
hljs.registerLanguage('shell', require('highlight.js/lib/languages/shell'));
hljs.registerLanguage('php', require('highlight.js/lib/languages/php'));
hljs.registerLanguage('lua', require('highlight.js/lib/languages/lua'));
hljs.registerLanguage('nginx', require('highlight.js/lib/languages/nginx'));
hljs.registerLanguage('perl', require('highlight.js/lib/languages/perl'));
hljs.registerLanguage('dockerfile', require('highlight.js/lib/languages/dockerfile'));
hljs.registerLanguage('julia', require('highlight.js/lib/languages/julia'));
hljs.registerLanguage('ocaml', require('highlight.js/lib/languages/ocaml'));
hljs.registerLanguage('verilog', require('highlight.js/lib/languages/verilog'));
hljs.registerLanguage('solidity', solidity);
hljs.registerLanguage('vb', require('highlight.js/lib/languages/vbnet'));

const prismLangs = [
  'haskell',
  'go',
  'groovy',
  'typescript',
  'json',
  'jsx',
  'gherkin',
  'sas',
  'javascript',
  'c',
  'cpp',
  'java',
  'csharp',
  'objectivec',
  'scala',
  'kotlin',
  'r',
  'rust',
  'yaml',
  'pug',
  'sass',
];

function render(tokens, idx, options, env, self): string {
  tokens[idx].attrJoin('role', 'alert');
  tokens[idx].attrJoin('class', 'alert');
  tokens[idx].attrJoin('class', `alert-${tokens[idx].info.trim()}`);
  return self.renderToken(tokens, idx, options, env, self);
}

function parseFenceCodeParams(lang) {
  const attrMatch = lang.match(/{(.*)}/);
  const params = {};
  if (attrMatch && attrMatch.length >= 2) {
    const attrs = attrMatch[1];
    const paraMatch = attrs.match(/([#.](\S+?)\s)|((\S+?)\s*=\s*("(.+?)"|'(.+?)'|\[[^\]]*\]|\{[}]*\}|(\S+)))/g);

    if (paraMatch) {
      paraMatch.forEach((param) => {
        param = param.trim();
        if (param[0] === '#') {
          params['id'] = param.slice(1);
        } else if (param[0] === '.') {
          if (params['class']) {
            params['class'] = [];
          }
          params['class'] = params['class'].concat(param.slice(1));
        } else {
          const offset = param.indexOf('=');
          const id = param.substring(0, offset).trim().toLowerCase();
          let val = param.substring(offset + 1).trim();
          const valStart = val[0];
          const valEnd = val[val.length - 1];
          if (['"', "'"].indexOf(valStart) !== -1 && ['"', "'"].indexOf(valEnd) !== -1 && valStart === valEnd) {
            val = val.substring(1, val.length - 1);
          }
          if (id === 'class') {
            if (params['class']) {
              params['class'] = [];
            }
            params['class'] = params['class'].concat(val);
          } else {
            params[id] = val;
          }
        }
      });
    }
  }
  return params;
}

function highlightRender(code, lang) {
  if (!lang || /no(-?)highlight|plain|text/.test(lang)) {
    // fallback
    return highlight(code, lang);
  }
  // support adding extra attributes for fence code block
  // ex: ```graphviz {engine="neato"}
  const params = parseFenceCodeParams(lang) as Record<string, any>;
  lang = lang.split(/\s+/g)[0];
  code = S(code).escapeHTML().s;
  if (lang === 'sequence') {
    return `<span class="sequence-diagram raw">${code}</span>`;
  } else if (lang === 'flow') {
    return `<span class="flow-chart raw">${code}</span>`;
  } else if (lang === 'graphviz') {
    // support to specify layout engine of graphviz
    let dataAttrs = '';
    // eslint-disable-next-line no-prototype-builtins
    if (params.hasOwnProperty('engine')) {
      dataAttrs = ' data-engine="' + params.engine + '"';
    }
    return `<span class="graphviz raw"${dataAttrs}>${code}</span>`;
  } else if (lang === 'mermaid') {
    return `<span class="mermaid raw">${code}</span>`;
  } else if (lang === 'abc') {
    return `<span class="abc raw">${code}</span>`;
  }

  const result = {
    value: code,
  };

  if (process.env.RUNTIME !== 'browser') {
    if (prismLangs.indexOf(lang) !== -1) {
      code = S(code).unescapeHTML().s;
      result.value = Prism.highlight(code, Prism.languages[lang]);
    } else if (lang === 'tiddlywiki' || lang === 'mediawiki') {
      code = S(code).unescapeHTML().s;
      result.value = Prism.highlight(code, Prism.languages.wiki);
    } else if (lang === 'cmake') {
      code = S(code).unescapeHTML().s;
      result.value = Prism.highlight(code, Prism.languages.makefile);
    } else {
      code = S(code).unescapeHTML().s;
      const languages = hljs.listLanguages();
      if (!languages.includes(lang)) {
        result.value = hljs.highlightAuto(code).value;
      } else {
        result.value = hljs.highlight(lang, code).value;
      }
    }
  } else {
    code = S(code).unescapeHTML().s;
    const languages = hljs.listLanguages();
    if (!languages.includes(lang)) {
      result.value = hljs.highlightAuto(code).value;
    } else {
      result.value = hljs.highlight(lang, code).value;
    }
  }

  const showlinenumbers = /=$|=\d+$|=\+$/.test(lang);
  if (showlinenumbers) {
    let startnumber = 1;
    const matches = lang.match(/=(\d+)$/);
    if (matches) {
      startnumber = parseInt(matches[1]);
    }
    const lines = result.value.split('\n');
    const linenumbers = [];
    for (let i = 0; i < lines.length - 1; i++) {
      linenumbers[i] = `<span data-linenumber='${startnumber + i}'></span>`;
    }
    const continuelinenumber = /=\+$/.test(lang);
    const linegutter = `<div class='gutter linenumber${continuelinenumber ? ' continue' : ''}'>${linenumbers.join(
      '\n'
    )}</div>`;
    result.value = `<div class='wrapper'>${linegutter}<div class='code'>${result.value}</div></div>`;
  }
  return result.value;
}

let highlight;

export async function activate(context: vscode.ExtensionContext) {
  // Check if API key exists FIRST before doing anything else
  const hasApiKey = !!(await context.secrets.get(ACCESS_TOKEN_KEY));

  // Only set the 'noApiKey' flag when we're absolutely certain there's no key
  // This prevents welcome views from showing until we've confirmed absence
  if (!hasApiKey) {
    await vscode.commands.executeCommand('setContext', 'hackmd.noApiKey', true);
  }

  registerCommands(context);

  try {
    await initializeAPIClient(context);
    if (API) {
      initializeHackmdModel(API);
    }
  } catch (error) {
    vscode.window.showErrorMessage('Failed to initialize HackMD API client. Please check your configuration.');
  }

  // Use TreeDataProvider for all views for consistency
  const dragAndDropController = new NoteDragAndDropController(true);
  const noDropDragAndDropController = new NoteDragAndDropController(false);

  myNotesProvider = new MyNotesProvider(context.extensionPath);
  myNotesTreeView = vscode.window.createTreeView('hackmd.tree.my-notes', {
    canSelectMany: true,
    treeDataProvider: myNotesProvider,
    dragAndDropController,
  });
  context.subscriptions.push(myNotesTreeView);
  bindTreeSelectionContexts(myNotesTreeView, 'hackmd.myNotesSelection', context);

  historyProvider = new HistoryProvider(context.extensionPath);
  historyTreeView = vscode.window.createTreeView('hackmd.tree.recent-notes', {
    canSelectMany: true,
    treeDataProvider: historyProvider,
    dragAndDropController: noDropDragAndDropController,
  });
  context.subscriptions.push(historyTreeView);
  bindTreeSelectionContexts(historyTreeView, 'hackmd.historySelection', context);

  teamNotesProvider = new TeamNotesProvider(context.extensionPath);
  teamNotesTreeView = vscode.window.createTreeView('hackmd.tree.team-notes', {
    canSelectMany: true,
    treeDataProvider: teamNotesProvider,
    dragAndDropController,
  });
  context.subscriptions.push(teamNotesTreeView);
  bindTreeSelectionContexts(teamNotesTreeView, 'hackmd.teamNotesSelection', context);

  // Register properties webview provider
  propertiesProvider = new NotePropertiesProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NotePropertiesProvider.viewType,
      propertiesProvider
    )
  );

  activateFSProvider(context);

  // Register note-link completion provider for hackmd:// documents.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'hackmd' },
      new NoteCompletionProvider(),
      '[', // trigger character
    )
  );

  return {
    extendMarkdownIt(md: any) {
      md.use(require('markdown-it-abbr'));
      md.use(require('markdown-it-deflist'));
      md.use(require('markdown-it-mark'));
      md.use(require('markdown-it-ins'));
      md.use(require('markdown-it-sub'));
      md.use(require('markdown-it-sup'));

      md.use(require('markdown-it-table-of-contents'), {
        markerPattern: /^\[toc\]/im,
      });

      md.use(
        require('markdown-it-mathjax')({
          beforeMath: '<span class="mathjax raw">',
          afterMath: '</span>',
          beforeInlineMath: '<span class="mathjax raw">',
          afterInlineMath: '</span>',
          beforeDisplayMath: '<span class="mathjax raw display">',
          afterDisplayMath: '</span>',
        })
      );

      md.use(markdownitContainer, 'success', { render });
      md.use(markdownitContainer, 'info', { render });
      md.use(markdownitContainer, 'warning', { render });
      md.use(markdownitContainer, 'danger', { render });
      md.use(markdownitContainer, 'spoiler', {
        validate: function (params) {
          return params.trim().match(/^spoiler\s+(.*)$/);
        },
        render: function (tokens, idx) {
          const m = tokens[idx].info.trim().match(/^spoiler\s+(.*)$/);

          if (tokens[idx].nesting === 1) {
            // opening tag
            return '<details><summary>' + md.utils.escapeHtml(m[1]) + '</summary>\n';
          } else {
            // closing tag
            return '</details>\n';
          }
        },
      });

      md.options.linkify = true;
      md.options.typographer = true;
      highlight = md.options.highlight;
      md.options.highlight = highlightRender;

      return md;
    },
    context,
  };
}

// this method is called when your extension is deactivated
export function deactivate() {
  // noop
}
