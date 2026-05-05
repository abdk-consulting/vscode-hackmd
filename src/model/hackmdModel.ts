import * as vscode from 'vscode';

import { HackMdApiClient, HackMdFolder, Note, Team } from '../api/hackmdApiClient';
import { recordUsage } from '../store';

export type ModelScope = string | null;

export interface ModelDisposable {
  dispose(): void;
}

export interface ModelEvent<T> {
  (listener: (payload: T) => void): ModelDisposable;
}

class EventSignal<T> {
  private readonly listeners = new Set<(payload: T) => void>();

  event: ModelEvent<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  emit(payload: T): void {
    for (const listener of [...this.listeners]) {
      listener(payload);
    }
  }
}

export interface ModelTeam {
  readonly type: 'team';
  id: string;
  path: string;
  name: string;
  rootFolders: ModelFolder[];
  rootNotes: ModelNote[];
}

export interface ModelFolder {
  readonly type: 'folder';
  id: string;
  name: string;
  path?: string;
  clientId: string;
  parentId?: string | null;
  teamPath: string | null;
  children: ModelFolder[];
  notes: ModelNote[];
}

export interface ModelNote {
  readonly type: 'note';
  id: string;
  title: string;
  shortId?: string;
  teamPath: string | null;
  content?: string;
  publishLink?: string;
  publishType?: Note['publishType'];
  permalink?: string | null;
  userPath?: string | null;
  folderPaths?: Array<{
    id: string;
    path: string;
    name?: string;
    clientId?: string;
    parentFolderId?: string | null;
    parentForderId?: string | null;
  }>;
  parentFolderId?: string | null;
  parentForderId?: string | null;
  readPermission?: string;
  writePermission?: string;
  tags?: string[];
  createdAt?: string;
  lastChangedAt?: string;
}

export interface ModelMyNotes {
  readonly type: 'my-notes';
}

export interface ModelTeams {
  readonly type: 'teams';
}

export interface ModelRecentNotes {
  readonly type: 'recent-notes';
}

export interface ModelRoot {
  readonly type: 'model-root';
}

export type ModelContainerEntity = ModelMyNotes | ModelTeams | ModelRecentNotes;

export type ModelEntity = ModelTeam | ModelFolder | ModelNote | ModelContainerEntity | ModelRoot;

export interface ModelEntityChangedEvent {
  entity: ModelEntity;
}

export interface ModelPendingChangedEvent {
  entity: ModelEntity;
  pending: boolean;
}

export type ModelPendingTarget =
  | { targetType: 'my-notes' }
  | { targetType: 'teams' }
  | { targetType: 'recent-notes' }
  | { targetType: 'team'; teamPath: string }
  | { targetType: 'folder'; scope: ModelScope; id: string }
  | { targetType: 'note'; scope: ModelScope; id: string };

export interface ModelScopeSnapshot {
  scope: ModelScope;
  rootFolders: readonly ModelFolder[];
  rootNotes: readonly ModelNote[];
}

export interface RefreshScopeInput {
  teamPath?: string | null;
}

export interface CreateNoteProps {
  title?: string;
  content?: string;
  permalink?: string | null;
  readPermission?: string;
  writePermission?: string;
}

export interface CreateFolderProps {
  name: string;
}

interface CreateNoteInput {
  teamPath?: string | null;
  title?: string;
  content?: string;
  parentFolderId?: string | null;
}

interface CreateFolderInput {
  teamPath?: string | null;
  name: string;
  parentFolderId?: string | null;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  publishType?: Note['publishType'];
  permalink?: string | null;
  readPermission?: string;
  writePermission?: string;
  tags?: string[];
  parentFolderId?: string | null;
}

export interface MoveNoteInput {
  noteId: string;
  sourceTeamPath?: string | null;
  targetTeamPath?: string | null;
  targetParentFolderId?: string | null;
}

export interface MoveFolderInput {
  folderId: string;
  teamPath?: string | null;
  targetParentFolderId?: string | null;
}

export interface UpdateFolderInput {
  name?: string;
  parentFolderId?: string | null;
}

function scopeKey(teamPath?: string | null): string {
  return teamPath || '__personal__';
}

function compareStrings(a: string, b: string): number {
  const ci = (a || '').localeCompare(b || '', undefined, { sensitivity: 'base' });
  return ci !== 0 ? ci : (a || '').localeCompare(b || '');
}

function resolveParentFolderId(item: { parentFolderId?: string | null; parentForderId?: string | null } | undefined): string | null {
  if (!item) {
    return null;
  }
  return item.parentFolderId || item.parentForderId || null;
}

function replaceArrayContents<T>(target: T[], next: T[]): void {
  target.splice(0, target.length, ...next);
}

function arraysReferenceEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function replaceArrayContentsIfChanged<T>(target: T[], next: T[]): boolean {
  if (arraysReferenceEqual(target, next)) {
    return false;
  }
  replaceArrayContents(target, next);
  return true;
}

function mergeDefinedProps<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const merged: T = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  }
  return merged;
}

function reconcileArrayAsSetPreserveOrder<T>(target: T[], next: readonly T[]): boolean {
  let changed = false;
  const nextSet = new Set(next);

  for (let i = target.length - 1; i >= 0; i -= 1) {
    if (!nextSet.has(target[i])) {
      target.splice(i, 1);
      changed = true;
    }
  }

  const currentSet = new Set(target);
  for (const item of next) {
    if (!currentSet.has(item)) {
      target.push(item);
      currentSet.add(item);
      changed = true;
    }
  }

  return changed;
}

function stringArrayEqual(a?: string[], b?: string[]): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return !a && !b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function folderPathsEqual(
  a?: Array<{ id: string; path: string; name?: string; clientId?: string; parentFolderId?: string | null; parentForderId?: string | null }>,
  b?: Array<{ id: string; path: string; name?: string; clientId?: string; parentFolderId?: string | null; parentForderId?: string | null }>
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return !a && !b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (
      ai.id !== bi.id
      || ai.path !== bi.path
      || ai.name !== bi.name
      || ai.clientId !== bi.clientId
      || (ai.parentFolderId || ai.parentForderId || null) !== (bi.parentFolderId || bi.parentForderId || null)
    ) {
      return false;
    }
  }
  return true;
}

