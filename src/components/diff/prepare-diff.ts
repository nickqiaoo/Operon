import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { ensureTrailingNewline, type DiffStats } from '@shared/tool-rendering/diff';

export interface DiffInput {
  filePath: string;
  oldContent: string;
  newContent: string;
}
export type PreparedDiff =
  | { status: 'ready'; fileDiff: FileDiffMetadata; stats: DiffStats }
  | { status: 'limited' };

// Bound both comparison work and the size sent back to the UI/highlighter.
const MAX_CHARS = 2 * 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_LINE_CHARS = 20_000;

export function exceedsDiffLimits(text: string): boolean {
  if (text.length > MAX_CHARS) return true;
  let lines = 1;
  let lineLength = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (++lines > MAX_LINES) return true;
      lineLength = 0;
    } else if (++lineLength > MAX_LINE_CHARS) return true;
  }
  return false;
}

export function countContentLines(text: string): number {
  if (!text) return 0;
  let count = text.endsWith('\n') ? 0 : 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

export function prepareDiff({ filePath, oldContent, newContent }: DiffInput): PreparedDiff {
  if (exceedsDiffLimits(oldContent) || exceedsDiffLimits(newContent)) return { status: 'limited' };
  const fileDiff = parseDiffFromFile(
    { name: filePath, contents: ensureTrailingNewline(oldContent) },
    { name: filePath, contents: ensureTrailingNewline(newContent) },
  );
  const stats = { additions: 0, deletions: 0 };
  for (const hunk of fileDiff.hunks) {
    stats.additions += hunk.additionLines;
    stats.deletions += hunk.deletionLines;
  }
  return { status: 'ready', fileDiff, stats };
}
