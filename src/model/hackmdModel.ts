import * as vscode from 'vscode';

import { HackMdApiClient, HackMdFolder, Note, Team } from '../api/hackmdApiClient';
import { recordUsage } from '../store';

interface ModelDisposable {
  dispose(): void;
}

interface ModelEvent<T> {
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

export interface ModelScopeSnapshot {
  rootFolders: readonly ModelFolder[];
  rootNotes: readonly ModelNote[];
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

export interface CreateNoteInput {
  teamPath?: string | null;
  title?: string;
  content?: string;
  parentFolderId?: string | null;
}

export interface CreateFolderInput {
  teamPath?: string | null;
  name: string;
  parentFolderId?: string | null;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  permalink?: string | null;
  readPermission?: string;
  writePermission?: string;
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
  private readonly orphanScopesByPath = new Map<string, ModelTeam>();
  private readonly orderedTeams: ModelTeam[] = [];

  private readonly foldersByScope = new Map<ModelMyNotes | ModelTeam, Map<string, ModelFolder>>();
  private readonly notesByScope = new Map<ModelMyNotes | ModelTeam, Map<string, ModelNote>>();

  private readonly personalRootFolders: ModelFolder[] = [];
  private readonly personalRootNotes: ModelNote[] = [];

  private readonly historyNotes: ModelNote[] = [];
  private readonly loadedScopes = new Set<ModelMyNotes | ModelTeam>();
  private readonly contentLoadedByScope = new Map<ModelMyNotes | ModelTeam, Set<string>>();

  private refreshTeamsPromise: Promise<void> | null = null;
  private refreshHistoryPromise: Promise<void> | null = null;
  private readonly refreshScopePromises = new Map<ModelMyNotes | ModelTeam, Promise<void>>();
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

  isPending(entity: ModelEntity): boolean {
    return (this.pendingCounts.get(entity) || 0) > 0;
  }

  getTeams(): readonly ModelTeam[] {
    return this.orderedTeams;
  }

  getScopeEntityForItem(item: ModelMyNotes | ModelTeam | ModelFolder | ModelNote): ModelMyNotes | ModelTeam {
    if (item.type === 'my-notes') return this.myNotesEntity;
    if (item.type === 'team') return this.scopeEntityForCleanup(item.path);
    return this.scopeEntityForCleanup(item.teamPath || null);
  }

  getImmediateParentContainer(item: ModelNote | ModelFolder | ModelTeam): ModelMyNotes | ModelTeam | ModelFolder | ModelTeams {
    if (item.type === 'team') {
      return this.teamsEntity;
    }

    const scope = this.scopeEntityForCleanup(item.teamPath || null);

    if (item.type === 'folder') {
      const folder = item.parentId !== undefined
        ? item
        : (this.getFolderSync(scope, item.id) || item);
      const parentFolderId = folder.parentId || null;
      if (!parentFolderId) {
        return scope;
      }
      return this.getFolderSync(scope, parentFolderId) || scope;
    }

    let parentFolderId = resolveParentFolderId(item);
    if (!parentFolderId) {
      const cachedNote = this.getNoteSync(scope, item.id);
      parentFolderId = resolveParentFolderId(cachedNote || undefined);
    }

    if (!parentFolderId) {
      return scope;
    }
    return this.getFolderSync(scope, parentFolderId) || scope;
  }

  getHistoryNotes(): readonly ModelNote[] {
    return this.historyNotes;
  }

  getScopeSnapshotSync(scope: ModelMyNotes | ModelTeam): ModelScopeSnapshot | null {
    if (scope.type === 'team') {
      if (!this.loadedScopes.has(scope)) {
        return null;
      }
      return {
        rootFolders: scope.rootFolders,
        rootNotes: scope.rootNotes,
      };
    }

    if (!this.loadedScopes.has(scope)) {
      return null;
    }
    return {
      rootFolders: this.personalRootFolders,
      rootNotes: this.personalRootNotes,
    };
  }

  async getScopeSnapshot(scope: ModelMyNotes | ModelTeam): Promise<ModelScopeSnapshot> {
    const existing = this.getScopeSnapshotSync(scope);
    if (existing) {
      return existing;
    }

    const teamPath = scope.type === 'team' ? scope.path : null;
    await this.refreshScopeImpl(teamPath);
    return this.getScopeSnapshotSync(scope) || {
      rootFolders: [],
      rootNotes: [],
    };
  }

  getNoteSync(scope: ModelMyNotes | ModelTeam, noteId: string): ModelNote | null {
    const teamPath = scope.type === 'team' ? scope.path : null;
    return this.getNoteScopeMap(teamPath).get(noteId) || null;
  }

