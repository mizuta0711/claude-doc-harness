/**
 * history.mjs（内部の改訂記録）と complete-doc.mjs（完了処理の検査）の検査。
 * 依存パッケージは使わない（node:test / node:assert のみ）。git は使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeBrief } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection, initHistory, parseSections, mentions, historyFile } from "../plugins/harness-doc/scripts/history.mjs";
import { checkDoc, changedDocs, revisionSection } from "../plugins/harness-doc/scripts/complete-doc.mjs";
import { DEFAULT_CONFIG } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPLETE_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "complete-doc.mjs");
const HISTORY_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "history.mjs");
const run = (cli, args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf-8" });

function project({ readerHistory = "あり" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-"));
  writeBrief(dir, {
    name: "usage",
    title: "利用者向けの使い方",
    paths: ["docs/usage/**"],
    set: { 読者: { プロファイル: "beginner", 読者像: "初めて使う人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: readerHistory } },
    outOfScope: ["なし"],
  });
  return dir;
}

function gitInit(dir) {
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return g;
}

const section = (extra = {}) => ({
  doc: "docs/usage/phone.md",
  size: "S",
  改訂箇所: "手順3",
  改訂内容: "許可を求められる時期の説明を直した",
  改訂意図: "実装と違っていたため。読者が許可の画面に戸惑わないように",
  根拠: "MainActivity.kt:168-181",
  読者向けの改訂履歴: "手順3：電話の許可を求められる時期の説明を直しました",
  "変更者・承認者": "Claude・依頼者",
  ...extra,
});

test("記録: 雛形から作り、新しい節を上に足す。コメントの中の見本の見出しは節として数えない", () => {
  const dir = project();
  const { created, file } = initHistory(dir, "usage", "利用者向けの使い方");
  assert.equal(created, true);
  assert.equal(path.relative(dir, file).split(path.sep).join("/"), "docs-style/history/usage.md");
  assert.equal(parseSections(fs.readFileSync(file, "utf-8")).length, 0, "雛形のコメントの中の ## は節ではない");
  addSection(dir, section({ 改訂箇所: "手順1" }), "2026-10-05");
  addSection(dir, section({ 改訂箇所: "手順3" }), "2026-10-06");
  const secs = parseSections(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(secs.map((s) => s.heading), ["2026-10-06 phone.md（規模 S）", "2026-10-05 phone.md（規模 S）"]);
  assert.equal(secs[0].items["改訂意図"], "実装と違っていたため。読者が許可の画面に戸惑わないように");
  assert.equal(secs[0].items["対象の文書"], "phone.md");
});

test("記録: 改訂意図などの必須の項目が空なら書かない。ブリーフの当たらない文書・文書群をまたぐ改訂も書かない", () => {
  const dir = project();
  assert.throws(() => addSection(dir, section({ 改訂意図: "  " })), /改訂意図/);
  assert.throws(() => addSection(dir, section({ doc: "README.md" })), /ブリーフが当たらない/);
  writeBrief(dir, { name: "ref", title: "リファレンス", paths: ["docs/ref/**"], set: {} });
  assert.throws(() => addSection(dir, section({ doc: undefined, docs: ["docs/usage/a.md", "docs/ref/b.md"] })), /文書群をまたいでいる/);
});

test("記録: 複数の文書の改訂は1節にまとめ、どの文書からも引ける", () => {
  const dir = project();
  addSection(dir, section({ doc: undefined, docs: ["docs/usage/a.md", "docs/usage/b.md", "docs/usage/c.md"], label: "テイスト変更: a.md ほか2本" }));
  const [s] = parseSections(fs.readFileSync(historyFile(dir, "usage"), "utf-8"));
  for (const k of ["a.md", "b.md", "c.md"]) assert.ok(mentions(s, k), k);
  assert.ok(!mentions(s, "d.md"));
});

test("記録: CLI の show はその文書の節だけを新しい順に出す", () => {
  const dir = project();
  addSection(dir, section({ 改訂箇所: "手順1" }), "2026-10-05");
  addSection(dir, section({ doc: "docs/usage/other.md" }), "2026-10-06");
  const out = run(HISTORY_CLI, ["show", "docs/usage/phone.md", "--dest", dir]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /この文書の節: 1/);
  assert.doesNotMatch(out.stdout, /other\.md/);
  const bad = run(HISTORY_CLI, ["add", "--json", "{x", "--dest", dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSON が読めない/);
});

test("改訂履歴の節を Markdown と HTML から取り出す", () => {
  assert.match(revisionSection("# t\n\n## 改訂履歴\n\n| 日付 |\n|---|\n| 2026 |\n", false), /2026/);
  assert.equal(revisionSection("# t\n\n## 手順\n", false), null);
  assert.match(revisionSection('<h2 id="h">改訂履歴</h2><table><tr><td>2026</td></tr></table></body>', true), /2026/);
});

test("完了処理: 記録が無ければ NG、記録と読者向けの1行があれば OK", async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  const doc = path.join(dir, "docs", "usage", "phone.md");
  fs.writeFileSync(
    doc,
    "# 電話\n\n## 手順\n\n1. 押す\n\n## 改訂履歴\n\n| 日付 | 箇所 | 変更 |\n|---|---|---|\n| 2026-10-01 | — | 初版 |\n"
  );
  gitInit(dir);
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("1. 押す", "1. 緑のボタンを押す"));
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const b = loadBriefs(dir);
  let r = checkDoc(dir, "docs/usage/phone.md", { briefs: b });
  assert.equal(r.problems.length, 2, r.problems.join("\n")); // 記録なし・読者向けの行なし
  addSection(dir, section());
  r = checkDoc(dir, "docs/usage/phone.md", { briefs: b });
  assert.deepEqual(r.problems, ["読者向けの改訂履歴が「あり」なのに、改訂履歴の節に行が足されていない"]);
  fs.writeFileSync(
    doc,
    fs.readFileSync(doc, "utf-8").replace("| 2026-10-01 |", "| 2026-10-06 | 手順1 | ボタンの名前を書きました |\n| 2026-10-01 |")
  );
  r = checkDoc(dir, "docs/usage/phone.md", { briefs: b });
  assert.deepEqual(r.problems, []);
});

test("完了処理: 読者向けの改訂履歴が「なし」なら記録だけを見る。問い合わせの印は NG（--allow-queries で警告）", async () => {
  const dir = project({ readerHistory: "なし" });
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  const doc = path.join(dir, "docs", "usage", "phone.md");
  fs.writeFileSync(doc, "# 電話\n\n1. 押す\n");
  gitInit(dir);
  fs.writeFileSync(doc, "# 電話\n\n1. 押す <!-- 問い合わせ: Q1 -->\n");
  addSection(dir, section({ 読者向けの改訂履歴: "対象外" }));
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const b = loadBriefs(dir);
  assert.deepEqual(checkDoc(dir, "docs/usage/phone.md", { briefs: b }).problems.length, 1);
  const allowed = checkDoc(dir, "docs/usage/phone.md", { briefs: b, allowQueries: true });
  assert.deepEqual(allowed.problems, []);
  assert.equal(allowed.warnings.length, 1);
});

test("完了処理: 変わった文書を git から集める（新しい文書も含め、記録・ブリーフ・include 外は除く）。CLI の終了コード", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "usage", "a.md"), "# a\n");
  fs.writeFileSync(path.join(dir, "src.md"), "# src\n");
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "docs", "usage", "a.md"), "# a 変えた\n");
  fs.writeFileSync(path.join(dir, "docs", "usage", "new.md"), "# new\n");
  fs.writeFileSync(path.join(dir, "src.md"), "# src 変えた\n");
  addSection(dir, section({ doc: "docs/usage/a.md", 読者向けの改訂履歴: "対象外" }));
  const config = { ...DEFAULT_CONFIG, include: ["docs/**/*.md"] };
  assert.deepEqual(changedDocs(dir, config, false).sort(), ["docs/usage/a.md", "docs/usage/new.md"]);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  const out = run(COMPLETE_CLI, ["--dest", dir]);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /NG: docs\/usage\/new\.md/);
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
  const ng = run(COMPLETE_CLI, ["--dest", notGit]);
  assert.equal(ng.status, 0);
  assert.match(ng.stdout, /git 管理外/);
});

