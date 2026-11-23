import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModel } from "../extensions/pstack/models.ts";

const available = [
	{ provider: "anthropic", id: "claude-opus-5-5" },
	{ provider: "anthropic", id: "claude-fable-5-2" },
	{ provider: "google", id: "gemini-4-neon" },
	{ provider: "openai", id: "gpt-6" },
];

test("omitted, auto, and inherit-parent run on the parent", () => {
	assert.deepEqual(resolveModel(undefined, undefined, available), { kind: "inherit", thinking: undefined });
	assert.equal(resolveModel("auto", undefined, available).kind, "inherit");
	assert.equal(resolveModel("inherit-parent", undefined, available).kind, "inherit");
});

test("Cursor slugs map to the pi model and thinking level, dropping -fast", () => {
	const opus = resolveModel("claude-opus-5-5-xhigh-fast", undefined, available);
	assert.equal(opus.kind, "model");
	assert.equal(opus.kind === "model" && opus.model, "anthropic/claude-opus-5-5");
	assert.equal(opus.kind === "model" && opus.thinking, "xhigh");
	assert.match(opus.kind === "model" ? (opus.note ?? "") : "", /-fast/);

	const fable = resolveModel("claude-fable-5-2-high", undefined, available);
	assert.deepEqual(fable.kind === "model" && [fable.model, fable.thinking], ["anthropic/claude-fable-5-2", "high"]);

	const gemini = resolveModel("gemini-4-neon-xhigh", undefined, available);
	assert.deepEqual(gemini.kind === "model" && [gemini.model, gemini.thinking], ["google/gemini-4-neon", "xhigh"]);
});

test("pi forms: provider/id, :level suffix, role-line spacing, separate thinking field", () => {
	const a = resolveModel("anthropic/claude-opus-5-5:high", undefined, available);
	assert.deepEqual(a.kind === "model" && [a.model, a.thinking], ["anthropic/claude-opus-5-5", "high"]);
	const b = resolveModel("anthropic/claude-opus-5-5 medium", undefined, available);
	assert.deepEqual(b.kind === "model" && [b.model, b.thinking], ["anthropic/claude-opus-5-5", "medium"]);
	const c = resolveModel("gpt-6", "low", available);
	assert.deepEqual(c.kind === "model" && [c.model, c.thinking], ["openai/gpt-6", "low"]);
	const d = resolveModel("inherit-parent high", undefined, available);
	assert.deepEqual(d, { kind: "inherit", thinking: "high" });
});

test("explicit thinking wins over the slug's effort", () => {
	const r = resolveModel("claude-opus-5-5-xhigh-fast", "medium", available);
	assert.equal(r.kind === "model" && r.thinking, "medium");
});

test("unknown models and levels are rejected with the available list", () => {
	const r = resolveModel("grok-9-high", undefined, available);
	assert.equal(r.kind, "rejected");
	assert.match(r.kind === "rejected" ? r.error : "", /anthropic\/claude-opus-5-5/);
	assert.equal(resolveModel("claude-opus-5-5", "turbo", available).kind, "rejected");
	assert.equal(resolveModel("other/claude-opus-5-5", undefined, available).kind, "rejected");
});
