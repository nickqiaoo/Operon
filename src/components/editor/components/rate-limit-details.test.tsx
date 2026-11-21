import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { expect, it } from 'vitest';
import { ClaudeRateLimitsDetails } from './ClaudeRateLimitsButton';
import { CodexRateLimitsDetails } from './CodexRateLimitsButton';

const claude = (
  <ClaudeRateLimitsDetails rateLimits={{ windows: {
    five_hour: { status: 'allowed', utilization: 49 },
    seven_day: { status: 'allowed_warning', utilization: 90 },
  } }} />
);

const codex = (
  <CodexRateLimitsDetails rateLimits={{ rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    primary: { usedPercent: 49, windowDurationMins: 300, resetsAt: null },
    secondary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: null },
    credits: null,
    planType: 'plus',
  } }} />
);

it.each([['Claude', claude], ['Codex', codex]])('shows remaining %s quota in the panel', (_, content) => {
  const html = renderToStaticMarkup(<IntlProvider locale="en">{content}</IntlProvider>);

  expect(html).toContain('51% left');
  expect(html).toContain('10% left');
  expect(html).toMatch(/bg-accent-green[^>]*translateX\(-49%\)/);
  expect(html).toMatch(/bg-accent-red[^>]*translateX\(-90%\)/);
});
