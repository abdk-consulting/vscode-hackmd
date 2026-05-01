import * as vscode from 'vscode';

import { Note } from '@hackmd/api/dist/type';

import { getMyNotesProvider, getTeamNotesProvider } from './extension';

/**
 * Returns the URL path segment for a note, e.g. `/@user/permalink-or-id`.
 */
function noteLinkPath(note: Note): string {
  const scope = note.teamPath ?? note.userPath;
  const slug = note.permalink ?? note.id;
  return scope ? `/@${scope}/${slug}` : `/${slug}`;
}

/**
 * Collects all notes visible in the cached providers.
 */
function collectCachedNotes(): Note[] {
  const notes: Note[] = [];

  const myNotes = getMyNotesProvider();
  if (myNotes) {
    // getAllCachedNotes is a thin accessor we expose below; fall back to a
    // cast to any to avoid a circular-import helper file.
    const cached = (myNotes as any).notesCache as Note[] | null;
    if (cached) {
      notes.push(...cached);
    }
  }

  const teamNotes = getTeamNotesProvider();
  if (teamNotes) {
    const cacheMap = (teamNotes as any).teamNotesCache as Map<string, Note[]>;
    if (cacheMap) {
      for (const noteList of cacheMap.values()) {
        notes.push(...noteList);
      }
    }
  }

  return notes;
}

/**
 * Provides `[...` → `[Title](/@scope/id-or-permalink)` completions inside
 * HackMD note editors.
 */
export class NoteCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.slice(0, position.character);

    // Find the last unmatched `[` before the cursor that hasn't been closed
    // with a matching `]`.
    const bracketIndex = this.findOpenBracketIndex(textBeforeCursor);
    if (bracketIndex === -1) {
      return undefined;
    }

    // The query is what the user typed after `[`.
    const query = textBeforeCursor.slice(bracketIndex + 1).toLowerCase();

    const notes = collectCachedNotes();
    const items: vscode.CompletionItem[] = [];

    for (const note of notes) {
      const title = note.title || '(Untitled)';
      const permalink = note.permalink ?? '';

      const titleMatches = title.toLowerCase().includes(query);
      const permalinkMatches = permalink.toLowerCase().includes(query);

      if (!titleMatches && !permalinkMatches) {
        continue;
      }

      const linkPath = noteLinkPath(note);
      const insertText = `[${title}](${linkPath})`;

      // Replace from the `[` to the current cursor position, and also consume
      // an auto-inserted `]` immediately after the cursor if present.
      const charAfterCursor = lineText[position.character];
      const endCharacter = charAfterCursor === ']' ? position.character + 1 : position.character;
      const replaceRange = new vscode.Range(
        position.line, bracketIndex,
        position.line, endCharacter,
      );

      const item = new vscode.CompletionItem(title, vscode.CompletionItemKind.Reference);
      item.detail = linkPath;
      item.filterText = `[${query}`; // keeps the item visible while filter text changes
      item.insertText = insertText;
      item.range = replaceRange;
      item.sortText = title.toLowerCase();

      if (permalink) {
        item.documentation = new vscode.MarkdownString(`**Permalink:** \`${permalink}\`\n\n**Link:** \`${insertText}\``);
      } else {
        item.documentation = new vscode.MarkdownString(`**Link:** \`${insertText}\``);
      }

      items.push(item);
    }

    return items;
  }

  /**
   * Returns the index of the last `[` in `text` that is not yet closed by a
   * matching `]`.  Returns -1 if no open bracket is found.
   */
  private findOpenBracketIndex(text: string): number {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ']') {
        depth++;
      } else if (ch === '[') {
        if (depth === 0) {
          return i;
        }
        depth--;
      }
    }
    return -1;
  }
}
