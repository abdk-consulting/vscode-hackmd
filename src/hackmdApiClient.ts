import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, Method } from 'axios';

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
    options: ApiMethodOptions = {}
  ): Promise<T | AxiosResponse<T>> {
    const response = await this.http.request<T>({
      method,
      url,
      ...config,
    });

    if (options.unwrapData === false) {
      return response;
    }

    return response.data;
  }

  // Profile
  getMe(options?: ApiMethodOptions) {
    return this.request<any>('GET', 'me', {}, options);
  }

  // Teams
  getTeams(options?: ApiMethodOptions) {
    return this.request<any[]>('GET', 'teams', {}, options);
  }

  // History
  getHistory(options?: ApiMethodOptions) {
    return this.request<any[]>('GET', 'history', {}, options);
  }

  // User notes
  getNoteList(options?: ApiMethodOptions) {
    return this.request<any[]>('GET', 'notes', {}, options);
  }

  getNote(noteId: string, options?: ApiMethodOptions) {
    return this.request<any>('GET', `notes/${encodeURIComponent(noteId)}`, {}, options);
  }

  createNote(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('POST', 'notes', { data: payload }, options);
  }

  updateNote(noteId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('PATCH', `notes/${encodeURIComponent(noteId)}`, { data: payload }, options);
  }

  updateNoteContent(noteId: string, content: string, options?: ApiMethodOptions) {
    return this.request<any>('PATCH', `notes/${encodeURIComponent(noteId)}`, { data: { content } }, options);
  }

  deleteNote(noteId: string, options?: ApiMethodOptions) {
    return this.request<any>('DELETE', `notes/${encodeURIComponent(noteId)}`, {}, options);
  }

  // Team notes
  getTeamNotes(teamPath: string, options?: ApiMethodOptions) {
    return this.request<any[]>('GET', `teams/${encodeURIComponent(teamPath)}/notes`, {}, options);
  }

  getTeamNote(teamPath: string, noteId: string, options?: ApiMethodOptions) {
    return this.request<any>(
      'GET',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      {},
      options
    );
  }

  createTeamNote(teamPath: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('POST', `teams/${encodeURIComponent(teamPath)}/notes`, { data: payload }, options);
  }

  updateTeamNote(teamPath: string, noteId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>(
      'PATCH',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      { data: payload },
      options
    );
  }

  deleteTeamNote(teamPath: string, noteId: string, options?: ApiMethodOptions) {
    return this.request<any>(
      'DELETE',
      `teams/${encodeURIComponent(teamPath)}/notes/${encodeURIComponent(noteId)}`,
      {},
      options
    );
  }

  // User folders
  getFolders(options?: ApiMethodOptions) {
    return this.request<any[]>('GET', 'folders', {}, options);
  }

  createFolder(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('POST', 'folders', { data: payload }, options);
  }

  getFolder(folderId: string, options?: ApiMethodOptions) {
    return this.request<any>('GET', `folders/${encodeURIComponent(folderId)}`, {}, options);
  }

  updateFolder(folderId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('PATCH', `folders/${encodeURIComponent(folderId)}`, { data: payload }, options);
  }

  deleteFolder(folderId: string, options?: ApiMethodOptions) {
    return this.request<any>('DELETE', `folders/${encodeURIComponent(folderId)}`, {}, options);
  }

  getFolderOrder(options?: ApiMethodOptions) {
    return this.request<any>('GET', 'folders/folder-order', {}, options);
  }

  updateFolderOrder(payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('PUT', 'folders/folder-order', { data: payload }, options);
  }

  // Team folders
  getTeamFolders(teamPath: string, options?: ApiMethodOptions) {
    return this.request<any[]>('GET', `teams/${encodeURIComponent(teamPath)}/folders`, {}, options);
  }

  createTeamFolder(teamPath: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>('POST', `teams/${encodeURIComponent(teamPath)}/folders`, { data: payload }, options);
  }

  getTeamFolder(teamPath: string, folderId: string, options?: ApiMethodOptions) {
    return this.request<any>(
      'GET',
      `teams/${encodeURIComponent(teamPath)}/folders/${encodeURIComponent(folderId)}`,
      {},
      options
    );
  }

  updateTeamFolder(teamPath: string, folderId: string, payload: AnyObject, options?: ApiMethodOptions) {
    return this.request<any>(
      'PATCH',
      `teams/${encodeURIComponent(teamPath)}/folders/${encodeURIComponent(folderId)}`,
      { data: payload },
      options
    );
  }

  deleteTeamFolder(teamPath: string, folderId: string, options?: ApiMethodOptions) {
    return this.request<any>(
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
