import { useState, type FormEvent } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { SUPPORTED_EXTERNAL_AGENT_IDS } from '@shared/external-agent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { codingAgentName } from '@/components/assistant/CodingAgentCard'
import { useChatApi, useChatNodeId } from '@/lib/chat-api-context'
import { useDelegationCatalog, useDelegationMachines } from '@/lib/delegation-queries'
import { useProviderModels, useProviders } from '@/lib/provider-queries'

const THIS_MACHINE = 'this-machine'
const DEFAULT_MODEL = 'default'

/** The Agents panel's way to start an external agent here or on another machine, as the chat's agent can. */
export function ExternalAgentDispatch({ chatId }: { chatId: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Run external agent
      </Button>
      {open && <DispatchForm chatId={chatId} close={() => setOpen(false)} />}
    </Dialog>
  )
}

const labelClass = 'grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground'

function DispatchForm({ chatId, close }: { chatId: number; close: () => void }) {
  // Everything here is asked of the chat's machine: it dispatches from its own
  // conversation, and "this machine" in the list is that one.
  const api = useChatApi()
  const chatOnRemote = useChatNodeId() != null
  const [machine, setMachine] = useState(THIS_MACHINE)
  const [workspaceId, setWorkspaceId] = useState<number>()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const remote = machine === THIS_MACHINE ? undefined : machine
  const machines = useDelegationMachines()
  const providers = useProviders({ enabled: !remote })
  const catalog = useDelegationCatalog(remote)
  const models = useProviderModels(providerId || undefined, remote)

  const agents = remote
    ? catalog.data?.agents.map(({ agentType }) => agentType) ?? []
    : providers.data?.filter((provider) => provider.available &&
      (SUPPORTED_EXTERNAL_AGENT_IDS as readonly string[]).includes(provider.id)).map(({ id }) => id) ?? []
  const workspaces = catalog.data?.workspaces ?? []
  const workspace = workspaces.find(({ id }) => id === workspaceId) ?? (workspaces.length === 1 ? workspaces[0] : undefined)
  const modelChoices = models.data?.models?.flatMap((item) => {
    const id = item.modelId ?? item.id
    return id ? [{ id, name: item.name || id }] : []
  }) ?? []
  const loadError = (remote ? catalog.error : providers.error)?.message ?? models.error?.message
  const canRun = !!providerId && !!description.trim() && !!prompt.trim() && (!remote || !!workspace) && !busy

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canRun) return
    setBusy(true)
    setError('')
    try {
      await api.runExternalAgent(chatId, {
        providerId, model, description: description.trim(), prompt: prompt.trim(),
        ...(remote ? { target: remote, workspaceId: workspace?.id } : {}),
      })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the agent')
    } finally { setBusy(false) }
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Run external agent</DialogTitle>
        <DialogDescription>It works in its own conversation and reports back here.</DialogDescription>
      </DialogHeader>
      <form id="external-agent-dispatch" className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            Machine
            <Select value={machine} onValueChange={(value) => {
              setMachine(value); setWorkspaceId(undefined); setProviderId(''); setModel(DEFAULT_MODEL); setError('')
            }}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={THIS_MACHINE}>
                  {chatOnRemote
                    ? machines.data?.machines.find((item) => item.current)?.label ?? "This chat's machine"
                    : 'This machine'}
                </SelectItem>
                {machines.data?.machines.filter((item) => !item.current).map((item) => (
                  <SelectItem key={item.nodeId} value={item.nodeId} disabled={!item.online}>
                    {item.label || item.nodeId}{item.online ? '' : ' · Offline'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {remote && (
            <label className={labelClass}>
              Workspace
              <Select value={workspace ? String(workspace.id) : ''} onValueChange={(value) => setWorkspaceId(Number(value))}
                disabled={!workspaces.length}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue placeholder={catalog.isFetching ? 'Loading…' : catalog.data ? 'No workspaces' : 'Select'} />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.project} / {item.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          )}
          <label className={labelClass}>
            Agent
            <Select value={providerId} onValueChange={(value) => { setProviderId(value); setModel(DEFAULT_MODEL) }} disabled={!agents.length}>
              <SelectTrigger size="sm" className="w-full"><SelectValue placeholder={agents.length ? 'Select an agent' : 'Loading…'} /></SelectTrigger>
              <SelectContent>
                {agents.map((id) => <SelectItem key={id} value={id}>{codingAgentName(id)}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className={labelClass}>
            Model
            <Select value={model} onValueChange={setModel} disabled={!providerId}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL}>
                  Agent default{models.data?.currentModelId ? ` (${models.data.currentModelId})` : ''}
                </SelectItem>
                {modelChoices.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className={labelClass}>
          Task title
          <Input className="border-border/50 text-foreground" maxLength={300} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className={labelClass}>
          Instructions
          <Textarea className="border-border/50 text-foreground" rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)}
            placeholder="The agent does not see this conversation: include what it needs to know." />
        </label>
        {(error || loadError) && <div role="alert" className="flex items-center gap-2 text-xs text-destructive">{error || loadError}</div>}
      </form>
      <DialogFooter>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={close}>Cancel</Button>
        <Button type="submit" form="external-agent-dispatch" size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!canRun}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Run agent
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
