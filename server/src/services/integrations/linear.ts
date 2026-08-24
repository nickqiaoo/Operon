const LINEAR_API = 'https://api.linear.app/graphql'

export interface LinearTeam {
  id: string
  name: string
  key: string
  projects: Array<{ id: string; name: string }>
  labels: Array<{ id: string; name: string; color: string }>
}

export interface LinearViewer {
  workspaceName: string
  userName: string
}

export interface CreateLinearIssueInput {
  teamId: string
  title: string
  description?: string
  projectId?: string
  priority?: number
  labelIds?: string[]
}

export interface CreatedLinearIssue {
  id: string
  identifier: string
  url: string
  title: string
}

async function linearRequest<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Linear API error: ${res.status} ${res.statusText} ${text}`)
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '))
  }
  if (!json.data) {
    throw new Error('Linear API returned no data')
  }
  return json.data
}

export async function fetchLinearViewer(apiKey: string): Promise<LinearViewer> {
  const data = await linearRequest<{
    viewer: { name: string; organization: { name: string } }
  }>(
    apiKey,
    `query { viewer { name organization { name } } }`,
  )
  return {
    userName: data.viewer.name,
    workspaceName: data.viewer.organization.name,
  }
}

export async function fetchLinearTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await linearRequest<{
    teams: {
      nodes: Array<{ id: string; name: string; key: string }>
    }
  }>(
    apiKey,
    `query {
      teams(first: 50) {
        nodes { id name key }
      }
    }`,
  )
  return data.teams.nodes.map((t) => ({
    id: t.id,
    name: t.name,
    key: t.key,
    projects: [],
    labels: [],
  }))
}

export async function fetchLinearTeamDetails(
  apiKey: string,
  teamId: string,
): Promise<{ projects: LinearTeam['projects']; labels: LinearTeam['labels'] }> {
  const data = await linearRequest<{
    team: {
      projects: { nodes: Array<{ id: string; name: string }> }
      labels: { nodes: Array<{ id: string; name: string; color: string }> }
    }
  }>(
    apiKey,
    `query TeamDetails($id: String!) {
      team(id: $id) {
        projects(first: 50) { nodes { id name } }
        labels(first: 50) { nodes { id name color } }
      }
    }`,
    { id: teamId },
  )
  return {
    projects: data.team.projects.nodes,
    labels: data.team.labels.nodes,
  }
}

export async function createLinearIssue(
  apiKey: string,
  input: CreateLinearIssueInput,
): Promise<CreatedLinearIssue> {
  const data = await linearRequest<{
    issueCreate: {
      success: boolean
      issue: { id: string; identifier: string; url: string; title: string } | null
    }
  }>(
    apiKey,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url title }
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
      },
    },
  )

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issue creation failed')
  }
  return data.issueCreate.issue
}