  async getNote(scope: ModelMyNotes | ModelTeam, noteId: string): Promise<ModelNote | null> {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const cached = this.getNoteSync(scope, noteId);
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

  getNoteContentSync(note: ModelNote): string | null {
    const contentSet = this.getContentLoadedSet(note.teamPath);
    if (!contentSet || !contentSet.has(note.id)) {
      return null;
    }
    return note.content ?? '';
  }

  async getNoteContent(note: ModelNote): Promise<string | null> {
    const existing = this.getNoteContentSync(note);
    if (existing !== null) {
      return existing;
    }

    const scope = note.teamPath || null;
    const fetched = await this.withPendingOperation(note, async () => {
      return this.fetchNote(scope, note.id);
    });
    return fetched.content ?? '';
  }

  toUri(entity: ModelNote | ModelFolder | ModelTeam): vscode.Uri {
    if (entity.type === 'note') {
      const note = entity;
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

    if (entity.type === 'folder') {
      const folder = entity;
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

    // team
    const team = entity;
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
      return this.getNoteSync(this.scopeEntityForCleanup(parsed.teamPath ?? null), parsed.noteId);
    }
    if (parsed.folderId) {
      return this.getFolderSync(this.scopeEntityForCleanup(parsed.teamPath ?? null), parsed.folderId) || null;
    }
    if (parsed.teamPath) {
      return this.teamsByPath.get(parsed.teamPath) || null;
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
          await this.refresh(this.teamsEntity);
          return this.teamsByPath.get(parsed.teamPath) || null;
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

  getFolderSync(scope: ModelMyNotes | ModelTeam, folderId: string): ModelFolder | undefined {
    const teamPath = scope.type === 'team' ? scope.path : null;
    return this.getFolderScopeMap(teamPath).get(folderId);
  }

  async refresh(entity: ModelRoot | ModelTeams | ModelMyNotes | ModelRecentNotes | ModelTeam): Promise<void> {
    switch (entity.type) {
      case 'model-root':
        await Promise.all([
          this.refresh(this.teamsEntity),
          this.refresh(this.myNotesEntity),
          this.refresh(this.recentNotesEntity),
        ]);
        for (const team of this.orderedTeams) {
          await this.refresh(team);
        }
        return;

      case 'teams':
        if (this.refreshTeamsPromise) {
          return this.refreshTeamsPromise;
        }
        this.refreshTeamsPromise = this.withPendingOperation(
          this.teamsEntity,
          async () => {
            const teams = await recordUsage(this.api.getTeams({ unwrapData: false }));
            this.withEntityEventBatch(() => {
              this.syncTeams(teams || []);
            });
          }
        ).finally(() => { this.refreshTeamsPromise = null; });
        return this.refreshTeamsPromise;

      case 'my-notes':
        return this.refreshScopeImpl(null);

      case 'recent-notes':
        if (this.refreshHistoryPromise) {
          return this.refreshHistoryPromise;
        }
        this.refreshHistoryPromise = this.withPendingOperation(
          this.recentNotesEntity,
          async () => {
            const notes = await recordUsage(this.api.getHistory({ unwrapData: false }));
            const next: ModelNote[] = [];
            this.withEntityEventBatch(() => {
              for (const note of notes || []) {
                const modelNote = this.upsertHistoryNote(note);
                next.push(modelNote);
              }
            });
            if (reconcileArrayAsSetPreserveOrder(this.historyNotes, next)) {
              // History notes array changed - emit on container
              this.emitEntityChanged(this.recentNotesEntity);
            }
          }
        ).finally(() => { this.refreshHistoryPromise = null; });
        return this.refreshHistoryPromise;

      case 'team':
        return this.refreshScopeImpl(entity.path);
    }
  }

  private async refreshScopeImpl(teamPath: string | null): Promise<void> {
    const scopeEntity: ModelMyNotes | ModelTeam | undefined = teamPath ? this.teamsByPath.get(teamPath) : this.myNotesEntity;
    if (!scopeEntity) {
      return;
    }
    const inflight = this.refreshScopePromises.get(scopeEntity);
    if (inflight) {
      return inflight;
    }

    const promise = teamPath
      ? this.withPendingOperation(
        this.teamsEntity,
        () => this.withPendingOperation(this.teamsByPath.get(teamPath), async () => {
          const team = this.teamsByPath.get(teamPath);
          const [notes, folders] = await Promise.all([
            recordUsage(this.api.getTeamNotes(teamPath, { unwrapData: false })),
            recordUsage(this.api.getTeamFolders(teamPath, { unwrapData: false })),
          ]);
          if (team) {
            this.withEntityEventBatch(() => {
              this.rebuildScope(team, notes || [], folders || []);
            });
          }
        })
      )
      : this.withPendingOperation(this.myNotesEntity, async () => {
        const [notes, folders] = await Promise.all([
          recordUsage(this.api.getNoteList({ unwrapData: false })),
          recordUsage(this.api.getFolders({ unwrapData: false })),
        ]);
        this.withEntityEventBatch(() => {
          this.rebuildScope(this.myNotesEntity, notes || [], folders || []);
        });
      });

    this.refreshScopePromises.set(scopeEntity, promise);
    try {
      await promise;
    } finally {
      this.refreshScopePromises.delete(scopeEntity);
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
      const scopeEntity = teamPath ? (this.teamsByPath.get(teamPath) ?? null) : this.myNotesEntity;
      const getScopeSnapshotPromise = scopeEntity ? this.getScopeSnapshot(scopeEntity) : null;
      const note = teamPath
        ? await recordUsage(this.api.createTeamNote(teamPath, payload, { unwrapData: false }))
        : await recordUsage(this.api.createNote(payload, { unwrapData: false }));
      if (getScopeSnapshotPromise) { await getScopeSnapshotPromise; }

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
      }

      if (scopeEntity) {
        const changedFolders = this.reconcileNotePlacement(scopeEntity, entity);
        if (changedFolders.size === 0 && !entity.parentFolderId) {
          // Note was created at root level; emit on scope container
          this.emitEntityChanged(scopeEntity);
        } else {
          this.emitDeduplicatedFolderChanges(scopeEntity, changedFolders);
        }
      }
      return entity;
    };

    if (parentFolderId) {
      return this.withPendingOperation(this.getFolderSync(this.scopeEntityForCleanup(teamPath), parentFolderId), create);
    }

    if (teamPath) {
      return this.withPendingOperation(this.teamsByPath.get(teamPath), create);
    }

    return this.withPendingOperation(this.myNotesEntity, create);
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
      const scopeEntity = teamPath ? (this.teamsByPath.get(teamPath) ?? null) : this.myNotesEntity;
      const getScopeSnapshotPromise = scopeEntity ? this.getScopeSnapshot(scopeEntity) : null;
      const folder = teamPath
        ? await recordUsage(this.api.createTeamFolder(teamPath, payload, { unwrapData: false }))
        : await recordUsage(this.api.createFolder(payload, { unwrapData: false }));
      if (getScopeSnapshotPromise) { await getScopeSnapshotPromise; }

      const responseParentFolderId = resolveParentFolderId(folder as any);
      const effectiveParentFolderId = responseParentFolderId ?? parentFolderId;
      const entity = this.upsertFolder(teamPath, {
        ...folder,
        parentFolderId: effectiveParentFolderId,
      });

      if (entity.parentId !== effectiveParentFolderId) {
        entity.parentId = effectiveParentFolderId;
      }

      if (scopeEntity) {
        const changedFolders = this.reconcileFolderPlacement(scopeEntity, entity);
        if (changedFolders.size === 0 && !entity.parentId) {
          // Folder was created at root level; emit on scope container
          this.emitEntityChanged(scopeEntity);
        } else {
          this.emitDeduplicatedFolderChanges(scopeEntity, changedFolders);
        }
      }
      return entity;
    };

    if (parentFolderId) {
      return this.withPendingOperation(this.getFolderSync(this.scopeEntityForCleanup(teamPath), parentFolderId), create);
    }

    if (teamPath) {
      return this.withPendingOperation(this.teamsByPath.get(teamPath), create);
    }

    return this.withPendingOperation(this.myNotesEntity, create);
  }

  async updateNote(note: ModelNote, input: UpdateNoteInput): Promise<ModelNote> {
    const noteId = note.id;
    const scope = note.teamPath || null;
    const markContentLoaded = input.content !== undefined;
    return this.withPendingOperation(note, async () => {
      await (scope
        ? await recordUsage(this.api.updateTeamNote(scope, noteId, input as any, { unwrapData: false }))
        : await recordUsage(this.api.updateNote(noteId, input as any, { unwrapData: false })));

      const hydratedNote = this.hydrateUpdatedNotePayload(this.scopeEntityForCleanup(scope), noteId, input as Partial<Note>);
      const entity = this.upsertNote(scope, hydratedNote, markContentLoaded);
      this.applyPredictedNotePlacement(this.scopeEntityForCleanup(scope), entity);
      return entity;
    });
  }

  async updateFolder(folder: ModelFolder, input: UpdateFolderInput): Promise<ModelFolder> {
    const folderId = folder.id;
    const scope = folder.teamPath || null;
    return this.withPendingOperation(folder, async () => {
      const updated = scope
        ? await recordUsage(this.api.updateTeamFolder(scope, folderId, input as any, { unwrapData: false }))
        : await recordUsage(this.api.updateFolder(folderId, input as any, { unwrapData: false }));

      const hydratedFolder = this.hydrateUpdatedFolderPayload(this.scopeEntityForCleanup(scope), folderId, updated);
      const entity = this.upsertFolder(scope, hydratedFolder);
      this.applyPredictedFolderPlacement(this.scopeEntityForCleanup(scope), entity);
      return entity;
    });
  }

  async moveNote(note: ModelNote, destination: ModelMyNotes | ModelTeam | ModelFolder): Promise<ModelNote> {
    if (destination.type !== 'folder') {
      throw new Error('Moving notes to non-folder destinations is not supported.');
    }
    const noteScope = note.teamPath || null;
    const destScope = destination.teamPath || null;
    if (noteScope !== destScope) {
      throw new Error('Moving notes between scopes is not supported.');
    }
    if ((note.parentFolderId ?? null) === destination.id) {
      return note;
    }
    const targetParentFolderId = destination.id;
    return this.withPendingOperation(note, async () => {
      const patch = { parentFolderId: targetParentFolderId };
      const updated = noteScope
        ? await recordUsage(this.api.updateTeamNote(noteScope, note.id, patch as any, { unwrapData: false }))
        : await recordUsage(this.api.updateNote(note.id, patch as any, { unwrapData: false }));

      const hydratedNote = this.hydrateUpdatedNotePayload(this.scopeEntityForCleanup(noteScope), note.id, updated);
      const entity = this.upsertNote(noteScope, hydratedNote, false);
      if (entity.parentFolderId !== targetParentFolderId) {
        entity.parentFolderId = targetParentFolderId;
        this.emitEntityChanged(entity);
      }
      this.applyPredictedNotePlacement(this.scopeEntityForCleanup(noteScope), entity);
      return entity;
    });
  }

  async moveFolder(folder: ModelFolder, destination: ModelMyNotes | ModelTeam | ModelFolder): Promise<ModelFolder> {
    if (destination.type !== 'folder') {
      throw new Error('Moving folders to non-folder destinations is not supported.');
    }
    const folderScope = folder.teamPath || null;
    const destScope = destination.teamPath || null;
    if (folderScope !== destScope) {
      throw new Error('Moving folders between scopes is not supported.');
    }
    if (folder.id === destination.id) {
      throw new Error('Cannot move a folder into itself.');
    }
    // Check ancestor: destination must not be a descendant of folder
    const folderMap = this.getFolderScopeMap(folderScope);
    let cursor: ModelFolder | undefined = destination;
    while (cursor) {
      if (cursor.parentId === folder.id) {
        throw new Error('Cannot move a folder into one of its own descendants.');
      }
      cursor = cursor.parentId ? folderMap.get(cursor.parentId) : undefined;
    }
    if ((folder.parentId ?? null) === destination.id) {
      return folder;
    }
    const targetParentFolderId = destination.id;
    return this.withPendingOperation(folder, async () => {
      const patch = { parentFolderId: targetParentFolderId };
      const updated = folderScope
        ? await recordUsage(this.api.updateTeamFolder(folderScope, folder.id, patch as any, { unwrapData: false }))
        : await recordUsage(this.api.updateFolder(folder.id, patch as any, { unwrapData: false }));

      const hydratedFolder = this.hydrateUpdatedFolderPayload(this.scopeEntityForCleanup(folderScope), folder.id, updated);
      const entity = this.upsertFolder(folderScope, hydratedFolder);
      if ((entity.parentId ?? null) !== targetParentFolderId) {
        entity.parentId = targetParentFolderId;
        this.emitEntityChanged(entity);
      }
      this.applyPredictedFolderPlacement(this.scopeEntityForCleanup(folderScope), entity);
      return entity;
    });
  }

  async deleteNote(note: ModelNote): Promise<void> {
    const scope = note.teamPath || null;
    const noteId = note.id;
    await this.withPendingOperation(note, async () => {
      if (scope) {
        await recordUsage(this.api.deleteTeamNote(scope, noteId, { unwrapData: false }));
      } else {
        await recordUsage(this.api.deleteNote(noteId, { unwrapData: false }));
      }

      this.applyPredictedNoteDelete(this.scopeEntityForCleanup(scope), noteId);
    });
  }

  async deleteFolder(folder: ModelFolder): Promise<void> {
    const scope = folder.teamPath || null;
    const folderId = folder.id;
    await this.withPendingOperation(folder, async () => {
      if (scope) {
        await recordUsage(this.api.deleteTeamFolder(scope, folderId, { unwrapData: false }));
      } else {
        await recordUsage(this.api.deleteFolder(folderId, { unwrapData: false }));
      }

      this.applyPredictedFolderDelete(this.scopeEntityForCleanup(scope), folderId);
    });
  }

  private applyPredictedNotePlacement(scope: ModelMyNotes | ModelTeam, note: ModelNote): void {
    const changedFolders = this.reconcileNotePlacement(scope, note);
    this.emitDeduplicatedFolderChanges(scope, changedFolders);
  }

  private applyPredictedFolderPlacement(scope: ModelMyNotes | ModelTeam, folder: ModelFolder): void {
    const changedFolders = this.reconcileFolderPlacement(scope, folder);
    this.emitDeduplicatedFolderChanges(scope, changedFolders);
  }

  private applyPredictedNoteDelete(scope: ModelMyNotes | ModelTeam, noteId: string): void {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const noteMap = this.getNoteScopeMap(teamPath);
    const existing = noteMap.get(noteId);
    if (!existing) {
      return;
    }

    const wasRootLevel = !existing.parentFolderId;
    let parentFolder: ModelFolder | undefined;

    noteMap.delete(noteId);
    this.getContentLoadedSet(teamPath).delete(noteId);

    for (const folder of this.getFolderScopeMap(teamPath).values()) {
      const nextNotes = folder.notes.filter((candidate) => candidate.id !== noteId);
      if (nextNotes.length !== folder.notes.length) {
        replaceArrayContents(folder.notes, nextNotes);
        if (!parentFolder && folder.id === existing.parentFolderId) {
          parentFolder = folder;
        }
      }
    }

    const roots = scope.type === 'team'
      ? scope.rootNotes
      : this.personalRootNotes;
    if (roots) {
      const nextRoots = roots.filter((candidate) => candidate.id !== noteId);
      if (nextRoots.length !== roots.length) {
        replaceArrayContents(roots, nextRoots);
      }
    }

    let historyChanged = false;
    const nextHistory = this.historyNotes.filter((candidate) => candidate.id !== noteId || (candidate.teamPath || null) !== teamPath);
    if (nextHistory.length !== this.historyNotes.length) {
      replaceArrayContents(this.historyNotes, nextHistory);
      historyChanged = true;
    }

    // Emit on the appropriate containers
    if (historyChanged) {
      // History array changed - emit on RecentNotes container
      this.emitEntityChanged(this.recentNotesEntity);
    }

    if (wasRootLevel) {
      // Root-level note deletion - emit on scope container
      this.emitEntityChanged(scope);
    } else if (parentFolder) {
      // Nested note deletion - emit on parent folder
      this.emitEntityChanged(parentFolder);
    }
  }

  private applyPredictedFolderDelete(scope: ModelMyNotes | ModelTeam, folderId: string): void {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const folderMap = this.getFolderScopeMap(teamPath);
    const folder = folderMap.get(folderId);
    if (!folder) {
      return;
    }

    const wasRootLevel = !folder.parentId;
    let parentFolder: ModelFolder | undefined;

    // Collect the full folder subtree that backend deletes: target folder + descendants.
    const deletedFolderIds = new Set<string>([folderId]);
    let foundMoreFolders = true;
    while (foundMoreFolders) {
      foundMoreFolders = false;
      for (const candidate of folderMap.values()) {
        if (deletedFolderIds.has(candidate.id)) {
          continue;
        }
        if (candidate.parentId && deletedFolderIds.has(candidate.parentId)) {
          deletedFolderIds.add(candidate.id);
          foundMoreFolders = true;
        }
      }
    }

    const noteMap = this.getNoteScopeMap(teamPath);
    const contentLoaded = this.getContentLoadedSet(teamPath);
    const deletedNoteIds = new Set<string>();

    // Remove all notes that belong to any deleted folder in the subtree.
    for (const note of noteMap.values()) {
      if (note.parentFolderId && deletedFolderIds.has(note.parentFolderId)) {
        deletedNoteIds.add(note.id);
      }
    }
    for (const noteId of deletedNoteIds) {
      noteMap.delete(noteId);
      contentLoaded.delete(noteId);
    }

    // Remove all folders in the subtree from the folder map.
    for (const deletedId of deletedFolderIds) {
      folderMap.delete(deletedId);
    }

    for (const candidate of folderMap.values()) {
      const nextChildren = candidate.children.filter((child) => !deletedFolderIds.has(child.id));
      if (nextChildren.length !== candidate.children.length) {
        replaceArrayContents(candidate.children, nextChildren);
        if (!parentFolder && candidate.id === folder.parentId) {
          parentFolder = candidate;
        }
      }
      const nextNotes = candidate.notes.filter((note) => !deletedNoteIds.has(note.id));
      if (nextNotes.length !== candidate.notes.length) {
        replaceArrayContents(candidate.notes, nextNotes);
      }
    }

    const roots = scope.type === 'team'
      ? scope.rootFolders
      : this.personalRootFolders;
    if (roots) {
      const nextRoots = roots.filter((candidate) => !deletedFolderIds.has(candidate.id));
      if (nextRoots.length !== roots.length) {
        replaceArrayContents(roots, nextRoots);
      }
    }

    const rootNotes = scope.type === 'team'
      ? scope.rootNotes
      : this.personalRootNotes;
    if (rootNotes) {
      const nextRootNotes = rootNotes.filter((note) => !deletedNoteIds.has(note.id));
      if (nextRootNotes.length !== rootNotes.length) {
        replaceArrayContents(rootNotes, nextRootNotes);
      }
    }

    // Keep RecentNotes consistent when deleted subtree contains notes.
    if (deletedNoteIds.size > 0) {
      const nextHistory = this.historyNotes.filter((note) => {
        if (!deletedNoteIds.has(note.id)) {
          return true;
        }
        return (note.teamPath || null) !== teamPath;
      });
      if (nextHistory.length !== this.historyNotes.length) {
        replaceArrayContents(this.historyNotes, nextHistory);
        this.emitEntityChanged(this.recentNotesEntity);
      }
    }

    // Emit on the appropriate container
    if (wasRootLevel) {
      // Root-level folder deletion - emit on scope container
      this.emitEntityChanged(scope);
    } else if (parentFolder) {
      // Nested folder deletion - emit on parent folder
      this.emitEntityChanged(parentFolder);
    }
  }

  private hydrateUpdatedNotePayload(scope: ModelMyNotes | ModelTeam, noteId: string, updated: Partial<Note> | null | undefined): Note {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const existing = this.getNoteSync(scope, noteId);
    const merged = mergeDefinedProps((existing as any || {}) as Record<string, any>, (updated as any || {}) as Record<string, any>);
    const title = Object.prototype.hasOwnProperty.call(merged, 'title')
      ? merged.title
      : (existing?.title ?? '');
    return {
      ...merged,
      id: noteId,
      teamPath,
      title,
    } as Note;
  }

  private hydrateUpdatedFolderPayload(scope: ModelMyNotes | ModelTeam, folderId: string, updated: Partial<HackMdFolder> | null | undefined): HackMdFolder {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const existing = this.getFolderSync(scope, folderId);
    const merged = mergeDefinedProps((existing as any || {}) as Record<string, any>, (updated as any || {}) as Record<string, any>);
    const name = Object.prototype.hasOwnProperty.call(merged, 'name')
      ? merged.name
      : (existing?.name ?? 'Folder');
    return {
      ...merged,
      id: folderId,
      teamPath,
      name,
    } as HackMdFolder;
  }

  private syncTeams(teams: Team[]): boolean {
    const incomingById = new Map<string, Team>();
    const existingTeamIds = new Set(this.teams.keys());
    let changed = false;
    let teamsContainerChanged = false;

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
        this.adoptOrphanScopeData(modelTeam);
        changed = true;
        teamsContainerChanged = true;  // Track that teams container changed
      } else {
        const oldPath = modelTeam.path;
        const teamMetaChanged = modelTeam.path !== team.path || modelTeam.name !== team.name;
        modelTeam.path = team.path;
        modelTeam.name = team.name;
        this.adoptOrphanScopeData(modelTeam);
        if (oldPath !== modelTeam.path) {
          this.teamsByPath.delete(oldPath);
          this.orphanScopesByPath.delete(oldPath);
        }
        if (teamMetaChanged) {
          // Emit on the team when its metadata changes
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
        this.foldersByScope.delete(existing);
        this.notesByScope.delete(existing);
        this.loadedScopes.delete(existing);
        this.contentLoadedByScope.delete(existing);
        this.orphanScopesByPath.delete(existing.path);
        // Don't emit on the deleted team; will emit on Teams container
        changed = true;
        teamsContainerChanged = true;  // Track that teams container changed
      }
    }

    // If teams were added or removed, emit on the Teams container (not on individual teams)
    if (teamsContainerChanged) {
      this.emitEntityChanged(this.teamsEntity);
    }

    const desiredOrder = teams
      .map((team) => this.teams.get(team.id))
      .filter((team): team is ModelTeam => !!team);
    if (reconcileArrayAsSetPreserveOrder(this.orderedTeams, desiredOrder)) {
      changed = true;
    }

    return changed;
  }

  private rebuildScope(scope: ModelMyNotes | ModelTeam, notes: Note[], folders: HackMdFolder[]): boolean {
    const teamPath = scope.type === 'team' ? scope.path : null;
    const folderMap = this.getFolderScopeMap(teamPath);
    const noteMap = this.getNoteScopeMap(teamPath);
    let changed = false;
    let scopeContainerChanged = false;
    const changedFolders = new Set<ModelFolder>();

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
          // Track folder deletion; will emit on container, not on folder itself
          changedFolders.add(removed);
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
        // Don't emit here; will emit on container after deduplication
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
          // Track note deletion; will emit on container, not on note itself
          changed = true;
          scopeContainerChanged = true;
        }
        changed = true;
      }
    }

