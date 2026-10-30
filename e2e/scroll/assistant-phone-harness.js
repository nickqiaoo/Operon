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
  Object.assign(host.style, { position: 'fixed', inset: '60px auto auto 280px', width: '390px', height: '700px', zIndex: '999999', background: 'var(--color-background)' });
  document.body.append(host);
  const root = createRoot(host);
  // Saved positions outlive a harness; a key of its own keeps tests apart.
  const positionKey = 'scroll-test-' + Date.now();
  const message = i => ({ id: 'assistant-row-' + i, role: i % 2 ? 'assistant' : 'user', text: ('Message ' + i + ': verify positioning across tab switches. ').repeat(4), createdAt: 1793232000000 + i * 60000 });
  let messages = Array.from({ length: 120 }, (_, i) => message(i));
  // As MobileAssistantScreen: the floating header is measured after the thread mounts.
  function Screen() {
    const header = React.useRef(null);
    const [headerHeight, setHeaderHeight] = React.useState(0);
    const [list, setList] = React.useState(messages);
    React.useLayoutEffect(() => setHeaderHeight(header.current.offsetHeight), []);
    // Coming back to the tab reloads the thread from the server.
    React.useEffect(() => {
      const timer = setTimeout(() => { messages = messages.map(m => ({ ...m })); setList(messages); }, 30);
      return () => clearTimeout(timer);
    }, []);
    return h('div', { style: { position: 'relative', height: '100%' } },
      h(AssistantChat, {
        compact: true, positionKey, insetTop: headerHeight, messages: list, typing: false, hasMore: false, loadingOlder: false, activities: [],
        onLoadOlder: () => {}, onSend: async () => {}, onDecide: () => {}, onOpenMemory: () => {}, onOpenChat: () => {},
      }),
      h('div', { ref: header, style: { position: 'absolute', inset: '0 0 auto 0', height: '110px', pointerEvents: 'none' } }));
  }
  function Harness() {
    const [shown, setShown] = React.useState(true);
    window.__conversationScrollTest = {
      switchTab: () => new Promise(resolve => { setShown(false); setTimeout(() => { setShown(true); resolve(); }, 50); }),
      cleanup: () => { root.unmount(); host.remove(); delete window.__conversationScrollTest; },
    };
    return h(IntlProvider, { locale: 'en', messages: {} }, shown ? h(Screen) : null);
  }
  root.render(h(Harness));
})()
