import { Hono } from 'hono'
import type {
  SkillInstallInput,
  SkillRemoveInput,
  SkillScope,
  SkillScopeInput,
  SkillUpdateInput,
} from '../types/skill.js'
import {
  listInstalledSkills,
  listInstalledSkillsWithShadowing,
  listAvailableSkills,
  getSkillDetail,
  installSkill,
  removeSkill,
  updateSkill,
} from '../services/skill.js'
import type { ScopeContext } from '../services/skill-targets.js'

/**
 * Resolve the scope a request is talking about.
 *
 * Project scope needs a workspace path; asking for it without one is a client bug, so
 * it fails loudly rather than silently writing to the user's home directory.
 */
function resolveScope(input: SkillScopeInput): ScopeContext {
  const scope: SkillScope = input.scope === 'project' ? 'project' : 'global'
  if (scope === 'project' && !input.workspacePath) {
    throw new Error('workspacePath is required when scope is "project"')
  }
  return { scope, workspacePath: input.workspacePath }
}

function scopeFromQuery(c: { req: { query: (k: string) => string | undefined } }): ScopeContext {
  return resolveScope({
    scope: c.req.query('scope') as SkillScope | undefined,
    workspacePath: c.req.query('workspacePath'),
  })
}

export function skillRoutes() {
  const router = new Hono()

  router.get('/', async (c) => {
    try {
      const ctx = scopeFromQuery(c)
      // Global listings flag entries a project copy shadows, which needs the workspace
      // even though the listing itself is global.
      const skills =
        ctx.scope === 'global'
          ? await listInstalledSkillsWithShadowing('global', c.req.query('workspacePath'))
          : await listInstalledSkills(ctx)
      return c.json({ skills })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list installed skills'
      return c.json({ error: message }, 400)
    }
  })

  router.get('/available', async (c) => {
    const source = c.req.query('source')
    if (!source) {
      return c.json({ error: 'source query parameter is required' }, 400)
    }
    try {
      const skills = await listAvailableSkills(source, c.req.query('refresh') === '1')
      return c.json({ skills })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list available skills'
      return c.json({ error: message }, 500)
    }
  })

  // Preview a skill (its SKILL.md + bundled files) before installing. Falls back to the
  // source repo when the skill isn't installed locally.
  router.get('/detail', async (c) => {
    const skillName = c.req.query('skillName')
    if (!skillName) {
      return c.json({ error: 'skillName query parameter is required' }, 400)
    }
    try {
      const detail = await getSkillDetail(skillName, c.req.query('source'), scopeFromQuery(c))
      return c.json({ detail })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load skill detail'
      return c.json({ error: message }, 500)
    }
  })

  router.post('/install', async (c) => {
    const payload = await c.req.json<SkillInstallInput>()
    if (!payload.source || !payload.skillName) {
      return c.json({ error: 'source and skillName are required' }, 400)
    }
    try {
      const result = await installSkill(payload.source, payload.skillName, resolveScope(payload))
      return c.json({ success: true, output: result.message, targets: result.targets })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to install skill'
      return c.json({ success: false, error: message }, 500)
    }
  })

  router.post('/update', async (c) => {
    const payload = await c.req.json<SkillUpdateInput>()
    if (!payload.skillName) {
      return c.json({ error: 'skillName is required' }, 400)
    }
    try {
      const result = await updateSkill(payload.skillName, resolveScope(payload), payload.force === true)
      return c.json({
        success: !result.needsForce,
        output: result.message,
        needsForce: result.needsForce,
        targets: result.targets,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update skill'
      return c.json({ success: false, error: message }, 500)
    }
  })

  router.post('/remove', async (c) => {
    const payload = await c.req.json<SkillRemoveInput>()
    if (!payload.skillName) {
      return c.json({ error: 'skillName is required' }, 400)
    }
    try {
      const output = await removeSkill(payload.skillName, resolveScope(payload))
      return c.json({ success: true, output })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to uninstall skill'
      return c.json({ success: false, error: message }, 500)
    }
  })

  return router
}