    for (const folder of folderMap.values()) {
      if (reconcileArrayAsSetPreserveOrder(folder.children, nextChildrenByFolder.get(folder.id) || HackmdModel.EMPTY_FOLDERS)) {
        changed = true;
        changedFolders.add(folder);
      }
      if (reconcileArrayAsSetPreserveOrder(folder.notes, nextNotesByFolder.get(folder.id) || HackmdModel.EMPTY_NOTES)) {
        changed = true;
        changedFolders.add(folder);
      }
    }

    if (scope.type === 'team') {
      if (reconcileArrayAsSetPreserveOrder(scope.rootFolders, rootFolders)) {
        changed = true;
        scopeContainerChanged = true;
      }
      if (reconcileArrayAsSetPreserveOrder(scope.rootNotes, rootNotes)) {
        changed = true;
        scopeContainerChanged = true;
      }
    } else {
      if (reconcileArrayAsSetPreserveOrder(this.personalRootFolders, rootFolders)) {
        changed = true;
        scopeContainerChanged = true;
      }
      if (reconcileArrayAsSetPreserveOrder(this.personalRootNotes, rootNotes)) {
        changed = true;
        scopeContainerChanged = true;
      }
    }

    if (!this.loadedScopes.has(scope)) {
      this.loadedScopes.add(scope);
      changed = true;
    }

