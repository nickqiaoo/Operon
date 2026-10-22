/** Includes the root and every descendant, even when the list contains a cycle. */
export function taskSubtreeIds(
  tasks: readonly { id: number; parentTaskId: number | null }[],
  rootId: number,
): Set<number> {
  const children = new Map<number, number[]>()
  for (const task of tasks) {
    if (task.parentTaskId == null) continue
    const siblings = children.get(task.parentTaskId)
    if (siblings) siblings.push(task.id)
    else children.set(task.parentTaskId, [task.id])
  }
  const ids = new Set<number>()
  const pending = [rootId]
  while (pending.length > 0) {
    const id = pending.pop()!
    if (ids.has(id)) continue
    ids.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  return ids
}