test("完了処理: プロジェクトが git リポジトリのサブフォルダーにあっても効く（2回目の改訂で記録を足さなければ NG）", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sub-"));
  const dir = path.join(repo, "app");
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  writeBrief(dir, {
    name: "usage",
    title: "使い方",
    paths: ["docs/usage/**"],
    set: { 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
  });
  const doc = path.join(dir, "docs", "usage", "a.md");
  fs.writeFileSync(doc, "# a\n");
  addSection(dir, section({ doc: "docs/usage/a.md", 読者向けの改訂履歴: "対象外" }), "2026-10-05");
  gitInit(repo);
  fs.writeFileSync(doc, "# a 2回目\n");
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const config = { ...DEFAULT_CONFIG, include: ["docs/**/*.md"] };
  assert.deepEqual(changedDocs(dir, config, false), ["docs/usage/a.md"]);
  const r = checkDoc(dir, "docs/usage/a.md", { briefs: loadBriefs(dir), config });
  assert.equal(r.problems.length, 1, "1回目の節は HEAD にあるので、足したことにならない");
  addSection(dir, section({ doc: "docs/usage/a.md", 読者向けの改訂履歴: "対象外" }), "2026-10-06");
  assert.deepEqual(checkDoc(dir, "docs/usage/a.md", { briefs: loadBriefs(dir), config }).problems, []);
});

