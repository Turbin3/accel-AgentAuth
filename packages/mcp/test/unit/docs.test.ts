import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toolsFor } from '../../src/server'

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const SKILL_DIR = join(ROOT, 'skills', 'agentauth')
const read = (path: string) => readFileSync(path, 'utf8')

const allTools = new Set(
  (['agent', 'owner', 'observer'] as const).flatMap((profile) =>
    toolsFor({ profile, unsafeDevSign: true }).map((t) => t.name),
  ),
)

describe('skill, snippets and examples', () => {
  it('SKILL.md has the required frontmatter', () => {
    const text = read(join(SKILL_DIR, 'SKILL.md'))
    const match = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text)
    expect(match?.[1]).toBe('agentauth')
    expect(match?.[2]?.length).toBeGreaterThan(80)
    expect(match?.[2]?.length).toBeLessThan(1024)
  })

  it('SKILL.md states the core behaviour rules', () => {
    const text = read(join(SKILL_DIR, 'SKILL.md'))
    for (const rule of [
      /Check status first/,
      /Move money only through the tools/,
      /A denial means stop/,
      /do \*\*not\*\* retry with another recipient/,
      /Never handle keys/,
      /unaudited devnet prototype/i,
    ]) {
      expect(text).toMatch(rule)
    }
  })

  it.each([
    ['SKILL.md', join(SKILL_DIR, 'SKILL.md')],
    ['AGENTS.snippet.md', join(SKILL_DIR, 'AGENTS.snippet.md')],
    ['compromised prompts', join(SKILL_DIR, 'compromised-agent-test-prompts.md')],
    ['README.md', join(ROOT, 'packages', 'mcp', 'README.md')],
  ])('%s only names tools that exist', (_name, path) => {
    const mentioned = new Set(read(path).match(/\b(?:agentauth|owner|observer)_[a-z_]+\b/g) ?? [])
    for (const name of mentioned) {
      expect(allTools.has(name), `${path} mentions unknown tool ${name}`).toBe(true)
    }
  })

  it('example configs are valid JSON, keep the key out of the arguments and use no secret', () => {
    for (const file of ['.mcp.json', 'claude_desktop_config.json']) {
      const text = read(join(SKILL_DIR, 'examples', file))
      const json = JSON.parse(text) as {
        mcpServers: Record<string, { args: string[]; env?: Record<string, string> }>
      }
      const agent = Object.values(json.mcpServers).find((s) => s.args.includes('agent'))
      expect(agent?.env?.['AGENTAUTH_AGENT_KEYPAIR']).toBeDefined()
      for (const server of Object.values(json.mcpServers)) {
        expect(server.args.join(' ')).not.toMatch(/keypair|secret|seed/i)
        expect(Object.keys(server.env ?? {})).not.toContain('AGENTAUTH_OWNER_KEYPAIR')
      }
    }
  })
})
