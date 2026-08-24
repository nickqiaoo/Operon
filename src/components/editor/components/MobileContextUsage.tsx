import { useState, type ComponentProps } from 'react';
import { useIntl } from 'react-intl';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import {
  Context,
  ContextDetailedContent,
  ContextTrigger,
} from '@/components/ai-elements/context';

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

  return (
    <Context {...props}>
      <ContextTrigger
        onClick={() => setOpen(true)}
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
