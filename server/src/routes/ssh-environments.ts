import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { connectSshEnvironment, deleteSshEnvironment, listSshEnvironments, saveSshEnvironment, sshTarget, SshHostKeyConfirmationRequired } from '../services/ssh-environments.js'
import type { SshEnvironmentProfile, SshHostKeyChallenge } from '../../../shared/ssh-environment.js'

import { changeChatEnvironment } from '../services/chat-environments.js'
import { getChatStorage } from '../services/ai/state.js'
import { loadedOperonSession } from '../services/operon-runtime/index.js'

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Enter an environment name.').max(80),
  host: z.string().trim().regex(/^[\w.:%-]+$/, 'Enter an SSH hostname or IP address.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1, 'Enter an SSH username.'),
  cwd: z.string().trim().startsWith('/', 'Enter an absolute remote working directory.'),
  hostFingerprint: z.string().trim().regex(/^(?:SHA256:[A-Za-z0-9+/]{43})?$/, 'Enter the SHA256 host key fingerprint.').default(''),
  authMethod: z.enum(['key', 'password']).default('key'),
  password: z.string().min(1).max(1024).optional(),
  id: z.string().uuid().optional(),
  keyPath: z.string().trim().refine((value) => !value || path.isAbsolute(value) || value.startsWith('~/'), {
    message: 'Enter an absolute private key path, use ~/, or leave it blank for SSH agent.',
  }).default(''),
})

const idSchema = z.string().uuid()

async function verifySshEnvironment(profile: SshEnvironmentProfile, password?: string) {
  const { environment, fingerprint } = await connectSshEnvironment(profile, password)
  void environment.close().catch((error: unknown) => console.warn('[SSH] Connection cleanup failed:', error))
  return fingerprint
}

function hostKeyChallenge(error: SshHostKeyConfirmationRequired): SshHostKeyChallenge {
  return { status: 'confirm-host-key', fingerprint: error.fingerprint }
}

export function sshEnvironmentRoutes() {
  const router = new Hono()
  router.get('/', (c) => c.json(listSshEnvironments()))

  router.get('/chats/:chatId', (c) => {
    const chat = getChatStorage()?.getChatMeta(Number(c.req.param('chatId')))
    if (!chat) return c.json({ error: 'Conversation unavailable.' }, 404)
    const session = chat.sessionId && loadedOperonSession(chat.sessionId)
    return c.json((chat.metadata?.additionalSshEnvironments ?? []).map(ref => ({
      ...ref, connected: session ? session.core.environments.get(sshTarget(ref.id))?.available ?? false : undefined,
    })))
  })

  router.patch('/chats/:chatId', async (c) => {
    const body = z.object({ id: z.union([idSchema, z.literal('local')]), add: z.boolean(), localDir: z.string().optional() }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Invalid environment selection.' }, 400)
    const storage = getChatStorage()
    if (!storage) return c.json({ error: 'Conversation unavailable.' }, 404)
    try {
      return c.json(await changeChatEnvironment(storage, Number(c.req.param('chatId')), body.data.id, body.data.add, body.data.localDir))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not change environment.' }, 409)
    }
  })

  router.post('/test', async (c) => {
    const parsed = profileSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400)
    const { id, password, ...profile } = parsed.data
    try {
      const fingerprint = await verifySshEnvironment({ ...profile, id: id ?? randomUUID() }, password)
      return c.json({ success: true, fingerprint })
    } catch (error) {
      if (error instanceof SshHostKeyConfirmationRequired) return c.json(hostKeyChallenge(error))
      return c.json({ error: error instanceof Error ? error.message : 'SSH connection failed.' }, 422)
    }
  })

  router.put('/:id', async (c) => {
    const id = idSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'Invalid SSH environment ID.' }, 400)
    const parsed = profileSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400)
    const { id: _bodyId, password, ...fields } = parsed.data
    const profile = { id: id.data, ...fields }
    try {
      if (!profile.hostFingerprint || (profile.authMethod === 'password' && password !== undefined)) {
        profile.hostFingerprint = await verifySshEnvironment(profile, password)
      }
      saveSshEnvironment(profile, password)
    } catch (error) {
      if (error instanceof SshHostKeyConfirmationRequired) return c.json(hostKeyChallenge(error))
      return c.json({ error: error instanceof Error ? error.message : 'Could not save the SSH environment.' }, 422)
    }
    return c.json(profile)
  })

  router.delete('/:id', (c) => {
    deleteSshEnvironment(c.req.param('id'))
    return c.json({ success: true })
  })

  return router
}
