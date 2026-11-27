import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { ChevronDown, Monitor, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  useChangeChatEnvironment,
  useChatEnvironments,
  useSshEnvironmentProfiles,
  useTestSshEnvironment,
  type ChatEnvironment,
} from '@/lib/ssh-environment-queries';
import { useDraftChatStore } from '@/stores/draft-chat-store';
import { useEditorStore } from '@/stores/editor-store';
import { useNavigationStore } from '@/stores/navigation-store';
import type { SshEnvironmentRef } from '@shared/ssh-environment';

const messages = defineMessages({
  trigger: { id: 'environmentPicker.trigger', defaultMessage: 'Execution environment' },
  local: { id: 'environmentPicker.local', defaultMessage: 'Local' },
  defaultEnvironment: { id: 'environmentPicker.default', defaultMessage: 'Default environment' },
  additional: { id: 'environmentPicker.additional', defaultMessage: 'Additional environments' },
  connecting: { id: 'environmentPicker.connecting', defaultMessage: 'Connecting…' },
  removing: { id: 'environmentPicker.removing', defaultMessage: 'Removing…' },
  disconnected: { id: 'environmentPicker.disconnected', defaultMessage: 'Disconnected. Select to reconnect.' },
  chooseDirectory: { id: 'environmentPicker.chooseDirectory', defaultMessage: 'Choose a directory on this computer' },
  afterResponse: { id: 'environmentPicker.afterResponse', defaultMessage: 'You can change environments after this response.' },
  loading: { id: 'environmentPicker.loading', defaultMessage: 'Loading SSH environments…' },
  loadFailed: { id: 'environmentPicker.loadFailed', defaultMessage: 'Could not load environments. Retry' },
  manage: { id: 'environmentPicker.manage', defaultMessage: 'Manage SSH environments' },
  manageOnPhone: { id: 'environmentPicker.manageOnPhone', defaultMessage: 'Manage environments in Settings → Operon' },
  failed: { id: 'environmentPicker.failed', defaultMessage: 'Connection failed.' },
  directoryTitle: { id: 'environmentPicker.directoryTitle', defaultMessage: 'Local directory' },
  directoryDescription: { id: 'environmentPicker.directoryDescription', defaultMessage: 'An absolute path on the computer running Operon. The agent can work there alongside the default environment.' },
  directoryPlaceholder: { id: 'environmentPicker.directoryPlaceholder', defaultMessage: '/Users/me/project' },
  attach: { id: 'environmentPicker.attach', defaultMessage: 'Attach' },
  cancel: { id: 'common.cancel', defaultMessage: 'Cancel' },
});

const triggerClassName =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-accent-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent-active data-[state=open]:text-foreground';

type Failure = { id: string; message: string; add: boolean };

/**
 * Where an Operon chat's tools run: its default environment (chosen before the first message,
 * fixed after) and any additional ones (attached or detached between turns). Before the first
 * message the selection lives on the draft tab; after it, on the chat's session.
 */
