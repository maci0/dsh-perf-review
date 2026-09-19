import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { apply, createSkillProvider, discoverSkills, parseFrontmatter, parseFrontmatterWithYaml } from './index.js'

const root = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(root, 'skills')

/** Matches a static `yaml` import; the perf gate below asserts there is none. */
const STATIC_YAML_IMPORT = /^\s*import\s[^\n]*['"]yaml['"]/m
/**
 * The read path as `readSkillFile` runs it: the flat reader first, the
 * dynamically-imported `yaml` parser only when it refuses. Resolved here rather
 * than imported at the top so the assertions, not module resolution, are what
 * fails when the flat reader regresses.
 */
const flatRead = async (source) => {
  const parsed = parseFrontmatter(source)
  if (parsed !== undefined) return parsed
  const { parseFrontmatterWithYaml } = await import('./index.js')
  return parseFrontmatterWithYaml(source)
}

test('parseFrontmatter folds block descriptions and keeps the body', async () => {
  const source = ['---', 'name: perf-review', 'description: >', '  First line', '  continues here.', '---', '', '# Perf', '', 'Body.'].join('\n')
  const parsed = await flatRead(source)
  assert.equal(parsed.data.name, 'perf-review')
  // YAML clip chomping keeps the folded block's final newline; callers trim.
  assert.equal(parsed.data.description, 'First line continues here.\n')
  assert.equal(parsed.body, '\n# Perf\n\nBody.')
  // Deterministic perf gate: the flat reader owns this whole block.
  assert.notEqual(parseFrontmatter(source), undefined)
})

test('parseFrontmatter reads a literal block scalar and a nested map', async () => {
  const parsed = await flatRead(
    [
      '---',
      'name: perf-review',
      'description: |-',
      '  First line.',
      '  Second line.',
      'provider:',
      '  owner: perf',
      '  tags:',
      '    - profile',
      '    - bench',
      '---',
      'body',
    ].join('\n'),
  )
  // `|-` keeps the newlines and strips the final one.
  assert.equal(parsed.data.description, 'First line.\nSecond line.')
  assert.deepEqual(parsed.data.provider, { owner: 'perf', tags: ['profile', 'bench'] })
  assert.equal(parsed.body, 'body')
  // The nested `provider:` map is outside the flat subset: the fast reader refuses.
  assert.equal(parseFrontmatter('---\nname: flat\nprovider:\n  owner: perf\n---\nbody\n'), undefined)
})

test('parseFrontmatter reads a chomped folded scalar', async () => {
  const parsed = await flatRead('---\ndescription: >-\n  one\n  two\n---\nbody\n')
  assert.equal(parsed.data.description, 'one two')
})

test('a flat frontmatter block never loads yaml', async () => {
  const sources = [
    '---\nname: flat\ndescription: >\n  A usable description.\n---\nbody\n',
    '---\nname: flat\ndescription: "quoted, with: characters"\nlicense: MIT\n---\nbody\n',
  ]
  // The flat reader resolving a header is what keeps readSkillFile off the
  // dynamic-import branch, and the module must therefore hold no static import.
  assert.doesNotMatch(readFileSync(join(root, 'index.js'), 'utf8'), STATIC_YAML_IMPORT, 'a static yaml import is back')
  for (const source of sources) {
    const parsed = parseFrontmatter(source)
    assert.notEqual(parsed, undefined, 'a flat header fell through to the yaml fallback')
    assert.equal((await flatRead(source)).body, parsed.body)
  }

  let sink = 0
  const before = process.cpuUsage()
  for (let index = 0; index < 2000; index += 1) sink += parseFrontmatter(sources[0]).body.length
  const spent = process.cpuUsage(before)
  const perParse = (spent.user + spent.system) / 2000
  assert.ok(sink > 0)
  // CPU time, not wall clock; ~1.4us/parse measured on the Ryzen 9 9950X. The
  // pre-change reader never reached this path (every header paid the yaml
  // parse, 32us here), so the band only has to catch that regression.
  assert.ok(perParse <= 8, `flat frontmatter parse cost ${perParse.toFixed(1)}us, budget 8us`)
})

test('discoverSkills reads the bundled skill with a usable description', async () => {
  const { candidates: skills, complete } = await discoverSkills(skillsDir)
  assert.equal(complete, true)
  assert.deepEqual(skills.map((s) => s.name), ['perf-review'])
  assert.ok(skills[0].description.length > 20)
  assert.doesNotMatch(skills[0].content, /^---/)
  assert.match(skills[0].content, /Profile before you change/)
})

test('discoverSkills reports an unreadable root as incomplete discovery', async () => {
  const warnings = []
  const { candidates, complete } = await discoverSkills(join(root, 'does-not-exist'), (m) => warnings.push(m))
  assert.deepEqual(candidates, [])
  assert.equal(complete, false)
  assert.equal(warnings.length, 1)
})

test('discoverSkills reports a SKILL.md the reader refuses as incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'perf-review'), { recursive: true })
    await writeFile(join(dir, 'perf-review', 'SKILL.md'), '---\nname: [unterminated\ndescription: literal\n---\nbody\n')
    const warnings = []
    const { candidates, complete } = await discoverSkills(dir, (m) => warnings.push(m))
    // A refused file is not an empty catalog: the registry must re-read, not cache it.
    assert.deepEqual(candidates, [])
    assert.equal(complete, false)
    assert.equal(warnings.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discoverSkills accepts a literal block scalar the reader used to refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'perf-review'), { recursive: true })
    await writeFile(
      join(dir, 'perf-review', 'SKILL.md'),
      '---\nname: literal\ndescription: |\n  One line.\n  Two lines.\n---\nbody\n',
    )
    const { candidates } = await discoverSkills(dir)
    assert.deepEqual(candidates.map((s) => s.name), ['literal'])
    assert.equal(candidates[0].description, 'One line.\nTwo lines.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list and get settle promptly when the lookup signal is aborted', async () => {
  const provider = createSkillProvider({ skillsDir })
  const controller = new AbortController()
  controller.abort()
  const observed = await provider.list({ signal: controller.signal })
  // An aborted lookup settles promptly as an explicit incomplete observation.
  assert.deepEqual(observed, { candidates: [], complete: false })
  const candidate = (await provider.list())[0]
  assert.ok(candidate)
  assert.equal(await provider.get(candidate, { signal: controller.signal }), undefined)
})

test('a real cordis composition mounts the bundled skill and disposes it', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')
  const mod = await import('./index.js')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  // The loader mounts the module itself, so the test forwards its `inject`
  // declaration: cordis refuses `ctx.skills` to a fiber that did not declare it.
  const fiber = await ctx.plugin({ name: mod.name, inject: mod.inject, apply: (scope) => mod.apply(scope) })

  const summaries = await ctx.skills.list()
  assert.deepEqual(summaries.map((s) => s.name), ['perf-review'])
  assert.equal(summaries[0].provider, 'perf-review')
  assert.deepEqual(summaries[0].invocation, { modelInvocable: true, userInvocable: true })
  const loaded = await ctx.skills.get('perf-review')
  assert.match(loaded.content, /Profile before you change/)

  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})

