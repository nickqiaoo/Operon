import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { createHarness, createModelManager, LocalEnvironment } from 'operon-agents'
import { SshEnvironment } from 'operon-agents/advanced'
import type { ChatMeta, ChatMetadata } from '../types/chat.js'
import { additionalSshRefs, initSshEnvironments, saveSshEnvironment, sessionEnvironmentBindings, sshTarget } from './ssh-environments.js'
import { changeChatEnvironment, releaseAddedEnvironments } from './chat-environments.js'
import { beginChatTurn, emitChatTurnFinished } from './ai/chat-turn-lifecycle.js'
import { OperonStreamMapper } from './operon-runtime/message-mapper.js'

const provider = vi.hoisted(() => ({ getOperonHarness: vi.fn() }))
vi.mock('./operon-runtime/index.js', () => provider)

describe('Operon chat environments', () => {
  it('keeps an SSH default while attaching, restoring and removing a local workspace', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'operon-build-'))
    const local = await mkdtemp(join(tmpdir(), 'operon-local-'))
    const profile = { id: 'build', name: 'Build', host: 'example.test', port: 22, username: 'builder',
      keyPath: '/test-key', hostFingerprint: 'test', cwd: remote }
    const close = vi.fn(async () => {})
    vi.spyOn(SshEnvironment, 'create').mockResolvedValue(Object.assign(new LocalEnvironment(remote), { close }) as unknown as SshEnvironment)
    const model = fauxProvider()
    const manager = createModelManager({ builtins: false })
    manager.models.setProvider(model.provider)
    const harness = createHarness({ config: { defaults: { model: model.provider.id + '/' + model.getModel().id, permission: { mode: 'yolo' } } }, modelManager: manager })
    provider.getOperonHarness.mockResolvedValue(harness)
    try {
      const session = await harness.createSession({ workDir: remote, bindings: sessionEnvironmentBindings(profile) })
      const chat: ChatMeta = { tp: 'chat', providerId: 'custom', sessionId: session.id, updatedAt: 0, metadata: { sshEnvironment: { id: profile.id, name: profile.name } } }
      const storage = { getChatMeta: () => chat, updateChatMetadata: (_id: number, metadata: ChatMetadata) => { chat.metadata = metadata } }
      const refs = await changeChatEnvironment(storage, 7, 'local', true, local)
      expect(refs).toEqual(additionalSshRefs(['local'], profile.id, local))
      await session.close()
      const restored = await harness.resumeSession(session.id, { bindings: sessionEnvironmentBindings(profile, refs) })
      model.setResponses([
        fauxAssistantMessage([fauxToolCall('Write', { path: 'marker', content: 'build' }),
          fauxToolCall('Write', { target: 'local', path: 'marker', content: 'host' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done', { stopReason: 'stop' }),
      ])
      await restored.prompt('write a different marker in each environment')
      expect(await readFile(join(remote, 'marker'), 'utf8')).toBe('build')
      expect(await readFile(join(local, 'marker'), 'utf8')).toBe('host')
      expect(await changeChatEnvironment(storage, 7, 'local', false)).toEqual([])
      expect(restored.core.environments.size).toBe(1)
      expect(chat.metadata?.sshEnvironment?.id).toBe(profile.id)
    } finally {
      await harness.close()
      vi.restoreAllMocks()
      await Promise.all([remote, local].map(path => rm(path, { recursive: true, force: true })))
    }
  })

  it('routes a write, restores an offline host, reconnects and removes it between turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operon-root-'))
    const remote = await mkdtemp(join(tmpdir(), 'operon-ssh-'))
    const data = new Map<string, unknown>()
    initSshEnvironments({ get: <T>(key: string) => data.get(key) as T | undefined, set: (key, value) => { data.set(key, value) } })
    const profile = { name: 'Build Server', id: '59da817d-dda2-4fee-8b9d-96789e20c8bd', host: 'example.test', port: 22,
      cwd: remote, username: 'builder', keyPath: '/test-key', hostFingerprint: 'test' }
    saveSshEnvironment(profile)
    const refs = additionalSshRefs([profile.id])
    const close = vi.fn(async () => {})
    const ssh = Object.assign(new LocalEnvironment(remote), { close })
    const connect = vi.spyOn(SshEnvironment, 'create').mockResolvedValue(ssh as unknown as SshEnvironment)
    const model = fauxProvider()
    const manager = createModelManager({ builtins: false })
    manager.models.setProvider(model.provider)
    const harness = createHarness({ config: { workDir: root, defaults: { model: model.provider.id + '/' + model.getModel().id,
      permission: { mode: 'yolo' } } }, modelManager: manager })
    harness.onSessionOpened(session => () => releaseAddedEnvironments(session))
    provider.getOperonHarness.mockResolvedValue(harness)
    try {
      const session = await harness.createSession({ workDir: root, bindings: sessionEnvironmentBindings(undefined, refs) })
      const chat: ChatMeta = { tp: 'chat', providerId: 'custom', sessionId: session.id, updatedAt: 0,
        metadata: { additionalSshEnvironments: refs } }
      const storage = { getChatMeta: () => chat, updateChatMetadata: (_id: number, metadata: ChatMetadata) => { chat.metadata = metadata } }
      const target = sshTarget(profile.id)
      const mapper = new OperonStreamMapper(undefined, session)
      const calls: unknown[] = []
      session.onEvent(event => { for (const part of mapper.map(event)) if (part.type === 'tool-call') calls.push(part) })
      model.setResponses([
        fauxAssistantMessage([fauxToolCall('Write', { target, path: 'result', content: 'remote' }),
          fauxToolCall('Write', { path: 'result', content: 'local' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done', { stopReason: 'stop' }),
      ])
      await session.prompt('write to both')
      expect(await readFile(join(remote, 'result'), 'utf8')).toBe('remote')
      expect(await readFile(join(root, 'result'), 'utf8')).toBe('local')
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerMetadata: { operon: { environment: 'Build Server', remote: true } } }),
        expect.objectContaining({ providerMetadata: { operon: { environment: 'Local', remote: false } } }),
      ]))
      await session.close()
      expect(close).toHaveBeenCalledTimes(1)
      connect.mockRejectedValueOnce(new Error('Host offline'))
      const restored = await harness.resumeSession(session.id, { bindings: sessionEnvironmentBindings(undefined, refs) })
      expect(restored.core.environments.get(target)?.available).toBe(false)
      await changeChatEnvironment(storage, 12, profile.id, true)
      expect(restored.core.environments.get(target)?.available).toBe(true)
      beginChatTurn(12, 'turn')
      try {
        await expect(changeChatEnvironment(storage, 12, profile.id, false)).rejects.toThrow('after this response')
      } finally {
        emitChatTurnFinished({ chatId: 12, turnId: 'turn', status: 'completed' })
      }
      await changeChatEnvironment(storage, 12, profile.id, false)
      expect(chat.metadata?.additionalSshEnvironments).toEqual([])
      expect(restored.core.environments.get(target)).toBeUndefined()
      expect(close).toHaveBeenCalledTimes(2)
      connect.mockRejectedValueOnce(new Error('Host offline'))
      await expect(changeChatEnvironment(storage, 12, profile.id, true)).rejects.toThrow('Host offline')
      expect(chat.metadata?.additionalSshEnvironments).toEqual([])
      await restored.close()
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      await harness.close()
      vi.restoreAllMocks()
      await Promise.all([root, remote].map(path => rm(path, { recursive: true, force: true })))
    }
  })
})
