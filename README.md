# pstack for pi

A [pi](https://pi.dev) package of [pstack](https://github.com/cursor/plugins/tree/main/pstack), poteto's agent workflows from `cursor/plugins`: `poteto-mode` and its 22 playbooks, 24 principle skills, and situational skills such as `swarm`, `arena`, `interrogate`, `why`, `how`, `tdd`, and `unslop`.

The skills are upstream's, unchanged except for one line that points them at the pi adapter. pstack is written against Cursor's tools, so this package adds the pieces pi lacks.

| Upstream needs | This package provides |
| --- | --- |
| Cursor's `Task` subagents (`subagent_type`, `model`, `readonly`, `run_in_background`, `resume`, `environment: "cloud"`) | A `Task` tool with the same fields. Each worker is a separate `pi` process with its own context and saved session. `TaskOutput` waits for background workers. |
| `poteto-agent` and `comment-sicko` subagents | Loaded from `agents/` and given the absolute path of pstack. |
| `AskQuestion` | An `AskQuestion` tool on pi's select and input dialogs. |
| The todolist tool | A `TodoWrite` tool with a widget above the editor. The list follows `/tree` and `/fork`. |
| `/poteto-mode` and other slash commands | `/poteto-mode`, `/why`, `/swarm`, and the other non-principle skills as aliases for `/skill:<name>`. |
| Cursor custom modes | `/pstack-mode <skill>` keeps a skill in the system prompt every turn. `/pstack-mode off` ends it. |
| `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/pstack-models.md`, written by `/setup-pstack` and injected into every session. |
| Cursor model slugs such as `claude-opus-5-5-xhigh-fast` | `Task` maps them to pi models (`anthropic/claude-opus-5-5` at thinking `xhigh`) and rejects ones pi cannot run, listing what it can run. |

[`docs/harness/pi.md`](docs/harness/pi.md) is the adapter the skills read. It maps every Cursor name they use to pi.

## Install

```bash
pi install git:github.com/eovidiu/pstack-pi
pi install ~/Work/pstack-pi                  # or from a local checkout
```

For one session without installing: `pi -e ~/Work/pstack-pi`.

Install it with `pi install`, not just `-e`. Workers are separate `pi` processes, and they load only installed packages, so a worker started from an `-e` session gets no pstack tools or skills.

## Get started

1. Run `/setup-pstack`. It lists your models with `pi --list-models`, asks for a reasoning budget, and writes `~/.pi/agent/pstack-models.md`. Without it, skills use upstream's default slugs, which work only if pi has those models.
2. Start rigorous work with `/poteto-mode <task>`.
3. Run `/pstack` to see the version, model rule, and mode. Run `/pstack-tasks` to list background workers.

New to pstack? Read [the guide](docs/guide/README.md), or ask `/poteto-help`.

## How `Task` behaves in pi

- **Parallelism.** pi runs the tool calls in one message concurrently, so N `Task` calls in one message run as N workers. At most 4 run at once (`PSTACK_MAX_CONCURRENCY`). The rest queue.
- **Background.** `run_in_background: true` returns an `agent_id` at once. When the worker finishes, its result arrives as a `pstack-task` message and wakes the session if it is idle, unless `TaskOutput` already collected it. In `-p` and JSON mode the worker runs in the foreground, because the process exits when the prompt ends.
- **`environment: "cloud"`.** pi has no cloud agents, so the worker gets a git worktree on branch `pstack/<agent_id>` under `~/.pi/agent/pstack/worktrees/`. Merging or deleting it is up to you or the parent agent.
- **`resume`.** Workers save sessions under `~/.pi/agent/pstack/subagent-sessions/`, so `resume: <agent_id>` continues one with a new prompt.
- **`readonly: true`** (and `subagent_type: "explore"`). The worker gets `read`, `bash`, `grep`, `find`, and `ls`. A guard in the worker blocks `write`, `edit`, and shell commands that clearly change state (redirects, `rm`, `git commit`, installs, and so on). It is a seatbelt, not a sandbox.
- **Depth.** A worker can start workers, and those cannot (`PSTACK_MAX_DEPTH`, default 2).
- **Models.** With no `model`, a worker runs on the parent's model and thinking level. A user agent in `~/.pi/agent/agents/*.md` can pin one.

## What does not carry over

- Cursor Automations, Bugbot setup, the cloud agent dashboard, and `SendToUser`. Skills skip those steps with one line, as the adapter says. That leaves out the dormant benny automation pack, and `make-bot-ui` cannot finish without a Cursor routine.
- `/deslop`, `control-ui`, and `control-cli` come from Cursor's `cursor-team-kit`, not pstack.
- Upstream's model defaults name Cursor slugs. They work when pi has the same models, as with Anthropic. Otherwise run `/setup-pstack`.

## Updating from upstream

`skills/`, `agents/`, `docs/guide/`, `LICENSE`, and `upstream.json` are generated. Do not edit them by hand.

```bash
npm run sync                                                # clone cursor/plugins main and regenerate
node scripts/sync-upstream.mjs --upstream ../cursor-plugins # or use a local checkout
npm run check                                               # fail if the generated tree is stale
npm test                                                    # model-slug mapping and readonly guard
```

The sync fails when an upstream skill starts using a Cursor name that `docs/harness/pi.md` has no row for. In that case, add the row and rerun.

## Layout

```
extensions/pstack/   the pi extension (hand-written)
  index.ts           system prompt context, /<skill> aliases, /pstack-mode, /pstack
  task-tool.ts       Task, TaskOutput, background registry, worktrees
  runner.ts          spawns one worker pi process
  models.ts          Cursor slug and pi model resolution
  agents.ts          generalPurpose, explore, pstack agents, user agents
  todo-tool.ts       TodoWrite
  ask-tool.ts        AskQuestion
  readonly-guard.ts  shell guard for readonly workers
docs/harness/pi.md   the adapter (hand-written)
skills/ agents/ docs/guide/   generated from upstream
```

## License

MIT. pstack is © Lauren Tan (see `LICENSE`). The pi extension and adapter in this repository are released under the same license.
