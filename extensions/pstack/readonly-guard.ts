/**
 * Guardrail for `readonly: true` workers, which keep `bash` so they can inspect git history,
 * run tests, and so on. Blocks shell commands that clearly change files or repository state.
 * This is a seatbelt against a worker drifting from its brief, not a sandbox.
 */

const WRITE_PATTERNS: RegExp[] = [
	/(^|[^<>&0-9=\-])>{1,2}\s*(?!\/dev\/(null|stdout|stderr)\b)(?!&)\S/, // redirect into a file
	/\btee\b/,
	/(^|[;&|(\s])(rm|rmdir|mv|cp|touch|mkdir|ln|chmod|chown|chgrp|truncate|dd|shred|install|unlink|rsync|patch)\s/,
	/\bsed\s+(-[a-zA-Z]*i|--in-place)/,
	/\bperl\s+-[a-zA-Z]*i/,
	/\bgit\s+(-C\s+\S+\s+)?(add|commit|push|pull|reset|checkout|switch|restore|rebase|merge|stash|apply|am|cherry-pick|revert|tag|clean|rm|mv|worktree\s+(add|remove|prune)|branch\s+-[dDmM]|gc|prune|fetch|submodule\s+update|init|clone|config\s+(?!--get|-l|--list))/,
	/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade|link|publish|ci)\b/,
	/\bpip3?\s+install\b/,
	/\bcargo\s+(install|add|remove|publish)\b/,
	/\bgo\s+(get|install|mod\s+tidy)\b/,
	/\b(apt|apt-get|brew|pacman|dnf|yum)\s+/,
	/\bgh\s+(pr\s+(create|merge|close|edit|comment|review)|issue\s+(create|close|edit|comment)|release\s+create|repo\s+(create|delete))/,
	/\bsudo\b/,
];

export function readonlyViolation(command: string): string | undefined {
	for (const re of WRITE_PATTERNS) {
		const m = command.match(re);
		if (m) return m[0].trim();
	}
	return undefined;
}
