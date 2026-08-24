/**
 * /setup wizard command for the Operon adapter plugin.
 *
 * Guides the user through: provider → workspace → model selection.
 * Session config is stored per sender and used by wrapStreamFn.
 */
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ServerUrlResolver } from "./types.js";
import { withOperonServerRetry } from "./discovery.js";
import { buildLegacySessionKey, getSessionConfig, setSessionConfig, clearSessionConfig, type OperonSessionConfig } from "./session-store.js";

interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  models: Array<{ modelId: string; name: string; description?: string }>;
}

interface WorkspaceInfo {
  id: number;
  name: string;
  worktreePath: string;
}

interface ProjectInfo {
  id: number;
  name: string;
  workspaces: WorkspaceInfo[];
}

export function registerCommands(api: OpenClawPluginApi, resolveUrl: ServerUrlResolver): void {
  api.registerCommand({
    name: "setup",
    description: "Setup Operon session (provider, workspace, model)",
    acceptsArgs: true,
    handler: async (ctx: PluginCommandContext) => {
      const args = ctx.args?.trim() ?? "";

      const sessionKey = resolveSessionKey(ctx);

      // No args → start wizard from step 1
      if (!args) {
        return await showProviderStep(resolveUrl);
      }

      const parts = args.split(/\s+/);
      const subcommand = parts[0];
      const value = parts.slice(1).join(" ");

      switch (subcommand) {
        case "provider":
          return await handleProviderSelect(resolveUrl, sessionKey, value);
        case "workspace":
          return await handleWorkspaceSelect(resolveUrl, sessionKey, value);
        case "model":
          return await handleModelSelect(sessionKey, value);
        case "status":
          return showStatus(sessionKey);
        case "reset":
          clearSessionConfig(sessionKey);
          return { text: "Session cleared. Run `/setup` to start again." };
        default:
          return { text: "Unknown subcommand. Usage: `/setup`, `/setup provider <id>`, `/setup workspace <id>`, `/setup model <id>`, `/setup status`, `/setup reset`" };
      }
    },
  });
}

function resolveSessionKey(ctx: PluginCommandContext): string {
  return buildLegacySessionKey(ctx.channel, ctx.senderId);
}

async function showProviderStep(resolveUrl: ServerUrlResolver): Promise<{ text: string }> {
  try {
    const providers = await fetchProviders(resolveUrl);
    if (providers.length === 0) {
      return { text: "No providers available. Configure providers in the Operon desktop app first." };
    }

    const lines = [
      "**Step 1/3: Select a provider**\n",
      ...providers.map((p, i) => `  ${i + 1}. **${p.label}** (\`${p.id}\`)`),
      "",
      "Reply with: `/setup provider <id>`",
      `Example: \`/setup provider ${providers[0].id}\``,
    ];
    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `Failed to fetch providers: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleProviderSelect(resolveUrl: ServerUrlResolver, sessionKey: string, providerId: string): Promise<{ text: string }> {
  if (!providerId) {
    return { text: "Missing provider ID. Usage: `/setup provider <id>`" };
  }

  let providers: ProviderInfo[];
  try {
    providers = await fetchProviders(resolveUrl);
  } catch (err) {
    return { text: `Failed to fetch providers: ${err instanceof Error ? err.message : err}` };
  }
  // Allow selection by index or by ID
  const idx = parseInt(providerId, 10);
  const provider = Number.isFinite(idx) && idx >= 1 && idx <= providers.length
    ? providers[idx - 1]
    : providers.find((p) => p.id === providerId);

  if (!provider) {
    return { text: `Provider "${providerId}" not found. Run \`/setup\` to see available providers.` };
  }

  setSessionConfig(sessionKey, { providerId: provider.id, providerLabel: provider.label });

  // Show workspace step
  try {
    const projects = await fetchWorkspaces(resolveUrl);
    if (projects.length === 0) {
      return { text: `Provider set to **${provider.label}**.\n\nNo workspaces found. Create a workspace in the Operon desktop app first.` };
    }

    const lines = [
      `Provider: **${provider.label}**\n`,
      "**Step 2/3: Select a workspace**\n",
    ];

    let idx = 1;
    for (const project of projects) {
      for (const ws of project.workspaces) {
        const dirName = ws.worktreePath.split("/").pop() || ws.name;
        lines.push(`  ${idx}. **${project.name}** / ${ws.name} (\`${dirName}\`)`);
        idx++;
      }
    }

    lines.push("");
    lines.push("Reply with: `/setup workspace <number>`");

    // Store flat workspace list for index-based selection
    const flatWorkspaces = projects.flatMap((p) =>
      p.workspaces.map((ws) => ({ ...ws, projectName: p.name })),
    );
    setSessionConfig(sessionKey, {
      ...getSessionConfig(sessionKey)!,
      _workspaceChoices: flatWorkspaces,
    });

    return { text: lines.join("\n") };
  } catch (err) {
    return { text: `Provider set to **${provider.label}**, but failed to fetch workspaces: ${err instanceof Error ? err.message : err}` };
  }
}

