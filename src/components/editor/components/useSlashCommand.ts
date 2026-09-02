import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SlashCommandItem } from '../hooks/useModelManagement';

export interface SlashCommandState {
  isOpen: boolean;
  suggestions: SlashCommandItem[];
  selectedIndex: number;
  loading: boolean;
  query: string;
  triggerIndex: number;
  moveUp: () => void;
  moveDown: () => void;
  dismiss: () => void;
  setSelectedIndex: (index: number) => void;
}

interface UseSlashCommandOptions {
  input: string;
  setInput: (val: string) => void;
  cursorPos: number;
  slashCommands: SlashCommandItem[];
}

export function useSlashCommand({ input, setInput, cursorPos, slashCommands }: UseSlashCommandOptions) {
  const [selectedSkills, setSelectedSkills] = useState<SlashCommandItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedMatchKey, setDismissedMatchKey] = useState<string | null>(null);

  const rawSlashMatch = useMemo(() => {
    const textBeforeCursor = input.slice(0, cursorPos);
    const match = textBeforeCursor.match(/(^|\s)\/([\w-]*)$/);
    if (!match) return null;
    const triggerIndex = match.index! + match[1].length;
    const query = match[2];
    return { triggerIndex, query };
  }, [input, cursorPos]);

  const slashMatchKey = useMemo(() => {
    if (!rawSlashMatch) return null;
    return `${rawSlashMatch.triggerIndex}:${cursorPos}:${rawSlashMatch.query}`;
  }, [rawSlashMatch, cursorPos]);

  useEffect(() => {
    if (dismissedMatchKey && dismissedMatchKey !== slashMatchKey) {
      setDismissedMatchKey(null);
    }
  }, [dismissedMatchKey, slashMatchKey]);

  const slashMatch = useMemo(() => {
    if (!rawSlashMatch) return null;
    if (dismissedMatchKey === slashMatchKey) return null;
    return rawSlashMatch;
  }, [rawSlashMatch, dismissedMatchKey, slashMatchKey]);

  const suggestions = useMemo(() => {
    if (!slashMatch) return [];
    const q = slashMatch.query.toLowerCase();
    const selectedNames = new Set(selectedSkills.map((s) => s.name));
    return slashCommands.filter(
      (s) => s.name.toLowerCase().includes(q) && !selectedNames.has(s.name)
    );
  }, [slashMatch, slashCommands, selectedSkills]);

  useEffect(() => {
    if (selectedIndex >= suggestions.length) {
      setSelectedIndex(Math.max(0, suggestions.length - 1));
    }
  }, [suggestions.length, selectedIndex]);

  const isOpen = !!slashMatch && suggestions.length > 0;

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
  }, [suggestions.length]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
  }, [suggestions.length]);

  const dismiss = useCallback(() => {
    if (!slashMatchKey) return;
    setDismissedMatchKey(slashMatchKey);
  }, [slashMatchKey]);

  const selectItem = useCallback((item: SlashCommandItem) => {
    if (item.type === 'skill') {
      // Skill: add as chip, remove slash text
      setSelectedSkills((prev) => {
        if (prev.some((s) => s.name === item.name)) return prev;
        return [...prev, item];
      });
      if (slashMatch) {
        const before = input.slice(0, slashMatch.triggerIndex);
        const after = input.slice(cursorPos);
        const trimmed = before.trimEnd();
        setInput(trimmed + (after.trimStart() ? (trimmed ? ' ' : '') + after.trimStart() : ''));
      }
    } else {
      // Command: replace slash text with /commandName, no chip
      if (slashMatch) {
        const before = input.slice(0, slashMatch.triggerIndex);
        const after = input.slice(cursorPos);
        setInput(`${before}/${item.name}${after ? ' ' + after.trimStart() : ' '}`);
      }
    }
    setDismissedMatchKey(null);
  }, [slashMatch, input, cursorPos, setInput]);

  const removeSkill = useCallback((skillName: string) => {
    setSelectedSkills((prev) => prev.filter((s) => s.name !== skillName));
  }, []);

  const clearSkills = useCallback(() => {
    setSelectedSkills([]);
  }, []);

  /**
   * Add a skill chip from outside the composer — the session panel's "Use skill".
   *
   * Picking a skill is the same act whether you type `/` or find it in the panel, so it
   * has to land in the same place: a chip, removable, with the composer still empty and
   * yours to write in. Inserting `/name` as plain text would look close but behave
   * differently — it would be re-parsed as you typed, and it would reach the model as
   * literal text rather than as the `[skill:name]` prefix `handleSubmit` builds.
   */
  const addSkill = useCallback((item: SlashCommandItem) => {
    setSelectedSkills((prev) => (prev.some((s) => s.name === item.name) ? prev : [...prev, item]));
  }, []);

  const state: SlashCommandState = {
    isOpen,
    suggestions,
    selectedIndex,
    loading: false,
    query: slashMatch?.query ?? '',
    triggerIndex: slashMatch?.triggerIndex ?? -1,
    moveUp,
    moveDown,
    dismiss,
    setSelectedIndex,
  };

  return {
    slashCommand: state,
    selectedSkills,
    selectItem,
    addSkill,
    removeSkill,
    clearSkills,
  };
}
