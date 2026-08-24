import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMentionSuggestions, type FileEntry } from '../hooks/useMentionSuggestions';

const mentionOverlayPattern = /(^|\s)(@[^\s@]+)/g;

export type MentionOverlayPart = { text: string; isMention: boolean };
type MentionRange = { start: number; end: number };

export function parseMentionOverlayParts(text: string): MentionOverlayPart[] {
  if (!text) return [];

  const parts: MentionOverlayPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(mentionOverlayPattern)) {
    const index = match.index ?? -1;
    if (index < 0) continue;

    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), isMention: false });
    }

    const leading = match[1] ?? '';
    const token = match[2] ?? '';
    if (leading) {
      parts.push({ text: leading, isMention: false });
    }
    if (token) {
      parts.push({ text: token, isMention: true });
    }

    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), isMention: false });
  }

  return parts;
}

function parseMentionRanges(text: string): MentionRange[] {
  if (!text) return [];

  const ranges: MentionRange[] = [];
  for (const match of text.matchAll(mentionOverlayPattern)) {
    const index = match.index ?? -1;
    if (index < 0) continue;

    const leading = match[1] ?? '';
    const token = match[2] ?? '';
    if (!token) continue;

    const start = index + leading.length;
    const end = start + token.length;
    ranges.push({ start, end });
  }
  return ranges;
}

function findMentionRangeForDelete(
  ranges: MentionRange[],
  cursorPos: number,
  key: 'Backspace' | 'Delete'
): MentionRange | null {
  for (const range of ranges) {
    if (key === 'Backspace') {
      if (cursorPos > range.start && cursorPos <= range.end) return range;
    } else if (cursorPos >= range.start && cursorPos < range.end) {
      return range;
    }
  }
  return null;
}

function findMentionRangeForReplace(
  ranges: MentionRange[],
  cursorPos: number,
  triggerIndex: number
): MentionRange | null {
  for (const range of ranges) {
    if (cursorPos > range.start && cursorPos <= range.end) return range;
  }
  if (triggerIndex < 0) return null;
  return ranges.find((range) => range.start === triggerIndex) ?? null;
}

interface UseMentionOverlayOptions {
  input: string;
  setInput: (val: string) => void;
}

