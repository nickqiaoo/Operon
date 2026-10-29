import { useState } from 'react';
import { useIntl } from 'react-intl';
import { CornerUpRightIcon } from 'lucide-react';
import { MessageAction } from '@/components/ai-elements/message';
import { useEditorStore } from '@/stores/editor-store';
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';

interface SendToChatButtonProps {
  onSendTo: (tabId: string) => void;
  currentChatId: string;
}

export function SendToChatButton({ onSendTo, currentChatId }: SendToChatButtonProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  // Read here rather than passed down: as a prop, every tab change (a title, a new
  // chat) re-rendered every message of every open chat to reach this button.
  const tabs = useEditorStore((state) => state.tabs);
  const otherTabs = tabs.filter((t) => t.type === 'chat' && t.id !== currentChatId);

  if (otherTabs.length === 0) return null;

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <MessageAction label={intl.formatMessage({ id: 'editor.action.sendToTab', defaultMessage: 'Send to Tab' })}>
          <CornerUpRightIcon className="size-3" />
        </MessageAction>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder={intl.formatMessage({ id: 'editor.tabSearch', defaultMessage: 'Search tabs...' })} />
        <ModelSelectorList>
          <ModelSelectorGroup heading={intl.formatMessage({ id: 'editor.openChats', defaultMessage: 'Open Chats' })}>
            {otherTabs.map((tab) => (
              <ModelSelectorItem
                key={tab.id}
                value={tab.title}
                onSelect={() => {
                  onSendTo(tab.id);
                  setOpen(false);
                }}
              >
                <div className="flex items-center gap-2">
                  <ModelSelectorLogo provider={tab.provider ?? ''} />
                  <span className="text-xs truncate max-w-[200px]">{tab.title}</span>
                </div>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
