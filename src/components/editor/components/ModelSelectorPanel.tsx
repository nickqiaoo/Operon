import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';

import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { hasNativeTabBar, NativeShell } from '@/lib/native';
import { cn } from '@/lib/utils';
import { ProviderIcon } from '@/components/icons/ProviderLabel';
import { providerLogoName } from '@/lib/provider-logos';
import { Command } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelSelectorInput, ModelSelectorList, ModelSelectorGroup, ModelSelectorItem, ModelSelectorEmpty } from '@/components/ai-elements/model-selector';

export { ProviderIcon } from '@/components/icons/ProviderLabel';

export interface DynamicModel {
  id: string;
  label: string;
  providerId: string;
  provider: string;
  group: string;
  hasThinking: boolean;
}

interface ModelSelectorPanelProps {
  selectedModel: DynamicModel | undefined;
  availableModels: DynamicModel[];
  model: string;
  setModel: (id: string) => void;
  buttonClassName: string;
  disabled?: boolean;
}

export function ModelSelectorPanel({
  selectedModel,
  availableModels,
  model,
  setModel,
  buttonClassName,
  disabled,
}: ModelSelectorPanelProps) {
  const intl = useIntl();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  // Reset search when panel closes
  useEffect(() => {
    if (!open) setModelSearch('');
  }, [open]);

  // Packaged apps: the picker is a system sheet (ModelSheet.swift /
  // ModelSheet.kt); the pick comes back as an event. The web sheet stays
  // for the browser.
  const nativeSheet = hasNativeTabBar();
  useEffect(() => {
    if (!nativeSheet) return;
    const handle = NativeShell.addListener('modelPicked', ({ id }) => setModel(id));
    return () => {
      void handle.then((h) => h.remove()).catch(() => {});
    };
  }, [nativeSheet, setModel]);
  const openPicker = () => {
    if (!nativeSheet) {
      setOpen((value) => !value);
      return;
    }
    void NativeShell.presentModelSheet({
      title: intl.formatMessage({ id: 'editor.model.selectTitle', defaultMessage: 'Select model' }),
      searchPlaceholder: intl.formatMessage({ id: 'editor.modelSearch', defaultMessage: 'Search models...' }),
      emptyText: availableModels.length === 0
        ? intl.formatMessage({ id: 'editor.model.noProviders', defaultMessage: 'No providers enabled. Go to Settings -> AI Providers.' })
        : intl.formatMessage({ id: 'editor.model.noModelsFound', defaultMessage: 'No models found.' }),
      selectedId: model || undefined,
      models: availableModels.map((m) => ({ id: m.id, label: m.label, group: m.group, logo: providerLogoName(m.provider) ?? undefined })),
    }).catch(() => setOpen((value) => !value));
  };

  const groupedModels = useMemo(() => {
    const query = modelSearch.toLowerCase();
    const filtered = query
      ? availableModels.filter(
        (m) => m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
      )
      : availableModels;
    return filtered.reduce<Record<string, DynamicModel[]>>((groups, item) => {
      (groups[item.group] ??= []).push(item);
      return groups;
    }, {});
  }, [availableModels, modelSearch]);

  const title = intl.formatMessage({ id: 'editor.model.selectTitle', defaultMessage: 'Select model' });
  const modelList = (
    <Command shouldFilter={false} defaultValue={model} className="h-auto">
      <ModelSelectorInput
        value={modelSearch}
        onValueChange={setModelSearch}
        aria-label={title}
        placeholder={intl.formatMessage({ id: 'editor.modelSearch', defaultMessage: 'Search models...' })}
        className="text-base md:text-sm"
      />
      <ModelSelectorList data-testid="model-selector-list" className="max-h-[min(18rem,50vh)] py-1">
        <ModelSelectorEmpty>
          {availableModels.length === 0
            ? intl.formatMessage({ id: 'editor.model.noProviders', defaultMessage: 'No providers enabled. Go to Settings -> AI Providers.' })
            : intl.formatMessage({ id: 'editor.model.noModelsFound', defaultMessage: 'No models found.' })}
        </ModelSelectorEmpty>
        {Object.entries(groupedModels).map(([group, items]) => (
          <ModelSelectorGroup key={group} heading={
            <span className="flex items-center gap-2">
              <ProviderIcon id={items[0].provider} size={13} />{group}
            </span>
          }>
            {items.map((item) => (
              <ModelSelectorItem key={item.id} value={item.id}
                onSelect={() => { setModel(item.id); setOpen(false); }}
                className="py-2 pl-7 md:py-1.5">
                <span className="flex-1 truncate">{item.label}</span>
                {model === item.id && <CheckIcon className="size-3.5 shrink-0 text-tint" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        ))}
      </ModelSelectorList>
    </Command>
  );
  const trigger = (
    <PromptInputButton
      data-composer-dismiss-keyboard
      data-testid="chat-model-selector"
      aria-label={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={isMobile ? openPicker : undefined}
      disabled={disabled}
      className={cn('gap-2', buttonClassName)}
    >
      <ProviderIcon id={selectedModel?.provider ?? ''} size={14} />
      <span className="truncate max-w-32 @max-[460px]:hidden">{selectedModel?.label ?? intl.formatMessage({ id: 'editor.model.selectPlaceholder', defaultMessage: 'Select model...' })}</span>
      <ChevronDownIcon className={cn('size-3 opacity-50 transition-transform @max-[460px]:hidden', open && 'rotate-180')} />
    </PromptInputButton>
  );

  if (isMobile) {
    return <>
      {trigger}
      <MobileSheet open={open} onClose={() => setOpen(false)} title={title} bodyClassName="px-1 pb-3">
        <div data-composer-dismiss-keyboard>{modelList}</div>
      </MobileSheet>
    </>;
  }

  return (
    <Popover open={open} onOpenChange={(next) => {
      if (next && nativeSheet) openPicker();
      else setOpen(next);
    }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} collisionPadding={8}
        aria-label={title} className="w-72 max-w-[calc(100vw-1rem)] p-1">
        {modelList}
      </PopoverContent>
    </Popover>
  );
}
