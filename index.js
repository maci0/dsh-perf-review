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

/** Read every valid skill directory under `dir`. Broken files are skipped, never fatal. */
export async function discoverSkills(dir, onWarn) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    onWarn?.(`cannot read skills directory ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'SKILL.md')
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = parseFrontmatter(source)
    } catch (error) {
      onWarn?.(`skipping ${path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const skillName = (parsed.data.name ?? entry.name).trim()
    const description = (parsed.data.description ?? '').trim()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
      onWarn?.(`skipping ${path}: "${skillName}" is not a valid kebab-case skill name`)
      continue
    }
    if (description === '') {
      onWarn?.(`skipping ${path}: frontmatter has no description`)
      continue
    }
    skills.push({
      name: skillName,
      description,
      content: parsed.body.trim(),
      path,
      directory: dirname(path),
    })
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
export function createSkillProvider(skillsDir, onWarn) {
  return {
    name: 'perf-review',
    async list() {
      const skills = await discoverSkills(skillsDir, onWarn)
      return skills.map((skill) => ({ ...summaryOf(skill), rank: BUNDLED_SKILL_RANK, locator: skill.path }))
    },
    async get(candidate) {
      if (typeof candidate.locator !== 'string') return undefined
      const skills = await discoverSkills(skillsDir, onWarn)
      const found = skills.find((skill) => skill.path === candidate.locator && skill.name === candidate.name)
      if (found === undefined) return undefined
      return { ...summaryOf(found), content: found.content }
    },
  }
}

/** Mount the plugin: skills provider only. */
export function apply(ctx) {
  const warn = (message) => { console.warn(`[perf-review] ${message}`) }
  ctx.inject?.(['skills'], (scope) => {
    scope.skills.registerProvider(() =>
      createSkillProvider(new URL('./skills', import.meta.url).pathname, warn),
    )
  })
}