export function useMentionOverlay({ input, setInput }: UseMentionOverlayOptions) {
  const mentionOverlayParts = useMemo(() => parseMentionOverlayParts(input), [input]);
  const mentionRanges = useMemo(() => parseMentionRanges(input), [input]);

  const [cursorPos, setCursorPos] = useState(input.length);
  const mention = useMentionSuggestions(input, cursorPos);
  const textareaContainerRef = useRef<HTMLDivElement>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const textareaElRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionOverlayRef = useRef<HTMLDivElement | null>(null);
  // Stores the expected input value after mention/skill selection during IME composition.
  // Any onChange with a different value is corrected back to this value.
  const expectedInputRef = useRef<string | null>(null);

  const syncMentionOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!mentionOverlayRef.current) return;
    mentionOverlayRef.current.scrollTop = target.scrollTop;
    mentionOverlayRef.current.scrollLeft = target.scrollLeft;
  }, []);

  // After input changes from a mention selection, restore cursor position
  useEffect(() => {
    if (pendingCursorRef.current !== null) {
      const pos = pendingCursorRef.current;
      pendingCursorRef.current = null;
      requestAnimationFrame(() => {
        const el = textareaElRef.current
          ?? textareaContainerRef.current?.querySelector('textarea');
        if (el) {
          (el as HTMLTextAreaElement).setSelectionRange(pos, pos);
          (el as HTMLTextAreaElement).focus();
          textareaElRef.current = el as HTMLTextAreaElement;
          syncMentionOverlayScroll(el as HTMLTextAreaElement);
        }
        setCursorPos(pos);
        // Clear expectedInputRef after the cursor is restored and DOM is settled.
        // This ensures any spurious IME onChange has already been handled.
        expectedInputRef.current = null;
      });
    }
  }, [input, syncMentionOverlayScroll]);

  const handleMentionSelect = useCallback((entry: FileEntry, selectionPos?: number) => {
    const resolvedCursorPos = typeof selectionPos === 'number'
      ? selectionPos
      : (textareaElRef.current?.selectionStart ?? cursorPos);
    const replaceRange = findMentionRangeForReplace(mentionRanges, resolvedCursorPos, mention.triggerIndex);
    const replaceStart = replaceRange?.start ?? mention.triggerIndex;
    const replaceEnd = replaceRange?.end ?? Math.max(
      resolvedCursorPos,
      mention.triggerIndex + 1 + mention.query.length
    );
    if (replaceStart < 0 || replaceEnd < replaceStart) return;

    const relativePath = mention.getRelativePath(entry);
    const before = input.slice(0, replaceStart);
    const after = input.slice(replaceEnd);
    const insertion = `@${relativePath} `;
    const newInput = before + insertion + after;
    const newCursorPos = before.length + insertion.length;

    pendingCursorRef.current = newCursorPos;
    expectedInputRef.current = newInput;
    setInput(newInput);
    mention.dismiss();
  }, [input, mention, mentionRanges, setInput, cursorPos]);

  const handleMentionKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Backspace' || e.key === 'Delete')) {
      const selectionStart = e.currentTarget.selectionStart;
      const selectionEnd = e.currentTarget.selectionEnd;
      if (selectionStart !== null && selectionEnd !== null && selectionStart === selectionEnd) {
        const deleteRange = findMentionRangeForDelete(mentionRanges, selectionStart, e.key);
        if (deleteRange) {
          e.preventDefault();
          const nextInput = input.slice(0, deleteRange.start) + input.slice(deleteRange.end);
          pendingCursorRef.current = deleteRange.start;
          setInput(nextInput);
          mention.dismiss();
          return;
        }
      }
    }

    if (!mention.isOpen) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mention.moveUp();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      mention.moveDown();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (mention.suggestions.length > 0) {
        e.preventDefault();
        handleMentionSelect(mention.suggestions[mention.selectedIndex], e.currentTarget.selectionStart ?? undefined);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      mention.dismiss();
    }
  }, [mention, handleMentionSelect, mentionRanges, input, setInput]);

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // After mention/skill selection, IME may commit composed text causing a spurious onChange.
    // If we have an expected value and the incoming value differs, correct it.
    if (expectedInputRef.current !== null) {
      const expected = expectedInputRef.current;
      expectedInputRef.current = null;
      if (e.target.value !== expected) {
        e.target.value = expected;
        setInput(expected);
        setCursorPos(pendingCursorRef.current ?? expected.length);
        textareaElRef.current = e.target;
        syncMentionOverlayScroll(e.target);
        return;
      }
    }
    setInput(e.target.value);
    setCursorPos(e.target.selectionStart ?? e.target.value.length);
    textareaElRef.current = e.target;
    syncMentionOverlayScroll(e.target);
  }, [setInput, syncMentionOverlayScroll]);

  const handleTextareaKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
    textareaElRef.current = e.currentTarget;
    syncMentionOverlayScroll(e.currentTarget);
  }, [syncMentionOverlayScroll]);

  const handleTextareaClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
    textareaElRef.current = e.currentTarget;
    syncMentionOverlayScroll(e.currentTarget);
  }, [syncMentionOverlayScroll]);

  const handleTextareaSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    setCursorPos(target.selectionStart ?? 0);
    textareaElRef.current = target;
    syncMentionOverlayScroll(target);
  }, [syncMentionOverlayScroll]);

  const handleTextareaScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    syncMentionOverlayScroll(e.currentTarget);
  }, [syncMentionOverlayScroll]);

  return {
    mentionOverlayParts,
    mentionOverlayRef,
    textareaContainerRef,
    mention,
    handleMentionSelect,
    handleMentionKeyDown,
    handleTextareaChange,
    handleTextareaKeyUp,
    handleTextareaClick,
    handleTextareaSelect,
    handleTextareaScroll,
  };
}
