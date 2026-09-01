import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useProviderCapabilityStore } from '@/stores/provider-capability-store';

export interface DynamicModel {
  id: string;
  label: string;
  providerId: string;
  provider: string;
  group: string;
  hasThinking: boolean;
  supportedEffortLevels?: string[];
  supportsAutoMode?: boolean;
  supportsFastMode?: boolean;
  supportsAdaptiveThinking?: boolean;
}

type ProviderConfigCategory = 'model' | 'mode' | 'thought_level' | 'service_tier';

interface ProviderConfigOptionResponse {
  category: ProviderConfigCategory;
  currentValue?: string;
  options: Array<{
    value: string;
    name: string;
    description?: string;
    providerLogo?: string;
    providerLabel?: string;
    supportedEffortLevels?: string[];
    supportsAutoMode?: boolean;
    supportsFastMode?: boolean;
    supportsAdaptiveThinking?: boolean;
  }>;
}

interface ProviderModelsResponse {
  models?: Array<{
    id?: string;
    modelId?: string;
    name: string;
    providerLogo?: string;
    providerLabel?: string;
  }>;
  currentModelId?: string;
  modes?: Array<{ id: string; name: string; description?: string }>;
  currentModeId?: string;
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
  currentServiceTier?: string;
  commands?: Array<{ id: string; name: string; description?: string }>;
  skills?: Array<{ name: string; description?: string }>;
  slashCommands?: Array<{ name: string; description?: string; type?: 'skill' | 'command' }>;
  features?: {
    injection?: boolean;
    goal?: boolean;
    dynamicSwitch?: boolean;
    contextUsage?: boolean;
    sideChat?: boolean;
  };
  configOptions?: ProviderConfigOptionResponse[];
  // Set by the backend SWR cache when the provider's model list isn't ready yet
  // (e.g. copilot's background probe is still running). We poll until it clears.
  modelsPending?: boolean;
}

// How the frontend backs off while a provider is still warming up. copilot's
// probe takes ~10-20s, so ~15 tries at 2s covers the cold-start window.
const MODELS_PENDING_POLL_MS = 2000;
const MODELS_PENDING_MAX_ATTEMPTS = 15;

// ---------------------------------------------------------------------------
// Global invalidation – lets external code (e.g. settings save) tell every
// mounted instance to re-fetch.
// ---------------------------------------------------------------------------
const invalidationListeners = new Set<() => void>();

/**
 * Call this whenever provider configs are saved or toggled.
 * Every mounted useModelManagement instance will re-fetch its own models.
 */
export function invalidateModelsCache() {
  invalidationListeners.forEach((notify) => notify());
}

export interface ProviderCommand {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderSkillInfo {
  name: string;
  description: string;
}

export interface SlashCommandItem {
  name: string;
  description: string;
  type: 'skill' | 'command';
}

interface ProviderConfig {
  modes: { value: string; label: string; description?: string }[];
  defaultMode: string;
  serviceTiers: { value: string; label: string; description?: string }[];
  defaultServiceTier: string;
  thinkingEfforts: { value: string; label: string }[];
  commands: ProviderCommand[];
  skills: ProviderSkillInfo[];
  slashCommands: SlashCommandItem[];
  supportsInjection: boolean;
  supportsGoal: boolean;
  /** Provider can switch model / mode on a live session, so the pickers stay usable mid-turn. */
  supportsDynamicSwitch: boolean;
  /** Provider reports a per-category context-window breakdown for the usage panel. */
  supportsContextUsage: boolean;
}

export interface InitialModelOptions {
  modeId?: string;
  serviceTier?: string;
}

/**
 * Merge items that share a colon-delimited prefix into a single entry.
 * e.g. "build-ios-apps:ios-debugger-agent" and "build-ios-apps:swiftui-liquid-glass"
 * become one entry named "build-ios-apps".
 */
function dedupeByPrefix<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const colonIdx = item.name.indexOf(':');
    const key = colonIdx !== -1 ? item.name.slice(0, colonIdx) : item.name;
    if (seen.has(key)) continue;
    seen.add(key);
    if (colonIdx !== -1) {
      result.push({ ...item, name: key });
    } else {
      result.push(item);
    }
  }
  return result;
}

