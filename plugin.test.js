import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, createSkillProvider, discoverSkills, parseFrontmatter, BUNDLED_SKILL_RANK } from './index.js'

const root = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(root, 'skills')

test('parseFrontmatter folds block descriptions and keeps the body', () => {
  const parsed = parseFrontmatter(
    ['---', 'name: perf-review', 'description: >', '  First line', '  continues here.', '---', '', '# Perf', '', 'Body.'].join('\n'),
  )
  assert.equal(parsed.data.name, 'perf-review')
  assert.equal(parsed.data.description, 'First line continues here.')
  assert.equal(parsed.body, '\n# Perf\n\nBody.')
})

test('parseFrontmatter refuses a block scalar it does not read', () => {
  assert.throws(
    () => parseFrontmatter('---\nname: x\ndescription: |\n  one\n---\nbody\n'),
    /unsupported block scalar indicator "\|"/,
  )
})

test('discoverSkills reads the bundled skill with a usable description', async () => {
  const skills = await discoverSkills(skillsDir)
  assert.deepEqual(skills.map((s) => s.name), ['perf-review'])
  assert.ok(skills[0].description.length > 20)
  assert.doesNotMatch(skills[0].content, /^---/)
  assert.match(skills[0].content, /Profile before you change/)
})

test('discoverSkills reports and skips an unreadable directory', async () => {
  const warnings = []
  const skills = await discoverSkills(join(root, 'does-not-exist'), (m) => warnings.push(m))
  assert.deepEqual(skills, [])
  assert.equal(warnings.length, 1)
})

test('discoverSkills skips a file the reader refuses and keeps the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-skills-'))
  try {
    await mkdir(join(dir, 'broken'), { recursive: true })
    await writeFile(join(dir, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: |\n  literal\n---\nbody\n')
    await mkdir(join(dir, 'fine'), { recursive: true })
    await writeFile(join(dir, 'fine', 'SKILL.md'), '---\nname: fine\ndescription: >\n  A usable description.\n---\nbody\n')
    const warnings = []
    const skills = await discoverSkills(dir, (m) => warnings.push(m))
    assert.deepEqual(skills.map((s) => s.name), ['fine'])
    assert.equal(warnings.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
  assert.equal(candidate.invocation.modelInvocable, true)
  assert.equal(candidate.invocation.userInvocable, true)
  assert.equal(candidate.resourceBase?.kind, 'directory')
  const definition = await provider.get(candidate)
  assert.ok(definition)
  assert.equal(definition.name, 'perf-review')
  assert.match(definition.content, /Profile before you change/)
  assert.doesNotMatch(definition.content, /^---/)
  assert.equal(await provider.get({ ...candidate, locator: join(skillsDir, 'nope', 'SKILL.md') }), undefined)
  assert.equal(await provider.get({ ...candidate, name: 'other-skill' }), undefined)
})

test('apply registers exactly one skills provider and nothing else', async () => {
  const providers = []
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['skills'])
      callback({ skills: { registerProvider: (create) => { providers.push(create()); return () => {} } } })
    },
  }
  apply(ctx)
  assert.equal(providers.length, 1)
  assert.equal((await providers[0].list()).length, 1)
})
