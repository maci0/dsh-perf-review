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

import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'

/** Plugin name as it appears in the loader. */
export const name = 'perf-review'

/** Service this plugin needs; `ctx.skills` is ready when `apply` runs. */
export const inject = ['skills']

/**
 * Read and parse one skill file. Shared by discovery and direct loads so a
 * single file enforces the name/description/frontmatter rules everywhere.
 */
async function readSkillFile(path, onWarn, entryName, signal) {
  if (signal?.aborted) return undefined

  let source
  try {
    source = await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    onWarn?.(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }

  let parsed
  try {
    // The flat reader covers every header this package ships. Its refusal is
    // what selects the real YAML parser, so the fallback stays the contract.
    parsed = parseFrontmatter(source)
    if (parsed === undefined) parsed = await parseFrontmatterWithYaml(source)
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

  return {
    name: skillName,
    description,
    content: parsed.body.trim(),
    path,
    directory: dirname(path),
  }
}

/** `key: value` at column zero, with nothing but horizontal space around the colon. */
const ENTRY = /^([^\s:#][^\s:#]*?)[ \t]*:([ \t]+[^\r\n]*|)$/
/** A plain scalar with no leading indicator, no `#`, no `: ` mapping, no reserved start. */
const PLAIN = /^[^\s!&*\-?{}[\],#|>@`"'%:][^#:]*$/
/** A double-quoted scalar with no backslash escape in it. */
const SIMPLE_DOUBLE = /^[^\\]*$/
/** A single-quoted scalar with no `''` escape in it. */
const SIMPLE_SINGLE = /^[^']*$/
/** The block scalar header: style plus an optional indent and/or chomping modifier. */
const BLOCK_HEADER = /^([|>])(-)?$/
/** A block scalar indicator with keep chomping: its trailing newlines are not read here. */
/** A plain scalar YAML types as an integer: `0x10`, `0o17`, `+5`, `-0`, `007`, `1_000`. */
const TYPED_INT = /^[-+]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*)$/
/** A plain scalar YAML types as a special float: `.inf`, `.nan`, either sign, any case. */
const TYPED_SPECIAL = /^[-+]?\.(?:inf|nan)$/i
/** A plain scalar YAML types as a float: a leading `+`, leading zeros, a `.5`/`1.` body. */
const TYPED_FLOAT = /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|[-+]?\.[0-9][0-9_]*)$/i
/** The decimal scalars this reader converts itself, with no YAML-only spelling. */
const SAFE_INT = /^-?(?:0|[1-9]\d*)$/
const SAFE_FLOAT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/
/** Keys YAML resolves to a non-string: `null` becomes `''` and `True` becomes `'true'`. */
const RESOLVED_KEY = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/
/** Keys that would not survive `data[key] = value` on an object literal. */
const UNSAFE_KEY = new Set(['__proto__'])
/** Keys YAML itself resolves to a non-string: `null` and `true` become `''` and `'true'`. */
/** A key this reader can prove `yaml` resolves to the same string. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/
/** Code points JS `trim` strips but YAML counts as content: indentation is unprovable. */
const JS_ONLY_SPACE = /[\u000B\u000C\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

/** The delimiter line, exactly as the pre-change reader tested it. */
const DELIMITER = /^---[ \t]*$/

/** Split a data block into lines: `\r\n`, `\n`, and lone `\r` are all breaks to YAML. */
function toLines(text) {
  return text.split('\n')
}

/**
 * Split one document into its leading frontmatter block and the body, the way
 * the pre-change reader did: line by line, so the string handed to `yaml` is
 * byte-identical to what it parsed before the fast path existed.
 * @param {string} source - the file's contents.
 * @returns {{ block: string, body: string, present: boolean }} the parts.
 */
function splitDocument(source) {
  const text = String(source).replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || !DELIMITER.test(lines[0])) return { block: '', body: text, present: false }
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER.test(lines[index] ?? '')) {
      closing = index
      break
    }
  }
  if (closing === -1) return { block: '', body: text, present: false }
  return { block: lines.slice(1, closing).join('\n'), body: lines.slice(closing + 1).join('\n'), present: true }
}

/**
 * Count the spaces a line starts with. YAML indentation is spaces; a tab or a
 * code point JS treats as blank is not this reader's to interpret.
 * @param {string} line - one line of the block.
 * @returns {number} the number of leading spaces.
 */
function leadingSpaces(line) {
  let count = 0
  while (count < line.length && line.charCodeAt(count) === 32) count += 1
  return count
}

/**
 * Read one block scalar: same-indent lines only, chomping as YAML defines it.
 * @returns the scalar and the index one past the block, or `undefined` when the
 *   block has an explicit or deeper indent, an interior blank line, or no content.
 */
function readBlockScalar(lines, header, headerValue) {
  const style = headerValue[0]
  const modifier = headerValue.slice(1)
  let indent = 0
  for (const char of modifier) {
    if (char !== '+' && char !== '-') indent = char.charCodeAt(0) - 48
  }
  if (indent === 0) {
    const first = lines[header + 1]
    if (first === undefined || leadingSpaces(first) === 0) return undefined
    indent = leadingSpaces(first)
  }
  if (indent === 0) return undefined
  const firstContent = lines[header + 1]
  // A tab is never block-scalar indentation to YAML; it is a parse error there
  // and would only look like indentation here.
  if (firstContent === undefined || firstContent.charCodeAt(0) === 9) return undefined

  const content = []
  let index = header + 1
  let closed = false
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (leadingSpaces(line) < indent) { closed = true; break }
    if (line.length === indent) {
      // An interior blank line folds differently; only a trailing run may stay.
      if (index + 1 < lines.length && lines[index + 1].length >= indent) return undefined
      content.push('')
      continue
    }
    if (leadingSpaces(line) > indent) return undefined
    if (line.charCodeAt(indent) === 9) return undefined
    content.push(line.slice(indent, line.length))
  }
  // A block that runs to the end of the document is closed there.
  if (!closed && index >= lines.length) closed = true
  if (!closed) return undefined
  if (content.length === 0) return undefined

  let last = content.length
  while (last > 0 && content[last - 1] === '') last -= 1
  const kept = content.slice(0, last)
  if (kept.length === 0) return undefined

  const body = style === '|' ? kept.join('\n') : kept.join(' ')
  if (modifier.includes('-')) return { value: body, next: index }
  return { value: `${body}\n`, next: index }
}

/**
 * Read one scalar value.
 * @returns the value, or `undefined` when it needs the real YAML parser.
 */
function readScalar(raw) {
  // A `#` needs YAML's comment rules (one only after whitespace) to read: refuse.
  if (raw.includes('#')) return undefined
  // `.inf` / `.nan` are YAML's special floats, in any case and either sign.
  if (TYPED_SPECIAL.test(raw)) return undefined
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return { value: null }
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return { value: true }
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return { value: false }
  if (/[0-9]/.test(raw)) {
    // A digit anywhere means YAML may type this scalar; only the spellings this
    // reader converts identically may pass, every other form goes to `yaml`.
    if (SAFE_INT.test(raw) || SAFE_FLOAT.test(raw)) return { value: Number(raw) }
    // Any other exponent spelling is YAML's floatExp, whose mantissa may be
    // `.5`, `1.`, or zero-padded (`01e9`, `00e0`) — none of which this reader
    // converts, so it must not claim the block.
    if (/[eE]/.test(raw)) return undefined
    if (TYPED_INT.test(raw) || TYPED_FLOAT.test(raw) || /^[-+]/.test(raw) || raw.includes('_')) return undefined
  }

  const first = raw.charCodeAt(0)
  if (first === 34) {
    if (!SIMPLE_DOUBLE.test(raw.slice(1))) return undefined
    const closing = raw.indexOf('"', 1)
    if (closing === -1 || raw.slice(closing + 1).trim() !== '') return undefined
    return { value: raw.slice(1, closing) }
  }
  if (first === 39) {
    if (!SIMPLE_SINGLE.test(raw.slice(1))) return undefined
    const closing = raw.indexOf("'", 1)
    if (closing === -1 || raw.slice(closing + 1).trim() !== '') return undefined
    return { value: raw.slice(1, closing) }
  }
  if (!PLAIN.test(raw)) return undefined
  return { value: raw }
}

/**
 * Read a flat block of `key: value` entries.
 * @returns the mapping, or `undefined` when any line needs the real YAML parser.
 */
function parseFlatBlock(block) {
  // `trim`/`trimStart` in this reader would measure indentation through these
  // and YAML would not: the real parser has to decide.
  if (JS_ONLY_SPACE.test(block)) return undefined
  const lines = toLines(block)
  const data = {}
  const seen = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '' || line.charCodeAt(0) === 35) continue
    const entry = ENTRY.exec(line)
    if (entry === null) return undefined

    const key = entry[1].trimEnd()
    if (key !== entry[1]) return undefined
    // Only a key that is provably its own string: that excludes quoted keys,
    // flow keys, keys starting with an indicator (`@a`, `|a`, `[a]`), typed
    // keys (`0x10`), and the words YAML resolves to `null`/`true`/`false`.
    if (!SAFE_KEY.test(key)) return undefined
    if (RESOLVED_KEY.test(key)) return undefined
    // A quoted key (`'qk': v`) is unquoted by YAML, not by this reader, and an
    // unclosed flow mapping (`{a: 1}`) only looks like one entry here.
    if (key.charCodeAt(0) === 39 || key.charCodeAt(0) === 34 || key.charCodeAt(0) === 123) return undefined
    // A plain key YAML resolves to `null`/`true`/`false` is not the string this
    // reader would build.
    // `yaml` rejects a duplicate key and a `__proto__` key does not survive a
    // plain object assignment; both need the real parser.
    if (seen.has(key) || UNSAFE_KEY.has(key)) return undefined
    seen.add(key)
    const raw = entry[2].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
    if (raw === '') {
      // A value on following lines is a nested map or a sequence.
      const next = lines[index + 1]
      if (next !== undefined && next.trimStart() !== '' && next.charCodeAt(0) !== 35) return undefined
      data[key] = null
      continue
    }
    if (raw.charCodeAt(0) === 124 || raw.charCodeAt(0) === 62) {
      // Only clip and strip chomping are read here; `+` keeps every trailing
      // line break, which this line-based reader does not count.
      if (BLOCK_HEADER.exec(raw) === null) return undefined
      const scalar = readBlockScalar(lines, index, raw)
      if (scalar === undefined) return undefined
      data[key] = scalar.value
      index = scalar.next - 1
      continue
    }
    const scalar = readScalar(raw)
    if (scalar === undefined) return undefined
    data[key] = scalar.value
  }
  return data
}

