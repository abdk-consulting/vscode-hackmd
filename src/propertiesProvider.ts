import { Note, NotePublishType } from '@hackmd/api/dist/type';
import * as vscode from 'vscode';
import { API } from './api';
import { getHistoryProvider, getMyNotesProvider, getTeamNotesProvider } from './extension';
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
  private _isSaving = false;

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
        case 'save':
          void this.saveCurrentProperties();
          break;
        case 'cancel':
          void this.cancelEditing();
          break;
        case 'copyShareUrl':
          if (typeof data.url === 'string' && data.url.length > 0) {
            void vscode.env.clipboard.writeText(data.url);
            vscode.window.setStatusBarMessage('HackMD share URL copied', 1500);
          }
          break;
        case 'ready':
          this._fullRenderWebview();
          break;
      }
    });

    this._fullRenderWebview();
  }

  public async openNote(note: Note, noteId: string, teamPath?: string | null): Promise<boolean> {
    if (this._currentNoteId && this._currentNoteId !== noteId && this.hasPendingChanges()) {
      const selection = await vscode.window.showWarningMessage(
        'You have unsaved property changes. What would you like to do?',
        { modal: true },
        'Save',
        'Discard'
      );

      if (selection === 'Save') {
        const saved = await this.saveCurrentProperties();
        if (!saved) {
          return false;
        }
      } else if (selection === 'Discard') {
        this.reset();
      } else {
        return false;
      }
    }

    this._currentNote = note;
    this._currentNoteId = noteId;
    this._currentTeamPath = teamPath;
    this._pendingChanges = {};
    this._isSaving = false;
    this._fullRenderWebview();
    return true;
  }

  public async cancelEditing(): Promise<boolean> {
    if (!this.hasPendingChanges()) {
      this.reset();
      return true;
    }

    const selection = await vscode.window.showWarningMessage(
      'You have unsaved property changes. What would you like to do?',
      { modal: true },
      'Save',
      'Discard'
    );

    if (selection === 'Save') {
      return this.saveCurrentProperties();
    }

    if (selection === 'Discard') {
      this.reset();
      return true;
    }

    return false;
  }

  public updateCurrentNote(noteId: string, updatedNote: Note): void {
    if (this._currentNoteId === noteId && this._currentNote) {
      this._currentNote = updatedNote;
      this._fullRenderWebview();
    }
  }

  public hasPendingChanges(): boolean {
    return Object.keys(this._pendingChanges).length > 0;
  }

  private reset() {
    this._currentNote = undefined;
    this._currentNoteId = undefined;
    this._currentTeamPath = undefined;
    this._pendingChanges = {};
    this._isSaving = false;
    this._fullRenderWebview();
  }

  private getMergedProperties(): NoteProperties | undefined {
    if (!this._currentNote) {
      return undefined;
    }
    return {
      permalink: this._pendingChanges.permalink !== undefined ? this._pendingChanges.permalink : (this._currentNote.permalink || ''),
      readPermission: this._pendingChanges.readPermission !== undefined ? this._pendingChanges.readPermission : this._currentNote.readPermission,
      writePermission: this._pendingChanges.writePermission !== undefined ? this._pendingChanges.writePermission : this._currentNote.writePermission,
      publishType: this._pendingChanges.publishType !== undefined ? this._pendingChanges.publishType : this._currentNote.publishType,
    };
  }

  private isValidPermalink(value: string | null | undefined): boolean {
    if (!value) {
      return false;
    }
    return /^[A-Za-z0-9_-]+$/.test(value);
  }

  private _normalizePermissions(changedProperty: keyof NoteProperties, changedValue: any): Partial<NoteProperties> {
    const rank: Record<string, number> = {
      owner: 0,
      signed_in: 1,
      guest: 2,
    };

    const merged = this.getMergedProperties();
    if (!merged) {
      return {};
    }

    let readPermission = merged.readPermission;
    let writePermission = merged.writePermission;

    if (changedProperty === 'readPermission') {
      readPermission = changedValue;
    } else if (changedProperty === 'writePermission') {
      writePermission = changedValue;
    }

    // readPermission cannot be more restrictive than writePermission.
    if (rank[readPermission] < rank[writePermission]) {
      if (changedProperty === 'readPermission') {
        writePermission = readPermission;
      } else if (changedProperty === 'writePermission') {
        readPermission = writePermission;
      }
    }

    return {
      readPermission,
      writePermission,
    };
  }

  public async saveCurrentProperties(): Promise<boolean> {
    if (!this._currentNote || !this._currentNoteId || this._isSaving) {
      return false;
    }

    const merged = this.getMergedProperties();
    if (!merged) {
      return false;
    }
    if ('permalink' in this._pendingChanges && !this.isValidPermalink(this._pendingChanges.permalink)) {
      vscode.window.showErrorMessage('Permalink must be non-empty and contain only letters, numbers, hyphens, or underscores.');
      this._fullRenderWebview();
      return false;
    }

    this._isSaving = true;
    this._fullRenderWebview();

    const noteId = this._currentNoteId;
    const teamPath = this._currentTeamPath;
    const myNotesProvider = getMyNotesProvider();
    const teamNotesProvider = getTeamNotesProvider();
    const historyProvider = getHistoryProvider();

    if (teamPath) {
      teamNotesProvider?.setPendingNote(noteId, this._currentNote);
    } else {
      myNotesProvider?.setPendingNote(noteId, this._currentNote);
    }
    historyProvider?.setPendingNote(noteId, this._currentNote);

    try {
      const payload: Record<string, any> = {
        readPermission: merged.readPermission,
        writePermission: merged.writePermission,
      };
      if ('permalink' in this._pendingChanges) {
        payload.permalink = merged.permalink;
      }

      if (teamPath) {
        await recordUsage(API.updateTeamNote(teamPath, noteId, payload as any));
      } else {
        await recordUsage(API.updateNote(noteId, payload as any, { unwrapData: false }));
      }

      const updatedNote = { ...this._currentNote, ...payload } as Note;

      if (teamPath) {
        teamNotesProvider?.updateNoteInCache(noteId, updatedNote, teamPath);
      } else {
        myNotesProvider?.updateNoteInCache(noteId, updatedNote);
      }
      historyProvider?.updateNoteInCache(noteId, updatedNote);

      this.reset();
      return true;
    } catch (error: any) {
      const code = error?.response?.status ?? error?.code;
      let message: string;
      if (code === 403) {
        message = 'You do not have permission to edit this note\'s properties.';
      } else if (code === 409) {
        message = 'That permalink is already in use. Please choose a different one.';
      } else if (code === 400) {
        message = 'Invalid permalink. Use only letters, numbers, hyphens, and underscores.';
      } else {
        message = `Failed to save note properties: ${error.message || 'Unknown error'}`;
      }
      vscode.window.showErrorMessage(message);
      this._isSaving = false;
      this._fullRenderWebview();
      return false;
    } finally {
      if (teamPath) {
        teamNotesProvider?.clearPendingNote(noteId, this._currentNote);
      } else {
        myNotesProvider?.clearPendingNote(noteId, this._currentNote);
      }
      historyProvider?.clearPendingNote(noteId, this._currentNote);
    }
  }

  private _onPropertyChanged(property: string, value: any) {
    if (!this._currentNote) {
      return;
    }

    const key = property as keyof NoteProperties;

    if (key === 'readPermission' || key === 'writePermission') {
      const normalized = this._normalizePermissions(key, value);

      (['readPermission', 'writePermission'] as const).forEach((permissionKey) => {
        const nextValue = normalized[permissionKey];
        const originalValue = (this._currentNote as any)[permissionKey] ?? '';

        if (nextValue === originalValue) {
          delete this._pendingChanges[permissionKey];
        } else {
          this._pendingChanges[permissionKey] = nextValue;
        }
      });
    } else {
      const originalValue = (this._currentNote as any)[key] ?? '';

      if (value === originalValue) {
        delete this._pendingChanges[key];
      } else {
        this._pendingChanges[key] = value;
      }
    }

    if (key === 'readPermission' || key === 'writePermission') {
      this._fullRenderWebview();
    } else {
      this._updateWebview();
    }
  }

  private _updateWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updatePendingChanges',
        pendingChanges: this._pendingChanges,
        canSave: this._canSave(),
        isSaving: this._isSaving,
      });
    }
  }

  private _canSave(): boolean {
    if (!this._currentNote || this._isSaving || !this.hasPendingChanges()) {
      return false;
    }
    if ('permalink' in this._pendingChanges && !this.isValidPermalink(this._pendingChanges.permalink)) {
      return false;
    }
    return true;
  }

  private _fullRenderWebview() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'update',
        note: this._currentNote,
        pendingChanges: this._pendingChanges,
        canSave: this._canSave(),
        isSaving: this._isSaving,
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
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }
    .header {
      margin-bottom: 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .title {
      font-size: 14px;
      font-weight: 700;
      color: var(--vscode-foreground);
      word-break: break-word;
    }
    .property-group {
      margin-bottom: 14px;
    }
    .property-group.compact {
      margin-bottom: 10px;
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
    .error {
      margin-top: 6px;
      font-size: 11px;
      color: var(--vscode-inputValidation-errorForeground);
    }
    .modified-indicator {
      display: inline-block;
      margin-left: 4px;
      color: var(--vscode-inputValidation-warningBorder);
      font-size: 10px;
    }
    .section-title {
      margin: 0 0 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .permission-row {
      display: grid;
      grid-template-columns: 52px 1fr;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .permission-row label {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      color: var(--vscode-foreground);
    }
    .permission-row select {
      padding: 4px 8px;
    }
    .sharing-prefix {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      word-break: break-all;
    }
    .sharing-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .sharing-row.input-button {
      grid-template-columns: 1fr auto;
    }
    .sharing-row label {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      color: var(--vscode-foreground);
    }
    .sharing-row select {
      padding: 4px 8px;
    }
    .sharing-row button {
      min-width: 74px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      cursor: pointer;
      font: inherit;
    }
    .sharing-row button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .actions {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .actions button {
      min-width: 74px;
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
      font: inherit;
      cursor: pointer;
    }
    .actions .secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    }
    .actions .secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    .actions .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .actions .primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .actions button:disabled,
    .sharing-row button:disabled,
    input:disabled,
    select:disabled {
      opacity: 0.6;
      cursor: default;
    }
  </style>
</head>
<body>
  <div id="content">
    <div class="empty-state">
      Select “Properties...” option from the context menu of a note to edit note properties
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentNote = null;
    let pendingChanges = {};
    let canSave = false;
    let isSaving = false;

    const permalinkRegex = /^[A-Za-z0-9_-]+$/;

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'update':
          currentNote = message.note;
          pendingChanges = message.pendingChanges || {};
          canSave = !!message.canSave;
          isSaving = !!message.isSaving;
          render();
          break;
        case 'updatePendingChanges':
          pendingChanges = message.pendingChanges || {};
          canSave = !!message.canSave;
          isSaving = !!message.isSaving;
          updateModifiedIndicators();
          updateSaveState();
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

    function onCopyShareUrl() {
      const url = buildShareUrl();
      if (url) {
        vscode.postMessage({ type: 'copyShareUrl', url });
      }
    }

    function getShareBaseAndSlug() {
      const publishLink = currentNote?.publishLink || '';
      if (publishLink && publishLink.includes('/')) {
        const lastSlash = publishLink.lastIndexOf('/');
        const base = publishLink.slice(0, lastSlash + 1);
        const fallbackSlug = publishLink.slice(lastSlash + 1);
        return { base, fallbackSlug };
      }
      return {
        base: 'https://hackmd.io/',
        fallbackSlug: currentNote?.shortId || '',
      };
    }

    function buildShareUrl() {
      if (!currentNote) {
        return '';
      }
      const { base, fallbackSlug } = getShareBaseAndSlug();
      const slug = (pendingChanges.permalink !== undefined ? pendingChanges.permalink : currentNote.permalink) || fallbackSlug;
      return \`\${base}\${slug || ''}\`;
    }

    function updateModifiedIndicators() {
      // Update each property's modified state
      ['permalink', 'readPermission', 'writePermission'].forEach(property => {
        const element = document.getElementById(property);
        const label = element?.parentElement?.querySelector('label');
        
        if (element) {
          const isModified = pendingChanges[property] !== undefined;
          
          // Update CSS class
          if (isModified) {
            element.classList.add('modified');
          } else {
            element.classList.remove('modified');
          }
          
          // Update indicator dot
          if (label) {
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
        }
      });

      const permalinkInput = document.getElementById('permalink');
      const permalinkError = document.getElementById('permalinkError');
      if (permalinkInput && permalinkError) {
        const value = permalinkInput.value.trim();
        const permalinkDirty = pendingChanges['permalink'] !== undefined;
        if (permalinkDirty && !value) {
          permalinkError.textContent = 'Permalink is required.';
        } else if (value && !permalinkRegex.test(value)) {
          permalinkError.textContent = 'Use only letters, numbers, hyphens, and underscores.';
        } else {
          permalinkError.textContent = '';
        }
      }
    }

    function updateSaveState() {
      const saveButton = document.getElementById('saveProperties');
      const cancelButton = document.getElementById('cancelProperties');
      if (saveButton) {
        saveButton.disabled = !canSave;
        saveButton.textContent = isSaving ? 'Saving...' : 'Save';
      }
      if (cancelButton) {
        cancelButton.disabled = isSaving;
      }
    }

    function render() {
      const content = document.getElementById('content');
      
      if (!currentNote) {
        content.innerHTML = \`
          <div class="empty-state">
            Select “Properties...” option from the context menu of a note to edit note properties
          </div>
        \`;
        return;
      }

      const permalinkValue = pendingChanges.permalink !== undefined ? pendingChanges.permalink : (currentNote.permalink || '');
      const readPermValue = pendingChanges.readPermission !== undefined ? pendingChanges.readPermission : currentNote.readPermission;
      const writePermValue = pendingChanges.writePermission !== undefined ? pendingChanges.writePermission : currentNote.writePermission;
      const shareInfo = getShareBaseAndSlug();

      content.innerHTML = \`
        <div class="header">
          <div class="title">\${escapeHtml(currentNote.title || currentNote.shortId || 'Untitled')}</div>
        </div>

        <div class="property-group compact">
          <div class="section-title">Sharing URL</div>
          <div class="sharing-prefix">\${escapeHtml(shareInfo.base)}</div>

          <div class="sharing-row input-button">
            <input
              type="text"
              id="permalink"
              value="\${escapeHtml(permalinkValue)}"
              placeholder="\${escapeHtml(shareInfo.fallbackSlug || 'custom-note-url')}"
              \${isSaving ? 'disabled' : ''}
            />
            <button type="button" id="copyShareUrl" \${isSaving ? 'disabled' : ''}>Copy</button>
          </div>
          <div id="permalinkError" class="error"></div>
        </div>

        <div class="property-group compact">
          <div class="section-title">Note Permission</div>

          <div class="permission-row">
            <label for="readPermission">Read</label>
            <select id="readPermission" \${isSaving ? 'disabled' : ''}>
              <option value="owner" \${readPermValue === 'owner' ? 'selected' : ''}>Only me</option>
              <option value="signed_in" \${readPermValue === 'signed_in' ? 'selected' : ''}>Signed-in users</option>
              <option value="guest" \${readPermValue === 'guest' ? 'selected' : ''}>Anyone with link</option>
            </select>
          </div>

          <div class="permission-row">
            <label for="writePermission">Write</label>
            <select id="writePermission" \${isSaving ? 'disabled' : ''}>
              <option value="owner" \${writePermValue === 'owner' ? 'selected' : ''}>Only me</option>
              <option value="signed_in" \${writePermValue === 'signed_in' ? 'selected' : ''}>Signed-in users</option>
              <option value="guest" \${writePermValue === 'guest' ? 'selected' : ''}>Anyone with link</option>
            </select>
          </div>
        </div>

        <div class="actions">
          <button class="secondary" id="cancelProperties" type="button">Cancel</button>
          <button class="primary" id="saveProperties" type="button">Save</button>
        </div>
      \`;

      // Attach event listeners
      document.getElementById('permalink').addEventListener('input', (e) => {
        const value = e.target.value.trim();
        onPropertyChange('permalink', value);
      });

      document.getElementById('readPermission').addEventListener('change', (e) => {
        onPropertyChange('readPermission', e.target.value);
      });

      document.getElementById('writePermission').addEventListener('change', (e) => {
        onPropertyChange('writePermission', e.target.value);
      });

      document.getElementById('copyShareUrl').addEventListener('click', () => {
        onCopyShareUrl();
      });

      document.getElementById('cancelProperties').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
      });

      document.getElementById('saveProperties').addEventListener('click', () => {
        vscode.postMessage({ type: 'save' });
      });
      
      // Update modified indicators after initial render
      updateModifiedIndicators();
      updateSaveState();
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
