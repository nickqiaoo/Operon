import type { Tab } from "@/components/app-shell/tabs/types"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useProjectStore } from "@/stores/project-store"
import { useTabsStore } from "@/stores/tabs-store"
import { basename, toAbsolutePath } from "@/lib/workspace-files"

interface OpenWorkspaceFilePreviewOptions {
  line?: number
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "")

const createWorkspaceTabId = (rootPath: string): string =>
  `workspace:${rootPath}:${crypto.randomUUID()}`

const resolveActiveWorkspacePath = (
  filePath: string
): { rootPath: string; absolutePath: string } | null => {
  const activeWorkspace = useProjectStore.getState().getActiveWorkspace()
  if (activeWorkspace == null || !activeWorkspace.worktreePath) return null

  const rootPath = normalizePath(activeWorkspace.worktreePath)
  const absolutePath = normalizePath(
    filePath.startsWith("/") ? filePath : toAbsolutePath(rootPath, filePath)
  )

  if (absolutePath === rootPath || !absolutePath.startsWith(`${rootPath}/`)) {
    return null
  }

  return { rootPath, absolutePath }
}

export function openWorkspaceFilePreview(
  filePath: string,
  options: OpenWorkspaceFilePreviewOptions = {}
): boolean {
  const resolved = resolveActiveWorkspacePath(filePath)
  if (resolved == null) return false

  const { rootPath, absolutePath } = resolved
  const tabs = useTabsStore.getState()
  const existing = tabs.right.tabs.find(
    (tab) =>
      tab.payload.type === "workspace-browser" &&
      tab.payload.rootPath === rootPath
  )
  const line = options.line != null ? Math.max(1, Math.floor(options.line)) : undefined
  const gotoNonce =
    line != null
      ? existing?.payload.type === "workspace-browser"
        ? (existing.payload.gotoNonce ?? 0) + 1
        : 1
      : undefined

  const payload = {
    type: "workspace-browser" as const,
    rootPath,
    selectedPath: absolutePath,
    ...(line != null ? { gotoLine: line, gotoNonce } : {}),
  }
  const title = basename(absolutePath)

  if (existing != null) {
    tabs.updateTab("right", existing.tabId, { title, payload })
    tabs.activateTab("right", existing.tabId)
  } else {
    const tab: Tab = {
      tabId: createWorkspaceTabId(rootPath),
      title,
      isClosable: true,
      payload,
    }
    tabs.openTab("right", tab)
  }

  useAppShellStore.getState().setRightPanelOpen(true)
  return true
}
