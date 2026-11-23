#!/usr/bin/env node
// Regenerates the pi copy of pstack from upstream cursor/plugins.
//
//   node scripts/sync-upstream.mjs                      # clone upstream main into a temp dir
//   node scripts/sync-upstream.mjs --upstream ../plugins # use an existing checkout
//   node scripts/sync-upstream.mjs --check               # fail if the generated tree is stale
//
// Generated: skills/, agents/, docs/guide/, LICENSE, upstream.json.
// Hand-written (never touched here): extensions/, docs/harness/pi.md, README.md, package.json.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB = "https://github.com/cursor/plugins";
const ADAPTER = "docs/harness/pi.md";
const GENERATED = ["skills", "agents", "docs/guide", "LICENSE", "upstream.json"];
const LINK = /\]\(([^)\s]+)\)/g;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Cursor names that the pi adapter must cover. Mirrors upstream's Claude Code generator.
const TERMS = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "poteto-agent", re: /poteto-agent/ },
  { key: "comment-sicko", re: /comment-sicko/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: "`environment: \"cloud\"`", re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "inherit-parent", re: /inherit-parent/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  { key: "Cursor-only features", re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/ },
];
const ROUTE_KEY = "Run another pstack skill";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function file(path) {
  return { bytes: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let upstream = arg("--upstream");
let cleanup;
if (!upstream) {
  upstream = mkdtempSync(join(tmpdir(), "pstack-upstream-"));
  cleanup = upstream;
  const ref = arg("--ref") ?? "main";
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", ref, `${GITHUB}.git`, upstream], { stdio: "inherit" });
}
const PSTACK = join(upstream, "pstack");
const SKILLS = join(PSTACK, "skills");
if (!existsSync(SKILLS)) throw new Error(`${SKILLS} does not exist`);

const skills = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, "SKILL.md")));
const skillPattern = skills.join("|");

function cursorTerms(paths, self) {
  const others = skills.filter((name) => name !== self).join("|") || skillPattern;
  const route = new RegExp(`the \\*\\*(?<bold>${others})\\*\\* skill|\`/(?<command>${others})\``, "g");
  const found = new Set();
  for (const path of paths.filter((p) => p.endsWith(".md"))) {
    const text = readFileSync(path, "utf8");
    for (const term of TERMS) if (term.re.test(text)) found.add(term.key);
    const routes = text
      .split("\n")
      .some((line) => [...line.matchAll(route)].some(({ groups }) => !line.includes(`(../${groups.bold ?? groups.command}/`)));
    if (routes) found.add(ROUTE_KEY);
  }
  return found;
}