test('the provider lists candidates and loads their bodies', async () => {
  const provider = createSkillProvider({ skillsDir })
  assert.equal(provider.name, 'perf-review')
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.provider, 'perf-review')
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(candidate.resourceBase?.kind, 'directory')
  const definition = await provider.get(candidate)
  assert.ok(definition)
  assert.equal(definition.name, 'perf-review')
  assert.match(definition.content, /Profile before you change/)
  assert.doesNotMatch(definition.content, /^---/)
  assert.equal(await provider.get({ ...candidate, locator: join(skillsDir, 'nope', 'SKILL.md') }), undefined)
  assert.equal(await provider.get({ ...candidate, name: 'other-skill' }), undefined)
})

test('the provider reports an unreadable root as an incomplete observation', async () => {
  const provider = createSkillProvider({ skillsDir: join(root, 'does-not-exist') })
  const observation = await provider.list()
  assert.equal(Array.isArray(observation), false)
  assert.deepEqual(observation.candidates, [])
  assert.equal(observation.complete, false)
})

test('a SKILL.md without name loads under its directory name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'perf-review'), { recursive: true })
    await writeFile(join(dir, 'perf-review', 'SKILL.md'), '---\ndescription: >\n  A usable description.\n---\nbody\n')
    const provider = createSkillProvider({ skillsDir: dir })
    const candidates = await provider.list()
    assert.deepEqual(candidates.map((c) => c.name), ['perf-review'])
    const definition = await provider.get(candidates[0])
    assert.equal(definition?.name, 'perf-review')
    assert.equal(definition?.content, 'body')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply resolves its skills directory from an install path containing a space', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh perf '))
  try {
    const pkg = join(dir, 'pkg')
    await mkdir(pkg)
    // The copied entry keeps its bare imports resolvable from the temp tree.
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
    await cp(join(root, 'index.js'), join(pkg, 'index.js'))
    await cp(skillsDir, join(pkg, 'skills'), { recursive: true })
    const mod = await import(pathToFileURL(join(pkg, 'index.js')).href)
    let provider
    mod.apply({
      logger: { warn: () => {} },
      skills: { registerProvider: (create) => { provider = create(); return () => {} } },
    })
    const candidates = await provider.list()
    assert.deepEqual(candidates.map((c) => c.name), ['perf-review'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply registers exactly one skills provider and nothing else', async () => {
  const providers = []
  const ctx = {
    skills: { registerProvider: (create) => { providers.push(create()); return () => {} } },
  }
  apply(ctx)
  assert.equal(providers.length, 1)
  assert.equal((await providers[0].list()).length, 1)
})

// --- perf gates -----------------------------------------------------------
// Instruction-level numbers were recorded with `taskset -c 2 perf stat -e
// instructions,cycles` over 2000 provider reads: ~1.22M instructions per
// list+get on this host, ~0.55M of it frontmatter parsing). The tests gate on
// retired CPU time and on the served text, never on wall clock.

test('the bundled skill parses to a byte-identical catalog and body', async () => {
  const { candidates, complete } = await discoverSkills(skillsDir)
  const provider = createSkillProvider({ skillsDir })
  const loaded = await provider.get((await provider.list())[0])
  const digest = createHash('sha256')
  digest.update(JSON.stringify(candidates.map((c) => [c.name, c.description, c.content])))
  digest.update(`\u0000${complete}\u0000${loaded.name}\u0000${loaded.content}`)
  assert.equal(
    digest.digest('hex'),
    'f8a9ce4dfe1c2c8d69b0b0b3a206fa50ddc4ba6d842874c9f74317a019aa9cf9',
    'the served skill text changed — re-measure and update the digest deliberately',
  )
})

// --- frontmatter fast-path regression table --------------------------------
//
// The flat reader may only claim a block whose value is provably what `yaml`
// produces. Each case pins a divergence an adversarial verifier found: a CRLF
// block that threw and got the whole skill silently skipped, `+` keep
// chomping, duplicate keys, typed plain scalars, `a: b`, quoted/flow/`__proto__`
// keys. The real `yaml` parser is the oracle for data and body.

/**
 * The block the real parser would be handed for one source: BOM stripped, CRLF
 * normalized, delimiters located. `undefined` when the source has no delimited
 * frontmatter.
 * @returns the block text without delimiters.
 */
const oracleBlock = (source) => {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source
  const lines = text.split(/\r\n?|\n/).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (lines[0]?.trimEnd() !== '---') return undefined
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line))
  if (close === -1) return undefined
  return lines.slice(1, close).join('\n')
}

