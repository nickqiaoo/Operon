import type { ExtensionDefinition, ExtensionHostContext } from 'operon-agents'
import {
  createFilePeerRepo,
  createPeerNetwork,
  mountHub,
  mountTeam,
  PEERS_SERVICE,
  sharedLabelVisibility,
  type PeerMemberOptions,
  type PeerNetworkHandle,
  type PeerParams,
  type TeammateFactory,
} from 'operon-agents-peers'
import { TEAMS_SERVICE, type TeamsExtensionServices } from './contract.js'

/**
 * The Teams extension — operon's build of `operon-agents-peers`, published as a file extension.
 *
 * Same shape as the framework's `peers()` definition — a `harness` half, so the process has one
 * roster, mailbox and budget — with one difference: teammate types and the budget are not
 * compiled in. `harness` reads them from the host's `operon-teams` service, so Settings edits
 * become a plain `harness.extensions.reload("peers")`, and every spawn is reported back to the
 * host the moment the session exists — that is what lets a teammate be a real conversation in the
 * sidebar (model, chat row, transcript observer). A teammate is still born in its lead's
 * workspace: `teammateOptions` reads the workDir off the creator's session.
 *
 * Roster cards and the mailbox ledger live in `host.dataDir` — the extension's data folder,
 * outside the bundle — so an update of this file keeps the teams.
 */
const definition: ExtensionDefinition<PeerNetworkHandle, PeerParams, TeamsExtensionServices> = {
  id: PEERS_SERVICE,
  uses: [TEAMS_SERVICE],

  async harness(host: ExtensionHostContext<TeamsExtensionServices>) {
    const teams = host.services[TEAMS_SERVICE]
    const config = await teams.config()
    if (host.dataDir === undefined) throw new Error('Teams needs an extension data dir (extensionDir on the harness)')

    const spawnable = Object.fromEntries(
      Object.keys(config.types).map((type): [string, TeammateFactory] => [
        type,
        async (request) => {
          const base = await teams.teammateOptions(request)
          const member: PeerMemberOptions = { name: request.name, team: request.team, type: request.type }
          const created = await host.createSession({ ...base, params: { ...(base.params ?? {}), [PEERS_SERVICE]: { member } } })
          try {
            await teams.onTeammateCreated(created.id, member)
          } catch (error) {
            host.warn(`teammate ${request.name} bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          return created
        },
      ]),
    )

    return createPeerNetwork({
      repo: createFilePeerRepo(host.dataDir),
      visibility: sharedLabelVisibility,
      budget: config.budget,
      limits: { maxOutboundPerTurn: 20, mailboxCapacity: 200 },
      spawnable,
    })
  },

  session(api, { shared: network, params }) {
    if (params?.member !== undefined) mountHub(network, api, params.member)
    else mountTeam(network, api, { type: 'lead', description: 'Coordinates the team from the user’s conversation' })
  },
}

export default definition
