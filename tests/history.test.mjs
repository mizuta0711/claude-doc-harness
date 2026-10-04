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
import { DEFAULT_CONFIG, loadStyle } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";

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

// ---------------------------------------------------------------------------
// 0.9.0: 作業前の基準点・箇条書きの改訂履歴・check-docs の指摘の増加・改行コード（実地検証 P3a の F2・F3・F10・F13）
// ---------------------------------------------------------------------------

function projectWithDoc(body) {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  fs.mkdirSync(path.join(dir, "docs-style"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs-style", "banned-words.txt"), "適宜\n");
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), body);
  gitInit(dir);
  return dir;
}

const PHONE = "# 電話\n\n1. 押す\n\n## 改訂履歴\n\n- 2026-10-01 初版\n";

test("基準点: コミットを挟まずに続けた2つ目の作業で、記録が無ければ NG（基準点が無いと誤って合格する）", () => {
  const dir = projectWithDoc(PHONE);
  const doc = path.join(dir, "docs", "usage", "phone.md");
  // 1つ目の作業: 本文・読者向けの行・内部の記録（コミットしない）
  fs.writeFileSync(doc, PHONE.replace("1. 押す", "1. 緑のボタンを押す").replace("- 2026-10-01", "- 2026-10-05 手順1を直しました\n- 2026-10-01"));
  addSection(dir, section({ 読者向けの改訂履歴: "手順1を直しました" }), "2026-10-05");
  // 2つ目の作業の始めに基準点を記録し、本文だけ直す
  assert.equal(run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]).status, 0);
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("緑のボタン", "緑色のボタン"));
  const withMark = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(withMark.status, 1, withMark.stdout);
  assert.match(withMark.stdout, /この文書の節が足されていない/);
  assert.match(withMark.stdout, /行が足されていない/);
  // 基準点が無いと、1つ目の作業の記録と区別できないので「判定できない」で止める（HEAD と比べて通さない）
  fs.rmSync(path.join(dir, ".git", "harness-doc", "baseline.json"));
  const noMark = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(noMark.status, 1, noMark.stdout);
  assert.match(noMark.stdout, /基準点が無いので/);
  assert.match(noMark.stdout, /判定できない/);
});

const baselineOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".git", "harness-doc", "baseline.json"), "utf-8"));
const hasBaseline = (dir) => fs.existsSync(path.join(dir, ".git", "harness-doc", "baseline.json"));
const PHONE_DONE = PHONE.replace("- 2026-10-01", "- 2026-10-05 直しました\n- 2026-10-01");

test("基準点: 引数なしの検査は、前の作業で直してコミットしていない文書を今回の変更に数えない", () => {
  const dir = projectWithDoc(PHONE);
  fs.writeFileSync(path.join(dir, "docs", "usage", "b.md"), PHONE);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "b"]);
  // 1つ目の作業: phone.md を直して記録（コミットしない）
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE);
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }), "2026-10-05");
  // 2つ目の作業: b.md
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/b.md"]);
  fs.writeFileSync(path.join(dir, "docs", "usage", "b.md"), PHONE_DONE);
  addSection(dir, section({ doc: "docs/usage/b.md", 読者向けの改訂履歴: "直しました" }), "2026-10-06");
  const r = run(COMPLETE_CLI, ["--dest", dir]);
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /phone\.md/);
  assert.match(r.stdout, /OK: docs\/usage\/b\.md/);
});

test("基準点: 一部の文書だけ検査して通っても、残りの文書があれば通過済みにしない", () => {
  const dir = projectWithDoc(PHONE);
  fs.writeFileSync(path.join(dir, "docs", "usage", "b.md"), PHONE);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "b"]);
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md", "docs/usage/b.md"]);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE);
  fs.writeFileSync(path.join(dir, "docs", "usage", "b.md"), PHONE_DONE);
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }));
  const a = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(a.status, 0, a.stdout);
  assert.ok(hasBaseline(dir), "b.md が残っているので消さない");
  const b = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/b.md"]);
  assert.equal(b.status, 1, "b.md は記録が無いので、基準点と比べて NG");
});

test("基準点: 基準点が無いときの --add は通常の記録と同じ（改訂記録も残す）。--add だけでは使い方の誤り", () => {
  const dir = projectWithDoc(PHONE);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE);
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }), "2026-10-05");
  assert.equal(run(COMPLETE_CLI, ["--add", "--dest", dir, "docs/usage/phone.md"]).status, 2);
  run(COMPLETE_CLI, ["--mark", "--add", "--dest", dir, "docs/usage/phone.md"]);
  assert.ok(Object.keys(baselineOf(dir).files).some((k) => k.startsWith("docs-style/history/")));
  const r = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(r.status, 1, "基準点の後に記録が足されていない");
});

