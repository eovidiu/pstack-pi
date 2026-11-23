/**
 * `Task` and `TaskOutput`: Cursor-compatible subagents for pi.
 *
 * Each Task call runs one worker as a separate pi process (see runner.ts). Field names match
 * Cursor's Task tool so pstack skills need no translation: subagent_type, model, readonly,
 * run_in_background, resume, environment, cloud_base_branch, file_attachments.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentDef, discoverAgents, findAgent, READONLY_TOOLS } from "./agents.ts";
import { resolveModel } from "./models.ts";
import { ADAPTER_PATH, PSTACK_ROOT, pstackStateDir, skillPath, worktreeDir } from "./paths.ts";
import { newResult, type RunResult, type RunSpec, runWorker, type Usage } from "./runner.ts";

export const DEPTH = Number(process.env.PSTACK_TASK_DEPTH ?? 0) || 0;
export const MAX_DEPTH = Number(process.env.PSTACK_MAX_DEPTH ?? 2) || 2;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.PSTACK_MAX_CONCURRENCY ?? 4) || 4);
const PER_RESULT_BYTES = 40 * 1024;

interface TaskDetails {
	results: RunResult[];
}

interface BackgroundEntry {
	result: RunResult;
	promise: Promise<RunResult>;
	controller: AbortController;
	/** TaskOutput returned the final result, so no message is needed. */
	collected: boolean;
	/** A TaskOutput call is blocked on this entry right now. */
	awaited: number;
}

// ---------------------------------------------------------------- concurrency

let active = 0;
const queue: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= MAX_CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		queue.shift()?.();
	}
}

// ---------------------------------------------------------------- agent index (for resume)

interface IndexEntry {
	cwd: string;
	agent: string;
	description: string;
	at: number;
}
const indexPath = () => path.join(pstackStateDir(), "agents.json");
function readIndex(): Record<string, IndexEntry> {
	try {
		return JSON.parse(fs.readFileSync(indexPath(), "utf8"));
	} catch {
		return {};
	}
}
function recordAgent(id: string, entry: IndexEntry) {
	try {
		const index = readIndex();
		index[id] = entry;
		const kept = Object.entries(index)
			.sort((a, b) => b[1].at - a[1].at)
			.slice(0, 300);
		fs.mkdirSync(pstackStateDir(), { recursive: true });
		fs.writeFileSync(indexPath(), JSON.stringify(Object.fromEntries(kept), null, 1));
	} catch {
		// Resume across restarts is best-effort.
	}
}

// ---------------------------------------------------------------- formatting

function newAgentId(): string {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function duration(r: RunResult): string {
	const ms = (r.endedAt ?? Date.now()) - r.startedAt;
	return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function tokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function usageLine(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${tokens(u.input)}`);
	if (u.output) parts.push(`↓${tokens(u.output)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncate(text: string, maxBytes: number): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES) });
	if (!t.truncated) return text;
	return `${t.content}\n\n[Output truncated: ${t.outputBytes} of ${t.totalBytes} bytes. Resume the worker and ask for the rest if you need it.]`;
}

export function formatResult(r: RunResult, maxBytes = DEFAULT_MAX_BYTES): string {
	const head = [
		`agent_id: ${r.agentId} (pass as \`resume\` to continue this worker)`,
		`subagent_type: ${r.agent}`,
		`status: ${r.status}${r.stopReason && r.status !== "completed" ? ` (${r.stopReason})` : ""} after ${duration(r)}`,
	];
	if (r.model) head.push(`model: ${r.model}`);
	if (r.worktree) head.push(`worktree: ${r.worktree.path} (branch ${r.worktree.branch})`);
	for (const note of r.notes) head.push(`note: ${note}`);
	let body = r.output.trim();
	if (r.status === "failed" || r.status === "aborted") {
		const evidence = [r.errorMessage && `error: ${r.errorMessage}`, r.stderr.trim() && `stderr: ${r.stderr.trim().slice(-4000)}`]
			.filter(Boolean)
			.join("\n");
		body = [evidence, body].filter(Boolean).join("\n\n");
	}
	return `${head.join("\n")}\n\n${truncate(body || "(no output)", maxBytes)}`;
}

// ---------------------------------------------------------------- worker prompt

