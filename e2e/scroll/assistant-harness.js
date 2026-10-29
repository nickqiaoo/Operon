(async () => {
  const source = await (await fetch('/src/components/assistant/AssistantChat.tsx')).text();
  const entry = await (await fetch('/src/main.tsx')).text();
  const dependency = (text, name) => text.match(new RegExp('"([^" ]*/' + name + '\\.js[^" ]*)"'))?.[1];
  const React = (await import(dependency(source, 'react'))).default;
  const { createRoot } = (await import(dependency(entry, 'react-dom_client'))).default;
  const { IntlProvider } = await import(dependency(source, 'react-intl'));
  const { AssistantChat } = await import('/src/components/assistant/AssistantChat.tsx');
  const h = React.createElement;
  const host = document.createElement('div');
  host.id = 'conversation-scroll-test';
  Object.assign(host.style, { position: 'fixed', inset: '60px auto auto 280px', width: '700px', height: '640px', zIndex: '999999', background: 'var(--color-background)' });
  document.body.append(host);
  const root = createRoot(host);
  const message = i => ({ id: 'assistant-row-' + i, role: i % 2 ? 'assistant' : 'user', text: ('Message ' + i + ': verify history positioning and streamed output. ').repeat(5), createdAt: 1793232000000 + i * 60000 });
  function Harness() {
    const [messages, setMessages] = React.useState(() => Array.from({ length: 120 }, (_, i) => message(i)));
    const [hasMore, setHasMore] = React.useState(true);
    const [loading, setLoading] = React.useState(false);
    const [typing, setTyping] = React.useState(false);
    window.__conversationScrollTest = {
      grow: () => setMessages(current => current.map((m, i) => i === current.length - 1 ? { ...m, text: m.text + '\n\n' + 'Streamed paragraph. '.repeat(300) } : m)),
      append: () => setMessages(current => [...current, message(120), message(121)]),
      prepend: () => { setMessages(current => [...Array.from({ length: 20 }, (_, i) => message(i - 20)), ...current]); setHasMore(false); },
      trim: () => setMessages(current => current.slice(20)),
      typing: () => setTyping(true),
      cleanup: () => { root.unmount(); host.remove(); delete window.__conversationScrollTest; window.getSelection()?.removeAllRanges(); },
    };
    return h(IntlProvider, { locale: 'en', messages: {} }, h(AssistantChat, {
      messages, typing, hasMore, loadingOlder: loading, activities: [], compact: false,
      onLoadOlder: () => { setLoading(true); setTimeout(() => { window.__conversationScrollTest.prepend(); setLoading(false); }, 40); },
      onSend: async (text) => setMessages(current => [...current, { ...message(120), text }, message(121)]),
      onDecide: () => {}, onOpenMemory: () => {}, onOpenChat: () => {},
    }));
  }
  root.render(h(Harness));
})()