test("基準点: パスの書き方（./）が違っても同じ文書として扱う。同じコミットの上の --mark は上書きせずに足す。--reset・--clear", () => {
  const dir = projectWithDoc(PHONE);
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "./docs/usage/phone.md"]);
  assert.ok(hasOwnKey(baselineOf(dir).files, "docs/usage/phone.md"));
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE);
  const merged = run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  assert.match(merged.stdout, /既にある基準点/);
  assert.equal(baselineOf(dir).files["docs/usage/phone.md"], PHONE, "直した後の中身を作業前にしない");
  run(COMPLETE_CLI, ["--mark", "--reset", "--dest", dir, "docs/usage/phone.md"]);
  assert.equal(baselineOf(dir).files["docs/usage/phone.md"], PHONE_DONE);
  assert.equal(run(COMPLETE_CLI, ["--clear", "--dest", dir]).status, 0);
  assert.equal(hasBaseline(dir), false);
});
const hasOwnKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test("改訂履歴: 節の後ろのナビ・フッターのリストや、リンクだけの箇条書きは行として数えない", () => {
  const html = '<h2>改訂履歴</h2><table><tr><th>日付</th></tr></table><footer><nav><ul><li>前へ</li></ul></nav></footer>';
  assert.equal(/<li/.test(revisionSection(html, true)), false);
  const inFooter = '<footer><h2>改訂履歴</h2><table><tr><th>日付</th></tr></table></footer><ul><li>前へ</li></ul>';
  assert.equal(/<li/.test(revisionSection(inFooter, true)), false, "見出しがフッターの中にあっても、フッターの終わりで切る");
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "docs", "usage", "h.html"), html);
  fs.writeFileSync(path.join(dir, "docs", "usage", "n.md"), "# n\n\n## 改訂履歴\n\n- [前へ](a.md)\n");
  addSection(dir, section({ docs: ["docs/usage/h.html", "docs/usage/n.md"], doc: undefined }));
  return import("../plugins/harness-doc/scripts/brief.mjs").then(({ loadBriefs }) => {
    for (const d of ["docs/usage/h.html", "docs/usage/n.md"])
      assert.match(checkDoc(dir, d, { briefs: loadBriefs(dir) }).problems.join("\n"), /行が無い/, d);
  });
});

test("改行コード: core.autocrlf=true でも、基準点が無ければ誤って警告しない", async () => {
  const dir = projectWithDoc(PHONE);
  execFileSync("git", ["-C", dir, "config", "core.autocrlf", "true"]);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE.replace(/\n/g, "\r\n"));
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }));
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const r = checkDoc(dir, "docs/usage/phone.md", { briefs: loadBriefs(dir) });
  assert.equal(r.warnings.some((w) => w.includes("改行コード")), false, r.warnings.join("\n"));
});

test("抑止のマーカーが作業前より増えたら警告する", async () => {
  const dir = projectWithDoc(PHONE);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), "<!-- check-docs: skip -->\n" + PHONE_DONE);
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }));
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  const r = checkDoc(dir, "docs/usage/phone.md", { briefs: loadBriefs(dir) });
  assert.ok(r.warnings.some((w) => w.includes("検査の抑止")), r.warnings.join("\n"));
});

test("基準点: すべて通ったら通過済みの印を付け、検査し直しても同じ結果になる。次の作業の --mark は作り直す", () => {
  const dir = projectWithDoc(PHONE);
  const doc = path.join(dir, "docs", "usage", "phone.md");
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  fs.writeFileSync(doc, PHONE.replace("- 2026-10-01", "- 2026-10-05 手順1を直しました\n- 2026-10-01"));
  addSection(dir, section({ 読者向けの改訂履歴: "手順1を直しました" }));
  const r = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(r.status, 0, r.stdout);
  const b = JSON.parse(fs.readFileSync(path.join(dir, ".git", "harness-doc", "baseline.json"), "utf-8"));
  assert.ok(b.passed, "通過済みの印");
  // 警告を直して確かめ直す（記録は変えない）
  fs.appendFileSync(doc, "\n");
  const again = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /通過した後に文書が変わっている/);
  // 次の作業: --mark は通過済みの基準点に足さずに作り直す
  const m = run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  assert.doesNotMatch(m.stdout, /既にある基準点/);
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("1. 押す", "1. 強く押す"));
  assert.equal(run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]).status, 1, "前の作業の記録で通さない");
});

