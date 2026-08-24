import type { CommandDefinition, CommandInfo, InvokeOptions } from "./types.ts"

export type CommandRunner = ((options: InvokeOptions) => Promise<unknown>) & {
  definition: CommandDefinition
}

const commands = new Map<string, CommandRunner>()

export function commandId(site: string, name: string): string {
  return `${site}.${name}`
}

export function registerCommand(runner: CommandRunner): CommandRunner {
  const id = commandId(runner.definition.site, runner.definition.name)
  commands.set(id, runner)
  return runner
}

export function getCommand(id: string): CommandRunner | undefined {
  return commands.get(id)
}

export function list(): CommandInfo[] {
  return [...commands.values()]
    .map((runner) => toInfo(runner.definition))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function search(query: string): CommandInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return list()
  return list().filter((info) => {
    const hay =
      `${info.id} ${info.description} ${info.domain ?? ""} ${info.columns.join(" ")} ${info.keywords.join(" ")}`.toLowerCase()
    return hay.includes(q) || info.site.includes(q) || info.name.includes(q)
  })
}

export function help(id: string): string {
  const runner = commands.get(id)
  if (!runner) {
    const suggestions = search(id).slice(0, 8).map((c) => c.id)
    const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""
    throw new Error(`Unknown command "${id}".${hint} Use siteAdapters.list() or search(query).`)
  }
  const d = runner.definition
  const lines = [
    `# ${commandId(d.site, d.name)}`,
    "",
    d.description,
    "",
    `- access: ${d.access ?? "read"}`,
    `- strategy: ${d.strategy ?? (d.browser === false ? "public" : "cookie")}`,
    `- browser: ${d.browser === false ? "optional (public)" : "required (pass globalThis.chrome)"}`,
  ]
  if (d.domain) lines.push(`- domain: ${d.domain}`)
  if (d.columns?.length) lines.push(`- columns: ${d.columns.join(", ")}`)
  lines.push("", "## Args")
  if (!d.args?.length) {
    lines.push("- (none besides browser when required)")
  } else {
    for (const arg of d.args) {
      const bits = [
        arg.type ?? "string",
        arg.required ? "required" : "optional",
        arg.default !== undefined ? `default=${JSON.stringify(arg.default)}` : null,
        arg.help ?? null,
      ].filter(Boolean)
      lines.push(`- \`${arg.name}\`: ${bits.join(" · ")}`)
    }
  }
  lines.push(
    "",
    "## Call",
    "```js",
    d.browser === false
      ? `await siteAdapters.${d.site}.${d.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}({ /* args */ })`
      : `await siteAdapters.${d.site}.${camelName(d.name)}({ /* args */, browser: globalThis.chrome })`,
    // also show run form
    `// or: await siteAdapters.run("${commandId(d.site, d.name)}", { /* args */, browser: globalThis.chrome })`,
    "```",
  )
  return lines.join("\n")
}

function camelName(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export async function run(id: string, options: InvokeOptions = {}): Promise<unknown> {
  const runner = commands.get(id)
  if (!runner) {
    throw new Error(`Unknown command "${id}". Use siteAdapters.list() or search(query).`)
  }
  return runner(options)
}

function toInfo(d: CommandDefinition): CommandInfo {
  const needsBrowser = d.browser !== false && (d.strategy ?? "cookie") !== "public"
  const browser = d.browser ?? needsBrowser
  return {
    id: commandId(d.site, d.name),
    site: d.site,
    name: d.name,
    description: d.description,
    access: d.access ?? "read",
    domain: d.domain,
    strategy: d.strategy ?? (browser ? "cookie" : "public"),
    browser,
    args: d.args ?? [],
    keywords: d.keywords ?? [],
    columns: d.columns ?? [],
  }
}

/** Test helper */
export function _resetRegistryForTests(): void {
  commands.clear()
}
