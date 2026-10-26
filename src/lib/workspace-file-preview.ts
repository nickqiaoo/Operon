import type { Tab } from "@/components/app-shell/tabs/types"
import { useAppShellStore } from "@/stores/app-shell-store"
import { useProjectStore } from "@/stores/project-store"
import { useTabsStore } from "@/stores/tabs-store"
import { basename } from "@/lib/workspace-files"
import { resolveCitationFile } from "@/lib/file-citation"
import { openPreviewFile, previewFilesOf } from "@/lib/workspace-preview-files"

interface OpenWorkspaceFilePreviewOptions {
  line?: number
  /** Source directory for relative references and the preferred file tree root. */
  rootPath?: string
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "") || "/"

const containsFile = (rootPath: string, filePath: string): boolean =>
  filePath !== rootPath && filePath.startsWith(rootPath === "/" ? "/" : `${rootPath}/`)

const createWorkspaceTabId = (rootPath: string): string =>
  `workspace:${rootPath}:${crypto.randomUUID()}`

const resolveActiveWorkspacePath = (
  filePath: string,
  sourceRoot?: string
): { rootPath: string; absolutePath: string } | null => {
  const projectStore = useProjectStore.getState()
  const activeWorkspace = projectStore.getActiveWorkspace()
  const source = sourceRoot ?? activeWorkspace?.worktreePath
  const absolutePath = resolveCitationFile(source ?? null, filePath)
  if (!absolutePath || absolutePath === "/") return null

  if (source) {
    const rootPath = normalizePath(source)
    if (absolutePath === rootPath) return null
    if (containsFile(rootPath, absolutePath)) return { rootPath, absolutePath }
  }

  // Cross-project references use the owning tree without changing the active workspace.
  const roots = projectStore.projects.flatMap((project) => [
    project.rootPath,
    ...project.workspaces.map((workspace) => workspace.worktreePath),
  ]).map(normalizePath)
  const rootPath = roots.filter((root) => containsFile(root, absolutePath))
    .sort((a, b) => b.length - a.length)[0]
    ?? (absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/")

  return { rootPath, absolutePath }
}

export function openWorkspaceFilePreview(
  filePath: string,
  options: OpenWorkspaceFilePreviewOptions = {}
): boolean {
  const resolved = resolveActiveWorkspacePath(filePath, options.rootPath)
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

  // Open alongside the files already in the strip rather than replacing the
  // one being read.
  const files = openPreviewFile(
    existing?.payload.type === "workspace-browser"
      ? previewFilesOf(existing.payload)
      : { openPaths: [], recentPaths: [] },
    absolutePath
  )
  const payload = {
    type: "workspace-browser" as const,
    rootPath,
    selectedPath: absolutePath,
    ...files,
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
    useAppShellStore.getState().toggleWorkspaceTree(tab.tabId)
    tabs.openTab("right", tab)
  }

  useAppShellStore.getState().setRightPanelOpen(true)
  return true
}
