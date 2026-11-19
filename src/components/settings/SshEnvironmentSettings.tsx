import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { deleteSshEnvironment, saveSshEnvironment, sshEnvironmentsQuery, testSshEnvironment, type SshEnvironmentInput } from '@/lib/ssh-environments'
import type { SshEnvironmentProfile } from '@shared/ssh-environment'

const emptyProfile: SshEnvironmentInput = {
  name: '', host: '', port: 22, username: '', cwd: '', hostFingerprint: '', keyPath: '',
}

const fields = [
  { key: 'name', label: 'Name', placeholder: 'Development server' },
  { key: 'host', label: 'Host', placeholder: 'dev.example.com' },
  { key: 'port', label: 'Port', placeholder: '22' },
  { key: 'username', label: 'Username', placeholder: 'developer' },
  { key: 'cwd', label: 'Remote working directory', placeholder: '/home/developer/project' },
  { key: 'hostFingerprint', label: 'Host key fingerprint (optional)', placeholder: 'SHA256:…' },
] as const

export function SshEnvironmentSettings() {
  const queryClient = useQueryClient()
  const { data: profiles = [], isLoading, isError, refetch } = useQuery(sshEnvironmentsQuery)
  const [editing, setEditing] = useState<{ id: string; profile: SshEnvironmentInput; saved: boolean }>()
  const [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>()
  const [hostKey, setHostKey] = useState<{ fingerprint: string; action: 'test' | 'save' }>()
  const savedProfile = profiles.find(({ id }) => id === editing?.id)
  const canUseSavedPassword = savedProfile?.authMethod === 'password' && editing !== undefined &&
    savedProfile.host === editing.profile.host.trim() && savedProfile.port === editing.profile.port &&
    savedProfile.username === editing.profile.username.trim() &&
    (!editing.profile.hostFingerprint.trim() || savedProfile.hostFingerprint === editing.profile.hostFingerprint.trim())

  const edit = (profile?: SshEnvironmentProfile) => {
    setEditing({ id: profile?.id ?? crypto.randomUUID(), profile: profile ?? emptyProfile, saved: !!profile })
    setConfirmDelete(false)
    setFeedback(undefined)
    setHostKey(undefined)
  }

  const updateProfile = (profile: SshEnvironmentInput) => {
    if (!editing) return
    setEditing({ ...editing, profile })
    setFeedback(undefined)
    setHostKey(undefined)
  }

  const run = async (action: 'test' | 'save' | 'delete', profile: SshEnvironmentInput) => {
    if (!editing || pending) return
    setPending(true)
    setFeedback(undefined)
    setHostKey(undefined)
    try {
      if (action === 'delete') {
        await deleteSshEnvironment(editing.id)
      } else {
        const result = action === 'test'
          ? await testSshEnvironment(editing.id, profile)
          : await saveSshEnvironment(editing.id, profile)
        if ('status' in result) {
          setHostKey({ fingerprint: result.fingerprint, action })
          return
        }
        if ('success' in result) {
          setEditing({ ...editing, profile: { ...profile, hostFingerprint: result.fingerprint || profile.hostFingerprint } })
          setFeedback({ text: 'Connection successful.' })
          return
        }
      }
      await queryClient.invalidateQueries({ queryKey: sshEnvironmentsQuery.queryKey })
      setEditing(undefined)
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : 'SSH environment request failed.', error: true })
    } finally {
      setPending(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    const submitter = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
    const action = submitter === 'test' || submitter === 'delete' ? submitter : 'save'
    void run(action, editing.profile)
  }

  return (
    <section className="space-y-3" aria-labelledby="ssh-environments-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 id="ssh-environments-heading" className="text-sm font-medium">SSH Environments</h3>
          <p className="text-xs text-muted-foreground">Run Operon chats in a remote working directory over SSH.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={pending || isLoading} onClick={() => edit()}>
          <Plus className="size-3.5" /> Add environment
        </Button>
      </div>
      {isError && (
        <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>Could not load environments. Retry</Button>
      )}
      {profiles.map((profile) => (
        <button
          key={profile.id}
          type="button"
          disabled={pending}
          aria-pressed={editing?.id === profile.id}
          onClick={() => edit(profile)}
          className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5 text-left hover:bg-accent-hover aria-pressed:bg-accent-active"
        >
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm">{profile.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{profile.username}@{profile.host}:{profile.port} · {profile.cwd}</span>
          </span>
        </button>
      ))}
      {editing && (
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-3 sm:p-4">
          <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
            {fields.map(({ key, label, placeholder }) => (
              <div key={key} className="min-w-0 space-y-1.5">
                <label htmlFor={`ssh-${key}`} className="text-xs font-medium">{label}</label>
                <Input
                  id={`ssh-${key}`}
                  type={key === 'port' ? 'number' : 'text'}
                  min={key === 'port' ? 1 : undefined}
                  max={key === 'port' ? 65535 : undefined}
                  required={key !== 'hostFingerprint'}
                  value={editing.profile[key] || ''}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    const value = event.target.value
                    const profile = { ...editing.profile, [key]: key === 'port' ? Number(value) : value }
                    if (key === 'host' || key === 'port') profile.hostFingerprint = ''
                    if (key === 'host' || key === 'port' || key === 'username') profile.password = undefined
                    updateProfile(profile)
                  }}
                />
                {key === 'hostFingerprint' && <p className="text-xs text-muted-foreground">Leave blank to use your OpenSSH known hosts or confirm the key on first connection.</p>}
              </div>
            ))}
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="ssh-authentication" className="text-xs font-medium">Authentication</label>
              <Select
                value={editing.profile.authMethod ?? 'key'}
                disabled={pending}
                onValueChange={(value) => {
                  if (value === 'key' || value === 'password') updateProfile({ ...editing.profile, authMethod: value, password: undefined })
                }}
              >
                <SelectTrigger id="ssh-authentication" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="key">Private key or SSH agent</SelectItem>
                  <SelectItem value="password">Password</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {editing.profile.authMethod === 'password' ? (
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="ssh-password" className="text-xs font-medium">Password</label>
                <Input
                  id="ssh-password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={1024}
                  required={!canUseSavedPassword}
                  placeholder={canUseSavedPassword ? 'Leave blank to keep the saved password' : undefined}
                  value={editing.profile.password ?? ''}
                  onChange={(event) => updateProfile({ ...editing.profile, password: event.target.value || undefined })}
                />
              </div>
            ) : (
              <div className="min-w-0 space-y-1.5">
                <label htmlFor="ssh-keyPath" className="text-xs font-medium">Private key path</label>
                <Input
                  id="ssh-keyPath"
                  placeholder="~/.ssh/id_ed25519"
                  autoComplete="off"
                  spellCheck={false}
                  value={editing.profile.keyPath}
                  onChange={(event) => updateProfile({ ...editing.profile, keyPath: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">Path on the Operon host. Leave blank to use its SSH agent.</p>
              </div>
            )}
          </fieldset>
          {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{feedback.text}</p>}
          {hostKey && (
            <div className="space-y-2 rounded-lg border border-border/50 bg-background p-3">
              <div role="status" className="space-y-1 text-xs">
                <p className="font-medium">Confirm the host key for {editing.profile.host}:{editing.profile.port}</p>
                <p className="break-all font-mono">{hostKey.fingerprint}</p>
                <p className="text-muted-foreground">Compare this fingerprint with a trusted source before continuing.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void run(hostKey.action, { ...editing.profile, hostFingerprint: hostKey.fingerprint })}>
                {hostKey.action === 'test' ? 'Trust and test' : 'Trust and save'}
              </Button>
            </div>
          )}
          {confirmDelete && <p className="text-xs text-muted-foreground">Chats using this environment will need it to reconnect.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {editing.saved && (confirmDelete ? (
              <Button type="submit" formNoValidate value="delete" size="sm" variant="destructive" disabled={pending}>Remove environment</Button>
            ) : (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(true)}>Remove</Button>
            ))}
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button type="submit" value="test" size="sm" variant="outline" disabled={pending}>Test connection</Button>
            <Button type="submit" value="save" size="sm" disabled={pending}>Save</Button>
          </div>
        </form>
      )}
    </section>
  )
}