function sanitizeSegment(name: string, fallback: string): string {
  return (name || fallback).replace(/[\\/:*?"<>|#]/g, '-');
}

export class HackmdModel {
  constructor(private readonly api: HackMdApiClient) { }

  private readonly teams = new Map<string, ModelTeam>();
  private readonly teamsByPath = new Map<string, ModelTeam>();
  private readonly orderedTeams: ModelTeam[] = [];

  private readonly foldersByScope = new Map<string, Map<string, ModelFolder>>();
  private readonly notesByScope = new Map<string, Map<string, ModelNote>>();

  private readonly personalRootFolders: ModelFolder[] = [];
  private readonly personalRootNotes: ModelNote[] = [];

  private readonly historyNotes: ModelNote[] = [];
  private readonly loadedScopes = new Set<string>();
  private readonly contentLoadedByScope = new Map<string, Set<string>>();

  private refreshTeamsPromise: Promise<readonly ModelTeam[]> | null = null;
  private refreshHistoryPromise: Promise<readonly ModelNote[]> | null = null;
  private readonly refreshScopePromises = new Map<string, Promise<void>>();
  private readonly noteFetchPromises = new Map<string, Promise<ModelNote>>();
  private readonly folderFetchPromises = new Map<string, Promise<ModelFolder>>();
  private readonly entityByUriPromises = new Map<string, Promise<ModelNote | ModelFolder | ModelTeam | null>>();

  private readonly didChangeEntity = new EventSignal<ModelEntityChangedEvent>();
  private readonly didChangePending = new EventSignal<ModelPendingChangedEvent>();
  private entityEventBatchDepth = 0;
  private readonly batchedEntityEvents: ModelEntityChangedEvent[] = [];
  private entityChangeVersion = 0;
  private readonly pendingCounts = new Map<ModelEntity, number>();

  private readonly myNotesEntity: ModelMyNotes = {
    type: 'my-notes',
  };

  private readonly teamsEntity: ModelTeams = {
    type: 'teams',
  };

  private readonly recentNotesEntity: ModelRecentNotes = {
    type: 'recent-notes',
  };

  private readonly modelRootEntity: ModelRoot = {
    type: 'model-root',
  };

  private static readonly EMPTY_FOLDERS: ModelFolder[] = [];
  private static readonly EMPTY_NOTES: ModelNote[] = [];

  readonly onDidChangeEntity = this.didChangeEntity.event;
  readonly onDidChangePending = this.didChangePending.event;

  getMyNotesEntity(): ModelMyNotes {
    return this.myNotesEntity;
  }

  getTeamsEntity(): ModelTeams {
    return this.teamsEntity;
  }

  getRecentNotesEntity(): ModelRecentNotes {
    return this.recentNotesEntity;
  }

  getModelRootEntity(): ModelRoot {
    return this.modelRootEntity;
  }

  isMyNotesPendingOperation(): boolean {
    return (this.pendingCounts.get(this.myNotesEntity) || 0) > 0;
  }

  isTeamNotesPendingOperation(): boolean {
    return (this.pendingCounts.get(this.teamsEntity) || 0) > 0;
  }

  isRecentNotesPendingOperation(): boolean {
    return (this.pendingCounts.get(this.recentNotesEntity) || 0) > 0;
  }

  isTeamPendingOperation(teamPath: string): boolean {
    const team = this.teamsByPath.get(teamPath);
    return team ? (this.pendingCounts.get(team) || 0) > 0 : false;
  }

  isFolderPendingOperation(folderId: string, teamPath?: string | null): boolean {
    const folder = this.getFolderById(folderId, teamPath);
    return folder ? (this.pendingCounts.get(folder) || 0) > 0 : false;
  }

  isNotePendingOperation(noteId: string, teamPath?: string | null): boolean {
    const note = this.getNoteById(noteId, teamPath);
    return note ? (this.pendingCounts.get(note) || 0) > 0 : false;
  }

  isPending(target: ModelPendingTarget): boolean {
    const entity: ModelEntity | undefined = target.targetType === 'my-notes'
      ? this.myNotesEntity
      : target.targetType === 'teams'
        ? this.teamsEntity
        : target.targetType === 'recent-notes'
          ? this.recentNotesEntity
          : target.targetType === 'team'
            ? this.teamsByPath.get(target.teamPath)
            : target.targetType === 'folder'
              ? this.getFolderById(target.id, target.scope)
              : this.getNoteById(target.id, target.scope);
    return entity ? (this.pendingCounts.get(entity) || 0) > 0 : false;
  }

  getTeams(): readonly ModelTeam[] {
    return this.orderedTeams;
  }

  getTeamById(teamId: string): ModelTeam | undefined {
    return this.teams.get(teamId);
  }

  getTeamByPath(teamPath: string): ModelTeam | undefined {
    return this.teamsByPath.get(teamPath);
  }

  getPersonalRootFolders(): readonly ModelFolder[] {
    return this.personalRootFolders;
  }

  getPersonalRootNotes(): readonly ModelNote[] {
    return this.personalRootNotes;
  }

  getHistoryNotes(): readonly ModelNote[] {
    return this.historyNotes;
  }

  getScopeSnapshotSync(scope: ModelMyNotes | ModelTeam): ModelScopeSnapshot | null {
    if (scope.type === 'team') {
      const key = scopeKey(scope.path);
      if (!this.loadedScopes.has(key)) {
        return null;
      }
      return {
        scope: scope.path,
        rootFolders: scope.rootFolders,
        rootNotes: scope.rootNotes,
      };
    }

    const key = scopeKey(null);
    if (!this.loadedScopes.has(key)) {
      return null;
    }
    return {
      scope: null,
      rootFolders: this.personalRootFolders,
      rootNotes: this.personalRootNotes,
    };
  }

  async getScopeSnapshot(teamPath?: string | null): Promise<ModelScopeSnapshot> {
    const entity: ModelMyNotes | ModelTeam | null = teamPath
      ? (this.teamsByPath.get(teamPath) ?? null)
      : this.myNotesEntity;
    const existing = entity ? this.getScopeSnapshotSync(entity) : null;
    if (existing) {
      return existing;
    }

    await this.refreshScope({ teamPath: teamPath || null });
    const entityAfterLoad: ModelMyNotes | ModelTeam | null = teamPath
      ? (this.teamsByPath.get(teamPath) ?? null)
      : this.myNotesEntity;
    return (entityAfterLoad ? this.getScopeSnapshotSync(entityAfterLoad) : null) || {
      scope: teamPath || null,
      rootFolders: [],
      rootNotes: [],
    };
  }

  getNoteSync(noteId: string, teamPath?: string | null): ModelNote | null {
    return this.getNoteById(noteId, teamPath) || null;
  }

  async getNote(noteId: string, teamPath?: string | null): Promise<ModelNote | null> {
    const cached = this.getNoteSync(noteId, teamPath);
    if (cached) {
      return cached;
    }

    try {
      const scope = teamPath || null;
      return await this.fetchNote(scope, noteId);
    } catch {
      return null;
    }
  }

  getNoteContentSync(noteId: string, teamPath?: string | null): string | null {
    const note = this.getNoteById(noteId, teamPath);
    if (!note) {
      return null;
    }
    const contentSet = this.contentLoadedByScope.get(scopeKey(teamPath));
    if (!contentSet || !contentSet.has(noteId)) {
      return null;
    }
    return note.content ?? '';
  }

  async getNoteContent(noteId: string, teamPath?: string | null): Promise<string | null> {
    const existing = this.getNoteContentSync(noteId, teamPath);
    if (existing !== null) {
      return existing;
    }

    const loaded = await this.loadNoteContent(noteId, teamPath);
    return loaded.content ?? '';
  }

  toNoteUri(note: ModelNote): vscode.Uri {
    const sanitizedTitle = sanitizeSegment(note.title || note.shortId || 'Untitled', 'Untitled');
    const folderPath = (note.folderPaths || [])
      .map((f) => sanitizeSegment(f.name || 'Folder', 'Folder'))
      .join('/');
    const folderPrefix = folderPath ? `/${folderPath}` : '';
    const path = note.teamPath
      ? `/Teams/${note.teamPath}${folderPrefix}/${sanitizedTitle}`
      : `/My Notes${folderPrefix}/${sanitizedTitle}`;

    const params = new URLSearchParams();
    params.set('noteId', note.id);
    if (note.teamPath) {
      params.set('teamPath', note.teamPath);
    }

    return vscode.Uri.from({
      scheme: 'hackmd',
      path,
      query: params.toString(),
      fragment: '',
    });
  }

  toFolderUri(folder: ModelFolder): vscode.Uri {
    const names = this.getFolderNamePath(folder);
    const folderPath = names.slice(0, Math.max(names.length - 1, 0)).map((n) => sanitizeSegment(n, 'Folder')).join('/');
    const sanitizedName = sanitizeSegment(folder.name || 'Folder', 'Folder');
    const folderPrefix = folderPath ? `/${folderPath}` : '';
    const path = folder.teamPath
      ? `/Teams/${folder.teamPath}${folderPrefix}/${sanitizedName}`
      : `/My Notes${folderPrefix}/${sanitizedName}`;

    const params = new URLSearchParams();
    params.set('folderId', folder.id);
    if (folder.teamPath) {
      params.set('teamPath', folder.teamPath);
    }

    return vscode.Uri.from({
      scheme: 'hackmd',
      path,
      query: params.toString(),
      fragment: '',
    });
  }

  toTeamUri(team: ModelTeam): vscode.Uri {
    const params = new URLSearchParams();
    params.set('teamPath', team.path);

    return vscode.Uri.from({
      scheme: 'hackmd',
      path: `/Teams/${team.path}`,
      query: params.toString(),
      fragment: '',
    });
  }

  getEntityByUriSync(uri: vscode.Uri): ModelNote | ModelFolder | ModelTeam | null {
    const parsed = this.parseHackmdUri(uri);
    if (parsed.noteId) {
      return this.getNoteById(parsed.noteId, parsed.teamPath) || null;
    }
    if (parsed.folderId) {
      return this.getFolderById(parsed.folderId, parsed.teamPath) || null;
    }
    if (parsed.teamPath) {
      return this.getTeamByPath(parsed.teamPath) || null;
    }
    return null;
  }

  async getEntityByUri(uri: vscode.Uri): Promise<ModelNote | ModelFolder | ModelTeam | null> {
    const existing = this.getEntityByUriSync(uri);
    if (existing) {
      return existing;
    }

    const key = uri.toString();
    const inflight = this.entityByUriPromises.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      const parsed = this.parseHackmdUri(uri);
      const scope = parsed.teamPath || null;

      try {
        if (parsed.noteId) {
          return await this.fetchNote(scope, parsed.noteId);
        }

        if (parsed.folderId) {
          return await this.fetchFolder(scope, parsed.folderId);
        }

        if (parsed.teamPath) {
          await this.refreshTeams();
          return this.getTeamByPath(parsed.teamPath) || null;
        }
      } catch {
        return null;
      }

      return null;
    })();

    this.entityByUriPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.entityByUriPromises.delete(key);
    }
  }

  getFolderById(folderId: string, teamPath?: string | null): ModelFolder | undefined {
    return this.getFolderScopeMap(teamPath).get(folderId);
  }

  getNoteById(noteId: string, teamPath?: string | null): ModelNote | undefined {
    return this.getNoteScopeMap(teamPath).get(noteId);
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshTeams(), this.refreshPersonal(), this.refreshHistory()]);
    for (const team of this.orderedTeams) {
      await this.refreshScope({ teamPath: team.path });
    }
  }

  async refreshTeams(): Promise<readonly ModelTeam[]> {
    if (this.refreshTeamsPromise) {
      return this.refreshTeamsPromise;
    }

    this.refreshTeamsPromise = this.withPendingOperation(
      { targetType: 'teams' },
      async () => {
        const teams = await recordUsage(this.api.getTeams({ unwrapData: false }));
        this.withEntityEventBatch(() => {
          this.syncTeams(teams || []);
        });
        return this.orderedTeams;
      }
    );

    try {
      return await this.refreshTeamsPromise;
    } finally {
      this.refreshTeamsPromise = null;
    }
  }

  async refreshPersonal(): Promise<void> {
    await this.refreshScope({ teamPath: null });
  }

  async refreshScope(input: RefreshScopeInput): Promise<void> {
    const teamPath = input.teamPath || null;
    const key = scopeKey(teamPath);

    const inflight = this.refreshScopePromises.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = this.withScopePending(teamPath, async () => {
      if (teamPath) {
        const [notes, folders] = await Promise.all([
          recordUsage(this.api.getTeamNotes(teamPath, { unwrapData: false })),
          recordUsage(this.api.getTeamFolders(teamPath, { unwrapData: false })),
        ]);
        this.withEntityEventBatch(() => {
          this.rebuildScope(teamPath, notes || [], folders || []);
        });
        return;
      }

      const [notes, folders] = await Promise.all([
        recordUsage(this.api.getNoteList({ unwrapData: false })),
        recordUsage(this.api.getFolders({ unwrapData: false })),
      ]);
      this.withEntityEventBatch(() => {
        this.rebuildScope(null, notes || [], folders || []);
      });
    });

    this.refreshScopePromises.set(key, promise);
    try {
      await promise;
    } finally {
      this.refreshScopePromises.delete(key);
    }
  }

  async refreshHistory(): Promise<readonly ModelNote[]> {
    if (this.refreshHistoryPromise) {
      return this.refreshHistoryPromise;
    }

    this.refreshHistoryPromise = this.withPendingOperation(
      { targetType: 'recent-notes' },
      async () => {
        const notes = await recordUsage(this.api.getHistory({ unwrapData: false }));
        const next: ModelNote[] = [];

        this.withEntityEventBatch(() => {
          for (const note of notes || []) {
            const teamPath = note.teamPath || null;
            const modelNote = this.upsertNote(teamPath, note);
            next.push(modelNote);
          }
        });

        reconcileArrayAsSetPreserveOrder(this.historyNotes, next);
        return this.historyNotes;
      }
    );

    try {
      return await this.refreshHistoryPromise;
    } finally {
      this.refreshHistoryPromise = null;
    }
  }

  async createNote(container: ModelMyNotes | ModelTeam | ModelFolder, props?: CreateNoteProps): Promise<ModelNote> {
    const teamPath = container.type === 'folder'
      ? container.teamPath
      : container.type === 'team'
        ? container.path
        : null;
    const parentFolderId = container.type === 'folder' ? container.id : null;
    return this.createNoteRaw({ teamPath, parentFolderId, ...props });
  }

  private async createNoteRaw(input: CreateNoteInput): Promise<ModelNote> {
    const payload: Record<string, any> = {};
    if (input.title) {
      payload.title = input.title;
    }
    if (input.content !== undefined) {
      payload.content = input.content;
    }
    if (input.parentFolderId) {
      payload.parentFolderId = input.parentFolderId;
    }

    const teamPath = input.teamPath || null;
    const parentFolderId = input.parentFolderId || null;

    const create = async () => {
      const getScopeSnapshotPromise = this.getScopeSnapshot(teamPath);
      const note = teamPath
        ? await recordUsage(this.api.createTeamNote(teamPath, payload, { unwrapData: false }))
        : await recordUsage(this.api.createNote(payload, { unwrapData: false }));
      await getScopeSnapshotPromise;

      const responseParentFolderId = resolveParentFolderId(note as any);
      const effectiveParentFolderId = responseParentFolderId ?? parentFolderId;

      const createdContent = note.content !== undefined
        ? note.content
        : (input.content !== undefined ? input.content : '');
      const entity = this.upsertNote(
        teamPath,
        {
          ...note,
          content: createdContent,
          parentFolderId: effectiveParentFolderId,
        },
        true
      );

      if (entity.parentFolderId !== effectiveParentFolderId) {
        entity.parentFolderId = effectiveParentFolderId;
        this.emitEntityChanged(entity);
      }

      if (this.reconcileNotePlacement(teamPath, entity)) {
        this.emitEntityChanged(entity);
      }
      return entity;
    };

    if (parentFolderId) {
      return this.withPendingOperation({ targetType: 'folder', scope: teamPath, id: parentFolderId }, create);
    }

    if (teamPath) {
      return this.withPendingOperation({ targetType: 'team', teamPath }, create);
    }

    return this.withPendingOperation({ targetType: 'my-notes' }, create);
  }

  async createFolder(container: ModelMyNotes | ModelTeam | ModelFolder, props: CreateFolderProps): Promise<ModelFolder> {
    const teamPath = container.type === 'folder'
      ? container.teamPath
      : container.type === 'team'
        ? container.path
        : null;
    const parentFolderId = container.type === 'folder' ? container.id : null;
    return this.createFolderRaw({ teamPath, parentFolderId, name: props.name });
  }

  private async createFolderRaw(input: CreateFolderInput): Promise<ModelFolder> {
    const payload: Record<string, any> = {
      name: input.name,
    };

    if (input.parentFolderId) {
      payload.parentFolderId = input.parentFolderId;
    }

    const teamPath = input.teamPath || null;
    const parentFolderId = input.parentFolderId || null;

    const create = async () => {
      const getScopeSnapshotPromise = this.getScopeSnapshot(teamPath);
      const folder = teamPath
        ? await recordUsage(this.api.createTeamFolder(teamPath, payload, { unwrapData: false }))
        : await recordUsage(this.api.createFolder(payload, { unwrapData: false }));
      await getScopeSnapshotPromise;

      const responseParentFolderId = resolveParentFolderId(folder as any);
      const effectiveParentFolderId = responseParentFolderId ?? parentFolderId;
      const entity = this.upsertFolder(teamPath, {
        ...folder,
        parentFolderId: effectiveParentFolderId,
      });

      if (entity.parentId !== effectiveParentFolderId) {
        entity.parentId = effectiveParentFolderId;
        this.emitEntityChanged(entity);
      }

      if (this.reconcileFolderPlacement(teamPath, entity)) {
        this.emitEntityChanged(entity);
      }
      return entity;
    };

    if (parentFolderId) {
      return this.withPendingOperation({ targetType: 'folder', scope: teamPath, id: parentFolderId }, create);
    }

    if (teamPath) {
      return this.withPendingOperation({ targetType: 'team', teamPath }, create);
    }

    return this.withPendingOperation({ targetType: 'my-notes' }, create);
  }

  async loadNoteContent(noteId: string, teamPath?: string | null): Promise<ModelNote> {
    const scope = teamPath || null;
    return this.withPendingOperation({ targetType: 'note', scope, id: noteId }, async () => {
      const entity = await this.fetchNote(scope, noteId);
      return entity;
    });
  }

  async saveNoteContent(noteId: string, content: string, teamPath?: string | null): Promise<ModelNote> {
    const scope = teamPath || null;
    return this.withPendingOperation({ targetType: 'note', scope, id: noteId }, async () => {
      const updated = scope
        ? await recordUsage(this.api.updateTeamNote(scope, noteId, { content }, { unwrapData: false }))
        : await recordUsage(this.api.updateNote(noteId, { content }, { unwrapData: false }));

      const note = this.hydrateUpdatedNotePayload(scope, noteId, updated);
      const entity = this.upsertNote(scope, note, true);
      this.applyPredictedNotePlacement(scope, entity);
      return entity;
    });
  }

  async updateNoteProperties(noteId: string, input: UpdateNoteInput, teamPath?: string | null): Promise<ModelNote> {
    const scope = teamPath || null;
    return this.withPendingOperation({ targetType: 'note', scope, id: noteId }, async () => {
      const updated = scope
        ? await recordUsage(this.api.updateTeamNote(scope, noteId, input as any, { unwrapData: false }))
        : await recordUsage(this.api.updateNote(noteId, input as any, { unwrapData: false }));

      const note = this.hydrateUpdatedNotePayload(scope, noteId, updated);
      const entity = this.upsertNote(scope, note);
      if (Object.prototype.hasOwnProperty.call(input, 'parentFolderId')) {
        const requestedParentFolderId = input.parentFolderId;
        if (requestedParentFolderId !== undefined && entity.parentFolderId !== requestedParentFolderId) {
          entity.parentFolderId = requestedParentFolderId;
          this.emitEntityChanged(entity);
        }
      }
      this.applyPredictedNotePlacement(scope, entity);
      return entity;
    });
  }

  async renameNote(noteId: string, newTitle: string, teamPath?: string | null): Promise<ModelNote> {
    return this.updateNoteProperties(noteId, { title: newTitle }, teamPath);
  }

  async renameFolder(folderId: string, newName: string, teamPath?: string | null): Promise<ModelFolder> {
    return this.updateFolder(folderId, { name: newName }, teamPath);
  }

  async updateFolder(folderId: string, input: UpdateFolderInput, teamPath?: string | null): Promise<ModelFolder> {
    const scope = teamPath || null;
    return this.withPendingOperation({ targetType: 'folder', scope, id: folderId }, async () => {
      const updated = scope
        ? await recordUsage(this.api.updateTeamFolder(scope, folderId, input as any, { unwrapData: false }))
        : await recordUsage(this.api.updateFolder(folderId, input as any, { unwrapData: false }));

      const folder = this.hydrateUpdatedFolderPayload(scope, folderId, updated);
      const entity = this.upsertFolder(scope, folder);
      if (Object.prototype.hasOwnProperty.call(input, 'parentFolderId')) {
        const requestedParentFolderId = input.parentFolderId;
        if (requestedParentFolderId !== undefined && entity.parentId !== requestedParentFolderId) {
          entity.parentId = requestedParentFolderId;
          this.emitEntityChanged(entity);
        }
      }
      this.applyPredictedFolderPlacement(scope, entity);
      return entity;
    });
  }

  async moveNote(input: MoveNoteInput): Promise<ModelNote> {
    const sourceScope = input.sourceTeamPath || null;
    const targetScope = input.targetTeamPath || null;

    return this.withPendingOperation({ targetType: 'note', scope: sourceScope, id: input.noteId }, async () => {
      if (sourceScope === targetScope) {
        const patch: UpdateNoteInput = {};
        if (Object.prototype.hasOwnProperty.call(input, 'targetParentFolderId')) {
          patch.parentFolderId = input.targetParentFolderId;
        }
        const updated = await this.updateNoteProperties(
          input.noteId,
          patch,
          sourceScope
        );
        return updated;
      }

      const loaded = await this.loadNoteContent(input.noteId, sourceScope);
      const created = await this.createNoteRaw({
        teamPath: targetScope,
        title: loaded.title,
        content: loaded.content || '',
        parentFolderId: input.targetParentFolderId || null,
      });

      await this.deleteNote(input.noteId, sourceScope);

      return created;
    });
  }

  async moveFolder(input: MoveFolderInput): Promise<ModelFolder> {
    return this.withPendingOperation(
      { targetType: 'folder', scope: input.teamPath || null, id: input.folderId },
      async () => this.updateFolder(
        input.folderId,
        { parentFolderId: input.targetParentFolderId || null },
        input.teamPath || null
      )
    );
  }

  async deleteNote(noteId: string, teamPath?: string | null): Promise<void> {
    const scope = teamPath || null;
    await this.withPendingOperation({ targetType: 'note', scope, id: noteId }, async () => {
      if (scope) {
        await recordUsage(this.api.deleteTeamNote(scope, noteId, { unwrapData: false }));
      } else {
        await recordUsage(this.api.deleteNote(noteId, { unwrapData: false }));
      }

      this.applyPredictedNoteDelete(scope, noteId);
    });
  }

  async deleteFolder(folderId: string, teamPath?: string | null): Promise<void> {
    const scope = teamPath || null;
    await this.withPendingOperation({ targetType: 'folder', scope, id: folderId }, async () => {
      if (scope) {
        await recordUsage(this.api.deleteTeamFolder(scope, folderId, { unwrapData: false }));
      } else {
        await recordUsage(this.api.deleteFolder(folderId, { unwrapData: false }));
      }

      this.applyPredictedFolderDelete(scope, folderId);
    });
  }

  private applyPredictedNotePlacement(scope: ModelScope, note: ModelNote): void {
    if (this.reconcileNotePlacement(scope, note)) {
      this.emitEntityChanged(note);
    }
  }

  private applyPredictedFolderPlacement(scope: ModelScope, folder: ModelFolder): void {
    if (this.reconcileFolderPlacement(scope, folder)) {
      this.emitEntityChanged(folder);
    }
  }

  private applyPredictedNoteDelete(scope: ModelScope, noteId: string): void {
    const noteMap = this.getNoteScopeMap(scope);
    const existing = noteMap.get(noteId);
    if (!existing) {
      return;
    }

    noteMap.delete(noteId);
    this.getContentLoadedSet(scope).delete(noteId);

    for (const folder of this.getFolderScopeMap(scope).values()) {
      const nextNotes = folder.notes.filter((candidate) => candidate.id !== noteId);
      if (nextNotes.length !== folder.notes.length) {
        replaceArrayContents(folder.notes, nextNotes);
      }
    }

    const roots = scope
      ? this.teamsByPath.get(scope)?.rootNotes
      : this.personalRootNotes;
    if (roots) {
      const nextRoots = roots.filter((candidate) => candidate.id !== noteId);
      if (nextRoots.length !== roots.length) {
        replaceArrayContents(roots, nextRoots);
      }
    }

    const nextHistory = this.historyNotes.filter((candidate) => candidate.id !== noteId || (candidate.teamPath || null) !== scope);
    if (nextHistory.length !== this.historyNotes.length) {
      replaceArrayContents(this.historyNotes, nextHistory);
    }

    this.emitEntityChanged(existing);
  }

  private applyPredictedFolderDelete(scope: ModelScope, folderId: string): void {
    const folderMap = this.getFolderScopeMap(scope);
    const folder = folderMap.get(folderId);
    if (!folder) {
      return;
    }

    const promotedParentId = folder.parentId || null;

    // Promote child folders to deleted folder's parent to preserve hierarchy continuity.
    for (const candidate of folderMap.values()) {
      if (candidate.id === folderId) {
        continue;
      }
      if ((candidate.parentId || null) === folderId) {
        candidate.parentId = promotedParentId;
        this.applyPredictedFolderPlacement(scope, candidate);
      }
    }

    // Promote direct notes to deleted folder's parent/root.
    for (const note of folder.notes) {
      if ((note.parentFolderId || null) !== promotedParentId) {
        note.parentFolderId = promotedParentId;
        this.emitEntityChanged(note);
      }
      this.applyPredictedNotePlacement(scope, note);
    }

    folderMap.delete(folderId);

    for (const candidate of folderMap.values()) {
      const nextChildren = candidate.children.filter((child) => child.id !== folderId);
      if (nextChildren.length !== candidate.children.length) {
        replaceArrayContents(candidate.children, nextChildren);
      }
    }

    const roots = scope
      ? this.teamsByPath.get(scope)?.rootFolders
      : this.personalRootFolders;
    if (roots) {
      const nextRoots = roots.filter((candidate) => candidate.id !== folderId);
      if (nextRoots.length !== roots.length) {
        replaceArrayContents(roots, nextRoots);
      }
    }

    this.emitEntityChanged(folder);
  }

  private hydrateUpdatedNotePayload(scope: ModelScope, noteId: string, updated: Partial<Note> | null | undefined): Note {
    const existing = this.getNoteById(noteId, scope);
    const merged = mergeDefinedProps((existing as any || {}) as Record<string, any>, (updated as any || {}) as Record<string, any>);
    const title = Object.prototype.hasOwnProperty.call(merged, 'title')
      ? merged.title
      : (existing?.title ?? '');
    return {
      ...merged,
      id: noteId,
      teamPath: scope,
      title,
    } as Note;
  }

  private hydrateUpdatedFolderPayload(scope: ModelScope, folderId: string, updated: Partial<HackMdFolder> | null | undefined): HackMdFolder {
    const existing = this.getFolderById(folderId, scope);
    const merged = mergeDefinedProps((existing as any || {}) as Record<string, any>, (updated as any || {}) as Record<string, any>);
    const name = Object.prototype.hasOwnProperty.call(merged, 'name')
      ? merged.name
      : (existing?.name ?? 'Folder');
    return {
      ...merged,
      id: folderId,
      teamPath: scope,
      name,
    } as HackMdFolder;
  }

  private syncTeams(teams: Team[]): boolean {
    const incomingById = new Map<string, Team>();
    const existingTeamIds = new Set(this.teams.keys());
    let changed = false;

    for (const team of teams) {
      incomingById.set(team.id, team);
      let modelTeam = this.teams.get(team.id);
      if (!modelTeam) {
        modelTeam = {
          type: 'team',
          id: team.id,
          path: team.path,
          name: team.name,
          rootFolders: [],
          rootNotes: [],
        };
        this.teams.set(team.id, modelTeam);
        this.emitEntityChanged(modelTeam);
        changed = true;
      } else {
        const oldPath = modelTeam.path;
        const teamMetaChanged = modelTeam.path !== team.path || modelTeam.name !== team.name;
        modelTeam.path = team.path;
        modelTeam.name = team.name;
        if (oldPath !== modelTeam.path) {
          this.teamsByPath.delete(oldPath);
        }
        if (teamMetaChanged) {
          this.emitEntityChanged(modelTeam);
          changed = true;
        }
      }
      this.teamsByPath.set(modelTeam.path, modelTeam);
      existingTeamIds.delete(team.id);
    }

    for (const teamId of existingTeamIds) {
      const existing = this.teams.get(teamId);
      if (existing) {
        this.teams.delete(teamId);
        this.teamsByPath.delete(existing.path);
        this.emitEntityChanged(existing);
        changed = true;
      }
    }

    const desiredOrder = teams
      .map((team) => this.teams.get(team.id))
      .filter((team): team is ModelTeam => !!team);
    if (reconcileArrayAsSetPreserveOrder(this.orderedTeams, desiredOrder)) {
      changed = true;
    }

    return changed;
  }

  private rebuildScope(teamPath: string | null, notes: Note[], folders: HackMdFolder[]): boolean {
    const folderMap = this.getFolderScopeMap(teamPath);
    const noteMap = this.getNoteScopeMap(teamPath);
    const scope = scopeKey(teamPath);
    let changed = false;

    const folderMetaById = new Map<string, any>();
    for (const note of notes) {
      for (const fp of note.folderPaths || []) {
        const prev = folderMetaById.get(fp.id) || {};
        folderMetaById.set(fp.id, {
          ...prev,
          ...fp,
          // Preserve whichever source has clientId metadata.
          clientId: fp.clientId !== undefined ? fp.clientId : (prev.clientId !== undefined ? prev.clientId : ''),
        });
      }
    }

    const desiredFolderIds = new Set<string>();
    for (const [id, meta] of folderMetaById.entries()) {
      desiredFolderIds.add(id);
      this.upsertFolder(teamPath, {
        id,
        name: meta.name !== undefined ? meta.name : 'Folder',
        path: meta.path,
        clientId: meta.clientId,
        parentFolderId: resolveParentFolderId(meta),
      });
    }

    for (const apiFolder of folders || []) {
      desiredFolderIds.add(apiFolder.id);
      const noteMeta = folderMetaById.get(apiFolder.id);
      const parentId = resolveParentFolderId(noteMeta) || resolveParentFolderId(apiFolder);
      this.upsertFolder(teamPath, {
        ...apiFolder,
        clientId: noteMeta?.clientId !== undefined
          ? noteMeta.clientId
          : (apiFolder.clientId !== undefined ? apiFolder.clientId : ''),
        parentFolderId: parentId,
      });
    }

    for (const folderId of [...folderMap.keys()]) {
      if (!desiredFolderIds.has(folderId)) {
        const removed = folderMap.get(folderId);
        folderMap.delete(folderId);
        if (removed) {
          this.emitEntityChanged(removed);
        }
        changed = true;
      }
    }

    const nextChildrenByFolder = new Map<string, ModelFolder[]>();
    const nextNotesByFolder = new Map<string, ModelNote[]>();
    const rootFolders: ModelFolder[] = [];
    for (const folder of folderMap.values()) {
      if (folder.parentId) {
        const parent = folderMap.get(folder.parentId);
        if (parent) {
          const nextChildren = nextChildrenByFolder.get(parent.id) || [];
          nextChildren.push(folder);
          nextChildrenByFolder.set(parent.id, nextChildren);
        } else {
          rootFolders.push(folder);
        }
      } else {
        rootFolders.push(folder);
      }
    }

    const desiredNoteIds = new Set<string>();
    const rootNotes: ModelNote[] = [];

    for (const apiNote of notes) {
      const note = this.upsertNote(teamPath, apiNote);
      desiredNoteIds.add(note.id);

      const folderPaths = note.folderPaths || [];
      const deepest = folderPaths.length > 0 ? folderPaths[folderPaths.length - 1] : undefined;
      const parentFolder = deepest ? folderMap.get(deepest.id) : undefined;
      const nextParentFolderId = parentFolder?.id || resolveParentFolderId(note);
      if (note.parentFolderId !== nextParentFolderId) {
        note.parentFolderId = nextParentFolderId;
        this.emitEntityChanged(note);
        changed = true;
      }

      if (parentFolder) {
        const nextNotes = nextNotesByFolder.get(parentFolder.id) || [];
        nextNotes.push(note);
        nextNotesByFolder.set(parentFolder.id, nextNotes);
      } else {
        rootNotes.push(note);
      }
    }

    for (const noteId of [...noteMap.keys()]) {
      if (!desiredNoteIds.has(noteId)) {
        const removed = noteMap.get(noteId);
        noteMap.delete(noteId);
        this.getContentLoadedSet(teamPath).delete(noteId);
        if (removed) {
          this.emitEntityChanged(removed);
        }
        changed = true;
      }
    }

    for (const folder of folderMap.values()) {
      if (reconcileArrayAsSetPreserveOrder(folder.children, nextChildrenByFolder.get(folder.id) || HackmdModel.EMPTY_FOLDERS)) {
        changed = true;
      }
      if (reconcileArrayAsSetPreserveOrder(folder.notes, nextNotesByFolder.get(folder.id) || HackmdModel.EMPTY_NOTES)) {
        changed = true;
      }
    }

    if (teamPath) {
      const team = this.teamsByPath.get(teamPath);
      if (team) {
        if (reconcileArrayAsSetPreserveOrder(team.rootFolders, rootFolders)) {
          changed = true;
        }
        if (reconcileArrayAsSetPreserveOrder(team.rootNotes, rootNotes)) {
          changed = true;
        }
      }
    } else {
      if (reconcileArrayAsSetPreserveOrder(this.personalRootFolders, rootFolders)) {
        changed = true;
      }
      if (reconcileArrayAsSetPreserveOrder(this.personalRootNotes, rootNotes)) {
        changed = true;
      }
    }

    if (!this.loadedScopes.has(scope)) {
      this.loadedScopes.add(scope);
      changed = true;
    }

    return changed;
  }

  private upsertFolder(teamPath: string | null, folder: Partial<HackMdFolder> & { id: string; name: string }): ModelFolder {
    const map = this.getFolderScopeMap(teamPath);
    let entity = map.get(folder.id);

    if (!entity) {
      entity = {
        type: 'folder',
        id: folder.id,
        name: folder.name !== undefined ? folder.name : 'Folder',
        path: folder.path,
        clientId: folder.clientId !== undefined ? folder.clientId : '',
        parentId: resolveParentFolderId(folder),
        teamPath,
        children: [],
        notes: [],
      };
      map.set(entity.id, entity);
      this.emitEntityChanged(entity);
    } else {
      let changed = false;

      const nextName = folder.name !== undefined ? folder.name : entity.name;
      if (entity.name !== nextName) {
        entity.name = nextName;
        changed = true;
      }

      const nextPath = folder.path !== undefined ? folder.path : entity.path;
      if (entity.path !== nextPath) {
        entity.path = nextPath;
        changed = true;
      }

      const nextClientId = folder.clientId !== undefined
        ? folder.clientId
        : (entity.clientId !== undefined ? entity.clientId : '');
      if (entity.clientId !== nextClientId) {
        entity.clientId = nextClientId;
        changed = true;
      }

      const nextParentId = resolveParentFolderId(folder);
      if (entity.parentId !== nextParentId) {
        entity.parentId = nextParentId;
        changed = true;
      }

      if (entity.teamPath !== teamPath) {
        entity.teamPath = teamPath;
        changed = true;
      }

      if (changed) {
        this.emitEntityChanged(entity);
      }
    }

    return entity;
  }

  private reconcileFolderPlacement(teamPath: ModelScope, folder: ModelFolder): boolean {
    const key = scopeKey(teamPath);
    if (!this.loadedScopes.has(key)) {
      return false;
    }

    const map = this.getFolderScopeMap(teamPath);
    const roots = teamPath
      ? this.teamsByPath.get(teamPath)?.rootFolders
      : this.personalRootFolders;

    if (!roots) {
      return false;
    }

    let changed = false;

    for (const candidate of map.values()) {
      if (candidate === folder) {
        continue;
      }
      const nextChildren = candidate.children.filter((child) => child !== folder);
      if (nextChildren.length !== candidate.children.length) {
        replaceArrayContents(candidate.children, nextChildren);
        changed = true;
      }
    }

    const nextRoots = roots.filter((candidate) => candidate !== folder);
    if (nextRoots.length !== roots.length) {
      replaceArrayContents(roots, nextRoots);
      changed = true;
    }

    const parent = folder.parentId ? map.get(folder.parentId) : undefined;
    if (parent) {
      if (parent.children.indexOf(folder) === -1) {
        parent.children.push(folder);
        changed = true;
      }
    } else if (roots.indexOf(folder) === -1) {
      roots.push(folder);
      changed = true;
    }

    return changed;
  }

  private upsertNote(teamPath: string | null, note: Note, markContentLoaded = false): ModelNote {
    const map = this.getNoteScopeMap(teamPath);
    let entity = map.get(note.id);

    if (!entity) {
      const initialParentFolderId = resolveParentFolderId(note);
      entity = {
        type: 'note',
        id: note.id,
        title: note.title,
        shortId: note.shortId,
        teamPath,
        content: markContentLoaded ? note.content : undefined,
        publishLink: note.publishLink,
        publishType: note.publishType,
        permalink: note.permalink,
        userPath: note.userPath,
        folderPaths: note.folderPaths,
        parentFolderId: initialParentFolderId,
        parentForderId: note.parentForderId,
        readPermission: note.readPermission,
        writePermission: note.writePermission,
        tags: note.tags,
        createdAt: note.createdAt,
        lastChangedAt: note.lastChangedAt,
      };
      map.set(entity.id, entity);
      this.emitEntityChanged(entity);
    } else {
      let changed = false;

      if (note.title !== undefined && entity.title !== note.title) {
        entity.title = note.title;
        changed = true;
      }
      if (note.shortId !== undefined && entity.shortId !== note.shortId) {
        entity.shortId = note.shortId;
        changed = true;
      }
      if (note.teamPath !== undefined && entity.teamPath !== note.teamPath) {
        entity.teamPath = note.teamPath;
        changed = true;
      }
      if (markContentLoaded && note.content !== undefined && entity.content !== note.content) {
        entity.content = note.content;
        changed = true;
      }
      if (note.publishLink !== undefined && entity.publishLink !== note.publishLink) {
        entity.publishLink = note.publishLink;
        changed = true;
      }
      if (note.publishType !== undefined && entity.publishType !== note.publishType) {
        entity.publishType = note.publishType;
        changed = true;
      }
      if (note.permalink !== undefined && entity.permalink !== note.permalink) {
        entity.permalink = note.permalink;
        changed = true;
      }
      if (note.userPath !== undefined && entity.userPath !== note.userPath) {
        entity.userPath = note.userPath;
        changed = true;
      }
      if (note.folderPaths !== undefined && !folderPathsEqual(entity.folderPaths, note.folderPaths)) {
        entity.folderPaths = note.folderPaths;
        changed = true;
      }
      const apiParentFolderId = resolveParentFolderId(note);
      if (
        (note.parentFolderId !== undefined || note.parentForderId !== undefined)
        && entity.parentFolderId !== apiParentFolderId
      ) {
        entity.parentFolderId = apiParentFolderId;
        changed = true;
      }
      if (note.parentForderId !== undefined && entity.parentForderId !== note.parentForderId) {
        entity.parentForderId = note.parentForderId;
        changed = true;
      }
      if (note.readPermission !== undefined && entity.readPermission !== note.readPermission) {
        entity.readPermission = note.readPermission;
        changed = true;
      }
      if (note.writePermission !== undefined && entity.writePermission !== note.writePermission) {
        entity.writePermission = note.writePermission;
        changed = true;
      }
      if (note.tags !== undefined && !stringArrayEqual(entity.tags, note.tags)) {
        entity.tags = note.tags;
        changed = true;
      }
      if (note.createdAt !== undefined && entity.createdAt !== note.createdAt) {
        entity.createdAt = note.createdAt;
        changed = true;
      }
      if (note.lastChangedAt !== undefined && entity.lastChangedAt !== note.lastChangedAt) {
        entity.lastChangedAt = note.lastChangedAt;
        changed = true;
        // The server reports a newer modification time but the list API doesn't
        // carry content.  Evict the cached content so the next getNoteContent
        // call re-fetches it instead of returning stale data.
        if (!markContentLoaded) {
          this.getContentLoadedSet(teamPath).delete(note.id);
        }
      }

      if (changed) {
        this.emitEntityChanged(entity);
      }
    }

    if (markContentLoaded) {
      this.getContentLoadedSet(teamPath).add(note.id);
    }

    return entity;
  }

  private reconcileNotePlacement(teamPath: ModelScope, note: ModelNote): boolean {
    const key = scopeKey(teamPath);
    if (!this.loadedScopes.has(key)) {
      return false;
    }

    const folderMap = this.getFolderScopeMap(teamPath);
    const roots = teamPath
      ? this.teamsByPath.get(teamPath)?.rootNotes
      : this.personalRootNotes;

    if (!roots) {
      return false;
    }

    let changed = false;

    for (const folder of folderMap.values()) {
      const nextNotes = folder.notes.filter((candidate) => candidate !== note);
      if (nextNotes.length !== folder.notes.length) {
        replaceArrayContents(folder.notes, nextNotes);
        changed = true;
      }
    }

    const nextRoots = roots.filter((candidate) => candidate !== note);
    if (nextRoots.length !== roots.length) {
      replaceArrayContents(roots, nextRoots);
      changed = true;
    }

    const parent = note.parentFolderId ? folderMap.get(note.parentFolderId) : undefined;
    if (parent) {
      if (parent.notes.indexOf(note) === -1) {
        parent.notes.push(note);
        changed = true;
      }
    } else if (roots.indexOf(note) === -1) {
      roots.push(note);
      changed = true;
    }

    return changed;
  }

  private emitEntityChanged(entity: ModelEntity): void {
    this.entityChangeVersion += 1;

    const event: ModelEntityChangedEvent = { entity };
    if (this.entityEventBatchDepth > 0) {
      this.batchedEntityEvents.push(event);
      return;
    }
    this.didChangeEntity.emit(event);
  }

  private async withPendingOperation<T>(
    target:
      | { targetType: 'my-notes' }
      | { targetType: 'teams' }
      | { targetType: 'recent-notes' }
      | { targetType: 'team'; teamPath: string }
      | { targetType: 'folder'; scope: ModelScope; id: string }
      | { targetType: 'note'; scope: ModelScope; id: string },
    action: () => Promise<T>
  ): Promise<T> {
    const entity: ModelEntity | undefined = target.targetType === 'my-notes'
      ? this.myNotesEntity
      : target.targetType === 'teams'
        ? this.teamsEntity
        : target.targetType === 'recent-notes'
          ? this.recentNotesEntity
          : target.targetType === 'team'
            ? this.teamsByPath.get(target.teamPath)
            : target.targetType === 'folder'
              ? this.getFolderById(target.id, target.scope)
              : this.getNoteById(target.id, target.scope);

    const prev = entity ? (this.pendingCounts.get(entity) || 0) : 0;
    if (entity) {
      this.pendingCounts.set(entity, prev + 1);
      if (prev === 0) {
        this.didChangePending.emit({ entity, pending: true });
      }
    }

    try {
      return await action();
    } finally {
      if (entity) {
        const next = (this.pendingCounts.get(entity) || 1) - 1;
        if (next <= 0) {
          this.pendingCounts.delete(entity);
          this.didChangePending.emit({ entity, pending: false });
        } else {
          this.pendingCounts.set(entity, next);
        }
      }
    }
  }

  private async withScopePending<T>(scope: ModelScope, action: () => Promise<T>): Promise<T> {
    if (scope) {
      return this.withPendingOperation(
        { targetType: 'teams' },
        async () => this.withPendingOperation({ targetType: 'team', teamPath: scope }, action)
      );
    }

    return this.withPendingOperation({ targetType: 'my-notes' }, action);
  }

  private withEntityEventBatch<T>(fn: () => T): T {
    this.entityEventBatchDepth += 1;
    try {
      return fn();
    } finally {
      this.entityEventBatchDepth -= 1;
      if (this.entityEventBatchDepth === 0 && this.batchedEntityEvents.length > 0) {
        const toEmit = this.batchedEntityEvents.splice(0, this.batchedEntityEvents.length);
        for (const event of toEmit) {
          this.didChangeEntity.emit(event);
        }
      }
    }
  }

  private getFolderNamePath(folder: ModelFolder): string[] {
    const names: string[] = [];
    const scopeMap = this.getFolderScopeMap(folder.teamPath);
    const visited = new Set<string>();
    let current: ModelFolder | undefined = folder;

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      names.push(current.name || 'Folder');
      current = current.parentId ? scopeMap.get(current.parentId) : undefined;
    }

    names.reverse();
    return names;
  }

  private parseHackmdUri(uri: vscode.Uri): { noteId?: string; folderId?: string; teamPath: string | null } {
    const params = new URLSearchParams(uri.query || '');
    const noteId = params.get('noteId') || undefined;
    const folderId = params.get('folderId') || undefined;
    let teamPath = params.get('teamPath');
    if (!teamPath) {
      const parts = (uri.path || '').split('/').filter(Boolean);
      if (parts.length >= 2 && parts[0] === 'Teams') {
        teamPath = decodeURIComponent(parts[1]);
      }
    }

    return {
      noteId,
      folderId,
      teamPath,
    };
  }

  private async fetchNote(teamPath: string | null, noteId: string): Promise<ModelNote> {
    const key = `${scopeKey(teamPath)}::${noteId}`;
    const inflight = this.noteFetchPromises.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      const note = teamPath
        ? await recordUsage(this.api.getTeamNote(teamPath, noteId, { unwrapData: false }))
        : await recordUsage(this.api.getNote(noteId, { unwrapData: false }));
      return this.upsertNote(teamPath, note, true);
    })();

    this.noteFetchPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.noteFetchPromises.delete(key);
    }
  }

  private async fetchFolder(teamPath: string | null, folderId: string): Promise<ModelFolder> {
    const key = `${scopeKey(teamPath)}::${folderId}`;
    const inflight = this.folderFetchPromises.get(key);
    if (inflight) {
      return inflight;
    }

    const promise = (async () => {
      const folder = teamPath
        ? await recordUsage(this.api.getTeamFolder(teamPath, folderId, { unwrapData: false }))
        : await recordUsage(this.api.getFolder(folderId, { unwrapData: false }));
      return this.upsertFolder(teamPath, folder);
    })();

    this.folderFetchPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.folderFetchPromises.delete(key);
    }
  }

  private getContentLoadedSet(teamPath?: string | null): Set<string> {
    const key = scopeKey(teamPath);
    let set = this.contentLoadedByScope.get(key);
    if (!set) {
      set = new Set<string>();
      this.contentLoadedByScope.set(key, set);
    }
    return set;
  }

  private getFolderScopeMap(teamPath?: string | null): Map<string, ModelFolder> {
    const key = scopeKey(teamPath);
    let map = this.foldersByScope.get(key);
    if (!map) {
      map = new Map<string, ModelFolder>();
      this.foldersByScope.set(key, map);
    }
    return map;
  }

  private getNoteScopeMap(teamPath?: string | null): Map<string, ModelNote> {
    const key = scopeKey(teamPath);
    let map = this.notesByScope.get(key);
    if (!map) {
      map = new Map<string, ModelNote>();
      this.notesByScope.set(key, map);
    }
    return map;
  }
}
