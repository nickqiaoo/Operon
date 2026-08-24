import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';

import anthropicLogo from '@/assets/logos/claude.svg';
import openaiLogo from '@/assets/logos/openai.svg';
import googleLogo from '@/assets/logos/google.svg';
import deepseekLogo from '@/assets/logos/deepseek.svg';
import kimiLogo from '@/assets/logos/kimi.svg';
import glmLogo from '@/assets/logos/zhipuai.svg';
import minimaxLogo from '@/assets/logos/minimax.svg';
import grokLogo from '@/assets/logos/grok.svg';
import claudeLogo from '@/assets/logos/claude.svg';
import opencodeLogo from '@/assets/logos/opencode.svg';
import vercelLogo from '@/assets/logos/vercel.svg';
import openrouterLogo from '@/assets/logos/openrouter.svg';
import customLogo from '@/assets/logos/custom.svg';
import copilotLogo from '@/assets/logos/copilot.svg';
import cursorLogo from '@/assets/logos/cursor.svg';

import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { MobileSheet } from '@/components/mobile/MobileSheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { useFloatingPanel, panelCn, panelInnerCn } from './floating-panel-utils';

const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  google: googleLogo,
  deepseek: deepseekLogo,
  kimi: kimiLogo,
  moonshot: kimiLogo,
  moonshotai: kimiLogo,
  glm: glmLogo,
  zhipuai: glmLogo,
  minimax: minimaxLogo,
  grok: grokLogo,
  xai: grokLogo,
  claude: claudeLogo,
  opencode: opencodeLogo,
  vercel: vercelLogo,
  openrouter: openrouterLogo,
  custom: customLogo,
  // Agent/adapter ID aliases
  'claude-code': anthropicLogo,
  gemini: googleLogo,
  codex: openaiLogo,
  copilot: copilotLogo,
  cursor: cursorLogo,
};

export function ProviderIcon({ id, size = 14 }: { id: string; size?: number }) {
  const src = PROVIDER_LOGOS[id] ?? PROVIDER_LOGOS[id?.toLowerCase?.()];
  if (!src) return <span className="inline-block rounded-sm bg-muted/60 flex-shrink-0" style={{ width: size, height: size }} />;
  return (
    <img src={src} alt="" width={size} height={size}
      className="dark:invert flex-shrink-0"
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  );
}

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
  const panel = useFloatingPanel();
  const [modelSearch, setModelSearch] = useState('');

  // Reset search when panel closes
  useEffect(() => {
    if (!panel.open) setModelSearch('');
  }, [panel.open]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (panel.open && !isMobile) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [isMobile, panel.open]);

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

  const modelList = (
    <>
      <div className={cn(
        'flex items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/5',
        isMobile && 'sticky top-0 z-10 bg-background'
      )}>
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchInputRef}
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={intl.formatMessage({ id: 'editor.modelSearch', defaultMessage: 'Search models...' })}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/60 md:text-sm"
        />
      </div>

      <div
        data-testid="model-selector-list"
        className={cn(
          'py-1',
          !isMobile && 'max-h-72 touch-pan-y overflow-y-auto overscroll-contain scrollbar-none [-webkit-overflow-scrolling:touch]'
        )}
      >
        {Object.entries(groupedModels).map(([group, items]) => (
          <div key={group} className="mb-0.5">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2">
              <ProviderIcon id={items[0].provider} size={13} />
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/70">
                {group}
              </span>
            </div>
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => { setModel(item.id); panel.close(); }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg py-2 pl-8 pr-3 text-left text-sm transition-colors md:py-1.5',
                  model === item.id
                    ? 'bg-muted/70 text-foreground'
                    : 'text-foreground/80 hover:bg-muted/40 hover:text-foreground'
                )}
              >
                <span className="flex-1 truncate">{item.label}</span>
                {model === item.id && <CheckIcon className="size-3.5 shrink-0 text-tint" />}
              </button>
            ))}
          </div>
        ))}
        {Object.keys(groupedModels).length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {availableModels.length === 0
              ? intl.formatMessage({ id: 'editor.model.noProviders', defaultMessage: 'No providers enabled. Go to Settings -> AI Providers.' })
              : intl.formatMessage({ id: 'editor.model.noModelsFound', defaultMessage: 'No models found.' })}
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Model selector button */}
      <PromptInputButton
        data-composer-dismiss-keyboard
        data-testid="chat-model-selector"
        ref={panel.btnRef}
        onClick={panel.toggle}
        disabled={disabled}
        className={cn('gap-2', buttonClassName)}
      >
        <ProviderIcon id={selectedModel?.provider ?? ''} size={14} />
        {/* Collapse to icon-only when the composer footer is too narrow
            (container query on PromptInputFooter's @container). */}
        <span className="truncate max-w-32 @max-[460px]:hidden">{selectedModel?.label ?? intl.formatMessage({ id: 'editor.model.selectPlaceholder', defaultMessage: 'Select model...' })}</span>
        <ChevronDownIcon className={cn('size-3 opacity-50 transition-transform @max-[460px]:hidden', panel.open && 'rotate-180')} />
      </PromptInputButton>

      {/* Phone-sized layouts use a modal sheet so iOS never pans the visual viewport. */}
      {isMobile ? (
        <MobileSheet
          open={panel.open}
          onClose={panel.close}
          title={intl.formatMessage({ id: 'editor.model.selectTitle', defaultMessage: 'Select model' })}
          contentRef={panel.panelRef}
          bodyClassName="px-1 pb-3"
        >
          <div className="contents" data-composer-dismiss-keyboard>
            {modelList}
          </div>
        </MobileSheet>
      ) : createPortal(
        <div
          ref={panel.panelRef}
          style={panel.pos ? { left: panel.pos.left, bottom: panel.pos.bottom } : undefined}
          className={cn(panelCn(panel.open, !!panel.pos), 'w-72')}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className={panelInnerCn}>
            {modelList}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
