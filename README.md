# dsh-perf-review

"Make it faster" is a guess. This skill makes the agent measure first.

Type `/perf-review` and it profiles the hot path you name, ranks the bottlenecks it finds by user-visible impact, changes one thing, and reports the p50/p95 delta. If it cannot measure a win, it says so instead of shipping one.

The whole plugin is one skill: instructions the agent follows, not a profiler. It brings the method and the output format; your existing tools (`perf`, `hyperfine`, `lighthouse`, `heaptrack`, devtools) do the measuring.

## What you get

- **A resident performance engineer.** The agent gets a role and a success metric — perceived speed — plus hard rules: profile before changing, name the tool and the scenario and the baseline, benchmark every change that claims speed with p50/p95, keep behaviour identical unless a tradeoff is explicit and measured.
- **A triage order.** Unbounded growth (no pagination, no bound) beats N+1 and redundant work, which beats hot-path allocations and per-iteration compilation, which beats cold-path issues. With no benchmark target, it fixes only categorically safe wins and skips anything whose benefit needs numbers to prove.
- **Checklists for both halves.** Frontend: FPS, long tasks, input delay, layout thrash, forced reflow, giant unwindowed lists, work that belongs on a worker, compositor-friendly animation, then render-blocking critical path and deferred bytes. Backend: CPU and allocation profiles, cache misses, SoA over AoS, arena reuse, batched I/O, auto-vectorization blockers checked before anyone reaches for intrinsics.
- **Deterministic perf tests, not flaky ones.** Every claimed win has to leave a test that still passes on a loaded machine: retired instructions or work counters first, then CPU time, then hardware-counter ratios. Wall clock is for the product-level p50/p95 and a coarse bound only — a wall-clock gate needs medians and a tolerance band, and says so.
- **Runtime currency check.** It notes the version the code actually runs on and checks recent releases for speedups that touch the hot paths found — recommend an upgrade only where a measured path gains.
- **Named ownership boundaries.** It judges whether a cache should exist and owns app-side query call sites; it never owns schema or migrations. It will not trade correctness, accessibility, or content for speed.
- **A fixed report shape.** Bottlenecks ranked by user-visible impact with confidence (confirmed / likely / potential), changes made with measured deltas, remaining hot paths, and what it refused to do because it was unmeasured or would not help.

## Install

```sh
dsh plugin --profile web add github:maci0/dsh-perf-review
```

The package declares `dsh.bundle.patch`, so the CLI appends it to `dsh.profile.bundles` and its shipped `cordis.patch.yml` supplies the row. Refresh later with:

```sh
dsh plugin --profile web update dsh-perf-review
```

Then **restart `dsh web`** — bundle layers compose at boot.

Do not paste that row into `~/.dsh/profiles/web/cordis.patch.yml` as well: the bundle layer already applies it, and a second row registers the plugin twice.

## Use it

Type the lag, not the fix:

```
/perf-review the file tree stalls for a beat when I expand a folder — profile it and tell me what to change
```

The agent then states the user-visible lag it is attacking, shows profile evidence (hot function, % time, scenario), proposes the smallest change that hits that hot path, implements it, re-runs the same scenario before and after, and keeps or reverts on the numbers.

Give it a repo path, a trace, or a running local URL and it works from what exists. For a browser measurement it uses static files or an already-listening local URL — it never installs tools, never starts a server to get a measurement, and never hits a remote host. With no codebase in reach it first lists the exact files, traces, and benchmarks it needs.

## Configure

No config fields. The plugin reads one bundled skill and mounts it; behaviour is the skill text itself.

| Frontmatter key | Effect |
|---|---|
| `name` | Skill id — `perf-review`, so the composer exposes `/perf-review`. |
| `description` | What the model sees when deciding to load the skill. |

Both invocation policies are always on — the provider emits `invocation: { modelInvocable: true, userInvocable: true }` — and any other frontmatter key is parsed and ignored.

## How it works

`index.js` is plain JavaScript, no build step. It hooks `ctx.skills.registerProvider()`, resolves its `skills/` directory with `fileURLToPath`, and lists every `skills/<name>/SKILL.md` it can read. Candidate summaries carry `rank: BUNDLED_SKILL_RANK`, so a project or user skill of the same name still takes precedence.

Frontmatter is parsed with `yaml` — the same parser the harness's own filesystem skill provider uses — so plain scalars, `|`/`|-`/`>-` block scalars, and nested maps read as YAML says they do. An invalid skill name or a description-less file is skipped with a warning, never fatal. An unreadable `skills/` root is reported as an **incomplete observation**, not an empty catalog, so the registry cannot cache a failed read as "no skills here".

Runtime dependencies: `@deepseek-ai/dsh-skill` and `yaml`, both declared in `package.json`.

## Limits

- It is a skill plus instructions, not a profiler. Every number comes from a tool you already have; if nothing can measure the path, the change does not ship.
- It does not own schema, indexes, or migrations, and it does not own caching correctness — only whether a cache should exist at all.
- It adds no model tool, no slash command, and no browser half. A skill needs none of that.
- The composer exposes user-invocable skills as `/<name>` on its own; this package does not draw UI.

## Development

```sh
npm test           # node --test plugin.test.js — 14 tests, no build step
```

Node `^22.19 || >=24`. Tests cover the frontmatter parser, discovery, the provider's `list`/`get` contract, abort handling, incomplete-root reporting, and a real Cordis composition that mounts and disposes the provider.

## Licence note

Gauntlet-derived lines above are adapted from AGPL-3.0 material, which is copyleft for distributed derivatives. This package is marked MIT to match its sisters, but if you publish it, either reword those lines into your own prompt's voice or relicense to AGPL-3.0 to comply.

## Uninstall

```sh
dsh plugin --profile web remove dsh-perf-review
```

That drops the dependency and the bundle layer with it; nothing else to edit.