function workerSystemPrompt(agent: AgentDef, spec: { agentId: string; readonly: boolean; worktree?: { path: string; branch: string } }): string {
	const lines = [
		"# pstack worker",
		"",
		`A parent pi session started you with the pstack \`Task\` tool. Your agent id is \`${spec.agentId}\` and your subagent type is \`${agent.name}\`.`,
		`pstack is installed at \`${PSTACK_ROOT}\` (this is \`<pstack>\`). Its skills live at \`${PSTACK_ROOT}/skills/<name>/SKILL.md\`. The poteto-mode skill is \`${skillPath("poteto-mode")}\`. The pi adapter, which maps Cursor names in pstack to pi, is \`${ADAPTER_PATH}\`.`,
		"No one reads your intermediate messages and no user can answer questions. Your final message is your whole report to the parent, so make it complete and self-contained.",
	];
	if (spec.readonly) {
		lines.push(
			"",
			"You are read-only. Do not create, edit, move, or delete files. Run only commands that inspect state; never commit, push, install, or write anywhere.",
		);
	}
	if (spec.worktree) {
		lines.push(
			"",
			`You run in an isolated git worktree at \`${spec.worktree.path}\` on branch \`${spec.worktree.branch}\`. Uncommitted changes in the parent's checkout are not here. Commit your work on this branch; the parent merges it. Do not push unless your brief says so.`,
		);
	}
	if (agent.systemPrompt.trim()) lines.push("", agent.systemPrompt.trim());
	return lines.join("\n");
}

// ---------------------------------------------------------------- worktrees

async function createWorktree(pi: ExtensionAPI, cwd: string, id: string, base?: string) {
	const top = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 15_000 });
	if (top.code !== 0) throw new Error(`environment "cloud" runs the worker in a git worktree, but ${cwd} is not in a git repository.`);
	const root = top.stdout.trim();
	const rel = path.relative(root, cwd);
	const wt = path.join(worktreeDir(), `${path.basename(root)}-${id}`);
	const branch = `pstack/${id}`;
	fs.mkdirSync(worktreeDir(), { recursive: true });
	const add = await pi.exec("git", ["worktree", "add", "-b", branch, wt, base || "HEAD"], { cwd: root, timeout: 120_000 });
	if (add.code !== 0) throw new Error(`git worktree add failed: ${(add.stderr || add.stdout).trim()}`);
	return { path: wt, branch, cwd: rel && !rel.startsWith("..") ? path.join(wt, rel) : wt };
}

// ---------------------------------------------------------------- rendering

function icon(r: RunResult, theme: any): string {
	if (r.status === "pending" || r.status === "running") return theme.fg("warning", "⏳");
	if (r.status === "completed") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function renderRun(r: RunResult, expanded: boolean, theme: any): Container {
	const box = new Container();
	let header = `${icon(r, theme)} ${theme.fg("toolTitle", theme.bold(r.agent))} ${theme.fg("dim", r.description)}`;
	header += theme.fg("muted", ` · ${r.agentId}`);
	if (r.background) header += theme.fg("muted", " · bg");
	if (r.status !== "completed") header += ` ${theme.fg(r.status === "running" || r.status === "pending" ? "warning" : "error", `[${r.status}]`)}`;
	box.addChild(new Text(header, 0, 0));
	if (r.worktree) box.addChild(new Text(theme.fg("muted", `worktree ${r.worktree.path} (${r.worktree.branch})`), 0, 0));
	for (const note of r.notes) box.addChild(new Text(theme.fg("muted", `note: ${note}`), 0, 0));
	if (r.errorMessage && r.status !== "completed") box.addChild(new Text(theme.fg("error", r.errorMessage), 0, 0));
	const trace = expanded ? r.trace : r.trace.slice(-6);
	if (!expanded && r.trace.length > trace.length) box.addChild(new Text(theme.fg("muted", `... ${r.trace.length - trace.length} earlier`), 0, 0));
	for (const item of trace) {
		box.addChild(new Text(item.kind === "tool" ? theme.fg("muted", "→ ") + theme.fg("toolOutput", item.text) : theme.fg("dim", item.text), 0, 0));
	}
	if (expanded && r.output.trim()) {
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(r.output.trim(), 0, 0, getMarkdownTheme()));
	}
	const usage = usageLine(r.usage, r.model);
	box.addChild(new Text(theme.fg("dim", `${usage}${usage ? " · " : ""}${duration(r)}`), 0, 0));
	return box;
}

