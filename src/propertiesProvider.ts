import { Note, NotePublishType } from '@hackmd/api/dist/type';
import * as vscode from 'vscode';
import { API } from './api';
import { recordUsage } from './store';

interface NoteProperties {
  publishType?: NotePublishType;
  permalink: string | null;
  readPermission: string;
  writePermission: string;
}

export class NotePropertiesProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'hackmd.properties';

  private _view?: vscode.WebviewView;
  private _currentNote?: Note;
  private _currentNoteId?: string;
  private _currentTeamPath?: string | null;
  private _pendingChanges: Partial<NoteProperties> = {};

  private _getNoteIdFromFragment(fragment: string): string {
    if (!fragment) {
      return '';
    }
    const questionIndex = fragment.indexOf('?');
    if (questionIndex >= 0) {
      return fragment.slice(0, questionIndex);
    }
    const encodedQuestionIndex = fragment.toLowerCase().indexOf('%3f');
    if (encodedQuestionIndex >= 0) {
      return fragment.slice(0, encodedQuestionIndex);
    }
    return fragment;
  }

  constructor(private readonly _extensionUri: vscode.Uri) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'propertyChanged':
          this._onPropertyChanged(data.property, data.value);
          break;
        case 'ready':
          // Webview is ready, send current state
          if (this._currentNote) {
            this._fullRenderWebview();
          }
          break;
      }
    });

    // Update if we already have a note
    if (this._currentNote) {
      this._fullRenderWebview();
    } else {
      // Check if there's an active editor with a HackMD note and fetch it
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'hackmd') {
        const noteId = this._getNoteIdFromFragment(editor.document.uri.fragment);
        const teamPath = editor.document.uri.query
          ? new URLSearchParams(editor.document.uri.query).get('teamPath')
          : null;

        if (noteId) {
          // Fetch the note and update the webview
          recordUsage(API.getNote(noteId, { unwrapData: false }))
            .then(note => {
              this.updateNote(note, noteId, teamPath);
            })
            .catch(err => {
              console.error('Failed to fetch note for properties view:', err);
            });
        }
      }
    }
  }

  public updateNote(note: Note | undefined, noteId?: string, teamPath?: string | null) {
    this._currentNote = note;
    this._currentNoteId = noteId;
    this._currentTeamPath = teamPath;
    this._pendingChanges = {};
    this._fullRenderWebview();
  }

  /**
   * Updates the current note data without clearing pending property changes or
   * re-rendering the inputs. Used by readFile to refresh note metadata while
   * the user may be actively editing properties.
   */
  public updateNotePreservingChanges(note: Note, noteId: string, teamPath?: string | null) {
    if (this._currentNoteId !== noteId) {
      // Different note — do a full update
      this.updateNote(note, noteId, teamPath);
      return;
    }
    // Same note: refresh cached data but keep pending edits intact
    this._currentNote = note;
    this._currentTeamPath = teamPath;
    // Do NOT clear _pendingChanges or call _fullRenderWebview
  }

  public getPendingChanges(): Partial<NoteProperties> {
    return this._pendingChanges;
  }

  public clearPendingChanges() {
    this._pendingChanges = {};
  }

  public hasPendingChanges(): boolean {
    return Object.keys(this._pendingChanges).length > 0;
  }

  private _onPropertyChanged(property: string, value: any) {
    if (!this._currentNote) {
      return;
    }

    // Store the pending change
    this._pendingChanges[property as keyof NoteProperties] = value;

    // Make the editor dirty by applying a minimal edit
    this._makeEditorDirty();

    // Update the badge to show unsaved changes
    this._updateWebview();
  }

  private async _makeEditorDirty() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'hackmd' && !editor.document.isDirty) {
      // Insert an invisible zero-width space to mark the document as dirty.
      // writeFile strips this character before saving to the API.
      const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
      const endPos = lastLine.range.end;
      await editor.edit((editBuilder) => {
        editBuilder.insert(endPos, '\u200B');
      });
    }
  }

  public getCurrentNoteId(): string | undefined {
    return this._currentNoteId;
  }

  public getCurrentTeamPath(): string | null | undefined {
    return this._currentTeamPath;
  }

  private _updateWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updatePendingChanges',
        pendingChanges: this._pendingChanges
      });
    }
  }

  private _fullRenderWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'update',
        note: this._currentNote,
        pendingChanges: this._pendingChanges
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Note Properties</title>
  <style>
    body {
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .empty-state {
      padding: 20px 0;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .property-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    input, select {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      box-sizing: border-box;
    }
    input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    input.modified, select.modified {
      border-color: var(--vscode-inputValidation-warningBorder);
      background: var(--vscode-inputValidation-warningBackground);
    }
    .info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      font-style: italic;
    }
    .modified-indicator {
      display: inline-block;
      margin-left: 4px;
      color: var(--vscode-inputValidation-warningBorder);
      font-size: 10px;
    }
    .note-info {
      padding: 6px 8px;
      margin-bottom: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 2px solid var(--vscode-textBlockQuote-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="content">
    <div class="empty-state">
      <p>No note open</p>
      <p style="font-size: 11px;">Open a HackMD note to edit its properties</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentNote = null;
    let pendingChanges = {};

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'update':
          currentNote = message.note;
          pendingChanges = message.pendingChanges || {};
          render();
          break;
        case 'updatePendingChanges':
          pendingChanges = message.pendingChanges || {};
          updateModifiedIndicators();
          break;
      }
    });

    function onPropertyChange(property, value) {
      vscode.postMessage({
        type: 'propertyChanged',
        property: property,
        value: value
      });
    }

    function updateModifiedIndicators() {
      // Update modified indicators and warning message without re-rendering inputs
      const hasPending = Object.keys(pendingChanges).length > 0;
      
      // Update warning message
      const existingWarning = document.querySelector('.pending-warning');
      if (hasPending && !existingWarning) {
        const noteInfo = document.querySelector('.note-info');
        if (noteInfo) {
          const warning = document.createElement('div');
          warning.className = 'info pending-warning';
          warning.style.marginBottom = '12px';
          warning.style.color = 'var(--vscode-inputValidation-warningBorder)';
          warning.textContent = '⚠ Changes will be saved when you save the note';
          noteInfo.insertAdjacentElement('afterend', warning);
        }
      } else if (!hasPending && existingWarning) {
        existingWarning.remove();
      }
      
      // Update each property's modified state
      ['publishType', 'permalink', 'readPermission', 'writePermission'].forEach(property => {
        const element = document.getElementById(property);
        const label = element?.parentElement?.querySelector('label');
        
        if (element && label) {
          const isModified = pendingChanges[property] !== undefined;
          
          // Update CSS class
          if (isModified) {
            element.classList.add('modified');
          } else {
            element.classList.remove('modified');
          }
          
          // Update indicator dot
          let indicator = label.querySelector('.modified-indicator');
          if (isModified && !indicator) {
            indicator = document.createElement('span');
            indicator.className = 'modified-indicator';
            indicator.textContent = '●';
            label.appendChild(indicator);
          } else if (!isModified && indicator) {
            indicator.remove();
          }
        }
      });
    }

    function render() {
      const content = document.getElementById('content');
      
      if (!currentNote) {
        content.innerHTML = \`
          <div class="empty-state">
            <p>No note open</p>
            <p style="font-size: 11px;">Open a HackMD note to edit its properties</p>
          </div>
        \`;
        return;
      }

      const hasPending = Object.keys(pendingChanges).length > 0;
      const publishTypeValue = pendingChanges.publishType !== undefined ? pendingChanges.publishType : currentNote.publishType;
      const permalinkValue = pendingChanges.permalink !== undefined ? pendingChanges.permalink : (currentNote.permalink || '');
      const readPermValue = pendingChanges.readPermission !== undefined ? pendingChanges.readPermission : currentNote.readPermission;
      const writePermValue = pendingChanges.writePermission !== undefined ? pendingChanges.writePermission : currentNote.writePermission;

      content.innerHTML = \`
        <div class="note-info">
          Editing note: \${escapeHtml(currentNote.shortId)}
        </div>

        <div class="property-group">
          <label>
            Publish Type
          </label>
          <select 
            id="publishType"
          >
            <option value="edit" \${publishTypeValue === 'edit' ? 'selected' : ''}>Edit (default editor view)</option>
            <option value="view" \${publishTypeValue === 'view' ? 'selected' : ''}>View (published view)</option>
            <option value="slide" \${publishTypeValue === 'slide' ? 'selected' : ''}>Slide (presentation mode)</option>
            <option value="book" \${publishTypeValue === 'book' ? 'selected' : ''}>Book (book mode)</option>
          </select>
          <div class="info">How your note is published</div>
        </div>

        <div class="property-group">
          <label>
            Permalink
          </label>
          <input 
            type="text" 
            id="permalink"
            value="\${escapeHtml(permalinkValue)}"
            placeholder="custom-note-url"
          />
          <div class="info">Custom URL slug for your note</div>
        </div>

        <div class="property-group">
          <label>
            Read Permission
          </label>
          <select 
            id="readPermission"
          >
            <option value="owner" \${readPermValue === 'owner' ? 'selected' : ''}>Owner</option>
            <option value="signed_in" \${readPermValue === 'signed_in' ? 'selected' : ''}>Signed-in users</option>
            <option value="guest" \${readPermValue === 'guest' ? 'selected' : ''}>Guest (anyone with link)</option>
          </select>
          <div class="info">Who can view this note</div>
        </div>

        <div class="property-group">
          <label>
            Write Permission
          </label>
          <select 
            id="writePermission"
          >
            <option value="owner" \${writePermValue === 'owner' ? 'selected' : ''}>Owner</option>
            <option value="signed_in" \${writePermValue === 'signed_in' ? 'selected' : ''}>Signed-in users</option>
            <option value="guest" \${writePermValue === 'guest' ? 'selected' : ''}>Guest (anyone with link)</option>
          </select>
          <div class="info">Who can edit this note</div>
        </div>
      \`;

      // Attach event listeners
      document.getElementById('publishType').addEventListener('change', (e) => {
        onPropertyChange('publishType', e.target.value);
      });

      document.getElementById('permalink').addEventListener('input', (e) => {
        onPropertyChange('permalink', e.target.value || null);
      });

      document.getElementById('readPermission').addEventListener('change', (e) => {
        onPropertyChange('readPermission', e.target.value);
      });

      document.getElementById('writePermission').addEventListener('change', (e) => {
        onPropertyChange('writePermission', e.target.value);
      });
      
      // Update modified indicators after initial render
      updateModifiedIndicators();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Initial render
    render();
    
    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