export function EnvironmentPicker({ tabId, selected, isMobile, chatId, busy = false, localDir, onChanging }: {
  tabId: string;
  selected?: SshEnvironmentRef;
  isMobile: boolean;
  chatId?: number;
  busy?: boolean;
  /** The chat's workspace on this machine, when it has one: what "Local" attaches. */
  localDir?: string | null;
  onChanging?: (changing: boolean) => void;
}) {
  const intl = useIntl();
  const t = intl.formatMessage;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<Failure>();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const draft = useEditorStore(s => s.tabs.find(tab => tab.id === tabId)?.additionalSshEnvironments);
  const creating = useDraftChatStore(s => s.byTab[tabId]?.creating ?? false);
  const profilesQuery = useSshEnvironmentProfiles(open);
  const live = useChatEnvironments(chatId);
  const change = useChangeChatEnvironment(chatId);
  const testProfile = useTestSshEnvironment();
  const profiles = profilesQuery.data ?? [];
  const additional: Array<SshEnvironmentRef & Partial<Pick<ChatEnvironment, 'connected'>>> = (chatId ? live.data : draft) ?? [];
  const disabled = busy || creating || !!pending || (!!chatId && !live.data);
  const rootLabel = selected?.name ?? t(messages.local);
  const rootDir = selected ? selected.cwd ?? profiles.find(profile => profile.id === selected.id)?.cwd : localDir;
  const local = additional.find(ref => ref.id === 'local');
  const localPath = local?.cwd || localDir || undefined;
  const Icon = selected ? Server : Monitor;

  function pickDefault(ref?: SshEnvironmentRef) {
    if (chatId || disabled || ref?.id === selected?.id) return;
    const store = useEditorStore.getState();
    store.setDraftAdditionalEnvironments(tabId, additional.filter(item => item.id !== (ref?.id ?? 'local')));
    useDraftChatStore.getState().clear(tabId);
    store.setDraftSshEnvironment(tabId, ref);
  }

  async function toggle(ref: SshEnvironmentRef, add: boolean) {
    if (disabled) return;
    setPending(ref.id);
    onChanging?.(true);
    setFailure(undefined);
    try {
      if (chatId) {
        await change.mutateAsync({ id: ref.id, add, localDir: ref.cwd });
      } else {
        const profile = profiles.find(item => item.id === ref.id);
        if (add && profile) await testProfile.mutateAsync(profile);
        const entry = { id: ref.id, name: ref.name, ...(ref.id === 'local' && ref.cwd ? { cwd: ref.cwd } : {}) };
        useEditorStore.getState().setDraftAdditionalEnvironments(tabId,
          add ? [...additional, entry] : additional.filter(item => item.id !== ref.id));
      }
    } catch (error) {
      setFailure({ id: ref.id, add, message: error instanceof Error ? error.message : t(messages.failed) });
    } finally {
      setPending(undefined);
      onChanging?.(false);
    }
  }

  const choices: SshEnvironmentRef[] = [
    ...(selected ? [{ id: 'local', name: t(messages.local), cwd: localPath }] : []),
    ...profiles.filter(profile => profile.id !== selected?.id),
    ...additional.filter(ref => ref.id !== 'local' && !profiles.some(profile => profile.id === ref.id)),
  ];

  return (
    <>
      <DropdownMenu open={open} onOpenChange={next => { setOpen(next); if (next && chatId) void live.refetch(); }}>
        <DropdownMenuTrigger aria-label={t(messages.trigger)} className={triggerClassName} disabled={creating}>
          <Icon className="size-3.5 shrink-0" />
          <span className="max-w-36 truncate">{rootLabel}{additional.length > 0 && ' +' + additional.length}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="max-h-[min(60vh,28rem)] w-72 overflow-y-auto" onCloseAutoFocus={event => event.preventDefault()}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t(messages.defaultEnvironment)}</DropdownMenuLabel>
          {chatId ? (
            <DropdownMenuItem disabled className="gap-2 opacity-100">
              <Icon className="size-4 shrink-0" />
              <EnvironmentText name={rootLabel} detail={rootDir ?? undefined} />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={disabled} className="gap-2">
                <Icon className="size-4 shrink-0" />
                <EnvironmentText name={rootLabel} detail={rootDir ?? undefined} />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuCheckboxItem checked={!selected} onSelect={() => pickDefault()}>{t(messages.local)}</DropdownMenuCheckboxItem>
                {profiles.map(({ id, name, cwd }) => (
                  <DropdownMenuCheckboxItem key={id} checked={selected?.id === id} onSelect={() => pickDefault({ id, name, cwd })}>{name}</DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t(messages.additional)}</DropdownMenuLabel>
          {choices.map(ref => {
            const included = additional.find(item => item.id === ref.id);
            const error = failure?.id === ref.id ? failure : undefined;
            const offline = included?.connected === false;
            const needsDirectory = ref.id === 'local' && !ref.cwd;
            const cwd = ref.id === 'local' ? ref.cwd : profiles.find(item => item.id === ref.id)?.cwd;
            const detail = pending === ref.id
              ? t(included && !offline ? messages.removing : messages.connecting)
              : offline ? t(messages.disconnected) : needsDirectory ? t(messages.chooseDirectory) : cwd;
            return (
              <DropdownMenuCheckboxItem
                key={ref.id}
                checked={!!included}
                disabled={disabled}
                className="items-start"
                onSelect={event => {
                  event.preventDefault();
                  if (needsDirectory) {
                    setOpen(false);
                    setDirectoryOpen(true);
                    return;
                  }
                  // A failed change is tried again; a dropped connection is reconnected.
                  void toggle(ref, error ? error.add : offline || !included);
                }}
              >
                {ref.id === 'local' ? <Monitor className="mt-0.5 size-4 shrink-0" /> : <Server className="mt-0.5 size-4 shrink-0" />}
                <EnvironmentText name={ref.name} detail={detail} error={error?.message} />
              </DropdownMenuCheckboxItem>
            );
          })}
          {busy && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t(messages.afterResponse)}</DropdownMenuLabel>}
          {profilesQuery.isLoading && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t(messages.loading)}</DropdownMenuLabel>}
          {(profilesQuery.isError || live.isError) && (
            <DropdownMenuItem onSelect={event => {
              event.preventDefault();
              void profilesQuery.refetch();
              if (chatId) void live.refetch();
            }}>{t(messages.loadFailed)}</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {isMobile
            ? <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t(messages.manageOnPhone)}</DropdownMenuLabel>
            : <DropdownMenuItem onSelect={() => useNavigationStore.getState().openPage({ kind: 'settings', tab: 'custom' })}>{t(messages.manage)}</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <LocalDirectoryDialog
        open={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        onAttach={cwd => {
          setDirectoryOpen(false);
          void toggle({ id: 'local', name: t(messages.local), cwd }, true);
        }}
      />
    </>
  );
}

function EnvironmentText({ name, detail, error }: { name: string; detail?: string; error?: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{name}</span>
      {error
        ? <span role="alert" className="block text-xs text-destructive">{error}</span>
        : detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

/** Asked for once, when the default environment is remote and the chat has no workspace here. */
function LocalDirectoryDialog({ open, onClose, onAttach }: { open: boolean; onClose: () => void; onAttach: (cwd: string) => void }) {
  const { formatMessage: t } = useIntl();
  const [value, setValue] = useState('');
  const cwd = value.trim();
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form className="contents" onSubmit={event => { event.preventDefault(); if (cwd) onAttach(cwd); }}>
          <DialogHeader>
            <DialogTitle>{t(messages.directoryTitle)}</DialogTitle>
            <DialogDescription>{t(messages.directoryDescription)}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={event => setValue(event.target.value)}
            placeholder={t(messages.directoryPlaceholder)}
            spellCheck={false}
            autoCapitalize="none"
            aria-label={t(messages.directoryTitle)}
            className="h-8 border-border/50 font-mono text-xs dark:border-border/35"
          />
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onClose}>{t(messages.cancel)}</Button>
            <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={!cwd}>{t(messages.attach)}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