const FRONTMATTER_CASES = [
  { what: 'CRLF frontmatter', source: '---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n' },
  { what: 'keep-chomped literal block', source: '---\ndescription: |+\n  a\n\n\n---\nbody\n' },
  { what: 'keep-chomped folded block', source: '---\ndescription: >+\n  a\n  b\n\n---\nbody\n' },
  { what: 'duplicate key', source: '---\nname: a\nname: b\n---\nbody\n' },
  { what: 'typed hex scalar', source: '---\nv: 0x10\n---\nbody\n' },
  { what: 'typed octal scalar', source: '---\nv: 0o17\n---\nbody\n' },
  { what: 'typed infinity scalar', source: '---\nv: .inf\n---\nbody\n' },
  { what: 'typed NaN scalar', source: '---\nv: .nan\n---\nbody\n' },
  { what: 'nested mapping in a value', source: '---\ndescription: a: b\n---\nbody\n' },
  { what: 'quoted key', source: "---\n'qk': v\n---\nbody\n" },
  { what: 'unclosed flow mapping', source: '---\n{a: 1}\n---\nbody\n' },
  { what: '`__proto__` key', source: '---\n__proto__: x\n---\nbody\n' },
  { what: 'nested map', source: '---\nname: a\nprovider:\n  owner: perf\n  tags:\n    - profile\n---\nbody\n' },
  { what: 'list value', source: '---\nname: a\ntags:\n  - one\n  - two\n---\nbody\n' },
  { what: 'tab-indented block body', source: '---\ndescription: |\n\ta\n---\nbody\n' },
  { what: 'tab-indented block body after spaces', source: '---\ndescription: |\n\t  a\n---\nbody\n' },
  { what: 'at-sign indicator key', source: '---\n@a: v\n---\nbody\n' },
  { what: 'block indicator key', source: '---\n|a: v\n---\nbody\n' },
  { what: 'anchor indicator key', source: '---\n&a: v\n---\nbody\n' },
  { what: 'typed hex key', source: '---\n0x10: v\n---\nbody\n' },
  { what: 'typed leading-zero key', source: '---\n01: v\n---\nbody\n' },
  { what: 'flow-sequence key', source: '---\n[a]: v\n---\nbody\n' },
  { what: 'keep chomp with indent digit', source: '---\ndescription: |+2\n  a\n\n\n---\nbody\n' },
  { what: 'indent digit with keep chomp', source: '---\ndescription: |2+\n  a\n\n\n---\nbody\n' },
  { what: 'zero indent indicator', source: '---\ndescription: |0\n  a\n---\nbody\n' },
  { what: 'non-breaking space in a block scalar indent', source: '---\ndescription: |\n \u00A0x\n---\nbody\n' },
  { what: 'line separator in a block scalar indent', source: '---\ndescription: |\n\u2028x\n---\nbody\n' },
  { what: 'vertical tab as separation', source: '---\nname: a\nv:\u000Bx\n---\nbody\n' },
  { what: 'form feed as separation', source: '---\nname: a\nv:\u000Cx\n---\nbody\n' },
  { what: 'leading blank lines', source: '\n\n---\nname: a\ndescription: b\n---\nbody\n' },
  { what: '`---` inside a value', source: '---\nname: a\nwhenToUse: see --- above\n---\nbody\n' },
  { what: 'empty block', source: '---\n---\nbody\n' },
  { what: 'blank block', source: '---\n\n---\nbody\n' },
  { what: 'BOM', source: '\uFEFF---\nname: a\ndescription: b\n---\nbody\n' },
  { what: 'unclosed frontmatter', source: '---\nname: a\ndescription: b\n' },
  { what: 'delimiter with no body break', source: '---\nname: a\n---' },
  { what: 'trailing space on the delimiter', source: '---\nname: a\n--- \nbody\n' },
  { what: 'no frontmatter at all', source: 'body only\n' },
  {
    what: 'typed scalars table',
    source: '---\na: 1\nb: -1\nc: 1.5\nd: 1e3\ne: 0\nf: 007\ng: +5\nh: 1_000\ni: .5\nj: 1.\nk: -0\n---\nbody\n',
  },
]

