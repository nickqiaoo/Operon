import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileMentionDir, useFileMentionSearch } from '@/lib/file-mention-queries';
import { useProjectStore } from '@/stores/project-store';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface MentionState {
  isOpen: boolean;
  query: string;
  /** The start index of '@' in the input string */
  triggerIndex: number;
}

const NO_ENTRIES: FileEntry[] = [];
const MENTION_SEARCH_DEBOUNCE_MS = 120;

const normalizeToPosixPath = (value: string) => value.replace(/\\/g, '/');

export function useMentionSuggestions(input: string, cursorPos: number) {
  const [mentionState, setMentionState] = useState<MentionState>({
    isOpen: false,
    query: '',
    triggerIndex: -1,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Subscribe reactively to project store so we get the path after persistence loads
  const workspacePath = useProjectStore((state) => {
    const wsId = state.activeWorkspaceId;
    if (wsId) {
      for (const project of state.projects) {
        const ws = project.workspaces.find((w) => w.id === wsId);
        if (ws) return ws.worktreePath;
      }
    }
    // Fallback to active project rootPath
    const proj = state.projects.find((p) => p.id === state.activeProjectId);
    return proj?.rootPath ?? null;
  });

  // Detect @ trigger in input based on cursor position
  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      if (mentionState.isOpen) {
        setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
      }
      return;
    }

    // @ must be at start or preceded by whitespace
    if (lastAtIndex > 0 && !/\s/.test(input[lastAtIndex - 1])) {
      if (mentionState.isOpen) {
        setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
      }
      return;
    }

    // Extract query: everything between @ and cursor
    const query = input.slice(lastAtIndex + 1, cursorPos);

    // If query contains a space, the mention is done
    if (/\s/.test(query)) {
      if (mentionState.isOpen) {
        setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
      }
      return;
    }

    setMentionState({ isOpen: true, query, triggerIndex: lastAtIndex });
    setSelectedIndex(0);
  }, [input, cursorPos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce typing (not the bare "@", which lists the root at once), then read
  // from the shared query cache: a fuzzy search for a plain word, a directory
  // listing once the query names a folder.
  const trimmedQuery = mentionState.query.trim();
  const query = useDebouncedValue(trimmedQuery, trimmedQuery.length > 0 ? MENTION_SEARCH_DEBOUNCE_MS : 0);
  const active = mentionState.isOpen && !!workspacePath;
  const useGlobalSearch = query.length > 0 && !query.includes('/');
  const { dirPath, filter } = resolveDirectoryQuery(workspacePath ?? '', query);
  const searchQuery = useFileMentionSearch(workspacePath, query, { enabled: active && useGlobalSearch });
  const dirQuery = useFileMentionDir(workspacePath, dirPath, { enabled: active && !useGlobalSearch });
  const activeQuery = useGlobalSearch ? searchQuery : dirQuery;

  const suggestions = useMemo<FileEntry[]>(() => {
    if (!active) return NO_ENTRIES;
    if (useGlobalSearch) return searchQuery.data ?? NO_ENTRIES;
    return dirQuery.data ? filterEntries(dirQuery.data, filter) : NO_ENTRIES;
  }, [active, useGlobalSearch, searchQuery.data, dirQuery.data, filter]);
  const loading = active && activeQuery.isFetching;

  const dismiss = useCallback(() => {
    setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
  }, []);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
  }, [suggestions.length]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
  }, [suggestions.length]);

  /** Build the relative path for a selected entry */
  const getRelativePath = useCallback((entry: FileEntry) => {
    if (!workspacePath) return entry.name;
    const normalizedWorkspacePath = normalizeToPosixPath(workspacePath);
    const normalizedEntryPath = normalizeToPosixPath(entry.path);
    if (!normalizedEntryPath.startsWith(normalizedWorkspacePath)) return entry.name;
    const relativePath = normalizedEntryPath.slice(normalizedWorkspacePath.length).replace(/^\/+/, '');
    return relativePath.length > 0 ? relativePath : entry.name;
  }, [workspacePath]);

  return {
    isOpen: mentionState.isOpen,
    query: mentionState.query,
    triggerIndex: mentionState.triggerIndex,
    suggestions,
    loading,
    selectedIndex,
    setSelectedIndex,
    moveUp,
    moveDown,
    dismiss,
    getRelativePath,
  };
}

function resolveDirectoryQuery(workspacePath: string, query: string): { dirPath: string; filter: string } {
  if (!query.includes('/')) {
    return { dirPath: workspacePath, filter: query };
  }

  const lastSlash = query.lastIndexOf('/');
  const parentPath = query.slice(0, lastSlash + 1);
  const filter = query.slice(lastSlash + 1);

  const normalizedParentPath = parentPath.replace(/^\/+/, '');
  const dirPath = `${workspacePath}/${normalizedParentPath}`.replace(/\/+$/, '');
  return { dirPath, filter };
}

function filterEntries(entries: FileEntry[], filter: string): FileEntry[] {
  if (!filter) return entries;
  const lowerFilter = filter.toLowerCase();
  return entries.filter((entry) => {
    const normalizedPath = normalizeToPosixPath(entry.path).toLowerCase();
    return entry.name.toLowerCase().includes(lowerFilter) || normalizedPath.includes(lowerFilter);
  });
}
