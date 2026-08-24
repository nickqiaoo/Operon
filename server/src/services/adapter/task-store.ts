import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

// ---------------------------------------------------------------------------
// Task record schema
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function getTaskDir(listId: string): string {
  return path.join(os.homedir(), '.agents', 'operon', 'tasks', sanitize(listId))
}

function getTaskPath(listId: string, taskId: string): string {
  return path.join(getTaskDir(listId), `${sanitize(taskId)}.json`)
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true })
}

async function getHighestId(listId: string): Promise<number> {
  const dir = getTaskDir(listId)
  try {
    const names = await fs.readdir(dir)
    const ids = names
      .filter(n => n.endsWith('.json'))
      .map(n => parseInt(n.replace('.json', ''), 10))
      .filter(n => !isNaN(n))
    return ids.length > 0 ? Math.max(...ids) : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Per-list mutex to prevent concurrent ID collisions
// ---------------------------------------------------------------------------

const listLocks = new Map<string, Promise<void>>()

function withListLock<T>(listId: string, fn: () => Promise<T>): Promise<T> {
  const prev = listLocks.get(listId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  listLocks.set(listId, next.then(() => {}, () => {}))
  return next
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function createTask(listId: string, task: Omit<TaskRecord, 'id'>): Promise<string> {
  return withListLock(listId, async () => {
    const dir = getTaskDir(listId)
    await ensureDir(dir)
    const nextId = String((await getHighestId(listId)) + 1)
    const record: TaskRecord = { id: nextId, ...task }
    await fs.writeFile(getTaskPath(listId, nextId), JSON.stringify(record, null, 2))
    return nextId
  })
}

export async function getTask(listId: string, taskId: string): Promise<TaskRecord | null> {
  try {
    const raw = await fs.readFile(getTaskPath(listId, taskId), 'utf-8')
    return JSON.parse(raw) as TaskRecord
  } catch {
    return null
  }
}

export async function updateTask(
  listId: string,
  taskId: string,
  patch: Partial<TaskRecord>,
): Promise<TaskRecord | null> {
  const existing = await getTask(listId, taskId)
  if (!existing) return null
  const updated = { ...existing, ...patch, id: taskId }
  await fs.writeFile(getTaskPath(listId, taskId), JSON.stringify(updated, null, 2))
  return updated
}

export async function deleteTask(listId: string, taskId: string): Promise<boolean> {
  try {
    await fs.unlink(getTaskPath(listId, taskId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  // Clean up references in other tasks
  const tasks = await listTasks(listId)
  for (const task of tasks) {
    const blocks = task.blocks.filter(id => id !== taskId)
    const blockedBy = task.blockedBy.filter(id => id !== taskId)
    if (blocks.length !== task.blocks.length || blockedBy.length !== task.blockedBy.length) {
      await updateTask(listId, task.id, { blocks, blockedBy })
    }
  }
  return true
}

export async function listTasks(listId: string): Promise<TaskRecord[]> {
  const dir = getTaskDir(listId)
  try {
    const names = await fs.readdir(dir)
    const ids = names
      .filter(n => n.endsWith('.json'))
      .map(n => n.replace('.json', ''))
    const tasks = await Promise.all(ids.map(id => getTask(listId, id)))
    return tasks.filter(Boolean) as TaskRecord[]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Dependency management
// ---------------------------------------------------------------------------

export async function addDependency(listId: string, fromId: string, toId: string): Promise<boolean> {
  const [from, to] = await Promise.all([getTask(listId, fromId), getTask(listId, toId)])
  if (!from || !to) return false
  if (!from.blocks.includes(toId)) {
    await updateTask(listId, fromId, { blocks: [...from.blocks, toId] })
  }
  if (!to.blockedBy.includes(fromId)) {
    await updateTask(listId, toId, { blockedBy: [...to.blockedBy, fromId] })
  }
  return true
}