test("基準点: 前の作業が記録まで進んで残した基準点には、同じコミットの上でも足さない。通過済みの後に記録が変わっていれば使わない", () => {
  const dir = projectWithDoc(PHONE);
  const doc = path.join(dir, "docs", "usage", "phone.md");
  // 1つ目の作業: 記録まで書いたが、検査を走らせずに終わった
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  fs.writeFileSync(doc, PHONE_DONE);
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }), "2026-10-05");
  // 2つ目の作業: --mark は作り直す。記録なしで直すと NG
  const m = run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  assert.doesNotMatch(m.stdout, /既にある基準点/);
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("1. 押す", "1. 強く押す"));
  assert.equal(run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]).status, 1);
});

test("基準点: HEAD の無いリポジトリでは、--mark は足さずに作り直す", () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE);
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  fs.writeFileSync(path.join(dir, "docs", "usage", "phone.md"), PHONE_DONE);
  const m = run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  assert.doesNotMatch(m.stdout, /既にある基準点/);
});

test("改訂履歴: 箇条書きでも数える（Markdown と HTML）", async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "docs", "usage", "n.md"), "# n\n\n## 改訂履歴\n\n- 2026-10-06 初版\n");
  fs.writeFileSync(path.join(dir, "docs", "usage", "h.html"), '<h1>h</h1><h2>改訂履歴</h2><ul><li>2026-10-06 初版</li></ul>');
  addSection(dir, section({ doc: "docs/usage/n.md" }));
  addSection(dir, section({ doc: "docs/usage/h.html" }), "2026-10-07");
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  for (const d of ["docs/usage/n.md", "docs/usage/h.html"]) {
    assert.deepEqual(checkDoc(dir, d, { briefs: loadBriefs(dir) }).problems, [], d);
  }
});

test("check-docs の指摘: 作業前より増えた分だけを止める（作業前からある指摘は数えない）", async () => {
  const dir = projectWithDoc("# 電話\n\n適宜押す。\n\n## 改訂履歴\n\n- 2026-10-01 初版\n");
  const doc = path.join(dir, "docs", "usage", "phone.md");
  const config = { ...DEFAULT_CONFIG, include: ["docs/**/*.md"] };
  const style = loadStyle(dir, config);
  const { loadBriefs } = await import("../plugins/harness-doc/scripts/brief.mjs");
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf-8").replace("- 2026-10-01", "- 2026-10-05 直しました\n- 2026-10-01"));
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }));
  let r = checkDoc(dir, "docs/usage/phone.md", { briefs: loadBriefs(dir), config, style });
  assert.deepEqual(r.problems, [], "作業前からある「適宜」は数えない");
  fs.appendFileSync(doc, "\n適宜確かめる。\n");
  r = checkDoc(dir, "docs/usage/phone.md", { briefs: loadBriefs(dir), config, style });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /check-docs の指摘が作業前より増えている/);
});

test("改行コード: 基準点から変わったら警告する", () => {
  const dir = projectWithDoc(PHONE.replace(/\n/g, "\r\n"));
  const doc = path.join(dir, "docs", "usage", "phone.md");
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  fs.writeFileSync(doc, PHONE.replace("- 2026-10-01", "- 2026-10-05 直しました\n- 2026-10-01"));
  addSection(dir, section({ 読者向けの改訂履歴: "直しました" }));
  const r = run(COMPLETE_CLI, ["--dest", dir, "docs/usage/phone.md"]);
  assert.match(r.stdout, /改行コードが作業前（CRLF）から変わっている/);
});

test("基準点: --add は記録済みの文書を上書きせず、新しい文書だけ足す", () => {
  const dir = projectWithDoc(PHONE);
  const doc = path.join(dir, "docs", "usage", "phone.md");
  fs.writeFileSync(path.join(dir, "docs", "usage", "other.md"), "# other\n");
  run(COMPLETE_CLI, ["--mark", "--dest", dir, "docs/usage/phone.md"]);
  fs.writeFileSync(doc, PHONE.replace("1. 押す", "1. 変えた"));
  run(COMPLETE_CLI, ["--mark", "--add", "--dest", dir, "docs/usage/phone.md", "docs/usage/other.md"]);
  const b = JSON.parse(fs.readFileSync(path.join(dir, ".git", "harness-doc", "baseline.json"), "utf-8"));
  assert.match(b.files["docs/usage/phone.md"], /1\. 押す/, "上書きしていない");
  assert.equal(b.files["docs/usage/other.md"], "# other\n");
});
