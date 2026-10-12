import { createRuntimeContext, type RuntimeContext, type RuntimeHost } from './context.js'
import type {
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  RuntimeSession,
  RuntimeSessionParams,
} from './types.js'

/**
 * Type-only facts about one provider, carried by its definition so a runtime
 * can narrow `createSession` / `native` to the provider picked by id. Every
 * field is optional; an omitted one falls back to the loose default.
 */
export interface ProviderTypes {
  /** Native permission-mode ids (`'acceptEdits'`, `'approveForMe'`, …). */
  mode?: string
  /** Native effort ids. */
  effort?: string
  /** Provider-level extras that need no session (account usage, …). */
  native?: object
}

/**
 * One agent provider, as handed to `createRuntime`. Built by the provider's
 * own factory (`claudeCode()`, `codex()`, …) rather than written by hand.
 */
export interface ProviderDefinition<Id extends string = string, T extends ProviderTypes = ProviderTypes> {
  readonly id: Id
  readonly info: ProviderInfo
  /**
   * A fresh provider instance bound to `ctx`. Called per use — instances carry
   * descriptor state ("current model") that must not leak between callers;
   * anything worth sharing lives in `ctx.shared`.
   */
  create(ctx: RuntimeContext): RuntimeProviderFactory
  /** The provider-level extras, built once per runtime. */
  native?(ctx: RuntimeContext): NonNullable<T['native']>
  /** Type-level only — never set at runtime. */
  readonly __types?: T
}

/** Any concrete definition fits: `Id` and `T` only appear in covariant positions. */
export type AnyProviderDefinition = ProviderDefinition<string, ProviderTypes>

export type ProviderIdOf<P extends readonly AnyProviderDefinition[]> = P[number]['id']
export type ProviderOf<P extends readonly AnyProviderDefinition[], Id> = Extract<P[number], { id: Id }>
type TypesOf<D> = D extends ProviderDefinition<string, infer T> ? T : never
export type ProviderNativeOf<D> = NonNullable<TypesOf<D>['native']>

export function defineProvider<const Id extends string, T extends ProviderTypes = ProviderTypes>(
  definition: Omit<ProviderDefinition<Id, T>, '__types'>,
): ProviderDefinition<Id, T> {
  return definition
}

export interface RuntimeConfig<P extends readonly AnyProviderDefinition[]> {
  providers: P
  host?: RuntimeHost
}

export interface Runtime<P extends readonly AnyProviderDefinition[] = readonly AnyProviderDefinition[]> {
  /** The host as this runtime's providers see it. */
  readonly context: RuntimeContext
  /** Every registered provider, in registration order. */
  providers(): ProviderInfo[]
  has(id: string): id is ProviderIdOf<P>
  /** A fresh provider instance — what `describe` and `createSession` go through. */
  provider(id: ProviderIdOf<P>): RuntimeProviderFactory
  /** Models, modes, effort levels, commands and features, as the provider reports them now. */
  describe(id: ProviderIdOf<P>): Promise<ProviderDescriptor>
  /** Warm the provider's metadata (models, account) in the background, without a session. */
  prefetch(id: ProviderIdOf<P>): Promise<void>
  createSession(id: ProviderIdOf<P>, params: RuntimeSessionParams): Promise<RuntimeSession>
  /** Provider-level extras (account usage, …), built once per runtime. */
  native<Id extends ProviderIdOf<P>>(id: Id): ProviderNativeOf<ProviderOf<P, Id>>
  /** Stop what the runtime's providers share: usage probes, the OpenCode server, … */
  dispose(): Promise<void>
}

export function createRuntime<const P extends readonly AnyProviderDefinition[]>(
  config: RuntimeConfig<P>,
): Runtime<P> {
  const context = createRuntimeContext(config.host)
  const definitions = new Map<string, AnyProviderDefinition>()
  for (const definition of config.providers) {
    if (definitions.has(definition.id)) throw new Error(`Provider registered twice: ${definition.id}`)
    definitions.set(definition.id, definition)
  }

  const definitionOf = (id: string): AnyProviderDefinition => {
    const definition = definitions.get(id)
    if (!definition) throw new Error(`No runtime provider registered for: ${id}`)
    return definition
  }
  const provider = (id: string): RuntimeProviderFactory => definitionOf(id).create(context)

  return {
    context,
    providers: () => [...definitions.values()].map((definition) => definition.info),
    has: (id): id is ProviderIdOf<P> => definitions.has(id),
    provider,
    describe: (id) => provider(id).getDescriptor(),
    prefetch: async (id) => {
      await provider(id).fetchInitInfo?.()
    },
    createSession: (id, params) => provider(id).createSession(params),
    native(id) {
      const definition = definitionOf(id)
      if (!definition.native) throw new Error(`Provider ${id} has no provider-level native API`)
      const build = definition.native
      return context.shared(`${id}:native`, () => build(context))
    },
    dispose: () => context.disposeShared(),
  }
}
