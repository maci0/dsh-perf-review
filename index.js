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
 * `package.json` declares `dsh.bundle.patch`, so `dsh plugin add` mounts this
 * package as a profile layer and cordis.patch.yml supplies the row.
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Plugin name as it appears in the loader. */
export const name = 'perf-review'

/** Service this plugin needs; `ctx.skills` is ready when `apply` runs. */
export const inject = ['skills']

/** Rank matching a harness bundled skill, re-exported from the registry, so a project/user skill of the same name still wins. */
export { BUNDLED_SKILL_RANK }

/** Frontmatter keys the harness defines; they project into named summary fields, never into `metadata`. */
const SUMMARY_KEYS = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable'])

/**
 * Read and parse one skill file. Shared by discovery and direct loads so a
 * single file enforces the name/description/frontmatter rules everywhere.
 */
export async function readSkillFile(path, onWarn, entryName, signal) {
  if (signal?.aborted) return undefined

  let source
  try {
    source = await readFile(path, { encoding: 'utf8', signal })
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

  const fallback = entryName ?? basename(path)
  const skillName = String(parsed.data.name ?? fallback).trim()
  const description = String(parsed.data.description ?? '').trim()
  if (!isSkillName(skillName)) {
    onWarn?.(`skipping ${path}: "${skillName}" is not a valid kebab-case skill name`)
    return undefined
  }
  if (description === '') {
    onWarn?.(`skipping ${path}: frontmatter has no description`)
    return undefined
  }

  const metadata = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (SUMMARY_KEYS.has(key)) continue
    metadata[key] = value
  }

  const whenToUse = String(parsed.data.whenToUse ?? '').trim()

  return {
    name: skillName,
    description,
    ...whenToUse === '' ? {} : { whenToUse },
    invocation: {
      modelInvocable: parsed.data['disable-model-invocation'] !== true,
      userInvocable: parsed.data['user-invocable'] !== false,
    },
    content: parsed.body.trim(),
    metadata,
    path,
    directory: dirname(path),
  }
}

/**
 * Parse leading `---` frontmatter with `yaml`, the parser the harness's own
 * filesystem skill provider uses: plain scalars, `|`/`|-`/`>-` block scalars,
 * and nested maps all read as YAML says they do. Frontmatter with no closing
 * `---` is not frontmatter, and the body is then the whole source.
 * @returns the parsed mapping and the body that follows it.
 */
export function parseFrontmatter(source) {
  const text = String(source).replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || !/^---[ \t]*$/.test(lines[0])) return { data: {}, body: text }
  let closing = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---[ \t]*$/.test(lines[i] ?? '')) { closing = i; break }
  }
  if (closing === -1) return { data: {}, body: text }

  const body = lines.slice(closing + 1).join('\n')
  const parsed = parseYaml(lines.slice(1, closing).join('\n'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Empty or non-mapping frontmatter: no keys, but the body still loads.
    return { data: {}, body }
  }
  return { data: parsed, body }
}

/**
 * Read every valid skill directory under `skillsDir`. Broken files are skipped, never fatal.
 * @param signal - aborts discovery for a caller that no longer wants the result.
 * @returns the candidates plus whether the root itself was readable; an
 *   unreadable root is incomplete discovery, not an authoritative empty catalog.
 */
export async function discoverSkills(skillsDir, onWarn, signal) {
  if (signal?.aborted) return { candidates: [], complete: false }

  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch (error) {
    if (signal?.aborted) return { candidates: [], complete: false }
    onWarn?.(`cannot read skills directory ${skillsDir}: ${error instanceof Error ? error.message : String(error)}`)
    return { candidates: [], complete: false }
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const path = join(skillsDir, entry.name, 'SKILL.md')
    const skill = await readSkillFile(path, onWarn, entry.name, signal)
    if (skill !== undefined) candidates.push(skill)
  }
  return { candidates: candidates.sort((left, right) => left.name.localeCompare(right.name)), complete: true }
}

function summaryOf(skill) {
  return {
    path: skill.path,
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    invocation: skill.invocation,
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
    async list(lookup) {
      const { candidates, complete } = await discoverSkills(skillsDir, onWarn, lookup?.signal)
      const skills = candidates.map((skill) => ({ ...summaryOf(skill), rank: BUNDLED_SKILL_RANK, locator: skill.path, metadata: skill.metadata }))
      // Array shorthand on a complete read; an explicit observation otherwise, so the registry cannot cache a failed read as an empty catalog.
      return complete ? skills : { candidates: skills, complete: false }
    },
    async get(candidate, lookup) {
      if (typeof candidate.locator !== 'string') return undefined
      // Read the locator directly: one file instead of a full re-discovery.
      // The directory name is the fallback identity a name-less SKILL.md is
      // listed under; the name check keeps a stale candidate (path reused by
      // another skill) from loading under the wrong identity.
      const skill = await readSkillFile(candidate.locator, onWarn, basename(dirname(candidate.locator)), lookup?.signal)
      if (skill === undefined || skill.name !== candidate.name) return undefined
      return { ...summaryOf(skill), content: skill.content, metadata: skill.metadata }
    },
  }
}

/** Mount the plugin: skills provider only. */
export function apply(ctx) {
  ctx.inject(['skills'], (scope) => {
    const warn = (message) => {
      if (scope.logger?.warn) scope.logger.warn(`[perf-review] ${message}`)
      else console.warn(`[perf-review] ${message}`)
    }
    scope.skills.registerProvider(() =>
      createSkillProvider({ skillsDir: fileURLToPath(new URL('./skills', import.meta.url)), onWarn: warn }),
    )
  })
}