async function handleWorkspaceSelect(resolveUrl: ServerUrlResolver, sessionKey: string, value: string): Promise<{ text: string }> {
  const config = getSessionConfig(sessionKey);
  if (!config?.providerId) {
    return { text: "No provider selected yet. Run `/setup` to start." };
  }

  if (!value) {
    return { text: "Missing workspace. Usage: `/setup workspace <number>`" };
  }

  const choices = Array.isArray(config._workspaceChoices)
    ? (config._workspaceChoices as Array<WorkspaceInfo & { projectName: string }>)
    : undefined;
  const idx = parseInt(value, 10);

  let workspace: (WorkspaceInfo & { projectName: string }) | undefined;

  if (choices && Number.isFinite(idx) && idx >= 1 && idx <= choices.length) {
    workspace = choices[idx - 1];
  } else {
    // Try by workspace ID
    const wsId = parseInt(value, 10);
    if (choices) {
      workspace = choices.find((ws) => ws.id === wsId);
    }
  }

  if (!workspace) {
    return { text: `Workspace "${value}" not found. Run \`/setup provider ${config.providerId}\` to see workspaces.` };
  }

  setSessionConfig(sessionKey, {
    ...config,
    workspaceId: workspace.id,
    workspaceName: `${workspace.projectName} / ${workspace.name}`,
    _workspaceChoices: undefined,
  });

  // Show model step
  try {
    const providers = await fetchProviders(resolveUrl);
    const provider = providers.find((p) => p.id === config.providerId);
    const models = provider?.models ?? [];

    const lines = [
      `Provider: **${config.providerLabel}**`,
      `Workspace: **${workspace.projectName} / ${workspace.name}**\n`,
      "**Step 3/3: Select a model**\n",
      "  0. Use default",
    ];

    for (let i = 0; i < models.length; i++) {
      lines.push(`  ${i + 1}. **${models[i].name}**${models[i].description ? ` — ${models[i].description}` : ""}`);
    }

    lines.push("");
    lines.push("Reply with: `/setup model <number>` or `/setup model default`");

    setSessionConfig(sessionKey, {
      ...getSessionConfig(sessionKey)!,
      _modelChoices: models,
    });

    return { text: lines.join("\n") };
  } catch (err) {
    return completeSetup(sessionKey);
  }
}

async function handleModelSelect(sessionKey: string, value: string): Promise<{ text: string }> {
  const config = getSessionConfig(sessionKey);
  if (!config?.providerId || !config?.workspaceId) {
    return { text: "Setup incomplete. Run `/setup` to start." };
  }

  if (!value) {
    return { text: "Missing model. Usage: `/setup model <number>` or `/setup model default`" };
  }

  if (value !== "default" && value !== "0") {
    const choices = Array.isArray(config._modelChoices)
      ? (config._modelChoices as Array<{ modelId: string; name: string }>)
      : undefined;
    const idx = parseInt(value, 10);

    let modelId: string | undefined;
    if (choices && Number.isFinite(idx) && idx >= 1 && idx <= choices.length) {
      modelId = choices[idx - 1].modelId;
    } else {
      modelId = value;
    }

    setSessionConfig(sessionKey, {
      ...config,
      modelId,
      _modelChoices: undefined,
    });
  } else {
    setSessionConfig(sessionKey, {
      ...config,
      _modelChoices: undefined,
    });
  }

  return completeSetup(sessionKey);
}

function completeSetup(sessionKey: string): { text: string } {
  const config = getSessionConfig(sessionKey);
  if (!config) return { text: "Setup failed." };

  // Clean up temporary fields
  setSessionConfig(sessionKey, {
    providerId: config.providerId,
    providerLabel: config.providerLabel,
    workspaceId: config.workspaceId,
    workspaceName: config.workspaceName,
    modelId: config.modelId,
    ready: true,
  });

  const lines = [
    "**Session ready!**\n",
    `**Provider**: ${config.providerLabel ?? config.providerId}`,
    `**Workspace**: ${config.workspaceName ?? config.workspaceId}`,
    config.modelId ? `**Model**: ${config.modelId}` : "**Model**: default",
    "",
    "Send a message to start chatting.",
  ];

  return { text: lines.join("\n") };
}

function showStatus(sessionKey: string): { text: string } {
  const config = getSessionConfig(sessionKey);
  if (!config || !config.ready) {
    return { text: "No active session. Run `/setup` to configure." };
  }

  const lines = [
    "**Current session**\n",
    `**Provider**: ${config.providerLabel ?? config.providerId}`,
    `**Workspace**: ${config.workspaceName ?? config.workspaceId}`,
    config.modelId ? `**Model**: ${config.modelId}` : "**Model**: default",
    config.chatId ? `**Chat ID**: ${config.chatId}` : "",
  ];

  return { text: lines.filter(Boolean).join("\n") };
}

// --- API helpers ---

async function fetchProviders(resolveUrl: ServerUrlResolver): Promise<ProviderInfo[]> {
  return withOperonServerRetry(resolveUrl, async (serverUrl) => {
    const response = await fetch(`${serverUrl}/api/plugin/providers`, { headers: operonAuthHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { providers: ProviderInfo[] };
    return data.providers.filter((p) => p.available);
  });
}

async function fetchWorkspaces(resolveUrl: ServerUrlResolver): Promise<ProjectInfo[]> {
  return withOperonServerRetry(resolveUrl, async (serverUrl) => {
    const response = await fetch(`${serverUrl}/api/plugin/workspaces`, { headers: operonAuthHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { projects: ProjectInfo[] };
    return data.projects;
  });
}