for (const { what, source } of FRONTMATTER_CASES) {
  test(`frontmatter regression: ${what}`, async () => {
    const block = oracleBlock(source)
    let expected
    let threw = false
    try {
      const parsed = parseYaml(block ?? '')
      expected = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
    } catch {
      threw = true
      expected = {}
    }

    let fast
    try {
      fast = parseFrontmatter(source)
    } catch (error) {
      assert.fail(`${what}: the fast reader threw where yaml did not: ${error.message}`)
    }

    if (threw) {
      // `yaml` rejects this block; the fast reader must refuse it, and its
      // caller's fallback must raise the same error.
      assert.equal(fast, undefined, `${what}: fast reader claimed a block yaml rejects`)
      await assert.rejects(parseFrontmatterWithYaml(source), `${what}: the fallback swallowed yaml's error`)
      return
    }

    if (fast !== undefined) {
      assert.deepStrictEqual(fast.data, expected, `${what}: fast data diverged from yaml`)
      const withYaml = await parseFrontmatterWithYaml(source)
      assert.deepStrictEqual(withYaml.data, expected, `${what}: yaml fallback data diverged`)
      assert.deepStrictEqual(fast.body, withYaml.body, `${what}: fast body diverged from yaml`)
    } else {
      const withYaml = await parseFrontmatterWithYaml(source)
      assert.deepStrictEqual(withYaml.data, expected, `${what}: refused and the fallback diverged`)
    }
  })
}

