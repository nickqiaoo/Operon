import { useState, type ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { CollapsibleContent } from '@/components/ui/collapsible';
import { TraceCollapsible, TraceCollapsibleTrigger, TraceTitle } from '@/components/ui/trace';
import { formatElapsed } from './turn-duration';

/**
 * Concise mode: the earlier rounds of a run that background events started back to
 * back (see `backgroundRunFolds`), behind one line. The run's last round stays out of
 * it, so what the agent says now is in view; opened, the rounds read as they always do.
 */
export function BackgroundRunFold({ rounds, durationMs, children }: { rounds: number; durationMs?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} data-testid="background-run-fold">
      <TraceCollapsibleTrigger className="text-sm">
        <TraceTitle>
          {durationMs != null ? (
            <FormattedMessage
              id="editor.backgroundRunFold.workedFor"
              defaultMessage="{rounds, plural, one {# background event} other {# background events}} · Worked for {duration}"
              values={{ rounds, duration: formatElapsed(durationMs) }}
            />
          ) : (
            <FormattedMessage
              id="editor.backgroundRunFold.events"
              defaultMessage="{rounds, plural, one {# background event} other {# background events}}"
              values={{ rounds }}
            />
          )}
        </TraceTitle>
      </TraceCollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden duration-200 [--radix-accordion-content-height:var(--radix-collapsible-content-height)] data-open:animate-accordion-down data-closed:animate-accordion-up">
        <div className="mt-1 space-y-1 phone:space-y-3">{children}</div>
      </CollapsibleContent>
    </TraceCollapsible>
  );
}
