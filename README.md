# dsh-perf-review

**Performance review skill for DeepSeek Harness.**

Your prompt, shipped as a skill: `/perf-review` profiles hot paths, attacks input-to-paint latency / frame jank / time-to-interactive, and benchmarks every change with p50/p95 — behavior identical unless a tradeoff is explicit and measured.

| Capability | Extension point | Effect |
|---|---|---|
| One skill | `ctx.skills.registerProvider()` | `perf-review` loads through the `skill` tool — and so appears as `/perf-review` in the composer. |

## Skill contents

Your prompt verbatim (role, goal, hard rules, stack freedom, data layout, frontend/backend checklists, process, output format), plus the gauntlet material worth folding in (from `maci0/gauntlet`, AGPL-3.0 — see note below):

- `perf-review` §8: auto-vectorization blockers (loop-carried deps, aliasing, non-contiguous access, branches) checked before hand-written intrinsics; intrinsics need a portable scalar fallback + a measurement beating the autovectorizer.
- `perf-review` fix order: unbounded growth > N+1 / redundant work > hot-path allocs / per-iteration compilation > cold-path issues. No benchmark target → categorically safe wins only.
- `webperf-review`: render-blocking critical path first, then compression/caching on large assets, then eagerly-loaded bytes that could be deferred.
- Ownership boundaries from cache/db/resource reviews: judge whether a cache should exist, own app-side query call sites (never schema), own throughput/tuning of held resources.

Measurement rule: `hyperfine`, `perf`/flamegraphs, `heaptrack`/`massif`, `lighthouse`, `curl -w` — static files or an already-listening local URL only. Never install tools, never start a server for a measurement, never hit a remote host.

Deliberately skipped: settings card, model tool, slash command, browser half — a skill needs none of that. The composer exposes user-invocable skills as `/<name>` on its own.

## License note

Gauntlet-derived lines above are adapted from AGPL-3.0 material, which is copyleft for distributed derivatives. This package is marked MIT to match its sisters, but if you publish it, either reword those lines into your own prompt's voice or relicense to AGPL-3.0 to comply.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-perf-review
# pnpm will warn "declares no dsh.bundle — installed as a plain dependency". That is the point.
```

Then paste `cordis.patch.yml` into `~/.dsh/profiles/web/cordis.patch.yml`. Saving that file remounts the plugin. `dsh.profile.bundles` is frozen at boot — do not put this package there, or `insert` will register it twice.

### Verify

After the profile patch save:

- `/perf-review` is in the `/` menu;
- invoking it injects the performance review instructions and the agent starts the audit.

## Development

```sh
npm test          # node --test plugin.test.js (Node >= 22.6, no build step)
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-perf-review
```

and delete the `id: perf-review` row from
`~/.dsh/profiles/<profile>/cordis.patch.yml`. Saving unmounts it.