/**
 * Parse leading frontmatter from a markdown document, for the flat subset only.
 * @param {string} source - full file contents.
 * @returns {{ data: Record<string, unknown>, body: string }|undefined} the read,
 *   or `undefined` when the block needs the real YAML parser.
 */
export function parseFrontmatter(source) {
  // `\r` is a line break to YAML and not to this reader: hand the whole file,
  // CRLF included, to the real parser instead of claiming the block.
  if (String(source).includes('\r')) return undefined
  const { block, body, present } = splitDocument(source)
  if (!present) return { data: {}, body }
  const data = parseFlatBlock(block)
  if (data === undefined) return undefined
  return { data, body }
}

/**
 * Parse leading `---` frontmatter with `yaml`, the parser the harness's own
 * filesystem skill provider uses. Frontmatter with no closing `---` is not
 * frontmatter, and the body is then the whole source. The extraction is the
 * pre-change reader's line-by-line split, so `yaml` sees the same bytes.
 * @param {string} source - full file contents.
 * @returns {Promise<{ data: Record<string, unknown>, body: string }>} the read.
 */
export async function parseFrontmatterWithYaml(source) {
  const { block, body, present } = splitDocument(source)
  if (!present) return { data: {}, body }
  const { parse: parseYaml } = await import('yaml')
  const parsed = parseYaml(block)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // Empty or non-mapping frontmatter: no keys, but the body still loads.
    return { data: {}, body }
  }
  return { data: parsed, body }
}
/**
 * Read this package's one bundled skill. No directory walk: the package ships
 * exactly one `SKILL.md`, and `get()` already loads a locator directly.
 * @returns `{ candidates, complete }`; `complete: false` means re-read, not "no skills".
 */
