# pstack in pi

pstack skills use Cursor names. In pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds `skills/` and `docs/`. The pstack system prompt section names its absolute path. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

The pstack-pi extension adds tools named after their Cursor counterparts: `Task`, `TaskOutput`, `AskQuestion`, and `TodoWrite`. If a tool in the table is missing from your tool list, use the fallback column.

## Tools

| Cursor | pi | Fallback when the tool is missing |
| --- | --- | --- |
| `Task` | `Task`. Same fields, described below. Several `Task` calls in one message run in parallel. | Do the work yourself in this chat and say that you could not delegate. |
| `AskQuestion` | `AskQuestion`. Same shape: `questions` with `id`, `prompt`, `options`, and `allow_multiple`. | Ask in plain text. In `-p` or JSON mode no user is present, so make the reversible choice and say what you chose. |
| Open a todolist, or copy steps into the todolist tool | `TodoWrite` with `merge` and `todos` (`id`, `content`, `status`). | Keep the list in your reply and update it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | `read` `<pstack>/skills/<name>/SKILL.md` and follow it. Most pstack skills set `disable-model-invocation`, so they are missing from your skill list. That does not mean they are absent. When you tell the user to type it, write `/name` (pstack-pi registers an alias) or `/skill:name`. | |
| `Grep`, `Glob` | `grep` and `find` when they are active. Otherwise `bash` with `rg` and `fd` or `find`. | |
| A background subagent finishing | A `pstack-task` message arrives in the chat with its result. `TaskOutput` waits for one or more by id. | |

## Subagent fields

Each `Task` call runs a separate `pi` process in JSON mode with its own context window. Its final assistant message is the result. The result names an `agent_id`.

| Cursor | pi |
| --- | --- |
| `subagent_type: generalPurpose` | `subagent_type: "generalPurpose"`. Default tools, no extra prompt. |
| `poteto-agent`, `comment-sicko` | `subagent_type: "poteto-agent"`, `subagent_type: "comment-sicko"`. The extension loads them from `<pstack>/agents/` and gives them `<pstack>`'s absolute path, so a `poteto-agent` brief still includes the absolute path of `poteto-mode/SKILL.md`. |
| `readonly: true` | `readonly: true`. The worker gets `read`, `bash`, `grep`, `find`, and `ls` only, plus a do-not-edit instruction. It keeps `bash`, so check `git status` afterward. `subagent_type: "explore"` is the same thing. |
| `readonly: false` | Omit, or `readonly: false`. The worker gets the session's default tools and every installed extension, MCP included. |
| `environment: "cloud"` | `environment: "cloud"`. pi has no cloud agents, so the tool runs the worker in a new git worktree on branch `pstack/<agent_id>` under `~/.pi/agent/pstack/worktrees/`. The result names the path and branch. Merge, cherry-pick, or delete it yourself. Outside a git repository the call fails. |
| `environment: "local"` | Omit, or `environment: "local"`. The worker runs in the session's working directory. |
| `cloud_base_branch: <b>` | `cloud_base_branch: "<b>"`. The worktree starts from that ref. Pass a ref that exists locally, such as `origin/<b>` after `git fetch`. |
| `run_in_background: true` | `run_in_background: true`. The call returns an `agent_id` at once. The result arrives later as a `pstack-task` message, or call `TaskOutput` to wait. In `-p` or JSON mode the call runs in the foreground because the process exits when the prompt ends. |
| `resume` | `resume: "<agent_id>"`. The worker continues its own saved session with your new `prompt`. It works only for agents this pi process started or whose session still exists, in the same working directory. |
| `file_attachments` | `file_attachments: ["<path>", ...]`. The tool lists the paths in the brief. The worker reads them itself. |
| Subagents of subagents | Allowed one level down by default. A worker's worker cannot spawn more. `PSTACK_MAX_DEPTH` changes the limit. |

## Models

pi names a model `provider/id` with an optional thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Run `pi --list-models` with `bash` to see what this machine can use.

