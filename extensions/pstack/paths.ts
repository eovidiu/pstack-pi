import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The package root: the folder that holds `skills/`, `agents/`, and `docs/`. */
export const PSTACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SKILLS_DIR = path.join(PSTACK_ROOT, "skills");
export const AGENTS_DIR = path.join(PSTACK_ROOT, "agents");
export const ADAPTER_PATH = path.join(PSTACK_ROOT, "docs", "harness", "pi.md");

export const pstackStateDir = () => path.join(getAgentDir(), "pstack");
export const modelsRulePath = () => path.join(getAgentDir(), "pstack-models.md");
export const subagentSessionDir = () => path.join(pstackStateDir(), "subagent-sessions");
export const worktreeDir = () => path.join(pstackStateDir(), "worktrees");

export function skillNames(): string[] {
	if (!fs.existsSync(SKILLS_DIR)) return [];
	return fs
		.readdirSync(SKILLS_DIR)
		.filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, "SKILL.md")))
		.sort();
}

export function skillPath(name: string): string {
	return path.join(SKILLS_DIR, name, "SKILL.md");
}

/** Frontmatter `description`, for command lists. */
export function skillDescription(name: string): string | undefined {
	try {
		const text = fs.readFileSync(skillPath(name), "utf8");
		const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
		const raw = frontmatter.match(/^description:\s*(.*)$/m)?.[1]?.trim();
		return raw?.replace(/^(["'])(.*)\1$/, "$2");
	} catch {
		return undefined;
	}
}

export function stripFrontmatter(text: string): string {
	return text.replace(/^---\n[\s\S]*?\n---\n*/, "");
}
