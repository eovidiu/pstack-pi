import assert from "node:assert/strict";
import { test } from "node:test";
import { readonlyViolation } from "../extensions/pstack/readonly-guard.ts";

test("blocks commands that change files or repository state", () => {
	for (const cmd of [
		"touch c.txt",
		"echo hi > c.txt",
		"echo hi >> log.txt",
		"cat a | tee b",
		"rm -rf build",
		"mkdir out",
		"sed -i 's/a/b/' f.ts",
		"git commit -m x",
		"git -C repo push",
		"git checkout main",
		"git branch -D old",
		"npm install left-pad",
		"cd x && mv a b",
		"gh pr create --fill",
		"sudo ls",
	]) {
		assert.ok(readonlyViolation(cmd), `should block: ${cmd}`);
	}
});

test("allows inspection", () => {
	for (const cmd of [
		"ls -la",
		"git log --oneline -20 2>&1",
		"git status --short",
		"git diff main...HEAD",
		"git branch -a",
		"git config --get user.name",
		"rg -n 'foo' src 2>/dev/null",
		"cat package.json | jq .name",
		"node -e 'const f = (a) => a; console.log(f(1))'",
		"find . -name '*.ts' | wc -l",
		"npm test",
		"echo hi >&2",
		"gh pr view 12 --json title",
	]) {
		assert.equal(readonlyViolation(cmd), undefined, `should allow: ${cmd}`);
	}
});