    // Emit events with hierarchical deduplication
    if (scopeContainerChanged) {
      // If root-level arrays changed, emit on the scope container (MyNotes or Team)
      this.emitEntityChanged(scope);
    } else if (changedFolders.size > 0) {
      // Otherwise, emit on deduplicated folders
      const deduplicatedFolders = this.deduplicateFoldersByAncestry(changedFolders, folderMap);
      for (const folder of deduplicatedFolders) {
        this.emitEntityChanged(folder);
      }
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

  private deduplicateFoldersByAncestry(folderSet: Set<ModelFolder>, folderMap: Map<string, ModelFolder>): Set<ModelFolder> {
    const result = new Set<ModelFolder>();
    for (const folder of folderSet) {
      let hasAncestorInSet = false;
      let current: ModelFolder | undefined = folder;
      while (current && current.parentId) {
        const parent = folderMap.get(current.parentId);
        if (parent && folderSet.has(parent)) {
          hasAncestorInSet = true;
          break;
        }
        current = parent;
      }
      if (!hasAncestorInSet) {
        result.add(folder);
      }
    }
    return result;
  }

  private emitDeduplicatedFolderChanges(scope: ModelMyNotes | ModelTeam, changedFolders: Set<ModelFolder>): void {
    if (changedFolders.size === 0) {
      return;
    }
    const teamPath = scope.type === 'team' ? scope.path : null;
    const folderMap = this.getFolderScopeMap(teamPath);
    const deduplicatedFolders = this.deduplicateFoldersByAncestry(changedFolders, folderMap);

    // Check if any of the changed folders are root folders
    const hasRootFolders = Array.from(deduplicatedFolders).some(folder => !folder.parentId);

    if (hasRootFolders) {
      // If root-level folders changed, report on the scope container (MyNotes or Team)
      this.emitEntityChanged(scope);
    } else {
      // Otherwise, report on the deduplicated folders
      for (const folder of deduplicatedFolders) {
        this.emitEntityChanged(folder);
      }
    }
  }

  private deduplicateChangedContainers(
    teamsChanged: boolean,
    scopeChanged: boolean,
    changedFolders: Set<ModelFolder>,
    scope: ModelMyNotes | ModelTeam | null
  ): ModelEntity[] {
    // Build hierarchical deduplication: Teams > Team/MyNotes > Folder
    // If a higher-level container changed, don't report lower-level changes
    const entitiesToReport: ModelEntity[] = [];

    if (teamsChanged) {
      // If Teams container changed, report only on it (don't report individual teams)
      entitiesToReport.push(this.teamsEntity);
      return entitiesToReport;
    }

    if (scopeChanged) {
      // If MyNotes or Team changed, report only on the scope (don't report individual folders)
      if (scope) {
        entitiesToReport.push(scope);
      }
      return entitiesToReport;
    }

    // Deduplicate folders by ancestry and report on non-ancestor folders
    if (changedFolders.size > 0) {
      const teamPath = scope && scope.type === 'team' ? scope.path : null;
      const folderMap = this.getFolderScopeMap(teamPath);
      const deduplicatedFolders = this.deduplicateFoldersByAncestry(changedFolders, folderMap);
      for (const folder of deduplicatedFolders) {
        entitiesToReport.push(folder);
      }
    }

    return entitiesToReport;
  }

  private reconcileFolderPlacement(scope: ModelMyNotes | ModelTeam, folder: ModelFolder): Set<ModelFolder> {
    const changedFolders = new Set<ModelFolder>();
    if (!this.loadedScopes.has(scope)) {
      return changedFolders;
    }

    const teamPath = scope.type === 'team' ? scope.path : null;
    const map = this.getFolderScopeMap(teamPath);
    const roots = scope.type === 'team' ? scope.rootFolders : this.personalRootFolders;

    let changed = false;

    for (const candidate of map.values()) {
      if (candidate === folder) {
        continue;
      }
      const nextChildren = candidate.children.filter((child) => child !== folder);
      if (nextChildren.length !== candidate.children.length) {
        replaceArrayContents(candidate.children, nextChildren);
        changedFolders.add(candidate);
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
        changedFolders.add(parent);
        changed = true;
      }
    } else if (roots.indexOf(folder) === -1) {
      roots.push(folder);
      changed = true;
    }

    return changedFolders;
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

  private reconcileNotePlacement(scope: ModelMyNotes | ModelTeam, note: ModelNote): Set<ModelFolder> {
    const changedFolders = new Set<ModelFolder>();
    if (!this.loadedScopes.has(scope)) {
      return changedFolders;
    }

    const teamPath = scope.type === 'team' ? scope.path : null;
    const folderMap = this.getFolderScopeMap(teamPath);
    const roots = scope.type === 'team' ? scope.rootNotes : this.personalRootNotes;

    let changed = false;

    for (const folder of folderMap.values()) {
      const nextNotes = folder.notes.filter((candidate) => candidate !== note);
      if (nextNotes.length !== folder.notes.length) {
        replaceArrayContents(folder.notes, nextNotes);
        changedFolders.add(folder);
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
        changedFolders.add(parent);
        changed = true;
      }
    } else if (roots.indexOf(note) === -1) {
      roots.push(note);
      changed = true;
    }

    return changedFolders;
  }

  private upsertHistoryNote(note: Note): ModelNote {
    const teamPath = note.teamPath || null;
    const existing = this.historyNotes.find((candidate) => candidate.id === note.id && (candidate.teamPath || null) === teamPath);
    if (!existing) {
      const entity: ModelNote = {
        type: 'note',
        id: note.id,
        title: note.title,
        shortId: note.shortId,
        teamPath,
        content: undefined,
        publishLink: note.publishLink,
        publishType: note.publishType,
        permalink: note.permalink,
        userPath: note.userPath,
        folderPaths: note.folderPaths,
        parentFolderId: resolveParentFolderId(note),
        parentForderId: note.parentForderId,
        readPermission: note.readPermission,
        writePermission: note.writePermission,
        tags: note.tags,
        createdAt: note.createdAt,
        lastChangedAt: note.lastChangedAt,
      };
      // Don't emit here - the caller will emit on recentNotesEntity
      return entity;
    }

    let changed = false;

    if (note.title !== undefined && existing.title !== note.title) {
      existing.title = note.title;
      changed = true;
    }
    if (note.shortId !== undefined && existing.shortId !== note.shortId) {
      existing.shortId = note.shortId;
      changed = true;
    }
    if (existing.teamPath !== teamPath) {
      existing.teamPath = teamPath;
      changed = true;
    }
    if (note.publishLink !== undefined && existing.publishLink !== note.publishLink) {
      existing.publishLink = note.publishLink;
      changed = true;
    }
    if (note.publishType !== undefined && existing.publishType !== note.publishType) {
      existing.publishType = note.publishType;
      changed = true;
    }
    if (note.permalink !== undefined && existing.permalink !== note.permalink) {
      existing.permalink = note.permalink;
      changed = true;
    }
    if (note.userPath !== undefined && existing.userPath !== note.userPath) {
      existing.userPath = note.userPath;
      changed = true;
    }
    if (note.folderPaths !== undefined && !folderPathsEqual(existing.folderPaths, note.folderPaths)) {
      existing.folderPaths = note.folderPaths;
      changed = true;
    }
    const apiParentFolderId = resolveParentFolderId(note);
    if (
      (note.parentFolderId !== undefined || note.parentForderId !== undefined)
      && existing.parentFolderId !== apiParentFolderId
    ) {
      existing.parentFolderId = apiParentFolderId;
      changed = true;
    }
    if (note.parentForderId !== undefined && existing.parentForderId !== note.parentForderId) {
      existing.parentForderId = note.parentForderId;
      changed = true;
    }
    if (note.readPermission !== undefined && existing.readPermission !== note.readPermission) {
      existing.readPermission = note.readPermission;
      changed = true;
    }
    if (note.writePermission !== undefined && existing.writePermission !== note.writePermission) {
      existing.writePermission = note.writePermission;
      changed = true;
    }
    if (note.tags !== undefined && !stringArrayEqual(existing.tags, note.tags)) {
      existing.tags = note.tags;
      changed = true;
    }
    if (note.createdAt !== undefined && existing.createdAt !== note.createdAt) {
      existing.createdAt = note.createdAt;
      changed = true;
    }
    if (note.lastChangedAt !== undefined && existing.lastChangedAt !== note.lastChangedAt) {
      existing.lastChangedAt = note.lastChangedAt;
      changed = true;
    }

    if (changed) {
      // Note properties changed - emit on recentNotesEntity container
      this.emitEntityChanged(this.recentNotesEntity);
    }
    return existing;
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
    entity: ModelEntity | undefined,
    action: () => Promise<T>
  ): Promise<T> {
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

  private getOrCreateOrphanScope(teamPath: string): ModelTeam {
    let orphan = this.orphanScopesByPath.get(teamPath);
    if (orphan) {
      return orphan;
    }
    orphan = {
      type: 'team',
      id: '',
      path: teamPath,
      name: teamPath,
      rootFolders: [],
      rootNotes: [],
    };
    this.orphanScopesByPath.set(teamPath, orphan);
    return orphan;
  }

  private adoptOrphanScopeData(team: ModelTeam): void {
    const orphan = this.orphanScopesByPath.get(team.path);
    if (!orphan || orphan === team) {
      return;
    }

    const folders = this.foldersByScope.get(orphan);
    if (folders) {
      this.foldersByScope.set(team, folders);
      this.foldersByScope.delete(orphan);
    }

    const notes = this.notesByScope.get(orphan);
    if (notes) {
      this.notesByScope.set(team, notes);
      this.notesByScope.delete(orphan);
    }

    const contentLoaded = this.contentLoadedByScope.get(orphan);
    if (contentLoaded) {
      this.contentLoadedByScope.set(team, contentLoaded);
      this.contentLoadedByScope.delete(orphan);
    }

    this.loadedScopes.delete(orphan);
    this.refreshScopePromises.delete(orphan);
    this.orphanScopesByPath.delete(team.path);
  }

  private scopeEntityForCleanup(teamPath: string | null): ModelMyNotes | ModelTeam {
    return this.getScopeMapKey(teamPath);
  }

  private getScopeMapKey(teamPath?: string | null): ModelMyNotes | ModelTeam {
    if (!teamPath) return this.myNotesEntity;
    return this.teamsByPath.get(teamPath) ?? this.getOrCreateOrphanScope(teamPath);
  }

  private getContentLoadedSet(teamPath?: string | null): Set<string> {
    const key = this.getScopeMapKey(teamPath);
    let set = this.contentLoadedByScope.get(key);
    if (!set) {
      set = new Set<string>();
      this.contentLoadedByScope.set(key, set);
    }
    return set;
  }

  private getFolderScopeMap(teamPath?: string | null): Map<string, ModelFolder> {
    const key = this.getScopeMapKey(teamPath);
    let map = this.foldersByScope.get(key);
    if (!map) {
      map = new Map<string, ModelFolder>();
      this.foldersByScope.set(key, map);
    }
    return map;
  }

  private getNoteScopeMap(teamPath?: string | null): Map<string, ModelNote> {
    const key = this.getScopeMapKey(teamPath);
    let map = this.notesByScope.get(key);
    if (!map) {
      map = new Map<string, ModelNote>();
      this.notesByScope.set(key, map);
    }
    return map;
  }
}