const problems = [];
const users = new Map();
const wrap = new Set();
for (const skill of skills) {
  const dir = join(SKILLS, skill);
  const terms = cursorTerms(walk(dir), skill);
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  if (terms.size > 0) {
    if (/^# /m.test(text)) wrap.add(`skills/${skill}/SKILL.md`);
    else problems.push(`skills/${skill}/SKILL.md uses Cursor names but has no H1`);
  }
  for (const key of terms) users.set(key, [...(users.get(key) ?? []), skill]);
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const name = frontmatter.match(/^name:(.*)$/m)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  if (name !== skill) problems.push(`skills/${skill}/SKILL.md has name ${JSON.stringify(name ?? "")}, not ${skill}`);
  if (!SKILL_NAME.test(skill) || skill.length > 64) problems.push(`skills/${skill} is not a valid Agent Skills name`);
}
for (const path of walk(join(PSTACK, "agents"))) {
  const rel = relative(PSTACK, path);
  const terms = cursorTerms([path]);
  if (terms.size > 0) wrap.add(rel);
  for (const key of terms) users.set(key, [...(users.get(key) ?? []), rel]);
}
const adapter = readFileSync(join(ROOT, ADAPTER), "utf8");
for (const [key, using] of users) {
  if (!adapter.includes(key)) problems.push(`${ADAPTER} has no row for ${key}, used by ${using.join(", ")}`);
}
for (const problem of problems) console.log(`FAIL ${problem}`);
if (problems.length > 0) process.exit(1);

const files = new Map();
for (const path of [...walk(SKILLS), ...walk(join(PSTACK, "agents")), ...walk(join(PSTACK, "docs/guide"))]) {
  files.set(relative(PSTACK, path), file(path));
}
files.set("LICENSE", file(join(PSTACK, "LICENSE")));

// Agent frontmatter carries Cursor model slugs and Cursor-only keys. The pi Task tool picks the model.
for (const [path, entry] of files) {
  if (!path.startsWith("agents/") || !path.endsWith(".md")) continue;
  const text = entry.bytes.toString("utf8").replace(/^---\n([\s\S]*?)\n---/, (_, body) => {
    const kept = body.split("\n").filter((line) => !/^(model|is_background|readonly):/.test(line));
    return `---\n${kept.join("\n")}\n---`;
  });
  entry.bytes = Buffer.from(text);
}

for (const path of wrap) {
  const entry = files.get(path);
  const depth = path.split("/").length - 1;
  const href = `${"../".repeat(depth)}${ADAPTER}`;
  const line =
    `In pi, read [the pi adapter](${href}) once per session before you follow this ${path.startsWith("agents/") ? "brief" : "skill"}. ` +
    "It maps the Cursor names in pstack to pi.";
  entry.bytes = Buffer.from(entry.bytes.toString("utf8").replace(/^(# .*)\n+/m, `$1\n\n${line}\n\n`));
}

// A relative link to an upstream file this tree leaves out, or to upstream's README (ours differs), points at GitHub.
const local = (path) => files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)) || path === ADAPTER;
for (const [path, entry] of files) {
  if (!path.endsWith(".md")) continue;
  const text = entry.bytes.toString("utf8").replace(LINK, (link, href) => {
    const bare = href.replace(/[#?].*/, "");
    if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return link;
    const target = posix.join(posix.dirname(path), bare).replace(/\/$/, "");
    if (target.startsWith("..") || local(target) || !existsSync(join(PSTACK, target))) return link;
    const kind = statSync(join(PSTACK, target)).isDirectory() ? "tree" : "blob";
    return `](${GITHUB}/${kind}/main/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
  });
  entry.bytes = Buffer.from(text);
}

const dangling = [];
for (const [path, entry] of files) {
  if (!path.endsWith(".md")) continue;
  for (const [, href] of entry.bytes.toString("utf8").matchAll(LINK)) {
    const bare = href.replace(/[#?].*/, "");
    if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare)) continue;
    const target = posix.join(posix.dirname(path), bare).replace(/\/$/, "");
    if (existsSync(join(PSTACK, target)) && !local(target)) dangling.push(`${path} links to ${href}`);
  }
}
for (const link of dangling) console.log(`FAIL ${link}, which is not in the tree`);
if (dangling.length > 0) process.exit(1);

const manifest = JSON.parse(readFileSync(join(PSTACK, "plugin.json"), "utf8"));
const commit = git(upstream, "rev-parse", "HEAD");
const meta = { repository: GITHUB, path: "pstack", version: manifest.version, commit };
files.set("upstream.json", { bytes: Buffer.from(`${JSON.stringify(meta, null, 2)}\n`), executable: false });

const onDisk = new Map(
  GENERATED.flatMap((path) => {
    const abs = join(ROOT, path);
    if (!existsSync(abs)) return [];
    return statSync(abs).isDirectory() ? walk(abs).map((p) => [relative(ROOT, p), file(p)]) : [[path, file(abs)]];
  }),
);

if (process.argv.includes("--check")) {
  const drifted = [...new Set([...files.keys(), ...onDisk.keys()])].sort().filter((path) => {
    const [want, have] = [files.get(path), onDisk.get(path)];
    if (path === "upstream.json") return !have;
    return !want || !have || !want.bytes.equals(have.bytes) || want.executable !== have.executable;
  });
  for (const path of drifted.slice(0, 20)) console.log(path);
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  if (drifted.length > 0) {
    console.log(`out of date with upstream ${commit.slice(0, 12)}. Run node scripts/sync-upstream.mjs.`);
    process.exit(1);
  }
  console.log(`up to date with upstream pstack ${manifest.version} (${commit.slice(0, 12)}).`);
} else {
  for (const path of GENERATED) rmSync(join(ROOT, path), { recursive: true, force: true });
  for (const [path, { bytes, executable }] of files) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), bytes);
    chmodSync(join(ROOT, path), executable ? 0o755 : 0o644);
  }
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  console.log(`pstack ${manifest.version} (${commit.slice(0, 12)}): ${skills.length} skills, ${wrap.size} files with the pi adapter line.`);
}