test("完了処理: 過去の節を書き換えただけでは足したことにならず、警告が出る。iphone.md の節は phone.md に当たらない", async () => {
  const dir = project({ readerHistory: "なし" });
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), "# p\n");
  addSection(dir, section({ 読者向けの改訂履歴: "対象外" }), "2026-10-05");
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), "# p 2\n");
  const file = historyFile(dir, "usage");
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("手順3", "手順3と4"));
  addSection(dir, section({ doc: "docs/usage/iphone.md", 読者向けの改訂履歴: "対象外" }), "2026-10-06");
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const r = checkDoc(dir, "docs/usage/phone.md", { briefs: loadBriefs(dir) });
  assert.equal(r.problems.length, 1);
  assert.ok(r.warnings.some((w) => w.includes("過去の節が書き換えられている")));
});

test("完了処理: HEAD の無いリポジトリでも、ステージした新しい文書を拾う。削除した文書も記録の対象", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "usage", "a.md"), "# a\n");
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("add", "docs/usage/a.md");
  const config = { ...DEFAULT_CONFIG, include: ["docs/**/*.md"] };
  assert.deepEqual(changedDocs(dir, config, false), ["docs/usage/a.md"]);
  const dir2 = project();
  fs.mkdirSync(path.join(dir2, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir2, "docs", "usage", "d.md"), "# d\n");
  gitInit(dir2);
  fs.rmSync(path.join(dir2, "docs", "usage", "d.md"));
  assert.deepEqual(changedDocs(dir2, config, false), ["docs/usage/d.md"]);
});

test("改訂履歴の節: 見出しの中のタグ・下位の見出し・最終行の見出し・コードの中の見出し・別の見出し名", () => {
  assert.match(revisionSection('<h2><span id="h">改訂履歴</span></h2><table><tr><td>x</td></tr></table>', true), /<td>x/);
  const sub = "# t\n\n## 改訂履歴\n\n### 2026年\n\n| 日付 |\n|---|\n| 1 |\n\n## 関連\n";
  assert.match(revisionSection(sub, false), /### 2026年[\s\S]*\| 1 \|/);
  assert.equal(revisionSection("# t\n\n## 改訂履歴", false), "");
  assert.equal(revisionSection("# t\n\n```md\n## 改訂履歴\n```\n", false), null);
  assert.match(revisionSection("# t\n\n## 更新履歴\n\n| a |\n", false, ["更新履歴"]), /\| a \|/);
});

test("完了処理: 新しい文書は改訂履歴の行が要る（YYYY-MM-DD の行は数えない）。コードの中の問い合わせの印は見ない", async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  gitInit(dir);
  const doc = path.join(dir, "docs", "usage", "n.md");
  fs.writeFileSync(doc, "# n\n\n`<!-- 問い合わせ: Q1 -->` の印を置く\n\n## 改訂履歴\n\n| 日付 | 箇所 | 変更 |\n|---|---|---|\n| YYYY-MM-DD | — | 初版 |\n");
  addSection(dir, section({ doc: "docs/usage/n.md" }));
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  let r = checkDoc(dir, "docs/usage/n.md", { briefs: loadBriefs(dir) });
  assert.deepEqual(r.problems, ["読者向けの改訂履歴の節に、行が無い（新しい文書なら「初版」の行を書く）"]);
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("YYYY-MM-DD", "2026-10-06"));
  r = checkDoc(dir, "docs/usage/n.md", { briefs: loadBriefs(dir) });
  assert.deepEqual(r.problems, []);
});
