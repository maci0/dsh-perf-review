/**
 * Real-composition test: the plugin mounts into a real `@deepseek-ai/cordis`
 * `Context` and releases every registration when its fiber disposes.
 *
 * The other suites drive plain-object fakes, which cannot show whether a
 * registration is released, and a live profile reloads plugin rows on every
 * edit — a leaked registration would double up on the next reload.
 *
 * @module dsh-perf-review/composition
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'

import { apply } from './index.js'

/** The skill registry seam: what `ctx.skills.registerProvider` needs. */
class SkillsSeam extends Service {
  providers = []

  constructor(ctx) {
    super(ctx, "skills")
  }

  registerProvider(create) {
    return this.ctx.effect(() => {
      this.providers.push(create)
      return () => { this.providers.pop() }
    })
  }
}

test('the plugin mounts into a real Cordis context and releases what it registered', async () => {
  const ctx = new Context()
  const skills = new SkillsSeam(ctx)

  const fiber = await ctx.plugin({ name: 'perf-review', inject: ['skills'], apply }, undefined)
  assert.equal(skills.providers.length, 1, 'the bundled skill provider is contributed')

  await fiber.dispose()
  assert.equal(skills.providers.length, 0, 'the provider is released with the fiber')
})
