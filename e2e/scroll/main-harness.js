(async () => {
  const source = await (await fetch('/src/components/assistant/AssistantChat.tsx')).text();
  const entry = await (await fetch('/src/main.tsx')).text();
  const dependency = (text, name) => text.match(new RegExp('"([^" ]*/' + name + '\\.js[^" ]*)"'))?.[1];
  const React = (await import(dependency(source, 'react'))).default;
  const { createRoot } = (await import(dependency(entry, 'react-dom_client'))).default;
  const { IntlProvider } = await import(dependency(source, 'react-intl'));
  const transcriptUrl = '/src/components/editor/components/MessagesList.tsx';
  const transcriptSource = await (await fetch(transcriptUrl)).text();
  const conversationPath = transcriptSource.match(/"([^"]*ai-elements\/conversation\.tsx[^"]*)"/)[1];
  const { Conversation, ConversationContent, ConversationScrollButton } = await import(conversationPath);
  const { MessagesList } = await import(transcriptUrl);
  const { ChatNavigator, buildChatNavigatorEntries } = await import('/src/components/editor/components/ChatNavigator.tsx');
  const { ChatWaitingIndicator } = await import('/src/components/editor/components/ChatWaitingIndicator.tsx');
  const delayedHistory = window.__conversationScrollDelayHistory === true;
  delete window.__conversationScrollDelayHistory;
  const h = React.createElement;
  const host = document.createElement('div');
  host.id = 'conversation-scroll-test';
  Object.assign(host.style, { position: 'fixed', inset: '60px auto auto 200px', width: '1000px', height: '540px', zIndex: '999999', display: 'flex', background: 'var(--color-background)' });
  document.body.append(host);
  const root = createRoot(host);
  const message = i => ({ id: 'main-row-' + i, role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: i % 2 ? '## Reply ' + i + '\n\n' + ('Readable markdown text for a long transcript. ').repeat(18) : 'Question ' + i + ': verify navigation and history.' }] });
  function Harness() {
    const initialMessages = () => Array.from({ length: 50 }, (_, i) => message(i));
    const [messages, setMessages] = React.useState(() => delayedHistory ? [] : initialMessages());
    window.__conversationScrollTest = {
      grow: () => setMessages(current => current.map((m, i) => i === current.length - 1 ? { ...m, parts: [{ type: 'text', text: m.parts[0].text + '\n\n' + 'Streamed paragraph. '.repeat(300) }] } : m)),
      prepend: () => setMessages(current => [...Array.from({ length: 8 }, (_, i) => message(i - 8)), ...current]),
      trim: () => setMessages(current => current.slice(8)),
      append: () => setMessages(current => [...current, message(50)]),
      reply: () => setMessages(current => [...current, message(51)]),
      hydrate: () => setMessages(initialMessages()),
      steer: () => setMessages(current => [...current, { ...message(50), metadata: { steer: true, turnMessageId: 'main-row-48' } }]),
      cleanup: () => { root.unmount(); host.remove(); delete window.__conversationScrollTest; },
    };
    return h(IntlProvider, { locale: 'en', messages: {} }, h(Conversation, null,
      h(ConversationContent, { className: 'gap-1 p-4', style: { width: '100%', maxWidth: 700, marginInline: 'auto' } }, h(MessagesList, {
        messages, status: delayedHistory ? 'streaming' : 'ready', currentChatId: 'ui-scroll-test', availableModels: [],
        onPermissionDecide: async () => false, onSendTo: () => {}, onSendToTab: () => {},
      }), h(ChatWaitingIndicator, { active: delayedHistory })),
      h(ChatNavigator, { entries: buildChatNavigatorEntries(messages) }),
      h(ConversationScrollButton),
    ));
  }
  root.render(h(Harness));
})()