function renderDetails(details: TaskDetails | undefined, fallback: string, expanded: boolean, theme: any) {
	if (!details?.results?.length) return new Text(fallback, 0, 0);
	const box = new Container();
	details.results.forEach((r, i) => {
		if (i > 0) box.addChild(new Spacer(1));
		box.addChild(renderRun(r, expanded, theme));
	});
	if (!expanded) box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
	return box;
}

// ---------------------------------------------------------------- registration

const TaskParams = Type.Object({
	description: Type.String({ description: "Short (3-6 word) label for the task, shown to the user." }),
	prompt: Type.String({
		description: "The worker's complete, self-contained brief. With `resume`, the follow-up instruction.",
	}),
	subagent_type: Type.Optional(
		Type.String({
			description:
				'Worker type: "generalPurpose" (default), "explore" (read-only), "poteto-agent", "comment-sicko", or a user agent from ~/.pi/agent/agents.',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'pi model ("provider/id", "id", optional ":<thinking>" suffix), a Cursor slug such as "claude-opus-5-5-xhigh-fast", or "inherit-parent"/"auto". Omit to use the parent model.',
		}),
	),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
	readonly: Type.Optional(Type.Boolean({ description: "Restrict the worker to read, bash, grep, find, ls and forbid edits." })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Return an agent_id at once. The result arrives later as a pstack-task message; call TaskOutput to wait for it.",
		}),
	),
	resume: Type.Optional(Type.String({ description: "agent_id of an earlier worker to continue with this prompt." })),
	environment: Type.Optional(
		StringEnum(["local", "cloud"] as const, {
			description: '"cloud" runs the worker in a fresh git worktree on its own branch. "local" (default) uses this checkout.',
		}),
	),
	cloud_base_branch: Type.Optional(Type.String({ description: 'With environment "cloud": the ref the worktree starts from.' })),
	file_attachments: Type.Optional(Type.Array(Type.String(), { description: "Paths the worker should read." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Defaults to the session's." })),
});

const TaskOutputParams = Type.Object({
	task_ids: Type.Optional(Type.Array(Type.String(), { description: "agent_ids to collect. Omit for every uncollected background task." })),
	block: Type.Optional(Type.Boolean({ description: "Wait for the tasks to finish (default true)." })),
	timeout_seconds: Type.Optional(Type.Number({ description: "Longest wait when blocking (default 900)." })),
});

export function registerTaskTools(pi: ExtensionAPI) {
	const background = new Map<string, BackgroundEntry>();
	let uiCtx: ExtensionContext | undefined;
	let lastStatus: string | undefined;

	const updateStatus = () => {
		const running = [...background.values()].filter((e) => e.result.status === "running" || e.result.status === "pending").length;
		const status = running ? `⏳ ${running} pstack task${running > 1 ? "s" : ""}` : undefined;
		if (status === lastStatus) return;
		lastStatus = status;
		try {
			uiCtx?.ui.setStatus("pstack-tasks", status);
		} catch {
			uiCtx = undefined;
		}
	};

	pi.on("session_start", (_e, ctx) => {
		uiCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		for (const entry of background.values()) entry.controller.abort();
		background.clear();
		uiCtx = undefined;
	});

	pi.registerMessageRenderer("pstack-task", (message: any, options: any, theme: any) => {
		const r = message.details as RunResult | undefined;
		if (!r) return new Text(String(message.content ?? ""), 0, 0);
		const box = new Container();
		box.addChild(new Text(theme.fg("accent", "background task finished"), 0, 0));
		box.addChild(renderRun(r, Boolean(options?.expanded), theme));
		return box;
	});

	pi.registerTool({
		name: "Task",
		label: "Task",
		description: [
			"Start a worker: a separate pi agent with its own context window that runs a self-contained brief and returns its final report.",
			"Several Task calls in one message run in parallel.",
			"Fields match Cursor's Task tool (subagent_type, model, readonly, run_in_background, resume, environment, cloud_base_branch, file_attachments).",
			`Workers cannot see this conversation: the prompt must stand alone. Workers can nest ${MAX_DEPTH} level(s) deep.`,
		].join(" "),
		promptSnippet: "Delegate a self-contained task to an isolated worker agent (pstack's Task tool)",
		promptGuidelines: [
			"Use Task when a pstack skill says to spawn a subagent or Task; pass its fields (subagent_type, model, readonly, run_in_background, environment) as written.",
		],
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			const agents = discoverAgents();
			const index = params.resume ? readIndex()[params.resume] : undefined;
			const agent = findAgent(agents, params.subagent_type ?? index?.agent);
			if (!agent) {
				throw new Error(
					`Unknown subagent_type "${params.subagent_type}". Available: ${agents.map((a) => a.name).join(", ")}.`,
				);
			}

			// Model: explicit field, else a user agent's pinned model, else the parent's.
			const available = ((await Promise.resolve(ctx.modelRegistry.getAvailable())) ?? []) as Array<{ provider: string; id: string }>;
			const choice = resolveModel(params.model ?? agent.model, params.thinking, available);
			if (choice.kind === "rejected") throw new Error(choice.error);
			const notes: string[] = [];
			if (choice.note) notes.push(choice.note);
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const model = choice.kind === "model" ? choice.model : parentModel;
			const thinking = choice.thinking ?? (choice.kind === "inherit" ? ctx.thinkingLevel : undefined);

			const readonly = Boolean(params.readonly ?? agent.readonly);
			const tools = readonly ? READONLY_TOOLS : agent.tools;
			const agentId = params.resume ?? newAgentId();
			let cwd = path.resolve(ctx.cwd, params.cwd ?? index?.cwd ?? ".");
			let worktree: { path: string; branch: string } | undefined;
			if (params.environment === "cloud") {
				if (params.resume && index) {
					notes.push("resumed in the worker's existing directory; no new worktree");
				} else {
					const wt = await createWorktree(pi, cwd, agentId, params.cloud_base_branch);
					worktree = { path: wt.path, branch: wt.branch };
					cwd = wt.cwd;
				}
			} else if (params.cloud_base_branch) {
				notes.push(`cloud_base_branch ignored: it applies only with environment "cloud"`);
			}

			let prompt = params.prompt;
			if (params.file_attachments?.length) {
				prompt += `\n\nAttached files (read them yourself):\n${params.file_attachments.map((f) => `- ${path.resolve(ctx.cwd, f)}`).join("\n")}`;
			}

			const interactive = ctx.mode === "tui" || ctx.mode === "rpc";
			let runInBackground = Boolean(params.run_in_background);
			if (runInBackground && !interactive) {
				runInBackground = false;
				notes.push(`ran in the foreground: background tasks need an interactive session (mode ${ctx.mode})`);
			}

			const spec: RunSpec = {
				agentId,
				agent: agent.name,
				description: params.description,
				prompt,
				cwd,
				model,
				thinking,
				tools,
				systemPrompt: workerSystemPrompt(agent, { agentId, readonly, worktree }),
				depth: DEPTH,
				readonly,
				background: runInBackground,
				notes,
				worktree,
			};
			recordAgent(agentId, { cwd, agent: agent.name, description: params.description, at: Date.now() });
			const result = newResult(spec);

			if (runInBackground) {
				if (background.get(agentId)?.result.status === "running") {
					throw new Error(`Worker ${agentId} is still running. Wait for it with TaskOutput before resuming it.`);
				}
				const controller = new AbortController();
				const entry: BackgroundEntry = {
					result,
					controller,
					collected: false,
					awaited: 0,
					promise: Promise.resolve(result),
				};
				entry.promise = withSlot(() => runWorker(spec, result, controller.signal, updateStatus)).then((final) => {
					updateStatus();
					if (!entry.collected && entry.awaited === 0 && !controller.signal.aborted) {
						entry.collected = true;
						try {
							pi.sendMessage(
								{
									customType: "pstack-task",
									content: `Background task finished.\n\n${formatResult(final)}`,
									display: true,
									details: final,
								},
								{ deliverAs: "steer", triggerTurn: true },
							);
						} catch {
							// The session that started the task is gone.
						}
					}
					return final;
				});
				background.set(agentId, entry);
				updateStatus();
				return {
					content: [
						{
							type: "text",
							text:
								`Started background task. agent_id: ${agentId} (${agent.name}: ${params.description}).` +
								`${notes.length ? `\n${notes.map((n) => `note: ${n}`).join("\n")}` : ""}` +
								`\nIts result arrives as a pstack-task message when it finishes. Call TaskOutput with task_ids ["${agentId}"] to wait for it.`,
						},
					],
					details: { results: [result] } as TaskDetails,
				};
			}

			const final = await withSlot(() =>
				runWorker(spec, result, signal, (r) => {
					onUpdate?.({ content: [{ type: "text", text: r.output || "(running...)" }], details: { results: [{ ...r }] } as TaskDetails });
				}),
			);
			return {
				content: [{ type: "text", text: formatResult(final) }],
				details: { results: [final] } as TaskDetails,
				isError: final.status !== "completed",
			};
		},

		renderCall(args: any, theme: any) {
			const flags = [
				args.readonly && "readonly",
				args.run_in_background && "bg",
				args.environment === "cloud" && "worktree",
				args.resume && `resume ${args.resume}`,
				args.model,
			].filter(Boolean);
			let text = theme.fg("toolTitle", theme.bold("Task ")) + theme.fg("accent", args.subagent_type ?? "generalPurpose");
			if (args.description) text += ` ${theme.fg("dim", args.description)}`;
			if (flags.length) text += theme.fg("muted", ` [${flags.join(", ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const fallback = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			return renderDetails(result.details as TaskDetails | undefined, fallback, expanded, theme);
		},
	});

	pi.registerTool({
		name: "TaskOutput",
		label: "TaskOutput",
		description:
			"Collect results of background Task workers by agent_id. Blocks until they finish (or timeout) unless block is false. Omit task_ids to collect every uncollected background task.",
		promptSnippet: "Wait for and collect results of background Task workers",
		parameters: TaskOutputParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			const ids = params.task_ids?.length ? params.task_ids : [...background.entries()].filter(([, e]) => !e.collected).map(([id]) => id);
			if (ids.length === 0) {
				return { content: [{ type: "text", text: "No uncollected background tasks." }], details: { results: [] } as TaskDetails };
			}
			const unknown = ids.filter((id) => !background.has(id));
			const entries = ids.map((id) => background.get(id)).filter((e): e is BackgroundEntry => Boolean(e));

			if (params.block ?? true) {
				const timeoutMs = Math.max(1, params.timeout_seconds ?? 900) * 1000;
				for (const e of entries) e.awaited++;
				const tick = setInterval(() => {
					onUpdate?.({
						content: [{ type: "text", text: "waiting..." }],
						details: { results: entries.map((e) => ({ ...e.result })) } as TaskDetails,
					});
				}, 1000);
				try {
					await Promise.race([
						Promise.all(entries.map((e) => e.promise)),
						new Promise((resolve) => setTimeout(resolve, timeoutMs)),
						new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
					]);
				} finally {
					clearInterval(tick);
					for (const e of entries) e.awaited--;
				}
			}

			const parts: string[] = [];
			for (const e of entries) {
				const done = e.result.status !== "running" && e.result.status !== "pending";
				if (done) {
					e.collected = true;
					parts.push(formatResult(e.result, Math.floor(PER_RESULT_BYTES)));
				} else {
					parts.push(`agent_id: ${e.result.agentId}\nstatus: ${e.result.status} for ${duration(e.result)} (not finished)`);
				}
			}
			for (const id of unknown) parts.push(`agent_id: ${id}\nstatus: unknown (not a background task of this session)`);
			updateStatus();
			return {
				content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
				details: { results: entries.map((e) => ({ ...e.result })) } as TaskDetails,
			};
		},

		renderCall(args: any, theme: any) {
			const ids = args.task_ids?.length ? args.task_ids.join(", ") : "all";
			return new Text(theme.fg("toolTitle", theme.bold("TaskOutput ")) + theme.fg("accent", ids), 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const fallback = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			return renderDetails(result.details as TaskDetails | undefined, fallback, expanded, theme);
		},
	});

	pi.registerCommand("pstack-tasks", {
		description: "List pstack background tasks in this session",
		handler: async (_args, ctx) => {
			if (background.size === 0) {
				ctx.ui.notify("No pstack background tasks in this session.", "info");
				return;
			}
			const lines = [...background.values()].map(
				(e) => `${e.result.status.padEnd(9)} ${e.result.agentId}  ${e.result.agent}: ${e.result.description} (${duration(e.result)})`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
