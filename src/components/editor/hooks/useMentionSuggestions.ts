import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
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

const MENTION_SEARCH_LIMIT = 50;
const MENTION_SEARCH_DEBOUNCE_MS = 120;

const normalizeToPosixPath = (value: string) => value.replace(/\\/g, '/');

export function useMentionSuggestions(input: string, cursorPos: number) {
  const [mentionState, setMentionState] = useState<MentionState>({
    isOpen: false,
    query: '',
    triggerIndex: -1,
  });
  const [suggestions, setSuggestions] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const directoryCacheRef = useRef<Map<string, FileEntry[]>>(new Map());
  const searchCacheRef = useRef<Map<string, FileEntry[]>>(new Map());

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
        setSuggestions([]);
      }
      return;
    }

    // @ must be at start or preceded by whitespace
    if (lastAtIndex > 0 && !/\s/.test(input[lastAtIndex - 1])) {
      if (mentionState.isOpen) {
        setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
        setSuggestions([]);
      }
      return;
    }

    // Extract query: everything between @ and cursor
    const query = input.slice(lastAtIndex + 1, cursorPos);

    // If query contains a space, the mention is done
    if (/\s/.test(query)) {
      if (mentionState.isOpen) {
        setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
        setSuggestions([]);
      }
      return;
    }

    setMentionState({ isOpen: true, query, triggerIndex: lastAtIndex });
    setSelectedIndex(0);
  }, [input, cursorPos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch suggestions when query changes
  useEffect(() => {
    if (!mentionState.isOpen) {
      setLoading(false);
      return;
    }

    if (!workspacePath) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const query = mentionState.query.trim();
    const shouldUseGlobalSearch = query.length > 0 && !query.includes('/');
    const runFetch = async () => {
      setLoading(true);

      if (shouldUseGlobalSearch) {
        const searchCacheKey = `${workspacePath}::${query.toLowerCase()}`;
        const cached = searchCacheRef.current.get(searchCacheKey);
        if (cached) {
          if (!controller.signal.aborted) {
            setSuggestions(cached);
            setLoading(false);
          }
          return;
        }

        try {
          const entries = await api.findPaths(workspacePath, query, MENTION_SEARCH_LIMIT);
          if (controller.signal.aborted) return;
          searchCacheRef.current.set(searchCacheKey, entries);
          setSuggestions(entries);
        } catch {
          if (controller.signal.aborted) return;
          setSuggestions([]);
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
        return;
      }

      const { dirPath, filter } = resolveDirectoryQuery(workspacePath, query);
      const cached = directoryCacheRef.current.get(dirPath);
      if (cached) {
        if (!controller.signal.aborted) {
          setSuggestions(filterEntries(cached, filter));
          setLoading(false);
        }
        return;
      }

      try {
        const entries = await api.readDir(dirPath);
        if (controller.signal.aborted) return;
        directoryCacheRef.current.set(dirPath, entries);
        setSuggestions(filterEntries(entries, filter));
      } catch {
        if (controller.signal.aborted) return;
        setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const timerId = window.setTimeout(
      () => {
        void runFetch();
      },
      query.length > 0 ? MENTION_SEARCH_DEBOUNCE_MS : 0
    );

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [mentionState.isOpen, mentionState.query, workspacePath]);

  const dismiss = useCallback(() => {
    setMentionState({ isOpen: false, query: '', triggerIndex: -1 });
    setSuggestions([]);
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
