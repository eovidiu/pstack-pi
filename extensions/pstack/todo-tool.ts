/**
 * `TodoWrite`: Cursor's todolist tool. State lives in tool result details, so /tree and
 * /fork see the list as it was at that point in the branch.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "completed" | "cancelled";
interface Todo {
	id: string;
	content: string;
	status: Status;
}
interface TodoDetails {
	todos: Todo[];
	error?: string;
}

const STATUS = ["pending", "in_progress", "completed", "cancelled"] as const;

const TodoWriteParams = Type.Object({
	merge: Type.Boolean({
		description: "true: update listed ids in place and append new ones. false: replace the whole list.",
	}),
	todos: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable id for the item" }),
			content: Type.Optional(Type.String({ description: "Item text. Required for new items." })),
			status: Type.Optional(StringEnum(STATUS)),
		}),
		{ description: "Items to write" },
	),
});

const mark: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" };

function asText(todos: Todo[]): string {
	if (todos.length === 0) return "Todo list is empty.";
	const done = todos.filter((t) => t.status === "completed").length;
	return `${done}/${todos.length} completed\n${todos.map((t) => `${mark[t.status]} ${t.id}: ${t.content}`).join("\n")}`;
}

export function registerTodoTool(pi: ExtensionAPI) {
	let todos: Todo[] = [];

	const showWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
		if (open.length === 0) {
			ctx.ui.setWidget("pstack-todos", undefined);
			return;
		}
		const th = ctx.ui.theme;
		const done = todos.filter((t) => t.status === "completed").length;
		const lines = [th.fg("accent", `Todos ${done}/${todos.length}`)];
		for (const t of todos) {
			if (t.status === "cancelled") continue;
			const box =
				t.status === "completed" ? th.fg("success", "✓") : t.status === "in_progress" ? th.fg("warning", "▸") : th.fg("dim", "○");
			const text = t.status === "completed" ? th.fg("dim", t.content) : t.status === "in_progress" ? th.bold(t.content) : t.content;
			lines.push(`${box} ${text}`);
		}
		ctx.ui.setWidget("pstack-todos", lines.slice(0, 16));
	};

	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg: any = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "TodoWrite") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.todos) todos = details.todos;
		}
		showWidget(ctx);
	};
	pi.on("session_start", (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_e, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "TodoWrite",
		label: "TodoWrite",
		description:
			"Write the session's todo list (Cursor's todolist tool). Use merge=false to set the whole list, merge=true to update statuses by id. Statuses: pending, in_progress, completed, cancelled. Keep one item in_progress.",
		promptSnippet: "Maintain a visible todo list for multi-step work",
		promptGuidelines: ["Use TodoWrite when a skill says to open a todolist or copy steps into the todolist tool."],
		parameters: TodoWriteParams,
		executionMode: "sequential",

		async execute(_id, params, _signal, _onUpdate, ctx) {
			let next: Todo[];
			if (params.merge) {
				next = todos.map((t) => ({ ...t }));
				for (const item of params.todos) {
					const existing = next.find((t) => t.id === item.id);
					if (existing) {
						if (item.content !== undefined) existing.content = item.content;
						if (item.status !== undefined) existing.status = item.status;
					} else if (item.content) {
						next.push({ id: item.id, content: item.content, status: item.status ?? "pending" });
					} else {
						throw new Error(`Todo "${item.id}" does not exist; new items need content.`);
					}
				}
			} else {
				const missing = params.todos.filter((t) => !t.content).map((t) => t.id);
				if (missing.length) throw new Error(`Items need content when merge is false: ${missing.join(", ")}`);
				next = params.todos.map((t) => ({ id: t.id, content: t.content!, status: t.status ?? "pending" }));
			}
			todos = next;
			showWidget(ctx);
			return { content: [{ type: "text", text: asText(todos) }], details: { todos } as TodoDetails };
		},

		renderCall(args: any, theme: any) {
			const n = args.todos?.length ?? 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("TodoWrite ")) + theme.fg("muted", `${args.merge ? "update" : "set"} ${n} item${n === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const list = (result.details as TodoDetails | undefined)?.todos;
			if (!list) return new Text(result.content?.[0]?.text ?? "", 0, 0);
			const done = list.filter((t) => t.status === "completed").length;
			let text = theme.fg("muted", `${done}/${list.length} completed`);
			const shown = expanded ? list : list.filter((t) => t.status === "in_progress" || t.status === "pending").slice(0, 4);
			for (const t of shown) {
				const box =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("warning", "▸")
							: t.status === "cancelled"
								? theme.fg("dim", "✗")
								: theme.fg("dim", "○");
				text += `\n${box} ${t.status === "completed" || t.status === "cancelled" ? theme.fg("dim", t.content) : t.content}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
