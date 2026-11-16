import { memo, useEffect, useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Ellipsis, Folder, GitBranch, Loader2, Split } from 'lucide-react';
import { toast } from 'sonner';
import { ProviderIcon } from '@/components/icons/ProviderLabel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import type { GitBranchEntry } from '@/lib/api-client';
import { gitKeys, useGitBranches } from '@/lib/git-queries';
import { moveDraftToWorkspace, rememberChatProvider } from '@/lib/new-chat';
import { useProviders, type ProviderSummary } from '@/lib/provider-queries';
import { cn } from '@/lib/utils';
import { mainWorkspaceOf } from '@/lib/workspace-actions';
import { useDraftChatStore } from '@/stores/draft-chat-store';
import { useEditorStore } from '@/stores/editor-store';
import { useProjectStore, type Project, type Workspace } from '@/stores/project-store';

const NO_PROVIDERS: ProviderSummary[] = [];

const triggerClassName =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground';

interface DraftChatBarProps {
  tabId: string;
  providerId: string | undefined;
  workspaceId: number | null;
}

/**
 * Above the composer of a chat that has not been sent yet: which agent drives it,
 * which project it runs in, and — under "More settings" — whether its first send
 * cuts a new worktree and from which branch. All are fixed by the first send,
 * after which the tab icon and the header breadcrumb say the same, so the bar goes away.
 */
