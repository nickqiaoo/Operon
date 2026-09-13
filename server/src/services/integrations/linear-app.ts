import { linearGraphQL } from './broker-client.js'

// Linear, as the workspace agent. Every call goes through the broker's
// GraphQL proxy (docs/linear-github/design.md §3 rule 3); this file only knows
// the documents. The org id names which workspace's token the broker uses.

export interface LinearTeam {
  id: string
  name: string
  key: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  type: string // triage | backlog | unstarted | started | completed | canceled
  position: number
}

export interface LinearTeamDetails {
  projects: Array<{ id: string; name: string }>
  labels: Array<{ id: string; name: string; color: string }>
  states: LinearWorkflowState[]
}

export interface LinearIssueRef {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  teamId: string | null
  projectId: string | null
  stateType: string | null
  assigneeId: string | null
  priority: number
  labels: string[]
}

export interface CreateLinearIssueInput {
  teamId: string
  title: string
  description?: string
  projectId?: string
  priority?: number
  labelIds?: string[]
  assigneeId?: string
  /** Shown as the author instead of the app (IssueCreateInput.createAsUser). */
  createAsUser?: string
}

export async function fetchLinearTeams(orgId: string): Promise<LinearTeam[]> {
  const data = await linearGraphQL<{ teams: { nodes: LinearTeam[] } }>(
    orgId,
    `query { teams(first: 100) { nodes { id name key } } }`,
  )
  return data.teams.nodes
}

export async function fetchLinearTeamDetails(orgId: string, teamId: string): Promise<LinearTeamDetails> {
  const data = await linearGraphQL<{
    team: {
      projects: { nodes: Array<{ id: string; name: string }> }
      labels: { nodes: Array<{ id: string; name: string; color: string }> }
      states: { nodes: LinearWorkflowState[] }
    }
  }>(
    orgId,
    `query TeamDetails($id: String!) {
      team(id: $id) {
        projects(first: 100) { nodes { id name } }
        labels(first: 100) { nodes { id name color } }
        states(first: 50) { nodes { id name type position } }
      }
    }`,
    { id: teamId },
  )
  return {
    projects: data.team.projects.nodes,
    labels: data.team.labels.nodes,
    states: [...data.team.states.nodes].sort((a, b) => a.position - b.position),
  }
}

export async function fetchLinearIssue(orgId: string, issueId: string): Promise<LinearIssueRef> {
  const data = await linearGraphQL<{
    issue: {
      id: string
      identifier: string
      title: string
      description: string | null
      url: string
      team: { id: string } | null
      project: { id: string } | null
      state: { type: string } | null
      assignee: { id: string } | null
      priority: number
      labels: { nodes: Array<{ name: string }> }
    }
  }>(
    orgId,
    `query Issue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority
        team { id } project { id } state { type } assignee { id }
        labels(first: 50) { nodes { name } }
      }
    }`,
    { id: issueId },
  )
  const i = data.issue
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description,
    url: i.url,
    teamId: i.team?.id ?? null,
    projectId: i.project?.id ?? null,
    stateType: i.state?.type ?? null,
    assigneeId: i.assignee?.id ?? null,
    priority: i.priority ?? 0,
    labels: (i.labels?.nodes ?? []).map((l) => l.name),
  }
}

export async function createLinearIssue(
  orgId: string,
  input: CreateLinearIssueInput,
): Promise<{ id: string; identifier: string; url: string; title: string; teamId: string; projectId: string | null }> {
  const data = await linearGraphQL<{
    issueCreate: {
      success: boolean
      issue: { id: string; identifier: string; url: string; title: string; team: { id: string }; project: { id: string } | null } | null
    }
  }>(
    orgId,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title team { id } project { id } }
      }
    }`,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        projectId: input.projectId,
        priority: input.priority,
        labelIds: input.labelIds,
        assigneeId: input.assigneeId,
        createAsUser: input.createAsUser,
      },
    },
  )
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issue creation failed')
  }
  const issue = data.issueCreate.issue
  return { ...issue, teamId: issue.team.id, projectId: issue.project?.id ?? null }
}

export async function updateLinearIssue(
  orgId: string,
  issueId: string,
  patch: { stateId?: string; title?: string; description?: string; priority?: number },
): Promise<void> {
  const data = await linearGraphQL<{ issueUpdate: { success: boolean } }>(
    orgId,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: patch },
  )
  if (!data.issueUpdate.success) throw new Error('Linear issue update failed')
}

export async function createLinearComment(
  orgId: string,
  issueId: string,
  body: string,
  createAsUser?: string,
): Promise<{ id: string }> {
  const data = await linearGraphQL<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
    orgId,
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id } }
    }`,
    { input: { issueId, body, ...(createAsUser ? { createAsUser } : {}) } },
  )
  if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error('Linear comment failed')
  return data.commentCreate.comment
}

/**
 * Agent activity content, per Linear's agent-session vocabulary. Field names
 * follow the public docs; design.md §18 item 5 verifies them live.
 */
export type LinearActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'action'; action: string; parameter?: string; result?: string }
  | { type: 'response'; body: string }
  | { type: 'elicitation'; body: string }
  | { type: 'error'; body: string }

export async function createAgentActivity(
  orgId: string,
  agentSessionId: string,
  content: LinearActivityContent,
  ephemeral = false,
): Promise<void> {
  const data = await linearGraphQL<{ agentActivityCreate: { success: boolean } }>(
    orgId,
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
    { input: { agentSessionId, content, ...(ephemeral ? { ephemeral: true } : {}) } },
  )
  if (!data.agentActivityCreate.success) throw new Error('Linear agent activity failed')
}

export async function addAgentSessionLink(
  orgId: string,
  agentSessionId: string,
  link: { label: string; url: string },
): Promise<void> {
  await linearGraphQL<{ agentSessionUpdate: { success: boolean } }>(
    orgId,
    `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) { success }
    }`,
    { id: agentSessionId, input: { addedExternalUrls: [link] } },
  )
}
