/**
 * dsh-perf-review — performance review skill for DeepSeek Harness.
 *
 * One capability: the bundled `perf-review` skill becomes a `ctx.skills`
 * provider, so it loads through the `skill` tool and appears as
 * `/perf-review` in the composer. No settings, no tool, no command, no
 * browser half — a skill needs none of that.
 *
 * Skill content: the user's perf prompt, plus the hot-path/SIMD/data-layout
 * material from gauntlet's perf-review and the critical-path/delivery
 * material from its webperf-review (maci0/gauntlet), plus fix-order and
 * ownership-boundary lines from the adjacent concurrency/resource/db/cache
 * reviews.
 *
 * Load via a row in ~/.dsh/profiles/<profile>/cordis.patch.yml
 * (see cordis.patch.yml).
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Plugin name as it appears in the loader. */
export const name = 'perf-review'

/** Rank matching a harness bundled skill, so a project/user skill of the same name still wins. */
export const BUNDLED_SKILL_RANK = 600

/**
 * Read and parse one skill file. Shared by discovery and direct loads so a
 * single file enforces the name/description/frontmatter rules everywhere.
 */
export async function readSkillFile(path, onWarn, entryName) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return undefined
  }

  let parsed
  try {
    parsed = parseFrontmatter(source)
  } catch (error) {
    onWarn?.(`skipping ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  const fallback = entryName ?? path.split('/').pop()
  const skillName = (parsed.data.name ?? fallback).trim()
  const description = (parsed.data.description ?? '').trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    onWarn?.(`skipping ${path}: "${skillName}" is not a valid kebab-case skill name`)
    return undefined
  }
  if (description === '') {
    onWarn?.(`skipping ${path}: frontmatter has no description`)
    return undefined
  }

  const metadata = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === 'name' || key === 'description') continue
    metadata[key] = value
  }

  return {
    name: skillName,
    description,
    content: parsed.body.trim(),
    metadata,
    path,
    directory: dirname(path),
  }
}

/**
 * Parse leading `---` frontmatter: plain `key: value` pairs plus the folded
 * (`>`) block scalar the bundled SKILL.md writes its description as.
 */
export function parseFrontmatter(source) {
  const lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0] === undefined || !/^---[ \t]*$/.test(lines[0])) return { data: {}, body: String(source) }
  let closing = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---[ \t]*$/.test(lines[i] ?? '')) { closing = i; break }
  }
  if (closing === -1) return { data: {}, body: String(source) }

  const data = {}
  const block = lines.slice(1, closing)
  for (let i = 0; i < block.length; i += 1) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(block[i] ?? '')
    if (!match?.[1]) continue
    const key = match[1]
    const raw = (match[2] ?? '').trim()
    if (raw.startsWith('>') || raw.startsWith('|')) {
      if (raw !== '>') throw new Error(`unsupported block scalar indicator ${JSON.stringify(raw)} for key "${key}"`)
      // Folded continuation: indented lines join with spaces, blanks break paragraphs.
      const collected = []
      let indent = -1
      let j = i + 1
      for (; j < block.length; j += 1) {
        const line = block[j] ?? ''
        if (line.trim() === '') { collected.push(''); continue }
        const leading = line.length - line.trimStart().length
        if (indent === -1) {
          if (leading === 0 && /^([A-Za-z0-9_-]+):/.test(line)) break
          indent = leading
        }
        if (leading < indent) break
        collected.push(line.slice(indent))
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      const paragraphs = []
      let current = []
      for (const line of collected) {
        if (line === '') { if (current.length > 0) { paragraphs.push(current.join(' ')); current = [] } }
        else current.push(line)
      }
      if (current.length > 0) paragraphs.push(current.join(' '))
      data[key] = paragraphs.join('\n')
      i = j - 1
      continue
    }
    data[key] = raw.length >= 2
      && ((raw[0] === '"' && raw[raw.length - 1] === '"') || (raw[0] === "'" && raw[raw.length - 1] === "'"))
      ? raw.slice(1, -1)
      : raw
  }
  return { data, body: lines.slice(closing + 1).join('\n') }
}

/** Read every valid skill directory under `skillsDir`. Broken files are skipped, never fatal. */
export async function discoverSkills(skillsDir, onWarn) {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch (error) {
    onWarn?.(`cannot read skills directory ${skillsDir}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(skillsDir, entry.name, 'SKILL.md')
    const skill = await readSkillFile(path, onWarn, entry.name)
    if (skill !== undefined) skills.push(skill)
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

function summaryOf(skill) {
  return {
    path: skill.path,
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: 'perf-review',
    resourceBase: { kind: 'directory', path: skill.directory },
  }
}

/** Build the provider the skill registry mounts. */
export function createSkillProvider(options) {
  const { skillsDir, onWarn } = options ?? {}
  return {
    name: 'perf-review',
    async list() {
      const skills = await discoverSkills(skillsDir, onWarn)
      return skills.map((skill) => ({ ...summaryOf(skill), rank: BUNDLED_SKILL_RANK, locator: skill.path, metadata: skill.metadata }))
    },
    async get(candidate) {
      if (typeof candidate.locator !== 'string') return undefined
      // Read the locator directly: one file instead of a full re-discovery.
      // The name check keeps a stale candidate (path reused by another skill)
      // from loading under the wrong identity.
      const skill = await readSkillFile(candidate.locator, onWarn)
      if (skill === undefined || skill.name !== candidate.name) return undefined
      return { ...summaryOf(skill), content: skill.content, metadata: skill.metadata }
    },
  }
}

/** Mount the plugin: skills provider only. Tolerates a ctx without inject (minimal compositions). */
export function apply(ctx) {
  const warn = (message) => { console.warn(`[perf-review] ${message}`) }
  ctx.inject?.(['skills'], (scope) => {
    scope.skills.registerProvider(() =>
      createSkillProvider({ skillsDir: new URL('./skills', import.meta.url).pathname, onWarn: warn }),
    )
  })
}