export const DraftChatBar = memo(function DraftChatBar({ tabId, providerId, workspaceId }: DraftChatBarProps) {
  const projects = useProjectStore((s) => s.projects);
  const current = useMemo(() => {
    for (const project of projects) {
      const workspace = project.workspaces.find((w) => w.id === workspaceId);
      if (workspace) return { project, workspace };
    }
    return null;
  }, [projects, workspaceId]);
  // The intent lives only as long as the draft does: once sent, the bar goes.
  const clearIntent = useDraftChatStore((s) => s.clear);
  useEffect(() => () => clearIntent(tabId), [clearIntent, tabId]);

  return (
    <div data-testid="draft-chat-bar" className="mb-1.5 flex min-w-0 items-center gap-0.5 px-1">
      <AgentPicker tabId={tabId} providerId={providerId} />
      <span aria-hidden className="text-muted-foreground/40">·</span>
      <ProjectPicker tabId={tabId} current={current} />
      {current && <MoreSettings tabId={tabId} workspace={current.workspace} />}
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
      <DropdownMenuContent side="top" align="start" className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
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

function ProjectPicker({ tabId, current }: { tabId: string; current: { project: Project; workspace: Workspace } | null }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const projects = useProjectStore((s) => s.projects);
  const creating = useDraftChatStore((s) => s.byTab[tabId]?.creating ?? false);

  // Pinned first, as in the sidebar; otherwise the store's order.
  const orderedProjects = useMemo(
    () => [...projects].sort((a, b) => Number(b.pinnedAt != null) - Number(a.pinnedAt != null)),
    [projects],
  );
  // A draft opened inside a worktree keeps saying which one.
  const inWorktree = current != null && mainWorkspaceOf(current.project)?.id !== current.workspace.id;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-testid="draft-workspace-picker"
        className={triggerClassName}
        disabled={creating}
        aria-label={intl.formatMessage({ id: 'draftChat.projectAria', defaultMessage: 'Project' })}
      >
        <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
        {current ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 shrink truncate">{current.project.name}</span>
            {inWorktree && (
              <>
                <span aria-hidden className="shrink-0 text-muted-foreground/40">›</span>
                <span className="min-w-0 max-w-40 shrink-[0.5] truncate">{current.workspace.name}</span>
              </>
            )}
          </span>
        ) : (
          <span className="truncate">
            <FormattedMessage id="draftChat.noProject" defaultMessage="Choose project" />
          </span>
        )}
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="max-h-[min(60vh,28rem)] w-56 overflow-y-auto"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {orderedProjects.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            <FormattedMessage id="draftChat.noProjects" defaultMessage="No projects yet" />
          </div>
        )}
        {orderedProjects.map((project) => {
          const target = mainWorkspaceOf(project);
          const selected = current?.project.id === project.id;
          return (
            <DropdownMenuItem
              key={project.id}
              data-testid={`draft-project-option-${project.id}`}
              className="gap-2"
              title={project.rootPath}
              disabled={!target}
              onSelect={() => {
                if (target && target.id !== current?.workspace.id) moveDraftToWorkspace(tabId, target.id, project.id);
              }}
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "More settings": a new worktree for this chat, and the branch. With the
 * worktree on, the branch is where the new one is cut from (its own branch is
 * named from the first message); off, picking a branch switches the checkout
 * the chat runs in.
 */
function MoreSettings({ tabId, workspace }: { tabId: string; workspace: Workspace }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const intent = useDraftChatStore((s) => s.byTab[tabId]);
  const setNewWorktree = useDraftChatStore((s) => s.setNewWorktree);
  const setBaseBranch = useDraftChatStore((s) => s.setBaseBranch);
  const root = workspace.worktreePath;
  const { data: branches = NO_BRANCHES, isError } = useGitBranches(root);

  const newWorktree = intent?.newWorktree ?? false;
  const creating = intent?.creating ?? false;
  const checkedOut = branches.find((b) => b.current && !b.remote)?.name ?? null;
  const shownBranch = (newWorktree ? intent?.baseBranch : null) ?? checkedOut;
  const local = branches.filter((b) => !b.remote);
  // A remote is only a useful start point when there is no local branch of that name.
  const remote = newWorktree
    ? branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`)))
    : NO_BRANCHES;
  // No branches at all: not a git repository, so neither setting applies.
  const isRepo = !isError && branches.length > 0;

  const pickBranch = async (name: string) => {
    if (newWorktree) {
      setBaseBranch(tabId, name === checkedOut ? null : name);
      return;
    }
    if (name === checkedOut) return;
    setSwitching(name);
    try {
      await api.gitCheckout(root, name);
      await queryClient.invalidateQueries({ queryKey: gitKeys.all(root) });
    } catch (error) {
      toast.error(intl.formatMessage({ id: 'draftChat.checkoutFailed', defaultMessage: 'Could not switch to {branch}' }, { branch: name }), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSwitching(null);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-testid="draft-more-settings"
        className={cn(triggerClassName, 'shrink-0 px-1.5')}
        disabled={creating || !isRepo}
        aria-label={intl.formatMessage({ id: 'draftChat.moreSettings', defaultMessage: 'More settings' })}
      >
        {creating ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : newWorktree ? (
          <Split className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Ellipsis className="size-3.5" />
        )}
        {creating && (
          <span className="truncate">
            <FormattedMessage id="draftChat.creatingWorktree" defaultMessage="Creating worktree…" />
          </span>
        )}
        {!creating && newWorktree && shownBranch && <span className="max-w-32 truncate">{shownBranch}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          <FormattedMessage id="draftChat.moreSettings" defaultMessage="More settings" />
        </DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="draft-new-worktree"
          className="gap-2"
          // A switch row: toggling keeps the menu open.
          onSelect={(e) => {
            e.preventDefault();
            setNewWorktree(tabId, !newWorktree);
          }}
        >
          <Split className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">
            <FormattedMessage id="draftChat.newWorktree" defaultMessage="New worktree" />
          </span>
          <Switch checked={newWorktree} tabIndex={-1} className="pointer-events-none" aria-hidden />
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="draft-branch" className="gap-2">
            <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">
              {newWorktree ? (
                <FormattedMessage id="draftChat.baseBranch" defaultMessage="From branch" />
              ) : (
                <FormattedMessage id="draftChat.branch" defaultMessage="Branch" />
              )}
            </span>
            <span className="max-w-28 truncate text-xs text-muted-foreground">{switching ?? shownBranch ?? ''}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(60vh,24rem)] w-60 overflow-y-auto">
            <BranchItems branches={local} selected={shownBranch} busy={switching} onPick={pickBranch} />
            {remote.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  <FormattedMessage id="draftChat.remoteBranches" defaultMessage="Remote" />
                </DropdownMenuLabel>
                <BranchItems branches={remote} selected={shownBranch} busy={switching} onPick={pickBranch} />
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_BRANCHES: GitBranchEntry[] = [];

function BranchItems({
  branches,
  selected,
  busy,
  onPick,
}: {
  branches: GitBranchEntry[];
  selected: string | null;
  busy: string | null;
  onPick: (name: string) => void;
}) {
  return (
    <>
      {branches.map((branch) => (
        <DropdownMenuItem
          key={`${branch.remote ? 'r' : 'l'}:${branch.name}`}
          className="gap-2"
          disabled={busy != null}
          onSelect={() => void onPick(branch.name)}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
          {busy === branch.name ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            branch.name === selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </DropdownMenuItem>
      ))}
    </>
  );
}
