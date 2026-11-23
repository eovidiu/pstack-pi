/**
 * `AskQuestion`: Cursor's multiple-choice question tool, built on ctx.ui.select/input so it
 * works in the TUI and over RPC. Without a UI it fails, and the adapter says to ask in text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER = "Other (type an answer)";
const DONE = "✓ Done";

const AskParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional heading for the whole set of questions" })),
	questions: Type.Array(
		Type.Object({
			id: Type.String(),
			prompt: Type.String({ description: "The question" }),
			options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() }), { minItems: 1 }),
			allow_multiple: Type.Optional(Type.Boolean()),
		}),
		{ minItems: 1 },
	),
});

interface Answer {
	id: string;
	prompt: string;
	selected: string[];
	other?: string;
	skipped?: boolean;
}

export function registerAskTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskQuestion",
		label: "AskQuestion",
		description:
			"Ask the user one or more multiple-choice questions and wait for the answers. Each question has an id, a prompt, options ({id, label}), and optional allow_multiple. The user can also type their own answer.",
		promptSnippet: "Ask the user multiple-choice questions",
		parameters: AskParams,
		executionMode: "sequential",

		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("No user is attached to this session. Ask in plain text, or make the reversible choice and say what you chose.");
			}
			const answers: Answer[] = [];
			for (const [i, q] of params.questions.entries()) {
				const head = [params.title, params.questions.length > 1 ? `(${i + 1}/${params.questions.length})` : undefined, q.prompt]
					.filter(Boolean)
					.join(" ");
				const answer: Answer = { id: q.id, prompt: q.prompt, selected: [] };
				if (q.allow_multiple) {
					const chosen = new Set<string>();
					while (true) {
						const labels = q.options.map((o) => `${chosen.has(o.id) ? "[x]" : "[ ]"} ${o.label}`);
						const pick = await ctx.ui.select(head, [...labels, OTHER, DONE], { signal });
						if (pick === undefined) {
							answer.skipped = chosen.size === 0;
							break;
						}
						if (pick === DONE) break;
						if (pick === OTHER) {
							answer.other = (await ctx.ui.input(q.prompt, "Your answer", { signal }))?.trim() || undefined;
							continue;
						}
						const option = q.options[labels.indexOf(pick)];
						if (option) chosen.has(option.id) ? chosen.delete(option.id) : chosen.add(option.id);
					}
					answer.selected = q.options.filter((o) => chosen.has(o.id)).map((o) => o.label);
				} else {
					const pick = await ctx.ui.select(head, [...q.options.map((o) => o.label), OTHER], { signal });
					if (pick === undefined) answer.skipped = true;
					else if (pick === OTHER) answer.other = (await ctx.ui.input(q.prompt, "Your answer", { signal }))?.trim() || undefined;
					else answer.selected = [pick];
				}
				answers.push(answer);
				if (signal?.aborted) break;
			}

			const text = answers
				.map((a) => {
					const parts = [...a.selected, ...(a.other ? [`other: ${a.other}`] : [])];
					return `${a.id}: ${a.skipped && parts.length === 0 ? "(dismissed, no answer)" : parts.join("; ")}`;
				})
				.join("\n");
			return { content: [{ type: "text", text }], details: { answers } };
		},

		renderCall(args: any, theme: any) {
			const n = args.questions?.length ?? 0;
			const first = args.questions?.[0]?.prompt ?? "";
			return new Text(
				theme.fg("toolTitle", theme.bold("AskQuestion ")) + theme.fg("dim", n > 1 ? `${n} questions` : first),
				0,
				0,
			);
		},

		renderResult(result: any, _opts: any, theme: any) {
			const answers = (result.details?.answers ?? []) as Answer[];
			if (!answers.length) return new Text(result.content?.[0]?.text ?? "", 0, 0);
			return new Text(
				answers
					.map((a) => {
						const parts = [...a.selected, ...(a.other ? [a.other] : [])];
						return `${theme.fg("muted", `${a.prompt} `)}${parts.length ? theme.fg("accent", parts.join(", ")) : theme.fg("dim", "(no answer)")}`;
					})
					.join("\n"),
				0,
				0,
			);
		},
	});
}
