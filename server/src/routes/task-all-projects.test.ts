import { describe, expect, it, vi } from "vitest"
import type { NotificationStorageAdapter, TaskStorageAdapter } from "../storage/interface.js"
import type { TaskEvent } from "../services/channel-bus.js"
import { emitTaskEvent, onTaskEvent } from "../services/channel-bus.js"
import { taskRoutes } from "./task.js"

type Storage = TaskStorageAdapter & NotificationStorageAdapter

// The board over every project asks for its tasks and labels without a projectId.
describe("task list reads without ?projectId=", () => {
  const storage = () => ({
    taskList: vi.fn(() => []),
    taskListLabelDefs: vi.fn(() => []),
  })

  it("lists every project's tasks", async () => {
    const s = storage()
    const response = await taskRoutes(s as unknown as Storage).request("/?includeArchived=1")

    expect(response.status).toBe(200)
    expect(s.taskList).toHaveBeenCalledWith({ projectId: undefined, includeArchived: true })
  })

  it("still scopes to one project when given", async () => {
    const s = storage()
    await taskRoutes(s as unknown as Storage).request("/?projectId=4")

    expect(s.taskList).toHaveBeenCalledWith({ projectId: 4 })
  })

  it("lists every project's labels", async () => {
    const s = storage()
    const routes = taskRoutes(s as unknown as Storage)

    await routes.request("/labels")

    expect(s.taskListLabelDefs).toHaveBeenCalledWith(undefined)
  })
})

describe("task events", () => {
  it("reach a subscriber to every project as well as the project's own", () => {
    const all: TaskEvent[] = []
    const one: TaskEvent[] = []
    const other: TaskEvent[] = []
    const unsubs = [
      onTaskEvent(null, (e) => all.push(e)),
      onTaskEvent(7, (e) => one.push(e)),
      onTaskEvent(8, (e) => other.push(e)),
    ]
    const event = { type: "task_upsert", task: { id: 1, projectId: 7 } } as unknown as TaskEvent

    emitTaskEvent(7, event)
    unsubs.forEach((u) => u())

    expect(all).toEqual([event])
    expect(one).toEqual([event])
    expect(other).toEqual([])
  })
})