test('a lone CR is not a delimiter, as before the fast path', async () => {
  const source = '---\rname: a\r---\rbody\r'
  assert.equal(parseFrontmatter(source), undefined, 'lone CR must not be read as frontmatter')
  const withYaml = await parseFrontmatterWithYaml(source)
  assert.deepStrictEqual(withYaml.data, {})
  assert.equal(withYaml.body, source)
})

test('unclosed flow mapping parses to the map yaml builds, not to two strings', async () => {
  const source = '---\n{a: 1}\n---\nbody\n'
  assert.deepStrictEqual(parseYaml('{a: 1}'), { a: 1 })
  const fast = parseFrontmatter(source)
  if (fast !== undefined) assert.deepStrictEqual(fast.data, { a: 1 })
  const read = fast ?? (await parseFrontmatterWithYaml(source))
  assert.deepStrictEqual(read.data, { a: 1 })
  assert.equal(read.body, 'body\n')
})

test('a CRLF skill still loads instead of being skipped', async () => {
  const source = '---\r\nname: crlf-skill\r\ndescription: A usable description.\r\n---\r\nbody\r\n'
  const expected = { name: 'crlf-skill', description: 'A usable description.' }
  assert.deepStrictEqual(parseYaml(oracleBlock(source)), expected)

  const fast = parseFrontmatter(source)
  if (fast !== undefined) assert.deepStrictEqual(fast.data, expected)
  // The fixed delimiter scan reads CRLF too, so the fallback never throws.
  const withYaml = await parseFrontmatterWithYaml(source)
  assert.deepStrictEqual(withYaml.data, expected)
  // The pre-change reader split on `\r?\n` and joined with `\n`, so a CRLF
  // body arrives LF-normalized.
  assert.equal(withYaml.body, 'body\n')

  const dir = await mkdtemp(join(tmpdir(), 'perf-frontmatter-'))
  try {
    await mkdir(join(dir, 'perf-review'))
    await writeFile(join(dir, 'perf-review', 'SKILL.md'), source)
    const warnings = []
    const { candidates } = await discoverSkills(dir, (message) => warnings.push(message))
    assert.deepEqual(candidates.map((skill) => skill.name), ['crlf-skill'])
    assert.deepEqual(warnings, [])

    const provider = createSkillProvider({ skillsDir: dir })
    const listed = await provider.list()
    assert.deepEqual(listed.map((skill) => skill.name), ['crlf-skill'])
    const loaded = await provider.get(listed[0])
    assert.ok(loaded, 'the CRLF skill was skipped end-to-end')
    assert.equal(loaded.name, 'crlf-skill')
    assert.equal(loaded.description, 'A usable description.')
    assert.equal(loaded.content, 'body')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
