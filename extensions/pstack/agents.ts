import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR } from "./paths.ts";

export interface AgentDef {
	name: string;
	description: string;
	/** Appended to the worker's system prompt. */
	systemPrompt: string;
	/** Explicit tool list; undefined keeps pi's defaults. */
	tools?: string[];
	readonly: boolean;
	/** Model pinned by a user agent file. pstack agents never pin one. */
	model?: string;
	source: "builtin" | "pstack" | "user";
	filePath?: string;
}

export const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

const BUILTIN: AgentDef[] = [
	{
		name: "generalPurpose",
		description: "General-purpose worker with the session's default tools.",
		systemPrompt: "",
		readonly: false,
		source: "builtin",
	},
	{
		name: "explore",
		description: "Read-only explorer: reads, searches, and runs read-only commands. Never edits files.",
		systemPrompt: "",
		readonly: true,
		source: "builtin",
	},
];

const ALIASES: Record<string, string> = {
	"general-purpose": "generalPurpose",
	generalpurpose: "generalPurpose",
	general: "generalPurpose",
	explore: "explore",
	explorer: "explore",
	"pstack:poteto-agent": "poteto-agent",
	"pstack:comment-sicko": "comment-sicko",
};

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return { fields, body: match[2] };
}

function loadDir(dir: string, source: "pstack" | "user"): AgentDef[] {
	if (!fs.existsSync(dir)) return [];
	const out: AgentDef[] = [];
	for (const entry of fs.readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(dir, entry);
		try {
			const { fields, body } = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
			if (!fields.name) continue;
			const tools = fields.tools
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			out.push({
				name: fields.name,
				description: fields.description ?? "",
				systemPrompt: body.trim(),
				tools: tools?.length ? tools : undefined,
				readonly: fields.readonly === "true",
				model: source === "user" ? fields.model : undefined,
				source,
				filePath,
			});
		} catch {
			// Unreadable agent file: skip it, the error surfaces as "unknown agent".
		}
	}
	return out;
}

export function discoverAgents(): AgentDef[] {
	const byName = new Map<string, AgentDef>();
	for (const agent of [...BUILTIN, ...loadDir(AGENTS_DIR, "pstack"), ...loadDir(path.join(getAgentDir(), "agents"), "user")]) {
		// First definition wins: built-ins and pstack agents cannot be shadowed by user files.
		if (!byName.has(agent.name)) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}

export function findAgent(agents: AgentDef[], requested: string | undefined): AgentDef | undefined {
	const raw = (requested ?? "generalPurpose").trim();
	const name = ALIASES[raw] ?? ALIASES[raw.toLowerCase()] ?? raw;
	return agents.find((a) => a.name === name) ?? agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
}
