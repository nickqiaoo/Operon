import { useState } from 'react';
import { useIntl } from 'react-intl';
import { CornerUpRightIcon } from 'lucide-react';
import { MessageAction } from '@/components/ai-elements/message';
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';

interface DynamicModel {
  id: string;
  label: string;
  providerId: string;
  provider: string;
  group: string;
  hasThinking: boolean;
}

export type SendToModel = DynamicModel;

interface SendToButtonProps {
  availableModels: SendToModel[];
  onSendTo: (modelId: string, providerId: string) => void;
  onOpen?: () => void;
}

export function SendToButton({ availableModels, onSendTo, onOpen }: SendToButtonProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  return (
    <ModelSelector open={open} onOpenChange={(v) => { setOpen(v); if (v) onOpen?.(); }}>
      <ModelSelectorTrigger asChild>
        <MessageAction label={intl.formatMessage({ id: 'editor.action.sendTo', defaultMessage: 'Send to' })}>
          <CornerUpRightIcon className="size-3" />
        </MessageAction>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder={intl.formatMessage({ id: 'editor.modelSearch', defaultMessage: 'Search models...' })} />
        <ModelSelectorList>
          {Object.entries(
            availableModels.reduce<Record<string, DynamicModel[]>>((groups, item) => {
              (groups[item.group] ??= []).push(item);
              return groups;
            }, {})
          ).map(([group, items]) => (
            <ModelSelectorGroup key={group} heading={group}>
              {items.map((item) => (
                <ModelSelectorItem
                  key={`${item.providerId}:${item.id}`}
                  value={`${item.group} ${item.label} ${item.id}`}
                  onSelect={() => {
                    onSendTo(item.id, item.providerId);
                    setOpen(false);
                  }}
                >
                  <ModelSelectorLogo provider={item.provider} />
                  <ModelSelectorName>{item.label}</ModelSelectorName>
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
