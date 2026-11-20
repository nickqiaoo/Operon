import { useState, type ReactNode } from 'react';
import { FormattedMessage } from 'react-intl';
import { CollapsibleContent } from '@/components/ui/collapsible';
import { TraceCollapsible, TraceCollapsibleTrigger, TraceTitle } from '@/components/ui/trace';
import { formatElapsed } from './turn-duration';

/**
 * Concise mode: everything a finished reply did before its final text — thinking,
 * tool calls, the prose between them — folded behind one "Worked for 4m 47s" line.
 * Opened, the work reads exactly as it does with concise mode off (no rail, full
 * color): it is the same transcript, only hidden by default.
 */
export function TurnWorkFold({ durationMs, children }: { durationMs?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen} data-testid="turn-work-fold">
      <TraceCollapsibleTrigger className="text-sm">
        <TraceTitle>
          {durationMs != null ? (
            <FormattedMessage
              id="editor.turnFold.workedFor"
              defaultMessage="Worked for {duration}"
              values={{ duration: formatElapsed(durationMs) }}
            />
          ) : (
            <FormattedMessage id="editor.turnFold.worked" defaultMessage="Worked" />
          )}
        </TraceTitle>
      </TraceCollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden duration-200 [--radix-accordion-content-height:var(--radix-collapsible-content-height)] data-open:animate-accordion-down data-closed:animate-accordion-up">
        <div className="mt-1 space-y-1 phone:space-y-3">{children}</div>
      </CollapsibleContent>
    </TraceCollapsible>
  );
}
