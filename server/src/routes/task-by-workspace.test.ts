import { describe, expect, it, vi } from "vitest"
import type { Task } from "../types/task.js"
import { taskRoutes } from "./task.js"

type Storage = Parameters<typeof taskRoutes>[0]

function routesWith(taskGetByWorkspace: (workspaceId: number) => Task | null) {
  return taskRoutes({ taskGetByWorkspace: vi.fn(taskGetByWorkspace) } as unknown as Storage)
}

describe("GET /by-workspace/:workspaceId", () => {
  it("returns the task that owns a dispatched worktree", async () => {
    const task = { id: 13, number: 11, title: "Add Taskboard section" } as Task

    const response = await routesWith(() => task).request("/by-workspace/38")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ task })
  })

  it("answers null for a workspace the user made by hand", async () => {
    const response = await routesWith(() => null).request("/by-workspace/7")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ task: null })
  })

  it("rejects a non-numeric workspace id instead of querying with NaN", async () => {
    const taskGetByWorkspace = vi.fn(() => null)
    const routes = taskRoutes({ taskGetByWorkspace } as unknown as Storage)

    const response = await routes.request("/by-workspace/abc")

    expect(response.status).toBe(400)
    expect(taskGetByWorkspace).not.toHaveBeenCalled()
  })

  // The route sits above `/:id`; if that order ever flips, `/by-workspace/38`
  // would be parsed as task id NaN and this suite would stop covering it.
  it("is not shadowed by the /:id route", async () => {
    const taskDetail = vi.fn(() => null)
    const routes = taskRoutes({
      taskGetByWorkspace: () => null,
      taskDetail,
    } as unknown as Storage)

    await routes.request("/by-workspace/38")

    expect(taskDetail).not.toHaveBeenCalled()
  })
})

describe("GET /by-chat/:chatId", () => {
  function routesFor(binding: { scopeKind: string; scopeKey: string } | null) {
    const task = { id: 19, number: 19, title: "issue" } as Task
    const taskGet = vi.fn((id: number) => (id === 19 ? task : null))
    const routes = taskRoutes({ getBindingByActiveChatId: vi.fn(() => binding), taskGet } as unknown as Storage)
    return { routes, task, taskGet }
  }

  it("returns the task a dispatched chat works on, shared workspace or not", async () => {
    const { routes, task } = routesFor({ scopeKind: "task", scopeKey: "19" })
    const response = await routes.request("/by-chat/501")
    expect(await response.json()).toEqual({ task })
  })

  it("answers null for a chat that is not a task's", async () => {
    const { routes, taskGet } = routesFor({ scopeKind: "channel", scopeKey: "3" })
    const response = await routes.request("/by-chat/501")
    expect(await response.json()).toEqual({ task: null })
    expect(taskGet).not.toHaveBeenCalled()
  })

  it("rejects a non-numeric chat id", async () => {
    const { routes } = routesFor(null)
    expect((await routes.request("/by-chat/abc")).status).toBe(400)
  })
})
