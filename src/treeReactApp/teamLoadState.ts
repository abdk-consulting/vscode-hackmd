import * as vscode from 'vscode';

// Track which teams have been loaded for lazy loading
export const loadedTeams = new Set<string>();

// Event to trigger re-render when a team is loaded
export const loadTeamNotesEvent = new vscode.EventEmitter<void>();

export function markTeamAsLoaded(teamId: string) {
  loadedTeams.add(teamId);
  loadTeamNotesEvent.fire();
}

export function isTeamLoaded(teamId: string): boolean {
  return loadedTeams.has(teamId);
}
