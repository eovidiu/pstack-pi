/**
 * Resolves a model value from a pstack skill or rule into a pi model and thinking level.
 *
 * Accepted forms:
 *   - omitted, "auto", "inherit-parent"            -> parent model and thinking level
 *   - "provider/id", "id"                           -> that model
 *   - any of the above with ":<level>" or " <level>" -> with that thinking level
 *   - a Cursor slug, "claude-opus-5-5-xhigh-fast"   -> "claude-opus-5-5" at "xhigh" ("-fast" dropped)
 *
 * Anything else is rejected, with the available models in the message, so the caller
 * can follow the skill's own fallback instead of silently running on another model.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const isLevel = (value: string | undefined): value is ThinkingLevel =>
	value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value);

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

export type ModelChoice =
	| { kind: "inherit"; thinking?: ThinkingLevel; note?: string }
	| { kind: "model"; model: string; thinking?: ThinkingLevel; note?: string }
	| { kind: "rejected"; error: string };

const INHERIT = new Set(["", "auto", "inherit", "inherit-parent", "parent", "default"]);

function findModel(available: ModelLike[], spec: string): ModelLike | undefined {
	const lower = spec.toLowerCase();
	if (lower.includes("/")) {
		const [provider, ...rest] = lower.split("/");
		const id = rest.join("/");
		return available.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
	}
	const matches = available.filter((m) => m.id.toLowerCase() === lower);
	return matches[0];
}

export function resolveModel(
	rawModel: string | undefined,
	rawThinking: string | undefined,
	available: ModelLike[],
): ModelChoice {
	let spec = (rawModel ?? "").trim();
	let thinking: ThinkingLevel | undefined;

	const explicit = rawThinking?.trim().toLowerCase();
	if (explicit) {
		if (!isLevel(explicit)) {
			return { kind: "rejected", error: `Unknown thinking level "${rawThinking}". Use one of: ${THINKING_LEVELS.join(", ")}.` };
		}
		thinking = explicit;
	}

	// "<model> <level>" (role-line form) or "<model>:<level>" (pi CLI form)
	const spaced = spec.match(/^(\S+)\s+(\S+)$/);
	if (spaced && isLevel(spaced[2].toLowerCase())) {
		spec = spaced[1];
		thinking ??= spaced[2].toLowerCase() as ThinkingLevel;
	}
	const colon = spec.match(/^(.*):([a-z]+)$/i);
	if (colon && isLevel(colon[2].toLowerCase())) {
		spec = colon[1];
		thinking ??= colon[2].toLowerCase() as ThinkingLevel;
	}

	if (INHERIT.has(spec.toLowerCase())) return { kind: "inherit", thinking };

	const direct = findModel(available, spec);
	if (direct) return { kind: "model", model: `${direct.provider}/${direct.id}`, thinking };

	// Cursor slug: <family...>-<effort>[-fast]
	const prefix = spec.includes("/") ? `${spec.split("/")[0]}/` : "";
	const tokens = (prefix ? spec.slice(prefix.length) : spec).split("-");
	let dropped = false;
	if (tokens.at(-1)?.toLowerCase() === "fast") {
		tokens.pop();
		dropped = true;
	}
	let slugLevel: ThinkingLevel | undefined;
	if (isLevel(tokens.at(-1)?.toLowerCase())) slugLevel = tokens.pop()!.toLowerCase() as ThinkingLevel;
	if (dropped || slugLevel) {
		const base = `${prefix}${tokens.join("-")}`;
		const match = findModel(available, base);
		if (match) {
			const notes: string[] = [];
			if (dropped) notes.push(`"-fast" has no pi equivalent and was dropped`);
			return {
				kind: "model",
				model: `${match.provider}/${match.id}`,
				thinking: thinking ?? slugLevel,
				note: `Mapped Cursor slug "${rawModel}" to ${match.provider}/${match.id}${(thinking ?? slugLevel) ? `:${thinking ?? slugLevel}` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}.`,
			};
		}
	}

	const list = available
		.map((m) => `${m.provider}/${m.id}`)
		.sort()
		.slice(0, 60)
		.join(", ");
	return {
		kind: "rejected",
		error:
			`Model "${rawModel}" is not available in pi. Do not pass it again this session. ` +
			`Follow the skill's fallback, or omit \`model\` to run on the parent model. ` +
			`Available: ${list || "(none with credentials)"}.`,
	};
}
