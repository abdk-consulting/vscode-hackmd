import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, Method } from 'axios';

export type NotePublishType = 'view' | 'edit' | 'slide' | 'book';

export interface Note {
  id: string;
  title: string;
  content?: string;
  publishLink?: string;
  publishType?: NotePublishType;
  permalink?: string | null;
  shortId?: string;
  teamPath?: string | null;
  userPath?: string | null;
  folderPaths?: Array<{
    id: string;
    path: string;
    name?: string;
    clientId?: string;
    parentFolderId?: string | null;
    /** HackMD API typo alias for parentFolderId */
    parentForderId?: string | null;
  }>;
  parentFolderId?: string | null;
  /** HackMD API typo alias for parentFolderId */
  parentForderId?: string | null;
  readPermission?: string;
  writePermission?: string;
  tags?: string[];
  createdAt?: string;
  lastChangedAt?: string;
}

export interface Team {
  id: string;
  path: string;
  name: string;
}

export interface HackMdFolder {
  id: string;
  name: string;
  path?: string;
  clientId?: string;
  parentFolderId?: string | null;
  /** HackMD API typo alias for parentFolderId */
  parentForderId?: string | null;
  teamPath?: string | null;
}

type ApiMethodOptions = {
  unwrapData?: boolean;
};

type AnyObject = Record<string, any>;

export class HackMdApiClient {
  private readonly http: AxiosInstance;

  constructor(accessToken: string, apiEndpoint: string) {
    this.http = axios.create({
      baseURL: apiEndpoint,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private async request<T>(
    method: Method,
    url: string,
    config: AxiosRequestConfig = {},
    _options: ApiMethodOptions = {}
  ): Promise<AxiosResponse<T>> {
    return this.http.request<T>({
      method,
      url,
      ...config,
    });
  }

  // Profile
  getMe(options?: ApiMethodOptions) {
    return this.request<any>('GET', 'me', {}, options);
  }

  // Teams
  getTeams(options?: ApiMethodOptions) {
    return this.request<Team[]>('GET', 'teams', {}, options);
  }

  // History
  getHistory(options?: ApiMethodOptions) {
    return this.request<Note[]>('GET', 'history', {}, options);
  }

  // User notes
  getNoteList(options?: ApiMethodOptions) {
    return this.request<Note[]>('GET', 'notes', {}, options);
  }

  getNote(noteId: string, options?: ApiMethodOptions) {
    return this.request<Note>('GET', `notes/${encodeURIComponent(noteId)}`, {}, options);
  }

  createNote(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<Note>('POST', 'notes', { data: payload }, options);
  }

  updateNote(noteId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<Note>('PATCH', `notes/${encodeURIComponent(noteId)}`, { data: payload }, options);
  }

  updateNoteContent(noteId: string, content: string, options?: ApiMethodOptions) {
    return this.request<Note>('PATCH', `notes/${encodeURIComponent(noteId)}`, { data: { content } }, options);
  }

  deleteNote(noteId: string, options?: ApiMethodOptions) {
    return this.request<void>('DELETE', `notes/${encodeURIComponent(noteId)}`, {}, options);
  }

  // Team notes
  getTeamNotes(teamPath: string, options?: ApiMethodOptions) {
    return this.request<Note[]>('GET', `teams/${encodeURIComponent(teamPath)}/notes`, {}, options);
  }

  getTeamNote(teamPath: string, noteId: string, options?: ApiMethodOptions) {
    return this.request<Note>(
      'GET',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      {},
      options
    );
  }

  createTeamNote(teamPath: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<Note>('POST', `teams/${encodeURIComponent(teamPath)}/notes`, { data: payload }, options);
  }

  updateTeamNote(teamPath: string, noteId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<Note>(
      'PATCH',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      { data: payload },
      options
    );
  }

  deleteTeamNote(teamPath: string, noteId: string, options?: ApiMethodOptions) {
    return this.request<void>(
      'DELETE',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      {},
      options
    );
  }

  // User folders
  getFolders(options?: ApiMethodOptions) {
    return this.request<HackMdFolder[]>('GET', 'folders', {}, options);
  }

  createFolder(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>('POST', 'folders', { data: payload }, options);
  }

  getFolder(folderId: string, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>('GET', `folders/${encodeURIComponent(folderId)}`, {}, options);
  }

  updateFolder(folderId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>('PATCH', `folders/${encodeURIComponent(folderId)}`, { data: payload }, options);
  }

  deleteFolder(folderId: string, options?: ApiMethodOptions) {
    return this.request<void>('DELETE', `folders/${encodeURIComponent(folderId)}`, {}, options);
  }

  getFolderOrder(options?: ApiMethodOptions) {
    return this.request<any>('GET', 'folders/folder-order', {}, options);
  }

  updateFolderOrder(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('PUT', 'folders/folder-order', { data: payload }, options);
  }

  // Team folders
  getTeamFolders(teamPath: string, options?: ApiMethodOptions) {
    return this.request<HackMdFolder[]>('GET', `teams/${encodeURIComponent(teamPath)}/folders`, {}, options);
  }

  createTeamFolder(teamPath: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>('POST', `teams/${encodeURIComponent(teamPath)}/folders`, { data: payload }, options);
  }

  getTeamFolder(teamPath: string, folderId: string, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>(
      'GET',
      `teams/${encodeURIComponent(teamPath)}/folders/${encodeURIComponent(folderId)}`,
      {},
      options
    );
  }

  updateTeamFolder(teamPath: string, folderId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<HackMdFolder>(
      'PATCH',
      `teams/${encodeURIComponent(teamPath)}/folders/${encodeURIComponent(folderId)}`,
      { data: payload },
      options
    );
  }

  deleteTeamFolder(teamPath: string, folderId: string, options?: ApiMethodOptions) {
    return this.request<void>(
      'DELETE',
      `teams/${encodeURIComponent(teamPath)}/folders/${encodeURIComponent(folderId)}`,
      {},
      options
    );
  }

  getTeamFolderOrder(teamPath: string, options?: ApiMethodOptions) {
    return this.request<any>('GET', `teams/${encodeURIComponent(teamPath)}/folders/folder-order`, {}, options);
  }

  updateTeamFolderOrder(teamPath: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('PUT', `teams/${encodeURIComponent(teamPath)}/folders/folder-order`, { data: payload }, options);
  }
}