export function useModelManagement(
  initialModel: string,
  providerId?: string,
  initialOptions?: InitialModelOptions,
) {
  const [model, setModelState] = useState(initialModel);
  const [availableModels, setAvailableModels] = useState<DynamicModel[]>([]);
  const [providerConfigs, setProviderConfigs] = useState<Record<string, ProviderConfig>>({});
  const [currentModes, setCurrentModes] = useState<Record<string, string>>({});
  const [currentServiceTiers, setCurrentServiceTiers] = useState<Record<string, string>>({});

  // Bumped by refetch() or invalidateModelsCache() — causes the load effect to re-run
  const [version, setVersion] = useState(0);

  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  // Warm-up poll bookkeeping (see MODELS_PENDING_*). A ref so it survives
  // re-renders without retriggering the load effect.
  const pendingPoll = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempts: number }>({
    timer: null,
    attempts: 0,
  });

  // Reset the warm-up poll counter whenever the provider changes.
  useEffect(() => {
    pendingPoll.current.attempts = 0;
  }, [providerId]);

  // Subscribe to global invalidation events for the lifetime of this component
  useEffect(() => {
    invalidationListeners.add(refetch);
    return () => { invalidationListeners.delete(refetch); };
  }, [refetch]);

  // Fetch models for this tab's provider only
  useEffect(() => {
    if (!providerId) return;

    let active = true;
    const emptyData: ProviderModelsResponse = {
      models: [],
      currentModelId: '',
      modes: [],
      currentModeId: '',
      serviceTiers: [],
      currentServiceTier: '',
      features: { injection: false },
      configOptions: [],
    };

    async function loadModels() {
      try {
        let data: ProviderModelsResponse;
        try {
          data = await api.getProviderModels(providerId!) as ProviderModelsResponse;
        } catch {
          data = emptyData;
        }

        if (!active) return;

        const models: DynamicModel[] = [];
        const configs: Record<string, ProviderConfig> = {};
        const modes: Record<string, string> = {};
        const serviceTiersByProvider: Record<string, string> = {};

        const modelConfigOpt = data.configOptions?.find((c) => c.category === 'model');
        const effortConfig = data.configOptions?.find((c) => c.category === 'thought_level');
        const modeConfigOpt = data.configOptions?.find((c) => c.category === 'mode');
        const serviceTierConfigOpt = data.configOptions?.find((c) => c.category === 'service_tier');
        const hasThinking = !!effortConfig;

        const providerModes = modeConfigOpt?.options?.length
          ? modeConfigOpt.options.map((o) => ({ value: o.value, label: o.name, description: o.description }))
          : data.modes?.length
            ? data.modes.map((m) => ({ value: m.id, label: m.name, description: m.description }))
            : [];
        const defaultMode = modeConfigOpt?.currentValue ?? data.currentModeId ?? '';
        const providerServiceTiers = serviceTierConfigOpt?.options?.length
          ? serviceTierConfigOpt.options.map((o) => ({ value: o.value, label: o.name, description: o.description }))
          : data.serviceTiers?.length
            ? data.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name, description: tier.description }))
            : [];
        const defaultServiceTier = serviceTierConfigOpt?.currentValue ?? data.currentServiceTier ?? '';

        const providerCommands: ProviderCommand[] = (data.commands ?? []).map((c) => ({
          id: c.id, name: c.name, description: c.description,
        }));

        const providerSkills: ProviderSkillInfo[] = dedupeByPrefix((data.skills ?? []).map((s) => ({
          name: s.name, description: s.description ?? '',
        })));

        const providerSlashCommands: SlashCommandItem[] = dedupeByPrefix((data.slashCommands ?? []).map((s) => ({
          name: s.name, description: s.description ?? '', type: s.type ?? 'skill',
        })));

        configs[providerId!] = {
          modes: providerModes,
          defaultMode,
          serviceTiers: providerServiceTiers,
          defaultServiceTier,
          thinkingEfforts: effortConfig?.options?.map((o) => ({ value: o.value, label: o.name })) ?? [],
          commands: providerCommands,
          skills: providerSkills,
          slashCommands: providerSlashCommands,
          supportsInjection: data.features?.injection === true,
          supportsGoal: data.features?.goal === true,
          supportsDynamicSwitch: data.features?.dynamicSwitch === true,
          supportsContextUsage: data.features?.contextUsage === true,
        };
        // Mirror the capability bits so surfaces outside this chat (the right
        // panel's new-tab menu) can gate on them without refetching.
        useProviderCapabilityStore.getState().setCapabilities(providerId!, {
          sideChat: data.features?.sideChat === true,
        });
        const initialMode = initialOptions?.modeId;
        const resolvedMode = initialMode && providerModes.some((mode) => mode.value === initialMode)
          ? initialMode
          : defaultMode;
        const initialServiceTier = initialOptions?.serviceTier;
        const resolvedServiceTier =
          initialServiceTier &&
          providerServiceTiers.some((tier) => tier.value === initialServiceTier)
            ? initialServiceTier
            : defaultServiceTier;
        if (resolvedMode) modes[providerId!] = resolvedMode;
        if (resolvedServiceTier) serviceTiersByProvider[providerId!] = resolvedServiceTier;

        // provider info comes back from the models endpoint in each option
        const providerLogo = modelConfigOpt?.options?.[0]?.providerLogo ?? providerId!;
        const providerLabel = modelConfigOpt?.options?.[0]?.providerLabel ?? providerId!;

        if (modelConfigOpt?.options?.length) {
          for (const opt of modelConfigOpt.options) {
            // Prefer per-model effort info when the provider supplies it.
            const modelHasThinking = opt.supportedEffortLevels
              ? opt.supportedEffortLevels.length > 0
              : hasThinking;
            models.push({
              id: opt.value, label: opt.name,
              providerId: providerId!,
              provider: opt.providerLogo ?? providerLogo,
              group: opt.providerLabel ?? providerLabel,
              hasThinking: modelHasThinking,
              supportedEffortLevels: opt.supportedEffortLevels,
              supportsAutoMode: opt.supportsAutoMode,
              supportsFastMode: opt.supportsFastMode,
              supportsAdaptiveThinking: opt.supportsAdaptiveThinking,
            });
          }
        } else if (data.models?.length) {
          for (const m of data.models) {
            const modelId = m.id ?? m.modelId;
            if (!modelId) continue;
            models.push({
              id: modelId,
              label: m.name,
              providerId: providerId!,
              provider: m.providerLogo ?? providerLogo,
              group: m.providerLabel ?? providerLabel,
              hasThinking: false,
            });
          }
        }

        setAvailableModels(models);
        setProviderConfigs(configs);
        setCurrentModes(modes);
        setCurrentServiceTiers(serviceTiersByProvider);

        // Provider still warming up on the backend (e.g. copilot's probe): keep
        // polling until the real list lands or we hit the attempt cap.
        if (data.modelsPending && models.length === 0) {
          if (pendingPoll.current.attempts < MODELS_PENDING_MAX_ATTEMPTS) {
            pendingPoll.current.attempts += 1;
            pendingPoll.current.timer = setTimeout(() => {
              pendingPoll.current.timer = null;
              refetch();
            }, MODELS_PENDING_POLL_MS);
          }
        } else {
          pendingPoll.current.attempts = 0;
        }
      } catch (err) {
        console.error('Failed to load provider models:', err);
      }
    }

    loadModels();
    return () => {
      active = false;
      if (pendingPoll.current.timer) {
        clearTimeout(pendingPoll.current.timer);
        pendingPoll.current.timer = null;
      }
    };
  }, [
    providerId,
    version,
    refetch,
    initialOptions?.modeId,
    initialOptions?.serviceTier,
  ]);

  // Auto-select first available model when the list changes
  useEffect(() => {
    if (availableModels.length > 0 && (!model || !availableModels.find((m) => m.id === model))) {
      setModelState(availableModels[0].id);
    }
  }, [availableModels, model]);

  const selectedModel = availableModels.find((item) => item.id === model) ?? availableModels[0];
  const currentProviderId = selectedModel?.providerId;

  // When the selected model doesn't support 'auto' / fast mode, drop those
  // selections so we never send an unsupported config (e.g. switching to Haiku).
  useEffect(() => {
    if (!currentProviderId) return;
    if (selectedModel?.supportsAutoMode === false && currentModes[currentProviderId] === 'auto') {
      setCurrentModes((prev) => ({ ...prev, [currentProviderId]: 'default' }));
    }
  }, [currentProviderId, selectedModel?.supportsAutoMode, currentModes]);

  useEffect(() => {
    if (!currentProviderId) return;
    if (selectedModel?.supportsFastMode === false && currentServiceTiers[currentProviderId] === 'fast') {
      setCurrentServiceTiers((prev) => ({ ...prev, [currentProviderId]: '' }));
    }
  }, [currentProviderId, selectedModel?.supportsFastMode, currentServiceTiers]);
  const currentProviderConfig = currentProviderId ? providerConfigs[currentProviderId] : undefined;
  const modeOptions = (() => {
    const all = currentProviderConfig?.modes ?? [];
    // Hide 'auto' on models that don't support it (capability advertised by init).
    if (selectedModel?.supportsAutoMode === false) return all.filter((o) => o.value !== 'auto');
    return all;
  })();
  const currentMode = currentProviderId ? (currentModes[currentProviderId] ?? '') : '';
  const serviceTierOptions = (() => {
    const all = currentProviderConfig?.serviceTiers ?? [];
    // Hide the Fast toggle on models that don't support fast mode.
    if (selectedModel?.supportsFastMode === false) return all.filter((o) => o.value !== 'fast');
    return all;
  })();
  const currentServiceTier = currentProviderId ? (currentServiceTiers[currentProviderId] ?? '') : '';
  const thinkingEffortOptions = (() => {
    const all = currentProviderConfig?.thinkingEfforts ?? [];
    const supported = selectedModel?.supportedEffortLevels;
    // Prefer the per-model effort list when the provider advertises it.
    if (supported) return all.filter((o) => supported.includes(o.value));
    // Fallback heuristic for providers without per-model capability data.
    const modelId = selectedModel?.id?.toLowerCase() ?? '';
    if (modelId.includes('haiku')) return [];
    if (!modelId.includes('opus')) return all.filter((o) => o.value !== 'xhigh' && o.value !== 'max');
    return all;
  })();
  const commands = currentProviderConfig?.commands ?? [];
  const skills = currentProviderConfig?.skills ?? [];
  const slashCommands = currentProviderConfig?.slashCommands ?? [];
  const supportsInjection = currentProviderConfig?.supportsInjection ?? false;
  const supportsGoal = currentProviderConfig?.supportsGoal ?? false;
  const supportsDynamicSwitch = currentProviderConfig?.supportsDynamicSwitch ?? false;
  const supportsContextUsage = currentProviderConfig?.supportsContextUsage ?? false;

  const modeButtonColorClasses = [
    '',
    'border-blue-500/60 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300',
    'border-purple-500/60 bg-purple-500/10 text-purple-600 hover:bg-purple-500/20 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300',
    'border-orange-500/60 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300',
    'border-green-500/60 bg-green-500/10 text-green-600 hover:bg-green-500/20 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300',
    'border-pink-500/60 bg-pink-500/10 text-pink-600 hover:bg-pink-500/20 hover:text-pink-700 dark:text-pink-400 dark:hover:text-pink-300',
  ];
  const currentModeIndex = modeOptions.findIndex((o) => o.value === currentMode);
  const modeButtonClass = modeButtonColorClasses[currentModeIndex] ?? modeButtonColorClasses[0];

  const setModel = useCallback((newModel: string) => { setModelState(newModel); }, []);

  const cycleMode = () => {
    if (!modeOptions.length || !currentProviderId) return;
    const idx = modeOptions.findIndex((o) => o.value === currentMode);
    const next = modeOptions[(idx + 1) % modeOptions.length];
    setCurrentModes((prev) => ({ ...prev, [currentProviderId]: next.value }));
  };

  const setMode = useCallback(
    (nextMode: string) => {
      if (!currentProviderId) return;
      setCurrentModes((prev) => ({ ...prev, [currentProviderId]: nextMode }));
    },
    [currentProviderId]
  );

  const setServiceTier = useCallback(
    (nextServiceTier: string) => {
      if (!currentProviderId) return;
      setCurrentServiceTiers((prev) => ({ ...prev, [currentProviderId]: nextServiceTier }));
    },
    [currentProviderId]
  );

  const toggleFastMode = useCallback(() => {
    if (!currentProviderId) return;
    if (!serviceTierOptions.some((option) => option.value === 'fast')) return;

    const fallbackServiceTier =
      serviceTierOptions.find((option) => option.value !== 'fast')?.value ?? '';
    const nextServiceTier = currentServiceTier === 'fast' ? fallbackServiceTier : 'fast';
    setCurrentServiceTiers((prev) => ({ ...prev, [currentProviderId]: nextServiceTier }));
  }, [currentProviderId, currentServiceTier, serviceTierOptions]);

  return {
    model, setModel,
    availableModels, selectedModel,
    currentProviderConfig,
    modeOptions, currentMode,
    serviceTierOptions, currentServiceTier,
    thinkingEffortOptions,
    modeButtonClass,
    cycleMode, setMode,
    setServiceTier, toggleFastMode,
    commands,
    skills,
    slashCommands,
    supportsInjection,
    supportsGoal,
    supportsDynamicSwitch,
    supportsContextUsage,
    refetch,
  };
}
