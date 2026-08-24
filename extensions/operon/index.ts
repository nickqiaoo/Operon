/**
 * OpenClaw Operon Adapter Plugin
 *
 * Registers Operon as an AI provider in OpenClaw. When selected, user messages
 * are forwarded to Operon's local HTTP API, and responses stream back through
 * OpenClaw's normal channel delivery (Telegram, Discord, Slack, etc.).
 *
 * Users must run /setup to select provider, workspace, and model before chatting.
 */
import { join } from "node:path";
import {
  definePluginEntry,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
  type ProviderWrapStreamFnContext,
  type ProviderNormalizeResolvedModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";
import { registerCommands } from "./commands.js";
import { getOperonUrl } from "./discovery.js";
import { operonAuthHeaders } from "./auth.js";
import { createOperonStreamFn } from "./stream-bridge.js";
import { configureSessionStore, deriveSessionStoreKeyFromSessionKey, setRuntimeSessionKey } from "./session-store.js";

const PROVIDER_ID = "operon";
const AUTH_MARKER = "operon-local";

export default definePluginEntry({
  id: "operon-adapter",
  name: "Operon Adapter",
  description: "Bridges Operon AI providers into OpenClaw channels",

  register(api) {
    const configuredUrl = api.pluginConfig?.serverUrl as string | undefined;
    const configuredStorePath = api.pluginConfig?.sessionStorePath as string | undefined;
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
    const sessionStorePath = configureSessionStore(
      configuredStorePath || (stateDir ? join(stateDir, "plugins", "operon-adapter", "sessions.json") : undefined),
    );

    const resolveUrl = configuredUrl ? async () => configuredUrl : getOperonUrl;

    api.logger.info(
      configuredUrl
        ? `Operon adapter: using configured URL ${configuredUrl}`
        : "Operon adapter: port auto-discovery enabled",
    );
    api.logger.debug(`Operon adapter: session store path ${sessionStorePath}`);

    // Auto-provision auth so the provider works without manual setup.
    upsertAuthProfile({
      profileId: `${PROVIDER_ID}:default`,
      credential: {
        type: "api_key",
        provider: PROVIDER_ID,
        key: AUTH_MARKER,
      },
    });

    const streamOpts = { resolveUrl };

    api.registerProvider({
      id: PROVIDER_ID,
      label: "Operon",
      envVars: ["OPERON_SERVER_URL"],
      auth: [
        {
          id: "local-setup",
          label: "Operon (local)",
          hint: "Auto-discovered from running Operon desktop app",
          kind: "custom",
          run: async () => ({
            profiles: [
              {
                profileId: `${PROVIDER_ID}:default`,
                credential: {
                  type: "api_key" as const,
                  provider: PROVIDER_ID,
                  key: AUTH_MARKER,
                },
              },
            ],
          }),
        },
      ],

      catalog: {
        order: "late",
        run: async (_ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> => {
          const serverUrl = await resolveUrl();
          if (!serverUrl) return null;

          try {
            const response = await fetch(`${serverUrl}/api/plugin/providers`, {
              headers: operonAuthHeaders(),
            });
            if (!response.ok) return null;

            const data = (await response.json()) as {
              providers: Array<{
                id: string;
                label: string;
                available: boolean;
                models: Array<{ modelId: string; name: string; description?: string }>;
              }>;
            };

            const models: Array<{ id: string; name?: string; description?: string }> = [];

            for (const provider of data.providers) {
              if (!provider.available) continue;
              for (const model of provider.models ?? []) {
                models.push({
                  id: `${provider.id}/${model.modelId}`,
                  name: `${provider.label}: ${model.name}`,
                  description: model.description,
                });
              }
              models.push({
                id: provider.id,
                name: `${provider.label} (default)`,
              });
            }

            if (models.length === 0) return null;

            return {
              provider: {
                baseUrl: "http://localhost",
                api: "openai-responses",
                apiKey: AUTH_MARKER,
                models: models.map((m) => ({
                  id: m.id,
                  name: m.name ?? m.id,
                  ...(m.description ? { description: m.description } : {}),
                })) as ModelDefinitionConfig[],
              },
            };
          } catch (err) {
            api.logger.warn(
              `Operon adapter: catalog failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          }
        },
      },

      wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
        if (ctx.provider !== PROVIDER_ID) return ctx.streamFn;
        return createOperonStreamFn(streamOpts);
      },

      normalizeResolvedModel: (ctx: ProviderNormalizeResolvedModelContext) => {
        if (ctx.provider !== PROVIDER_ID) return undefined;
        return ctx.model;
      },
    });

    api.on("llm_input", (event, ctx) => {
      if (!ctx.sessionKey) return;
      const sessionStoreKey = deriveSessionStoreKeyFromSessionKey(ctx.sessionKey);
      if (!sessionStoreKey) return;
      setRuntimeSessionKey(event.sessionId, sessionStoreKey);
    });

    registerCommands(api, resolveUrl);
    api.logger.info("Operon adapter: plugin registered successfully");
  },
});
