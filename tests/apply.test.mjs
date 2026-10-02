/**
 * setup-project の apply.mjs の検査。既存ファイルを上書きしないこと・CLAUDE.md への追記が1回だけであること・
 * dev-harness 併用時に harness-core のフォルダを検査対象から外すことを守る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  DEV_HARNESS_EXCLUDE,
  SCAFFOLD_DIR,
  apply,
  configFor,
  plan,
} from "../plugins/harness-doc/skills/setup-project/scripts/apply.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "..", "plugins", "harness-doc", "skills", "setup-project", "scripts", "apply.mjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "doc-apply-"));
const byRel = (items) => Object.fromEntries(items.map((i) => [i.rel, i.action]));

test("SCAFFOLD_DIR はプラグイン内の scaffold を指す（プラグインのキャッシュ単体で動く）", () => {
  assert.ok(fs.existsSync(path.join(SCAFFOLD_DIR, "CLAUDE.section.md")));
  assert.ok(fs.existsSync(path.join(SCAFFOLD_DIR, ".claude", "doc-harness.config.json")));
});

test("空のプロジェクト: 全部置き、CLAUDE.md は新規に作る", () => {
  const dest = tmp();
  const items = plan(SCAFFOLD_DIR, dest);
  assert.deepEqual(byRel(items), {
    ".claude/doc-harness.config.json": "copy",
    "CLAUDE.md": "create",
    "docs-style/README.md": "copy",
    "docs-style/banned-words.txt": "copy",
    "docs-style/glossary.md": "copy",
    "docs-style/voice.md": "copy",
  });
  apply(SCAFFOLD_DIR, dest, items);
  assert.match(fs.readFileSync(path.join(dest, "CLAUDE.md"), "utf-8"), /## 文書ルール（harness-doc）/);
});

test("既存の CLAUDE.md には追記し、既存ファイルは上書きせず、2回目は全部スキップ", () => {
  const dest = tmp();
  fs.writeFileSync(path.join(dest, "CLAUDE.md"), "# Mine\n\nkeep\n");
  fs.mkdirSync(path.join(dest, "docs-style"));
  fs.writeFileSync(path.join(dest, "docs-style", "glossary.md"), "MY GLOSSARY\n");

  const first = plan(SCAFFOLD_DIR, dest);
  assert.equal(byRel(first)["CLAUDE.md"], "append");
  assert.equal(byRel(first)["docs-style/glossary.md"], "skip");
  apply(SCAFFOLD_DIR, dest, first);

  const claude = fs.readFileSync(path.join(dest, "CLAUDE.md"), "utf-8");
  assert.ok(claude.startsWith("# Mine\n\nkeep\n"));
  assert.equal(claude.split("## 文書ルール（harness-doc）").length - 1, 1);
  assert.equal(fs.readFileSync(path.join(dest, "docs-style", "glossary.md"), "utf-8"), "MY GLOSSARY\n");

  const second = plan(SCAFFOLD_DIR, dest);
  assert.ok(second.every((i) => i.action === "skip"), JSON.stringify(second));
});

test("dev-harness 併用: config の exclude に harness-core のフォルダが入る", () => {
  const dest = tmp();
  fs.mkdirSync(path.join(dest, ".claude"));
  fs.writeFileSync(path.join(dest, ".claude", "harness.config.json"), "{}");
  apply(SCAFFOLD_DIR, dest, plan(SCAFFOLD_DIR, dest));
  const conf = JSON.parse(fs.readFileSync(path.join(dest, ".claude", "doc-harness.config.json"), "utf-8"));
  for (const g of DEV_HARNESS_EXCLUDE) assert.ok(conf.exclude.includes(g), g);
  assert.ok(conf.exclude.includes("CHANGELOG.md"), "雛形の exclude も残る");
  assert.deepEqual(conf.include, ["docs/**/*.md", "docs/**/*.html", "README.md"]);
});

test("dev-harness でなければ config は雛形のまま", () => {
  const text = fs.readFileSync(path.join(SCAFFOLD_DIR, ".claude", "doc-harness.config.json"), "utf-8");
  assert.equal(configFor(text, false), text);
});

test("CLI: --dest 省略時は CLAUDE_PROJECT_DIR を使い、--json で計画を返す", () => {
  const dest = tmp();
  const r = spawnSync(process.execPath, [scriptPath, "--dry-run", "--json"], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dest },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(path.resolve(out.dest), path.resolve(dest));
  assert.equal(out.dryRun, true);
  assert.equal(out.devHarness, false);
  assert.equal(fs.readdirSync(dest).length, 0, "dry-run は書き込まない");
});

test("--config: 配列は置き換え、voice は合成し、知らないキーは拒否する", async () => {
  const { mergeConfig } = await import("../plugins/harness-doc/skills/setup-project/scripts/apply.mjs");
  const cur = { include: ["docs/**/*.md"], voice: { endings: null }, exclude: ["CHANGELOG.md"] };
  assert.deepEqual(mergeConfig(cur, { include: ["web/**/*.html"], voice: { endings: "keitai" } }), {
    include: ["web/**/*.html"],
    voice: { endings: "keitai" },
    exclude: ["CHANGELOG.md"],
  });
  assert.throws(() => mergeConfig(cur, { inclde: [] }), /知らない設定キー: inclde/);
});

test("--config CLI: 導入済みの config に書き込む。未導入なら止まる", () => {
  const dest = tmp();
  const run = (args) => spawnSync(process.execPath, [scriptPath, "--dest", dest, ...args], { encoding: "utf-8" });
  assert.equal(run(["--config", '{"voice":{"endings":"jotai"}}']).status, 1, "未導入");
  assert.equal(run([]).status, 0);
  const r = run(["--config", '{"glossaryFiles":[".claude/rules/terms.md"],"voice":{"endings":"jotai"}}']);
  assert.equal(r.status, 0, r.stderr);
  const conf = JSON.parse(fs.readFileSync(path.join(dest, ".claude", "doc-harness.config.json"), "utf-8"));
  assert.deepEqual(conf.glossaryFiles, [".claude/rules/terms.md"]);
  assert.deepEqual(conf.voice, { endings: "jotai" });
  assert.deepEqual(conf.include, ["docs/**/*.md", "docs/**/*.html", "README.md"], "触らないキーは残る");
});
