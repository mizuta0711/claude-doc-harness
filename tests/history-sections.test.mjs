/**
 * 内部の改訂記録の節の比べ方（実地検証 P3a-3 の G1）。
 * 同じ日に同じ文書を2回直すと同じ見出しの節ができ、見出しで比べると取り違えていた。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeBrief, loadBriefs } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection, parseSections, historyFile } from "../plugins/harness-doc/scripts/history.mjs";
import { checkDoc, diffSections } from "../plugins/harness-doc/scripts/complete-doc.mjs";

const DOC = "docs/usage/phone.md";
const sec = (extra = {}) => ({
  doc: DOC,
  size: "S",
  改訂箇所: "手順3",
  改訂内容: "直した",
  改訂意図: "実装と違っていた",
  読者向けの改訂履歴: "対象外",
  "変更者・承認者": "Claude・依頼者",
  ...extra,
});

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-sec-"));
  writeBrief(dir, {
    name: "usage",
    title: "使い方",
    paths: ["docs/usage/**"],
    set: { 読者: { プロファイル: "beginner", 読者像: "初めて使う人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
    outOfScope: ["なし"],
  });
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, DOC), "# 電話\n\n1. 押す\n");
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

test("history.mjs add: 同じ日に同じ文書を2回直すと、2つ目の見出しに（2）を付ける", () => {
  const { dir } = project();
  addSection(dir, sec(), "2026-10-04");
  addSection(dir, sec({ 改訂内容: "戻した" }), "2026-10-04");
  addSection(dir, sec({ 改訂内容: "また直した" }), "2026-10-04");
  const hs = parseSections(fs.readFileSync(historyFile(dir, "usage"), "utf-8")).map((s) => s.heading);
  assert.deepEqual(hs.slice(0, 3), ["2026-10-04 phone.md（規模 S）（3）", "2026-10-04 phone.md（規模 S）（2）", "2026-10-04 phone.md（規模 S）"]);
});

test("diffSections: 同じ見出しの節が2つあっても、足した節を取り違えない・書き換えと誤らない", () => {
  const a = { heading: "2026-10-04 x（規模 S）", text: "## 2026-10-04 x（規模 S）\n\n1回目" };
  const b = { heading: "2026-10-04 x（規模 S）", text: "## 2026-10-04 x（規模 S）\n\n2回目" };
  const c = { heading: "2026-10-04 x（規模 S）", text: "## 2026-10-04 x（規模 S）\n\n3回目" };
  assert.deepEqual(diffSections([b, a], [c, b, a]).added, [c]);
  assert.equal(diffSections([b, a], [c, b, a]).rewritten, false);
  assert.deepEqual(diffSections([a], [b, a]).added, [b], "同じ見出しでも足した節として数える");
  const a2 = { ...a, text: a.text + "（直した）" };
  assert.equal(diffSections([b, a], [b, a2]).rewritten, true);
});

test("diffSections: 過去の節を写しただけでは足したことにならない（0.10.1 の査読 1）", () => {
  const a = { heading: "2026-10-04 x（規模 S）", text: "## 2026-10-04 x（規模 S）\n\n1回目" };
  assert.deepEqual(diffSections([a], [a, a]).added, []);
  assert.deepEqual(diffSections([a], [a, a]).copied, [a]);
});

test("diffSections: 同じ見出しで書き換えと追加が同時でも、新しい節を足した節とする（査読 4）", () => {
  const h = "2026-10-04 x（規模 S）";
  const A = { heading: h, text: `## ${h}\n\nA` };
  const B = { heading: h, text: `## ${h}\n\nB` };
  const N = { heading: h, text: `## ${h}\n\nN` };
  const A2 = { heading: h, text: `## ${h}\n\nA を直した` };
  const B2 = { heading: h, text: `## ${h}\n\nB を直した` };
  assert.deepEqual(diffSections([B, A], [N, B, A2]).added, [N]);
  assert.deepEqual(diffSections([B, A], [N, B2, A]).added, [N]);
  assert.equal(diffSections([B, A], [N, B2, A]).rewritten, true);
});

test("history.mjs add: 見出しに $ があっても（2）を付けられる（査読 2）", () => {
  const { dir } = project();
  addSection(dir, sec({ label: "料金$$表 $& x" }), "2026-10-05");
  addSection(dir, sec({ label: "料金$$表 $& x", 改訂内容: "また直した" }), "2026-10-05");
  const hs = parseSections(fs.readFileSync(historyFile(dir, "usage"), "utf-8")).map((s) => s.heading);
  assert.equal(hs[0], "2026-10-05 料金$$表 $& x（規模 S）（2）");
});

test("完了処理: 過去の節を写しただけの記録では NG（コミット時の検査の経路でも）", () => {
  const { dir, g } = project();
  addSection(dir, sec(), "2026-10-04");
  g("add", "-A");
  g("commit", "-q", "-m", "first");
  fs.appendFileSync(path.join(dir, DOC), "\n2. 話す\n");
  const file = historyFile(dir, "usage");
  const t = fs.readFileSync(file, "utf-8");
  const first = t.slice(t.indexOf("## 2026-10-04"));
  fs.writeFileSync(file, t.replace("## 2026-10-04", first.trimEnd() + "\n\n## 2026-10-04"));
  const r = checkDoc(dir, DOC, { briefs: loadBriefs(dir) });
  assert.match(r.problems.join("\n"), /足されていない/);
  assert.ok(r.warnings.some((w) => w.includes("同じ中身の節")), r.warnings.join("\n"));
  g("add", "-A");
  assert.match(checkDoc(dir, DOC, { briefs: loadBriefs(dir), staged: true }).problems.join("\n"), /足されていない/);
});

test("完了処理: 同じ見出しの節が既にあっても、足した節を見つけ、誤った警告を出さない（P3a-3 の写しの形）", () => {
  const { dir, g } = project();
  // P3a の T1・T2 が同じ見出しで残した記録を、そのまま作る（（2）を付ける前の版の形）
  const file = historyFile(dir, "usage");
  addSection(dir, sec(), "2026-10-04");
  const one = fs.readFileSync(file, "utf-8");
  const dup = one.replace(/(## 2026-10-04[^\n]*\n[\s\S]*)$/, (m) => m.replace("直した", "戻した") + "\n" + m);
  fs.writeFileSync(file, dup);
  g("add", "-A");
  g("commit", "-q", "-m", "p3a");
  fs.appendFileSync(path.join(dir, DOC), "\n2. 話す\n");
  addSection(dir, sec({ 改訂内容: "手順2を足した" }), "2026-10-06");
  const r = checkDoc(dir, DOC, { briefs: loadBriefs(dir) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.warnings.some((w) => w.includes("書き換えられている")), false, r.warnings.join("\n"));
});
