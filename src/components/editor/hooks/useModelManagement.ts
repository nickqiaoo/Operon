import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { effortOptionsForModel, useProviderModels, type ProviderModelsResponse } from '@/lib/provider-queries';

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
  preserveModel?: boolean;
  modeId?: string;
  serviceTier?: string;
}

/**
 * Merge skills that share a colon-delimited prefix into a single entry.
 * e.g. "build-ios-apps:ios-debugger-agent" and "build-ios-apps:swiftui-liquid-glass"
 * become one entry named "build-ios-apps".
 */
export function dedupeByPrefix<T extends { name: string; type?: 'skill' | 'command' }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    // Command namespaces (e.g. MCP prompts) are part of their executable name.
    const colonIdx = item.type === 'command' ? -1 : item.name.indexOf(':');
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

interface ProviderCatalog {
  models: DynamicModel[];
  config: ProviderConfig;
}

const EMPTY_MODELS_RESPONSE: ProviderModelsResponse = {};
// Stable identities: `availableModels` feeds effect deps and memoized rows.
const NO_MODELS: DynamicModel[] = [];
const NO_CONFIGS: Record<string, ProviderConfig> = {};

/** Turns the raw `/ai/providers/:id/models` payload into what the pickers render. Pure. */
function deriveProviderCatalog(providerId: string, data: ProviderModelsResponse): ProviderCatalog {
  const modelConfigOpt = data.configOptions?.find((c) => c.category === 'model');
  const effortConfig = data.configOptions?.find((c) => c.category === 'thought_level');
  const modeConfigOpt = data.configOptions?.find((c) => c.category === 'mode');
  const serviceTierConfigOpt = data.configOptions?.find((c) => c.category === 'service_tier');
  const hasThinking = !!effortConfig;

  const modes = modeConfigOpt?.options?.length
    ? modeConfigOpt.options.map((o) => ({ value: o.value, label: o.name, description: o.description }))
    : data.modes?.length
      ? data.modes.map((m) => ({ value: m.id, label: m.name, description: m.description }))
      : [];
  const serviceTiers = serviceTierConfigOpt?.options?.length
    ? serviceTierConfigOpt.options.map((o) => ({ value: o.value, label: o.name, description: o.description }))
    : data.serviceTiers?.length
      ? data.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name, description: tier.description }))
      : [];

  const config: ProviderConfig = {
    modes,
    defaultMode: modeConfigOpt?.currentValue ?? data.currentModeId ?? '',
    serviceTiers,
    defaultServiceTier: serviceTierConfigOpt?.currentValue ?? data.currentServiceTier ?? '',
    thinkingEfforts: effortConfig?.options?.map((o) => ({ value: o.value, label: o.name })) ?? [],
    commands: (data.commands ?? []).map((c) => ({ id: c.id, name: c.name, description: c.description })),
    skills: dedupeByPrefix((data.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? '' }))),
    slashCommands: dedupeByPrefix((data.slashCommands ?? []).map((s) => ({
      name: s.name, description: s.description ?? '', type: s.type ?? 'skill',
    }))),
    supportsInjection: data.features?.injection === true,
    supportsGoal: data.features?.goal === true,
    supportsDynamicSwitch: data.features?.dynamicSwitch === true,
    supportsContextUsage: data.features?.contextUsage === true,
  };

  // provider info comes back from the models endpoint in each option
  const providerLogo = modelConfigOpt?.options?.[0]?.providerLogo ?? providerId;
  const providerLabel = modelConfigOpt?.options?.[0]?.providerLabel ?? providerId;

  const models: DynamicModel[] = [];
  if (modelConfigOpt?.options?.length) {
    for (const opt of modelConfigOpt.options) {
      // Prefer per-model effort info when the provider supplies it.
      const modelHasThinking = opt.supportedEffortLevels
        ? opt.supportedEffortLevels.length > 0
        : hasThinking;
      models.push({
        id: opt.value, label: opt.name,
        providerId,
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
        providerId,
        provider: m.providerLogo ?? providerLogo,
        group: m.providerLabel ?? providerLabel,
        hasThinking: false,
      });
    }
  }

  return { models, config };
}

