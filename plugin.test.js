import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, createSkillProvider, discoverSkills, parseFrontmatter, BUNDLED_SKILL_RANK } from './index.js'

const root = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(root, 'skills')

test('parseFrontmatter folds block descriptions and keeps the body', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: perf-review', 'description: >', '  First line', '  continues here.', '---', '', '# Perf', '', 'Body.'].join('\n'),
  )
  assert.equal(parsed.data.name, 'perf-review')
  // YAML clip chomping keeps the folded block's final newline; callers trim.
  assert.equal(parsed.data.description, 'First line continues here.\n')
  assert.equal(parsed.body, '\n# Perf\n\nBody.')
})

test('parseFrontmatter reads a literal block scalar and a nested map', () => {
  const parsed = parseFrontmatter(
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
})

test('parseFrontmatter reads a chomped folded scalar', () => {
  const parsed = parseFrontmatter('---\ndescription: >-\n  one\n  two\n---\nbody\n')
  assert.equal(parsed.data.description, 'one two')
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

test('discoverSkills skips a file the reader refuses and keeps the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'broken'), { recursive: true })
    await writeFile(join(dir, 'broken', 'SKILL.md'), '---\nname: [unterminated\ndescription: literal\n---\nbody\n')
    await mkdir(join(dir, 'fine'), { recursive: true })
    await writeFile(join(dir, 'fine', 'SKILL.md'), '---\nname: fine\ndescription: >\n  A usable description.\n---\nbody\n')
    const warnings = []
    const { candidates, complete } = await discoverSkills(dir, (m) => warnings.push(m))
    assert.equal(complete, true)
    assert.deepEqual(candidates.map((s) => s.name), ['fine'])
    assert.equal(warnings.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('discoverSkills accepts a literal block scalar the reader used to refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'literal'), { recursive: true })
    await writeFile(
      join(dir, 'literal', 'SKILL.md'),
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
    await mkdir(join(dir, 'no-name'), { recursive: true })
    await writeFile(join(dir, 'no-name', 'SKILL.md'), '---\ndescription: >\n  A usable description.\n---\nbody\n')
    const provider = createSkillProvider({ skillsDir: dir })
    const candidates = await provider.list()
    assert.deepEqual(candidates.map((c) => c.name), ['no-name'])
    const definition = await provider.get(candidates[0])
    assert.equal(definition?.name, 'no-name')
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
