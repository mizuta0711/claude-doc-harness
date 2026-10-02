/**
 * setup-project の棚卸し（inventory.mjs）。読むだけで、既存か新規かの判定と候補の出し方を守る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inventory } from "../plugins/harness-doc/skills/setup-project/scripts/inventory.mjs";

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

test("空のプロジェクトは新規（existing: false）", () => {
  const r = inventory(mk({ "README.md": "# x", "src/a.ts": "" }));
  assert.equal(r.existing, false);
  assert.deepEqual(r.candidates, []);
});

test("既存: 利用者向けの場所を候補にし、dev-harness の管理フォルダ・生成物・開発文書だけの場所は外す", () => {
  const dir = mk({
    ".claude/harness.config.json": "{}",
    ".claude/rules/japanese-terms.md": "| 使う | 使わない |\n|---|---|\n",
    "docs/usage/HOME.md": "# h",
    "docs/web/usage/phone.html": "<p>x</p>",
    "docs/web/assets/style.css": "",
    "docs/設計書/a.md": "# a",
    "docs/reviews/r.md": "# r",
    "docs/ROADMAP.md": "# r",
    "docs/REQUIREMENTS.md": "# r",
    "node_modules/pkg/README.md": "# n",
    "build/out.html": "<p>x</p>",
  });
  const r = inventory(dir);
  assert.equal(r.devHarness, true);
  assert.equal(r.existing, true);
  assert.deepEqual(r.candidates.sort(), ["docs/usage", "docs/web/usage"]);
  assert.deepEqual(r.termFiles, [".claude/rules/japanese-terms.md"]);
  assert.deepEqual(r.cssFiles, ["docs/web/assets/style.css"]);
  assert.ok(!r.docDirs.some((d) => d.dir.startsWith("node_modules") || d.dir === "build"));
  assert.ok(r.docDirs.find((d) => d.dir === "docs/設計書").managedByDevHarness);
});

test("show.mjs: 同梱の資料だけを返し、パスの抜け出しを拒む", async () => {
  const { resolveDoc } = await import("../plugins/harness-doc/presets/show.mjs");
  assert.ok(fs.existsSync(resolveDoc("voices")));
  assert.ok(fs.existsSync(resolveDoc("visuals")));
  assert.ok(fs.existsSync(resolveDoc("profile", "beginner")));
  assert.equal(resolveDoc("profile", "../../hooks/x"), null);
  assert.equal(resolveDoc("other"), null);
});
