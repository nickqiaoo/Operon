import { memo, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Check, ChevronDown, Folder, GitBranch, Plus } from 'lucide-react';
import { ProviderIcon } from '@/components/icons/ProviderLabel';
import { NewWorkspaceDialog } from '@/components/project/NewWorkspaceDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { moveDraftToWorkspace, rememberChatProvider } from '@/lib/new-chat';
import { useProviders, type ProviderSummary } from '@/lib/provider-queries';
import { cn } from '@/lib/utils';
import { createProjectWorkspace, findSyncedWorkspace, syncProjectWorkspaces } from '@/lib/workspace-actions';
import { useEditorStore } from '@/stores/editor-store';
import { useProjectStore, type Project } from '@/stores/project-store';

const NO_PROVIDERS: ProviderSummary[] = [];

const triggerClassName =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground';

interface DraftChatBarProps {
  tabId: string;
  providerId: string | undefined;
  workspaceId: number | null;
}

/**
 * Above the composer of a chat that has not been sent yet: which agent drives it
 * and which workspace it runs in. Both are fixed by the first send, after which
 * the tab icon and the header breadcrumb say the same, so the bar goes away.
 */
export const DraftChatBar = memo(function DraftChatBar({ tabId, providerId, workspaceId }: DraftChatBarProps) {
  return (
    <div data-testid="draft-chat-bar" className="mb-1.5 flex min-w-0 items-center gap-0.5 px-1">
      <AgentPicker tabId={tabId} providerId={providerId} />
      <span aria-hidden className="text-muted-foreground/40">·</span>
      <WorkspacePicker tabId={tabId} workspaceId={workspaceId} />
    </div>
  );
});

function AgentPicker({ tabId, providerId }: { tabId: string; providerId: string | undefined }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  // Always on: the trigger shows the current agent's name.
  const { data: providers = NO_PROVIDERS } = useProviders();
  const switchDraftProvider = useEditorStore((s) => s.switchDraftProvider);
  const current = providers.find((p) => p.id === providerId);
  const label = current?.label ?? providerId ?? intl.formatMessage({ id: 'draftChat.agent', defaultMessage: 'Agent' });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-testid="draft-agent-picker"
        className={cn(triggerClassName, 'shrink-0')}
        aria-label={intl.formatMessage({ id: 'draftChat.agentAria', defaultMessage: 'Agent: {name}' }, { name: label })}
      >
        {providerId && <ProviderIcon id={providerId} size={14} />}
        <span className="max-w-32 truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          <FormattedMessage id="draftChat.agentMenuTitle" defaultMessage="Agent" />
        </DropdownMenuLabel>
        {providers.map((p) => (
          <DropdownMenuItem
            key={p.id}
            data-testid={`draft-agent-option-${p.id}`}
            className="gap-2"
            disabled={!p.available}
            onSelect={() => {
              rememberChatProvider(p.id);
              switchDraftProvider(tabId, p.id);
            }}
          >
            <ProviderIcon id={p.id} size={16} />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            {p.id === providerId && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspacePicker({ tabId, workspaceId }: { tabId: string; workspaceId: number | null }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [newWorkspaceProject, setNewWorkspaceProject] = useState<Project | null>(null);
  const projects = useProjectStore((s) => s.projects);

  // Pinned first, as in the sidebar; otherwise the store's order.
  const orderedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(b.pinnedAt != null) - Number(a.pinnedAt != null)),
    [projects],
  );
  const current = useMemo(() => {
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === workspaceId);
      if (workspace) return { project, workspace };
    }
    return null;
  }, [projects, workspaceId]);

  const handleCreateWorkspace = async (branchName: string) => {
    const project = newWorkspaceProject;
    if (!project) return;
    const created = await createProjectWorkspace(project, branchName);
    let target = created;
    try {
      target = findSyncedWorkspace(await syncProjectWorkspaces(project), created);
    } catch (error) {
      // The workspace exists; the sidebar picks up the rest on its next load.
      console.warn('[DraftChatBar] Failed to sync workspaces:', error);
    }
    moveDraftToWorkspace(tabId, target.id, project.id);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          data-testid="draft-workspace-picker"
          className={triggerClassName}
          aria-label={intl.formatMessage({ id: 'draftChat.workspaceAria', defaultMessage: 'Workspace' })}
        >
          <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
          {current ? (
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 shrink truncate">{current.project.name}</span>
              <span aria-hidden className="shrink-0 text-muted-foreground/40">›</span>
              <span className="min-w-0 max-w-40 shrink-[0.5] truncate">{current.workspace.name}</span>
            </span>
          ) : (
            <span className="truncate">
              <FormattedMessage id="draftChat.noWorkspace" defaultMessage="Choose workspace" />
            </span>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(60vh,28rem)] w-64 overflow-y-auto"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {orderedProjects.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              <FormattedMessage id="draftChat.noProjects" defaultMessage="No projects yet" />
            </div>
          )}
          {orderedProjects.map((project, index) => (
            <div key={project.id} role="group" aria-label={project.name}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{project.name}</DropdownMenuLabel>
              {project.workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  className="gap-2"
                  title={workspace.worktreePath}
                  onSelect={() => {
                    if (workspace.id !== workspaceId) moveDraftToWorkspace(tabId, workspace.id, project.id);
                  }}
                >
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {workspace.id === workspaceId && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                className="gap-2 text-muted-foreground"
                data-testid={`draft-new-workspace-${project.id}`}
                onSelect={() => setNewWorkspaceProject(project)}
              >
                <Plus className="size-3.5 shrink-0" />
                <FormattedMessage id="draftChat.newWorkspace" defaultMessage="New workspace…" />
              </DropdownMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewWorkspaceDialog
        open={newWorkspaceProject !== null}
        onOpenChange={(next) => !next && setNewWorkspaceProject(null)}
        project={newWorkspaceProject}
        onConfirm={handleCreateWorkspace}
      />
    </>
  );
}
