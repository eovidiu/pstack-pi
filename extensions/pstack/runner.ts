/**
 * Runs one worker as a separate `pi --mode json -p` process with its own saved session,
 * so a later `resume` can continue it. Adapted from pi's examples/extensions/subagent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { subagentSessionDir } from "./paths.ts";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface TraceItem {
	kind: "tool" | "text";
	text: string;
}

export interface RunResult {
	agentId: string;
	agent: string;
	description: string;
	status: TaskStatus;
	output: string;
	trace: TraceItem[];
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
	exitCode: number | null;
	cwd: string;
	worktree?: { path: string; branch: string };
	notes: string[];
	background: boolean;
	startedAt: number;
	endedAt?: number;
}

export interface RunSpec {
	agentId: string;
	agent: string;
	description: string;
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt: string;
	depth: number;
	readonly: boolean;
	background: boolean;
	notes: string[];
	worktree?: { path: string; branch: string };
}

const MAX_TRACE = 40;
const MAX_STDERR = 16 * 1024;

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

export function newResult(spec: RunSpec, status: TaskStatus = "pending"): RunResult {
	return {
		agentId: spec.agentId,
		agent: spec.agent,
		description: spec.description,
		status,
		output: "",
		trace: [],
		usage: emptyUsage(),
		model: spec.model,
		stderr: "",
		exitCode: null,
		cwd: spec.cwd,
		worktree: spec.worktree,
		notes: [...spec.notes],
		background: spec.background,
		startedAt: Date.now(),
	};
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const bunVirtual = script !== undefined && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
	if (script && !bunVirtual && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function preview(name: string, args: Record<string, unknown>): string {
	const home = os.homedir();
	const short = (p: unknown) => {
		const s = String(p ?? "");
		return s.startsWith(home) ? `~${s.slice(home.length)}` : s;
	};
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "");
			return `$ ${cmd.length > 80 ? `${cmd.slice(0, 80)}...` : cmd}`;
		}
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${name} ${short(args.path ?? args.file_path)}`;
		case "grep":
		case "find":
			return `${name} ${String(args.pattern ?? "")} in ${short(args.path ?? ".")}`;
		case "Task":
			return `Task ${String(args.subagent_type ?? "generalPurpose")}: ${String(args.description ?? "")}`;
		default: {
			const json = JSON.stringify(args);
			return `${name} ${json.length > 70 ? `${json.slice(0, 70)}...` : json}`;
		}
	}
}

export async function runWorker(
	spec: RunSpec,
	result: RunResult,
	signal: AbortSignal | undefined,
	onProgress: (result: RunResult) => void,
): Promise<RunResult> {
	result.status = "running";
	result.startedAt = Date.now();
	onProgress(result);

	const sessionDir = subagentSessionDir();
	fs.mkdirSync(sessionDir, { recursive: true });
	const args = ["--mode", "json", "-p", "--session-dir", sessionDir, "--session-id", spec.agentId];
	if (spec.model) args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.tools?.length) args.push("--tools", spec.tools.join(","));

	let tmpDir: string | undefined;
	try {
		if (spec.systemPrompt.trim()) {
			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pstack-task-"));
			const promptPath = path.join(tmpDir, "system.md");
			await fs.promises.writeFile(promptPath, spec.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		// A prompt that starts with "-" or "@" would parse as a flag or file include.
		args.push(`Task:\n${spec.prompt}`);

		if (signal?.aborted) {
			result.status = "aborted";
			result.errorMessage = "Aborted before start";
			return result;
		}

		let aborted = false;
		const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
			const inv = piInvocation(args);
			let buffer = "";
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const proc = spawn(inv.command, inv.args, {
				cwd: spec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PSTACK_TASK_DEPTH: String(spec.depth + 1),
					PSTACK_AGENT_ID: spec.agentId,
					PSTACK_READONLY: spec.readonly ? "1" : "0",
				},
			});

			const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				resolve(value);
			};
			const abort = () => {
				if (proc.exitCode !== null || proc.signalCode !== null) return;
				aborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
			};

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
				const msg = event.message;
				const u = msg.usage ?? {};
				result.usage.turns++;
				result.usage.input += u.input ?? 0;
				result.usage.output += u.output ?? 0;
				result.usage.cacheRead += u.cacheRead ?? 0;
				result.usage.cacheWrite += u.cacheWrite ?? 0;
				result.usage.cost += u.cost?.total ?? 0;
				result.usage.contextTokens = u.totalTokens ?? result.usage.contextTokens;
				if (msg.model) result.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
				result.stopReason = msg.stopReason;
				result.errorMessage = msg.errorMessage;
				let text = "";
				for (const part of msg.content ?? []) {
					if (part.type === "text" && part.text) text += part.text;
					else if (part.type === "toolCall") result.trace.push({ kind: "tool", text: preview(part.name, part.arguments ?? {}) });
				}
				if (text.trim()) {
					result.output = text;
					const firstLine = text.trim().split("\n")[0];
					result.trace.push({ kind: "text", text: firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine });
				}
				if (result.trace.length > MAX_TRACE) result.trace.splice(0, result.trace.length - MAX_TRACE);
				onProgress(result);
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});
			proc.stderr.on("data", (data) => {
				if (result.stderr.length < MAX_STDERR) result.stderr += data.toString();
			});
			proc.on("close", (code, sig) => {
				if (buffer.trim()) onLine(buffer);
				finish({ code, signal: sig });
			});
			proc.on("error", (error) => finish({ code: null, signal: null, error }));

			if (signal) {
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});

		result.exitCode = outcome.code;
		if (aborted) {
			result.status = "aborted";
			result.errorMessage ||= "Aborted";
		} else if (outcome.error) {
			result.status = "failed";
			result.errorMessage = `Failed to start pi: ${outcome.error.message}`;
		} else if (outcome.signal) {
			result.status = "failed";
			result.errorMessage ||= `Terminated by ${outcome.signal}`;
		} else if (outcome.code !== 0) {
			result.status = "failed";
			result.errorMessage ||= `pi exited with code ${outcome.code}`;
		} else if (result.stopReason === "aborted") {
			result.status = "aborted";
		} else if (result.stopReason === "error") {
			result.status = "failed";
		} else {
			result.status = "completed";
		}
		return result;
	} finally {
		result.endedAt = Date.now();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		onProgress(result);
	}
}
