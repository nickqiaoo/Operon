declare const __ENABLE_MEMORY__: boolean

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createNodeWebSocket } from '@hono/node-ws'
import type { AgentBindingStorageAdapter, CanvasWorkflowStorageAdapter, ChannelStorageAdapter, ChatStorageAdapter, CheckpointStorageAdapter, CronjobStorageAdapter, IMStorageAdapter, MemoryMaintenanceStorageAdapter, NotificationStorageAdapter, ProjectStorageAdapter, StorageAdapter, TaskStorageAdapter } from './storage/interface.js'
import { gitRoutes } from './routes/git.js'
import { gitWatchRoutes } from './routes/git-watch.js'
import { fsRoutes } from './routes/fs.js'
import { attachmentRoutes } from './routes/attachments.js'
import { chatHistoryRoutes } from './routes/chat-history.js'
import { aiRoutes } from './routes/ai.js'
import { terminalRoutes } from './routes/terminal.js'
import { fsWatchRoutes } from './routes/fs-watch.js'
import { cronjobRoutes } from './routes/cronjob.js'
import { skillRoutes } from './routes/skill.js'
import { canvasWorkflowRoutes } from './routes/canvas-workflow.js'
import { projectRoutes } from './routes/project.js'
import { agentRoutes, agentBindingRoutes, channelRoutes } from './routes/channel.js'
import { taskRoutes } from './routes/task.js'
import { notificationRoutes } from './routes/notifications.js'
import { sddRoutes } from './routes/sdd.js'
import { workspaceChatMcpRoutes } from './routes/workspace-chat-mcp.js'
import { taskBoardMcpRoutes } from './routes/task-board-mcp.js'
import { mcpRoutes } from './routes/mcp.js'
import { externalAgentMcpRoutes } from './routes/external-agent-mcp.js'
import { workflowMcpRoutes } from './routes/workflow-mcp.js'
import { sweepInterruptedRuns } from './services/workflow/store.js'
import { providerConfigRoutes } from './routes/provider-config.js'
import { initProviderConfigService } from './services/provider-config.js'
import { envRoutes } from './routes/env.js'
import { initEnvConfigService } from './services/env-config.js'
import { cliPathConfigRoutes } from './routes/cli-path-config.js'
import { initCliPathConfigService } from './services/cli-path-config.js'
import { diffPreviewConfigRoutes } from './routes/diff-preview-config.js'
import { initDiffPreviewConfigService, getDiffPreviewConfig } from './services/diff-preview-config.js'
import { commitMessageConfigRoutes } from './routes/commit-message-config.js'
import { initCommitMessageConfigService } from './services/commit-message-config.js'
import { saasRoutes } from './routes/saas.js'
import { integrationsRoutes } from './routes/integrations.js'
import { initIntegrationConfigService } from './services/integration-config.js'
import { pluginApiRoutes } from './routes/plugin-api.js'
import { pluginRoutes } from './routes/plugins.js'
import { extensionRoutes } from './routes/extensions.js'
import { peersRoutes } from './routes/peers.js'
import { connectorRoutes } from './routes/connectors.js'
import { adminIMRoutes } from './routes/admin-im.js'
import { imChatMcpRoutes } from './routes/im-chat-mcp.js'
import { teamInboxMcpRoutes } from './routes/team-inbox-mcp.js'
import { initDesktopIdentity } from './services/mobile/identity.js'
import { IMProviderRegistry } from './gateway/im/registry.js'
import { InboundPipeline } from './gateway/im/inbound-pipeline.js'
import { seedLegacyIMTokens } from './gateway/im/seed-legacy.js'
import { registerIMSourceMeta } from './gateway/im/source-meta.js'
import { slackProviderFactory, slackSourceMeta } from './gateway/im/providers/slack/index.js'
import { telegramProviderFactory, telegramSourceMeta } from './gateway/im/providers/telegram/index.js'
import { InteractiveDispatcher } from './gateway/im/interactive/dispatcher.js'
import { createPermissionHandler } from './gateway/im/permission-handler.js'
import { createSessionConfigStore } from './gateway/im/interactive/session-config.js'
import { buildSlashCommandRegistry } from './gateway/im/slash-commands/index.js'
import { DiffPreviewService } from './gateway/diff-preview-service.js'
import { runMateSetupWizard } from './gateway/im/mate-setup-wizard.js'
import { initMateOrchestrator, wakeMate, interruptMate, resetMate } from './services/channel/mate-orchestrator.js'
import { initAiService, getSessionManager } from './services/ai.js'
import { initOrchestrator } from './services/channel/agent-orchestrator.js'
import { resetAgentSessionsOnStartup } from './services/channel/agent-recovery.js'
import { initEmbeddingConfig } from './services/vector/embeddings.js'
import { CheckpointStore, RewindService } from './services/rewind/index.js'
import { syncBrowserUseSkill } from './services/browser-use-skill.js'
import { getBrowserUseConfig, initBrowserUseConfig } from './services/browser-use-config.js'
import { syncComputerUseSkill } from './services/computer-use-skill.js'
import { getComputerUseConfig, initComputerUseConfig } from './services/computer-use-config.js'
import { syncChromeUseSkill } from './services/chrome-use-skill.js'
import { syncSiteAdaptersSkill } from './services/site-adapters-skill.js'
import { syncWorkflowSkill } from './services/workflow-skill.js'
import { getChromeUseConfig, initChromeUseConfig } from './services/chrome-use-config.js'
import type { SqliteStorage } from './storage/sqlite.js'
import { remoteE2EERoutes } from './routes/remote-e2ee.js'
import { createRemoteE2EEMiddleware, initRemoteE2EE } from './services/remote-e2ee.js'
import { createApiTokenMiddleware } from './services/api-token.js'
import type { RemoteE2EEMode } from '@shared/e2ee/protocol'

