(async () => {
  const transcriptSource = await (await fetch('/src/components/editor/components/MessagesList.tsx')).text();
  const conversationPath = transcriptSource.match(/"([^"]*ai-elements\/conversation\.tsx[^"]*)"/)?.[1] ?? '/src/components/ai-elements/conversation.tsx';
  const source = await (await fetch(conversationPath)).text();
  const entry = await (await fetch('/src/main.tsx')).text();
  const dependency = (text, name) => text.match(new RegExp('"([^" ]*/' + name + '\\.js[^" ]*)"'))?.[1];
  const React = (await import(dependency(source, 'react') ?? dependency(entry, 'react'))).default;
  const { createRoot } = (await import(dependency(entry, 'react-dom_client'))).default;
  const ui = await import(conversationPath);
  const h = React.createElement;
  const host = document.createElement('div');
  host.id = 'conversation-scroll-test';
  Object.assign(host.style, { position: 'fixed', inset: '60px auto auto 280px', width: '700px', height: '440px', zIndex: '999999', display: 'flex', background: 'var(--color-background)', color: 'var(--color-foreground)' });
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [rows, setRows] = React.useState(() => Array.from({ length: 25 }, (_, i) => ({ id: 'row-' + i, height: 100 })));
    const [expanded, setExpanded] = React.useState(false);
    const Item = ui.ConversationItem ?? 'div';
    window.__conversationScrollTest = {
      grow: (height) => setRows(current => current.map((r, i) => i === current.length - 1 ? { ...r, height: r.height + height } : r)),
      prepend: () => setRows(current => [...Array.from({ length: 8 }, (_, i) => ({ id: 'older-' + i, height: 110 })), ...current]),
      trim: () => setRows(current => current.slice(8)),
      append: () => setRows(current => [...current, { id: 'appended', height: 180 }]),
      anchor: () => setRows(current => [...current, { id: 'anchored', height: 100, anchor: true }]),
      cleanup: () => { root.unmount(); host.remove(); delete window.__conversationScrollTest; window.getSelection()?.removeAllRanges(); },
    };
    return h(ui.Conversation, ui.ConversationItem ? {} : { initial: 'instant' },
      h(ui.ConversationContent, { className: 'gap-2 p-4' }, rows.map((row, i) => h(Item, {
        key: row.id, ...(ui.ConversationItem ? { messageId: row.id, scrollAnchor: row.anchor ?? false } : {}), 'data-message-id': row.id,
        style: { height: row.height + (i === rows.length - 1 && expanded ? 600 : 0), flexShrink: 0 },
      }, h('p', null, 'Message ' + row.id + ': content for reading and selection.'), i === rows.length - 1 ? h('button', { type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(v => !v) }, 'Expand details') : null))),
      h(ui.ConversationScrollButton),
    );
  }
  root.render(h(Harness));
  return { engine: ui.ConversationItem ? 'message-scroller' : 'use-stick-to-bottom' };
})()