| Cursor | pi |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh-fast` | Pass it to `Task` `model` as is. The tool drops `-fast`, reads the effort token as the thinking level, and runs `claude-opus-5-5` at `xhigh` when pi has that model. Otherwise it rejects the slug and lists what it can run. |
| A `gemini-*`, `gpt-*`, `grok-*`, or other slug | Same rule: `gemini-4-neon-xhigh` runs `gemini-4-neon` at `xhigh` when pi has it. When the tool rejects it, follow the calling skill's fallback. If none, omit `model` and say so. |
| `auto` or `inherit-parent` | Omit `model`, or pass the alias. The worker runs on the parent's model and thinking level. |
| A pi model, such as `anthropic/claude-opus-5-5:high` or `claude-opus-5-5 high` | Pass it as is. A separate `thinking` field also works. |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/pstack-models.md`. The extension puts it in the system prompt of every session, under `pstack_models`. If it is not there, read the file. If the file or the role's line is missing, use the skill's default slug. |
| A role value `<model> <effort>`, such as `anthropic/claude-opus-5-5 high` | `model: "anthropic/claude-opus-5-5"` and `thinking: "high"`, or the whole value as `model`. |

## setup-pstack

Follow the **setup-pstack** skill with these changes:

- Detect. Run `pi --list-models` with `bash`. Each row is a provider and a model id. Write a real model as `<provider>/<id> <effort>`, such as `anthropic/claude-opus-5-5 xhigh`. The effort is the last token, so the budget step works as written. Effort tokens are pi thinking levels, and no role runs above `xhigh`.
- Defaults. Map each default slug with the rows above: `claude-opus-5-5-xhigh-fast` is `anthropic/claude-opus-5-5 xhigh`, `claude-opus-5-5-high-fast` is `anthropic/claude-opus-5-5 high`, and `claude-fable-5-2-high` is `anthropic/claude-fable-5-2 high`, each only when the detect step found it. `gemini-4-neon-xhigh` is the detected Gemini 4 Neon model at `xhigh`, or `inherit-parent` when there is none. Use the provider the detect step lists for each model.
- Write. Write `~/.pi/agent/pstack-models.md` with no frontmatter, then the comment lines, the `# budget` line, and one line per role from step 5. Overwrite the whole file. Never put the role lines in `AGENTS.md`.

## Paths

| Cursor | pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/` or `.agents/skills/`, and `~/.pi/agent/skills/` or `~/.agents/skills/`. Run `/reload` after writing a skill. |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `<pstack>` and `<pstack>/package.json`. pi installs git packages under `~/.pi/agent/git/` and npm packages under its npm directory. `pi list` names them. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` at the repository root, or `~/.pi/agent/AGENTS.md` for every project. pi never reads `.mdc` files. The model rule is the exception. See Models. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `~/.pi/agent/sessions/--<slug>--/<timestamp>_<id>.jsonl`. The slug is the workspace path without its leading `/`, with each `/` changed to `-`, so `/Users/you/proj` is `--Users-you-proj--`. The pstack system prompt section names the current session file and this workspace's folder. Each line is one JSON entry. Chat messages are entries with `"type":"message"`, whose `message.role` is `user`, `assistant`, or `toolResult`. Read only this workspace's folder. Subagent sessions live in `~/.pi/agent/pstack/subagent-sessions/`. |

## Cursor-only features

pi has no Cursor Automations, Bugbot, Cursor cloud agents, or built-in PR tool. When a step needs one, put one line in your reply, `Skipped in pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | pi |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command that the step gives. Skip a step that starts, waits for, or configures Bugbot when the PR has no Bugbot check or comment. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagent fields. Skip a step that needs the cloud agent itself, such as its dashboard status or its own machine. |
| A built-in PR tool | Use the forge command that the step gives, such as `gh pr create`. That is not a skip, so write no line. |
| Custom modes (option+enter keeps a skill on across turns) | `/pstack-mode <skill>` keeps that skill in the system prompt every turn. `/pstack-mode off` ends it. |
| `/deslop`, `control-ui`, `control-cli` from `cursor-team-kit` | Not part of pstack. Use them when they are installed as pi skills. Otherwise skip with the line. |
