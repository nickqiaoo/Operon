import { useState, type ComponentProps } from 'react';
import { useIntl } from 'react-intl';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import {
  Context,
  ContextDetailedContent,
  ContextTrigger,
  compact,
  formatPercent,
} from '@/components/ai-elements/context';
import { hasNativeTabBar, NativeShell, type NativeInfoSection } from '@/lib/native';

type MobileContextUsageProps = Pick<
  ComponentProps<typeof Context>,
  'chatId' | 'usedTokens' | 'maxTokens' | 'usage' | 'detailedContextUsage'
>;

/**
 * Phone version of the desktop context-usage hover card. Mobile has no hover,
 * so the same percentage trigger opens a bottom sheet with the full breakdown
 * on tap instead. Reuses the desktop {@link ContextTrigger} and
 * {@link ContextDetailedContent} verbatim (both read from the {@link Context}
 * provider, which crosses the sheet's portal) so the label and the breakdown
 * stay identical — only the disclosure mechanism changes.
 */
export function MobileContextUsage(props: MobileContextUsageProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const title = intl.formatMessage({ id: 'editor.context.title', defaultMessage: 'Context window' });

  // Packaged apps: the same numbers as ContextDetailedContent, as a native info sheet.
  const openSheet = () => {
    if (!hasNativeTabBar()) {
      setOpen(true);
      return;
    }
    void NativeShell.presentInfoSheet({ title, sections: contextSections(props) }).catch(() => setOpen(true));
  };

  return (
    <Context {...props}>
      <ContextTrigger
        onClick={openSheet}
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      <MobileSheet
        open={open}
        onClose={() => setOpen(false)}
        title={intl.formatMessage({ id: 'editor.context.title', defaultMessage: 'Context window' })}
      >
        <ContextDetailedContent />
      </MobileSheet>
    </Context>
  );
}

/** The breakdown ContextDetailedContent renders, as rows for the native sheet. */
function contextSections({ usedTokens, maxTokens, usage, detailedContextUsage: detailed }: MobileContextUsageProps): NativeInfoSection[] {
  if (detailed) {
    const max = detailed.maxTokens;
    const hasFree = detailed.categories.some((c) => c.name === 'Free space');
    const categories = hasFree
      ? detailed.categories
      : [...detailed.categories, { name: 'Free space', tokens: Math.max(0, max - detailed.totalTokens), color: '' }];
    const sections: NativeInfoSection[] = [
      {
        header: 'Context window',
        value: `${compact(detailed.totalTokens)} / ${compact(max)} (${formatPercent(detailed.percentage / 100)})`,
        progress: detailed.percentage / 100,
        rows: categories.map((c) => ({
          label: c.name,
          value: compact(c.tokens),
          detail: formatPercent(max > 0 ? c.tokens / max : 0),
          color: c.color.startsWith('#') ? c.color : undefined,
        })),
      },
    ];
    if (detailed.memoryFiles.length > 0) {
      sections.push({
        rows: [{
          label: 'Memory files',
          value: compact(detailed.memoryFiles.reduce((sum, f) => sum + f.tokens, 0)),
          detail: `${detailed.memoryFiles.length} files`,
        }],
      });
    }
    return sections;
  }
  const inputTotal = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const reasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const contextTokens = usedTokens ?? inputTotal;
  const hasPercent = maxTokens != null && maxTokens > 0 && contextTokens > 0;
  const rows: NonNullable<NativeInfoSection['rows']> = [];
  if (inputTotal > 0) rows.push({ label: 'Input', value: compact(inputTotal) });
  if (cacheRead > 0) rows.push({ label: 'Cache Read', value: compact(cacheRead), indent: true });
  if (cacheWrite > 0) rows.push({ label: 'Cache Write', value: compact(cacheWrite), indent: true });
  if (outputTokens > 0) rows.push({ label: 'Output', value: compact(outputTokens) });
  if (reasoning > 0) rows.push({ label: 'Reasoning', value: compact(reasoning), indent: true });
  return [{
    header: hasPercent ? formatPercent(contextTokens / maxTokens) : 'Token Usage',
    value: hasPercent ? `${compact(contextTokens)} / ${compact(maxTokens)}` : `${compact(inputTotal || outputTokens)} tokens`,
    progress: hasPercent ? contextTokens / maxTokens : undefined,
    rows,
  }];
}
