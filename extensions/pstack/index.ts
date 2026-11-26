/**
 * pstack for pi.
 *
 * - Tools named after Cursor's: Task, TaskOutput, AskQuestion, TodoWrite.
 * - A short system prompt section that says where pstack lives, where the adapter is,
 *   and where this workspace's transcripts are, plus ~/.pi/agent/pstack-models.md when present.
 * - `/<skill>` aliases for `/skill:<skill>`, so `/poteto-mode ...` works as in Cursor.
 * - `/pstack-mode <skill>` keeps a skill in the system prompt every turn (Cursor's custom modes).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "./ask-tool.ts";
import { readonlyViolation } from "./readonly-guard.ts";
import { ADAPTER_PATH, modelsRulePath, PSTACK_ROOT, SKILLS_DIR, skillDescription, skillNames, skillPath, stripFrontmatter } from "./paths.ts";
import { DEPTH, MAX_DEPTH, registerTaskTools } from "./task-tool.ts";
import { registerTodoTool } from "./todo-tool.ts";

const MODE_ENTRY = "pstack-mode";
const RESERVED = new Set(["pstack", "pstack-mode", "pstack-tasks"]);

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function upstreamVersion(): string {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(PSTACK_ROOT, "upstream.json"), "utf8"));
		return `${meta.version} (${String(meta.commit).slice(0, 12)})`;
	} catch {
		return "unknown";
	}
}

export default function pstack(pi: ExtensionAPI) {
	const skills = skillNames();
	if (skills.length === 0) {
		pi.on("session_start", (_e, ctx) => ctx.ui.notify(`pstack: no skills found under ${SKILLS_DIR}`, "warning"));
		return;
	}

	if (process.env.PSTACK_READONLY === "1") {
		pi.on("tool_call", (event) => {
			if (event.toolName === "write" || event.toolName === "edit") {
				return { block: true, reason: "This worker is read-only (Task readonly: true). Report the change instead of making it." };
			}
			if (event.toolName !== "bash") return;
			const hit = readonlyViolation(String((event.input as { command?: unknown }).command ?? ""));
			if (hit) {
				return {
					block: true,
					reason: `This worker is read-only (Task readonly: true), so \`${hit}\` is blocked. Inspect only, and report what should change.`,
				};
			}
		});
	}

	registerTodoTool(pi);
	registerAskTool(pi);
	if (DEPTH < MAX_DEPTH) registerTaskTools(pi);

	// ------------------------------------------------------------ sticky mode

	let mode: string | undefined;
	const restoreMode = (ctx: ExtensionContext) => {
		mode = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const e: any = entry;
			if (e.type === "custom" && e.customType === MODE_ENTRY) mode = e.data?.skill ?? undefined;
		}
		if (mode && !skills.includes(mode)) mode = undefined;
		ctx.ui.setStatus("pstack-mode", mode ? `◆ ${mode}` : undefined);
	};
	pi.on("session_start", (_e, ctx) => restoreMode(ctx));
	pi.on("session_tree", (_e, ctx) => restoreMode(ctx));

	// ------------------------------------------------------------ system prompt

	pi.on("before_agent_start", (event, ctx) => {
		// pi exposes named prompt sections; omp passes `systemPrompt` (string[]) and takes a replacement back.
		const piSections = event.systemPromptOptions?.sections;
		const sections: Record<string, string> = piSections ?? {};
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir();
		const lines = [
			`pstack (poteto's agent workflows from cursor/plugins, ported to pi) is installed at \`${PSTACK_ROOT}\`. Its skills call this folder \`<pstack>\`.`,
			`- pstack skills live at \`${SKILLS_DIR}/<name>/SKILL.md\`. Most are hidden from the skill list. When the user or a pstack skill names one (\`/name\`, "the **name** skill"), read that file and follow it.`,
			`- Before following a pstack skill, read \`${ADAPTER_PATH}\` once per session. It maps the Cursor names in pstack (Task fields, model slugs, paths, Cursor-only features) to pi.`,
		];
		if (sessionFile) lines.push(`- This session's transcript is \`${sessionFile}\`. This workspace's transcripts are in \`${sessionDir}\`.`);
		if (DEPTH > 0) lines.push(`- You are a pstack worker at depth ${DEPTH}.${DEPTH >= MAX_DEPTH ? " You cannot start more workers." : ""}`);
		sections.pstack = lines.join("\n");

		const rule = readIfExists(modelsRulePath());
		if (rule?.trim()) {
			sections.pstack_models = `pstack per-role model choices from \`${modelsRulePath()}\` (written by /setup-pstack; they override skill defaults):\n\n${rule.trim()}`;
		} else {
			delete sections.pstack_models;
		}

		const modeText = mode ? readIfExists(skillPath(mode)) : undefined;
		if (mode && modeText) {
			sections.pstack_mode = `The user turned on the \`${mode}\` skill as a mode with /pstack-mode. Apply it on every turn until they turn it off. Its file is \`${skillPath(mode)}\`; resolve its relative paths from that folder.\n\n${stripFrontmatter(modeText).trim()}`;
		} else {
			delete sections.pstack_mode;
		}

		if (piSections || !("systemPrompt" in event)) return;
		const base = event.systemPrompt;
		const extra = Object.values(sections);
		if (Array.isArray(base)) return { systemPrompt: [...base, ...extra] };
		return { systemPrompt: [typeof base === "string" ? base : "", ...extra].filter(Boolean).join("\n\n") };
	});

	// ------------------------------------------------------------ commands

	const runSkill = (name: string, args: string, ctx: ExtensionContext) => {
		const text = `/skill:${name}${args.trim() ? ` ${args.trim()}` : ""}`;
		if (ctx.isIdle()) pi.sendUserMessage(text, { expandPromptTemplates: true });
		else pi.sendUserMessage(text, { expandPromptTemplates: true, deliverAs: "followUp" });
	};

	if (process.env.PSTACK_NO_ALIASES !== "1") {
		for (const name of skills) {
			// Principles are read by other skills, not typed by people.
			if (name.startsWith("principle-") || RESERVED.has(name)) continue;
			const description = skillDescription(name);
			pi.registerCommand(name, {
				description: `pstack: ${description ? description.slice(0, 120) : name}`,
				handler: async (args, ctx) => runSkill(name, args, ctx),
			});
		}
	}

	pi.registerCommand("pstack-mode", {
		description: "Keep a pstack skill on every turn (like Cursor custom modes): /pstack-mode poteto-mode, /pstack-mode off",
		getArgumentCompletions: (prefix: string) => {
			const items = ["off", ...skills.filter((s) => !s.startsWith("principle-"))]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(mode ? `pstack mode: ${mode}` : "pstack mode is off. Usage: /pstack-mode <skill> | off", "info");
				return;
			}
			if (arg === "off") {
				mode = undefined;
			} else if (skills.includes(arg)) {
				mode = arg;
			} else {
				ctx.ui.notify(`Unknown pstack skill: ${arg}`, "error");
				return;
			}
			pi.appendEntry(MODE_ENTRY, { skill: mode ?? null });
			ctx.ui.setStatus("pstack-mode", mode ? `◆ ${mode}` : undefined);
			ctx.ui.notify(mode ? `pstack mode on: ${mode}` : "pstack mode off", "info");
		},
	});

	pi.registerCommand("pstack", {
		description: "Show pstack install, version, model rule, and mode",
		handler: async (_args, ctx) => {
			const rule = readIfExists(modelsRulePath());
			ctx.ui.notify(
				[
					`pstack ${upstreamVersion()} at ${PSTACK_ROOT}`,
					`${skills.length} skills · adapter ${ADAPTER_PATH}`,
					`models rule: ${rule ? modelsRulePath() : "none (run /setup-pstack)"}`,
					`mode: ${mode ?? "off"} · Task depth ${DEPTH}/${MAX_DEPTH}`,
				].join("\n"),
				"info",
			);
		},
	});
}