export function useModelManagement(
  initialModel: string,
  providerId?: string,
  initialOptions?: InitialModelOptions,
) {
  const [model, setModelState] = useState(initialModel);
  const [currentModes, setCurrentModes] = useState<Record<string, string>>({});
  const [currentServiceTiers, setCurrentServiceTiers] = useState<Record<string, string>>({});

  // Served from the shared query cache: every tab on the same provider reads
  // one entry, a settings save refreshes them all (`invalidateProviderQueries`),
  // and the copilot warm-up poll lives in the query's `refetchInterval`.
  const { data: modelsData, refetch: refetchModels } = useProviderModels(providerId);
  // `refetch` ignores `enabled`: never fire it without a provider.
  const refetch = useCallback(() => { if (providerId) void refetchModels(); }, [providerId, refetchModels]);

  const catalog = useMemo(
    () => (providerId ? deriveProviderCatalog(providerId, modelsData ?? EMPTY_MODELS_RESPONSE) : null),
    [providerId, modelsData],
  );
  const availableModels = catalog?.models ?? NO_MODELS;
  const providerConfigs = useMemo(
    () => (providerId && catalog ? { [providerId]: catalog.config } : NO_CONFIGS),
    [providerId, catalog],
  );

  // Seed the mode / service-tier selection from the conversation's saved
  // options, falling back to the provider's default. Reseeds wholesale when the
  // provider or saved options change; otherwise only fills a provider that has
  // no selection yet (the list was still warming up), so a background refetch
  // never overwrites what the user picked.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!providerId || !catalog) return;
    const initialMode = initialOptions?.modeId;
    const initialServiceTier = initialOptions?.serviceTier;
    const { modes, defaultMode, serviceTiers, defaultServiceTier } = catalog.config;
    const resolvedMode = initialMode && modes.some((mode) => mode.value === initialMode)
      ? initialMode
      : defaultMode;
    const resolvedServiceTier =
      initialServiceTier && serviceTiers.some((tier) => tier.value === initialServiceTier)
        ? initialServiceTier
        : defaultServiceTier;

    const key = `${providerId}\u0000${initialMode ?? ''}\u0000${initialServiceTier ?? ''}`;
    const reseed = seededFor.current !== key;
    seededFor.current = key;
    const seed = (resolved: string) => (prev: Record<string, string>) => {
      if (reseed) return resolved ? { [providerId]: resolved } : {};
      return providerId in prev || !resolved ? prev : { ...prev, [providerId]: resolved };
    };
    setCurrentModes(seed(resolvedMode));
    setCurrentServiceTiers(seed(resolvedServiceTier));
  }, [providerId, catalog, initialOptions?.modeId, initialOptions?.serviceTier]);


  // Auto-select first available model when the list changes
  useEffect(() => {
    if (availableModels.length > 0 && (!model || (!initialOptions?.preserveModel && !availableModels.find((m) => m.id === model)))) {
      setModelState(availableModels[0].id);
    }
  }, [availableModels, model, initialOptions?.preserveModel]);

  // A server-owned chat may use a valid model absent from a short UI catalog.
  // Keep its actual model visible instead of labeling it as the first entry.
  // Memoized: this reaches every message row as `availableModels`, so a fresh
  // array per render re-rendered a sub-agent's whole transcript on each token.
  const preserveModel = initialOptions?.preserveModel;
  const visibleModels = useMemo<DynamicModel[]>(
    () => preserveModel && model && !availableModels.some((item) => item.id === model)
      ? [{ id: model, label: model === 'default' ? 'Default' : model,
          providerId: providerId ?? '', provider: providerId ?? '', group: providerId ?? '', hasThinking: false }, ...availableModels]
      : availableModels,
    [preserveModel, model, availableModels, providerId],
  );
  const selectedModel = visibleModels.find((item) => item.id === model) ?? visibleModels[0];
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
  const thinkingEffortOptions = effortOptionsForModel(
    currentProviderConfig?.thinkingEfforts ?? [],
    selectedModel?.id,
    selectedModel?.supportedEffortLevels,
  );
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
    availableModels: visibleModels, selectedModel,
    currentProviderConfig,
    modeOptions, currentMode,
    serviceTierOptions, currentServiceTier,
    thinkingEffortOptions,
    modeButtonClass,
    setMode,
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