export async function discoverSkills(skillsDir, onWarn, signal) {
  if (signal?.aborted) return { candidates: [], complete: false }
  const skill = await readSkillFile(join(skillsDir, name, 'SKILL.md'), onWarn, name, signal)
  // A failed read is an incomplete observation, so the registry re-reads
  // instead of caching a broken skill as an empty catalog.
  return skill === undefined ? { candidates: [], complete: false } : { candidates: [skill], complete: true }
}

/** Summary for one bundled skill. Every SKILL.md this package ships is invocable by both the model and the user. */
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
export function createSkillProvider({ skillsDir, onWarn }) {
  return {
    name: 'perf-review',
    async list(lookup) {
      const { candidates, complete } = await discoverSkills(skillsDir, onWarn, lookup?.signal)
      const skills = candidates.map((skill) => ({ ...summaryOf(skill), rank: BUNDLED_SKILL_RANK, locator: skill.path }))
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
      return { ...summaryOf(skill), content: skill.content }
    },
  }
}

/** Mount the plugin: skills provider only. `inject` above already made the fiber wait for `ctx.skills`. */
export function apply(ctx) {
  const warn = (message) => {
    if (ctx.logger?.warn) ctx.logger.warn(`[perf-review] ${message}`)
    else console.warn(`[perf-review] ${message}`)
  }
  ctx.skills.registerProvider(() =>
    createSkillProvider({ skillsDir: fileURLToPath(new URL('./skills', import.meta.url)), onWarn: warn }),
  )
}