export interface AppDeps {
  storage: StorageAdapter & ChatStorageAdapter & CronjobStorageAdapter & CanvasWorkflowStorageAdapter & ProjectStorageAdapter & ChannelStorageAdapter & TaskStorageAdapter & NotificationStorageAdapter & CheckpointStorageAdapter & IMStorageAdapter & AgentBindingStorageAdapter & MemoryMaintenanceStorageAdapter
  /**
   * Optional reseed hook. When set together with `OPERON_ENABLE_FAKE_RUNTIME=1`,
   * the app mounts /api/test/* routes that let e2e specs reset state in
   * `beforeEach`. The hook should clear/recreate any fixture data the tests rely
   * on (project, workspace, etc.).
   */
  reseed?: () => { projectId: number; workspaceId: number; workspaceCwd: string }
  remoteE2eeMode?: RemoteE2EEMode
}

export async function createApp(deps: AppDeps) {
  initProviderConfigService(deps.storage)
  initEnvConfigService(deps.storage)
  initBrowserUseConfig(deps.storage)
  initComputerUseConfig(deps.storage)
  initChromeUseConfig(deps.storage)
  // Reconcile the on-disk skills with their settings before the first session is
  // created: install when the feature is on, delete a previously installed copy when
  // it is off (the app may have been closed while it was still enabled). Tests call
  // the installers explicitly with a temporary home so they never mutate the
  // developer's real skill catalog.
  if (process.env.NODE_ENV !== 'test') {
    for (const [label, sync] of [
      ['Workflow', () => syncWorkflowSkill(true)],
      ['Browser Use', () => syncBrowserUseSkill(getBrowserUseConfig().enabled)],
      ['Computer Use', () => syncComputerUseSkill(getComputerUseConfig().enabled)],
      ['Chrome', () => syncChromeUseSkill(getChromeUseConfig().enabled)],
      // Site-adapter index skill needs Chrome for cookie commands; gate on the same switch.
      ['Site Adapters', () => syncSiteAdaptersSkill(getChromeUseConfig().enabled)],
    ] as const) {
      try {
        await sync()
      } catch (error) {
        console.warn(
          `[${label}] Failed to sync built-in skill: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  CheckpointStore.init(deps.storage)
  // Reclaim disk from rewind snapshot repos whose workspace no longer exists.
  // Runs in the background so it never delays startup.
  void (async () => {
    try {
      const liveCwds = deps.storage
        .listProjects()
        .flatMap((p) => deps.storage.listWorkspaces(p.id).map((w) => w.worktreePath))
      await RewindService.sweepOrphans(liveCwds)
    } catch (err) {
      console.warn('[Rewind] Orphan sweep failed:', err)
    }
  })()
  initAiService(deps.storage)
  // Workflow startup sweep: any run still marked `running` in SQLite was in-flight when
  // the previous process died — its execution is gone, so mark it `interrupted` (resumable
  // by re-invoking OperonWorkflow with resumeFromRunId). Best-effort; never blocks startup.
  try {
    const swept = sweepInterruptedRuns()
    if (swept > 0) console.log(`[workflow] startup sweep: marked ${swept} interrupted run(s)`)
  } catch (error) {
    console.warn(`[workflow] startup sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  initOrchestrator(deps.storage)
  if (__ENABLE_MEMORY__) {
    initEmbeddingConfig(deps.storage)
  }
  initCliPathConfigService(deps.storage)
  initDiffPreviewConfigService(deps.storage)
  initCommitMessageConfigService(deps.storage)
  initIntegrationConfigService(deps.storage)
  initDesktopIdentity(deps.storage)
  const mobileStorage = deps.storage as unknown as import('./storage/interface.js').MobilePairingStorageAdapter
  initRemoteE2EE({ storage: mobileStorage, mode: deps.remoteE2eeMode ?? 'required' })
  seedLegacyIMTokens(deps.storage)

  const app = new Hono()

  // Create WebSocket support with the real app reference
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Every surface reaches this server cross-origin (the Electron renderer from
  // file:// or the dev server, the web client from app.operon.* via the broker),
  // so a response header the client actually reads has to be listed here or
  // `response.headers.get(...)` silently returns null. X-Turn-Id is how a surface
  // tells "the live turn I started" from "a turn a peer started" — without it the
  // live-attach dedup in useChatRuntime degrades to re-attaching to its own turn
  // after every reply. Keep in sync with broker/main.go's withCORS.
  //
  // Origin is a LOCAL-SURFACE allowlist, not '*': the packaged renderer loads
  // from file:// (fetch sends `Origin: null`), dev and standalone-browser modes
  // run on localhost. Nothing else legitimately reads this server cross-origin —
  // web/mobile traffic goes through the broker, whose proxy DROPS the node's
  // access-control-* headers and applies its own policy (broker http_proxy.go
  // writeHead), so this list is invisible to those surfaces. Denying an origin
  // means an arbitrary web page can no longer read responses — defense in depth
  // on top of the api-token gate, and what keeps a leaked ?token= URL from
  // being exploitable from a drive-by page.
  app.use('*', cors({
    origin: (origin) => {
      if (origin === 'null' || origin === 'file://') return origin
      return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) ? origin : ''
    },
    exposeHeaders: [
      'X-Chat-Id',
      'X-Turn-Id',
      'X-Operon-E2EE',
      'X-Operon-E2EE-Context',
      'X-Operon-E2EE-Framing',
      'X-Operon-Inner-Content-Type',
    ],
  }))
  // Token first: an unauthenticated caller learns nothing about E2EE state.
  // Remote (tunneled) requests pass because the tunnel agent injects the token
  // after the broker strips nothing — see tunnel-agent/src/forward.ts.
  app.use('/api/*', createApiTokenMiddleware())
  app.use('/api/*', createRemoteE2EEMiddleware())

  app.onError((err, c) => {
    console.error('Server error:', err)
    return c.json({ error: err.message || 'Internal server error' }, 500)
  })

  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.route('/api/git', gitRoutes())
  app.route('/api/git', gitWatchRoutes())
  app.route('/api/fs', fsRoutes())
  app.route('/api/fs', fsWatchRoutes())
  app.route('/api/attachments', attachmentRoutes())
  app.route('/api/chat-history', chatHistoryRoutes(deps.storage))
  app.route('/api/ai', aiRoutes(deps.storage))
  app.route('/api/terminal', terminalRoutes(upgradeWebSocket))
  if (__ENABLE_MEMORY__) {
    const { memoryMcpRoutes } = await import('./routes/memory-mcp.js')
    const { memoryRoutes } = await import('./routes/memory.js')
    const { memoryMaintenanceRoutes } = await import('./routes/memory-maintenance.js')
    const { embeddingConfigRoutes } = await import('./routes/embedding-config.js')
    app.route('/api/memory-mcp', memoryMcpRoutes())
    app.route('/api/memory', memoryRoutes())
    app.route('/api/memory-maintenance', memoryMaintenanceRoutes(deps.storage))
    app.route('/api/embedding', embeddingConfigRoutes())
  }
  app.route('/api/cronjobs', cronjobRoutes(deps.storage))
  app.route('/api/skills', skillRoutes())
  app.route('/api/canvas-workflows', canvasWorkflowRoutes(deps.storage))
  app.route('/api/projects', projectRoutes(deps.storage))
  app.route('/api/agents', agentRoutes(deps.storage))
  app.route('/api/agent-bindings', agentBindingRoutes(deps.storage))
  app.route('/api/channels', channelRoutes(deps.storage))
  app.route('/api/tasks', taskRoutes(deps.storage))
  app.route('/api/inbox', notificationRoutes(deps.storage))
  app.route('/api/sdd', sddRoutes(deps.storage))
  app.route('/api/workspace-chat-mcp', workspaceChatMcpRoutes(deps.storage))
  app.route('/api/task-board-mcp', taskBoardMcpRoutes(deps.storage))
  // node_repl (Computer Use / Browser Use). Lazy: it forks a kernel per session,
  // so only pay for it when an agent actually calls the tool.
  {
    const { nodeReplMcpRoutes } = await import('./routes/node-repl-mcp.js')
    app.route('/api/node-repl-mcp', nodeReplMcpRoutes())
    // Browser Use approval management. Settings -> Browser reads and writes the
    // same TOML file that node_repl persists.
    const { browserUseRoutes } = await import('./routes/browser-use.js')
    app.route('/api/browser-use', browserUseRoutes())
    // Computer Use has a single master switch. Per-app approval goes through an
    // in-conversation elicitation and is never persisted.
    const { computerUseRoutes } = await import('./routes/computer-use.js')
    app.route('/api/computer-use', computerUseRoutes())

    const { chromeUseRoutes } = await import('./routes/chrome-use.js')
    app.route('/api/chrome-use', chromeUseRoutes())
  }
  app.route('/api/mcp', mcpRoutes())
  app.route('/api/external-agent-mcp', externalAgentMcpRoutes())
  app.route('/api/workflow-mcp', workflowMcpRoutes())
  app.route('/api/provider-configs', providerConfigRoutes())
  app.route('/api/env', envRoutes())
  app.route('/api/cli-paths', cliPathConfigRoutes())
  app.route('/api/diff-preview', diffPreviewConfigRoutes())
  app.route('/api/commit-message', commitMessageConfigRoutes())
  app.route('/api/saas', saasRoutes())
  app.route('/api/integrations', integrationsRoutes())
  app.route('/api/plugin', pluginApiRoutes(deps.storage))
  app.route('/api/plugins', pluginRoutes())
  app.route('/api/extensions', extensionRoutes())
  app.route('/api/peers', peersRoutes())
  app.route('/api/connectors', connectorRoutes())
  app.route('/api/e2ee', remoteE2EERoutes())

  const imRegistry = new IMProviderRegistry(deps.storage)
  imRegistry.register(slackProviderFactory)
  imRegistry.register(telegramProviderFactory)

  registerIMSourceMeta(slackSourceMeta)
  registerIMSourceMeta(telegramSourceMeta)

  const diffPreviewService = new DiffPreviewService(() => {
    const c = getDiffPreviewConfig()
    return c.workerUrl && c.workerApiKey ? c : null
  })

  // Shared PermissionHandler: same instance drives interactive chat approvals
  // AND mate-mode approvals. `runApprovalResponse` routes custom-provider
  // approvals back into the interactive dispatcher; mate uses Claude/Codex/etc
  // and never hits that path.
  const sessionConfigStore = createSessionConfigStore()
  const slashRegistry = buildSlashCommandRegistry({
    storage: deps.storage as SqliteStorage,
    sessionManager: getSessionManager(),
    sessionConfigStore,
    mateHooks: {
      interrupt: (input) => interruptMate(input),
      reset: (input) => resetMate(input),
    },
  })

  const imInbound = new InboundPipeline(
    deps.storage,
    imRegistry,
    {
      wakeMate: (input) => {
        wakeMate(input).catch((err) => {
          console.error(`[IM:wake] agent=${input.agentId} error:`, err)
        })
      },
      startMateSetup: (input) => {
        runMateSetupWizard({
          provider: input.provider,
          storage: deps.storage as SqliteStorage,
          bindingId: input.bindingId,
          agentId: input.agentId,
          ref: { sourceChannel: input.sourceChannel, threadRef: input.threadRef },
        }).catch((err) => {
          console.error(`[IM:setup] binding=${input.bindingId} error:`, err)
        })
      },
    },
    slashRegistry,
  )

  let interactiveDispatcher: InteractiveDispatcher
  const permissionHandler = createPermissionHandler({
    sessionManager: getSessionManager(),
    sessionConfigStore,
    runApprovalResponse: (channelKey, approvalId, approved, reason) => {
      void interactiveDispatcher.runApprovalResponse(channelKey, approvalId, approved, reason)
    },
  })
  interactiveDispatcher = new InteractiveDispatcher({
    storage: deps.storage as SqliteStorage,
    diffPreviewService,
    permissionHandler,
    sessionConfigStore,
    slashRegistry,
  })
  initMateOrchestrator(deps.storage, imRegistry, permissionHandler)
  imRegistry.setModeConsumer('mate', imInbound)
  imRegistry.setModeConsumer('interactive', interactiveDispatcher)

  imRegistry.startAll().catch((err) => {
    console.error('[IM] startAll failed:', err)
  })
  app.route('/api/admin/im', adminIMRoutes(deps.storage, imRegistry))
  app.route('/api/im-chat-mcp', imChatMcpRoutes(deps.storage, imRegistry))
  app.route('/api/team-inbox-mcp', teamInboxMcpRoutes(deps.storage))

  if (process.env.OPERON_ENABLE_FAKE_RUNTIME === '1' && deps.reseed) {
    const { testControlRoutes } = await import('./routes/test-control.js')
    app.route(
      '/api/test',
      testControlRoutes({ storage: deps.storage as SqliteStorage, reseed: deps.reseed }),
    )
  }

  // Reset stale agent sessions to idle (do NOT auto-wake on restart)
  resetAgentSessionsOnStartup(deps.storage)

  return { app, injectWebSocket }
}
