import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { SteerTray } from './SteerTray';

describe('SteerTray delivery uncertainty', () => {
  it('allows retry only for known unsent messages and keeps uncertain messages dismissible', () => {
    const render = (status: 'failed' | 'unknown') => renderToStaticMarkup(
      <IntlProvider locale="en">
        <SteerTray
          items={[{ localId: 'local', messageId: 'client', text: 'adjust', status }]}
          canRetry
          onRetry={() => undefined}
          onDismiss={() => undefined}
        />
      </IntlProvider>,
    );
    expect(render('failed')).toContain('data-testid="steer-retry"');
    const uncertain = render('unknown');
    expect(uncertain).toContain('Delivery unknown');
    expect(uncertain).not.toContain('data-testid="steer-retry"');
    expect(uncertain).toContain('data-testid="steer-dismiss"');
  });
});
