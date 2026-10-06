/**
 * 0.20.0: B15（陳腐化の追随）の検査。
 * 内部の改訂記録の項目「確かめたソース」（書き込みのときのパス検査）・古くなった候補の判定（docset.mjs。基準点はソースを挙げた節のコミット・範囲で判定）・
 * 「確かめたが変更なし」の節・対象のアプリの版（ブリーフの項目）。
 * 依存パッケージは使わない（node:test / node:assert のみ）。git は使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeBrief, loadBriefs, missingItems } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection, normalizeSources, isConfirmOnly, parseSections } from "../plugins/harness-doc/scripts/history.mjs";
import { analyze, renderText, renderStale, staleAnalysis, docsetContext } from "../plugins/harness-doc/scripts/docset.mjs";
import { checkDoc } from "../plugins/harness-doc/scripts/complete-doc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCSET_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "docset.mjs");

const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const gitIn = (root) => {
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  return g;
};
const commit = (g, msg) => {
  g("add", "-A");
  g("commit", "-q", "-m", msg);
};

const DOC = "docs/usage/phone.md";
const INDEX = "docs/usage/index.md";
const FILES = {
  [DOC]: "# 電話\n\n## 手順\n\n1. 押す\n\n## 改訂履歴\n\n| 日付 | 箇所 | 変更 |\n|---|---|---|\n| 2026-10-01 | — | 初版 |\n",
  [INDEX]: "# 使い方\n\n[電話](phone.md)\n",
  "app/a.txt": "a\n",
  "app/b.txt": "b\n",
};

/** ブリーフを書いた git のプロジェクト（初回コミット済み）。sub を渡すと、リポジトリのサブフォルダーをプロジェクトにする */
function project({ files = FILES, readerHistory = "なし", git = true, brief = true, sub = null, paths = ["docs/usage/**"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b15-"));
  const dir = sub ? path.join(root, sub) : root;
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  if (brief)
    writeBrief(dir, {
      name: "usage",
      title: "使い方",
      paths,
      set: { 読者: { プロファイル: "beginner", 読者像: "初めて使う人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: readerHistory } },
      outOfScope: ["なし"],
    });
  let g = null;
  if (git) {
    g = gitIn(root);
    commit(g, "init");
  }
  return { dir, root, g };
}

/** 内部の改訂記録に節を足す。sources が undefined なら確かめたソースを書かない */
const rec = (dir, docs, sources, extra = {}) =>
  addSection(dir, {
    docs,
    size: "S",
    改訂箇所: "手順1",
    改訂内容: "押すボタンの名前を直した",
    改訂意図: "実装と違っていたため",
    根拠: "app/a.txt:1",
    ...(sources === undefined ? {} : { 確かめたソース: sources }),
    読者向けの改訂履歴: "対象外",
    "変更者・承認者": "Claude・依頼者",
    ...extra,
  });
/** 「確かめたが変更なし」の節 */
const confirm = (dir, docs, sources, extra = {}) =>
  rec(dir, docs, sources, { 改訂箇所: "なし（確かめただけ）", 改訂内容: "変更なし", 改訂意図: "a の変更が文書に影響しないことを確かめた", 根拠: undefined, ...extra });

const stale = (dir, name = "usage") => analyze(dir).groups.find((g) => g.name === name).stale;
const sourcesOfCand = (s) => s.candidates.map((c) => `${c.doc}|${c.source}|${c.count}`).sort();

// ---------------------------------------------------------------------------
// 書き込みのときの検査（基準5の前半）
// ---------------------------------------------------------------------------

test("確かめたソース: 引用符と :行 を外して正規化し、ルートからのパスでない・実在しない・追跡されていないものは書かない", () => {
  assert.deepEqual(normalizeSources("`app/a.txt:10-20`, \"app/b.txt\"、./app/c.txt#L3"), ["app/a.txt", "app/b.txt", "app/c.txt"]);
  assert.deepEqual(normalizeSources(["app/a.txt", "app/a.txt:5"]), ["app/a.txt"], "同じパスは1つにする");
  const { dir } = project();
  put(dir, "app/new.txt", "untracked\n"); // 実在するが git に add していない
  const before = fs.readFileSync(path.join(dir, ".claude", "rules", "doc-brief-usage.md"), "utf-8");
  const bad = (v, re) => assert.throws(() => rec(dir, [DOC], v), re);
  bad("/etc/passwd", /ルートからのパスでない/);
  bad("C:/Users/x/a.txt", /ルートからのパスでない/);
  bad("../outside.txt", /ルートからのパスでない/);
  bad("app/nothere.txt", /実在するファイルでない/);
  bad("app", /実在するファイルでない/); // ディレクトリ
  bad("app/new.txt", /git が追跡していない/);
  bad("app/a.txt, app/new.txt", /app\/new\.txt/); // 1つでも外れていれば全体を書かない
  assert.ok(!fs.existsSync(path.join(dir, "docs-style", "history", "usage.md")), "拒んだときは、記録のファイルも作らない");
  assert.equal(fs.readFileSync(path.join(dir, ".claude", "rules", "doc-brief-usage.md"), "utf-8"), before);
  const { section } = rec(dir, [DOC], "`app/a.txt:10-20`, \"app/b.txt\"");
  assert.match(section, /\| 確かめたソース \| app\/a\.txt, app\/b\.txt \|/);
  const { section: s2 } = rec(dir, [DOC], ["./app/a.txt"]);
  assert.match(s2, /\| 確かめたソース \| app\/a\.txt \|/);
  const { section: s3 } = rec(dir, [DOC], undefined); // 必須ではない
  assert.doesNotMatch(s3, /確かめたソース/);
});

test("確かめたソース: git の管理下でないプロジェクトでは、実在だけを見る", () => {
  const { dir } = project({ git: false });
  assert.throws(() => rec(dir, [DOC], "app/nothere.txt"), /実在するファイルでない/);
  assert.doesNotThrow(() => rec(dir, [DOC], "app/a.txt"));
});

test("確かめたが変更なし: 節の形（改訂箇所「なし」・改訂内容「変更なし」・読者向けの改訂履歴「対象外」）で見分ける", () => {
  const { dir } = project();
  const a = confirm(dir, [DOC], "app/a.txt");
  assert.equal(isConfirmOnly(parseSections(a.section)[0]), true);
  const b = rec(dir, [DOC], "app/a.txt");
  assert.equal(isConfirmOnly(parseSections(b.section)[0]), false);
  const c = confirm(dir, [DOC], "app/a.txt", { 読者向けの改訂履歴: "手順1：直しました" });
  assert.equal(isConfirmOnly(parseSections(c.section)[0]), false, "読者向けの改訂履歴を書いた節は、文書を直した節");
});

// ---------------------------------------------------------------------------
// 判定（基準1〜3）
// ---------------------------------------------------------------------------

test("候補（基準1）: 確かめた後にソースへのコミットがあれば出る。記録と同じコミットで文書とソースを変えたら出ない", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt, app/b.txt");
  commit(g, "record");
  assert.deepEqual(stale(dir).candidates, [], "記録と同じコミットより後に、ソースの変更が無い");
  put(dir, "app/a.txt", "a2\n");
  commit(g, "a2");
  let s = stale(dir);
  assert.deepEqual(sourcesOfCand(s), [`${DOC}|app/a.txt|1`]);
  assert.match(s.candidates[0].command, /^git log -p [0-9a-f]{7}\.\.HEAD -- app\/a\.txt$/);
  put(dir, "app/a.txt", "a3\n");
  commit(g, "a3");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${DOC}|app/a.txt|2`], "基準点からのコミットの数");
  // 同じコミットで、文書・ソース・記録を変える: b は候補にならない。a は、a を挙げた最新の節（最初の記録）が基準点のままなので残る
  put(dir, "app/b.txt", "b2\n");
  put(dir, DOC, fs.readFileSync(path.join(dir, DOC), "utf-8").replace("1. 押す", "1. 緑のボタンを押す"));
  rec(dir, [DOC], "app/b.txt");
  commit(g, "doc + source + record");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${DOC}|app/a.txt|2`]);
});

test("候補（基準2）: テイスト変更・リンクの付け替えで文書だけが新しくなっても、候補は消えない。文書を移すと、記録と対応が切れた文書として出る", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "record");
  put(dir, "app/a.txt", "a2\n");
  commit(g, "a2");
  // テイスト変更（確かめたソースを書かない節）
  put(dir, DOC, fs.readFileSync(path.join(dir, DOC), "utf-8").replace("1. 押す", "1. 押します"));
  rec(dir, [DOC], undefined, { 改訂箇所: "全体", 改訂内容: "です・ます調に揃えた", 改訂意図: "文体の統一", 根拠: undefined });
  commit(g, "tone");
  // リンクの付け替え（リンク元の文書。事実を確かめていないので確かめたソースは書かない）
  put(dir, INDEX, "# 使い方\n\n[電話のかけ方](phone.md#手順)\n");
  rec(dir, [INDEX], undefined, { 改訂箇所: "リンク", 改訂内容: "アンカーを付けた", 改訂意図: "リンクの付け替え", 根拠: undefined });
  commit(g, "link");
  let s = stale(dir);
  assert.deepEqual(sourcesOfCand(s), [`${DOC}|app/a.txt|1`], "文書の最終コミットは見ない");
  assert.equal(s.untraceable.includes(INDEX), true, "リンク元は、確かめたソースが無いので追随できない文書");
  // 移動: 記録は旧パスの名前で残る
  g("mv", DOC, "docs/usage/call.md");
  commit(g, "move");
  s = stale(dir);
  assert.deepEqual(s.candidates, []);
  assert.deepEqual(
    s.detached.map((d) => d.key),
    ["phone.md"],
    "旧パスの名前の記録が、今のどの文書にも当たらない"
  );
  assert.ok(s.untraceable.includes("docs/usage/call.md"), "移した先は、新しいパスで1節を足すまで追随できない");
});

test("候補（基準3）: 最新の節が別のソースだけでも、古い節のソースを判定する。そのソースを挙げた新しい節が入れば、基準点が進む", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "S1: a");
  put(dir, "app/b.txt", "b2\n");
  rec(dir, [DOC], "app/b.txt", { 改訂箇所: "手順2", 根拠: "app/b.txt:1" });
  commit(g, "S2: b");
  assert.deepEqual(stale(dir).candidates, [], "S2 の後は、どちらも変わっていない");
  put(dir, "app/a.txt", "a2\n");
  commit(g, "a2");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${DOC}|app/a.txt|1`], "最新の節（S2）は a を挙げていないが、S1 の a が判定される");
  confirm(dir, [DOC], "app/a.txt");
  commit(g, "S3: confirm a");
  assert.deepEqual(stale(dir).candidates, [], "a を挙げた最新の節（S3）が新しい基準点");
});

test("候補（基準3）: 枝のマージで、記録より後にソースの変更が入った場合も出る。コミットの時刻には頼らない", () => {
  const { dir, g } = project();
  const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "record");
  g("branch", "side", "HEAD~1"); // 記録のコミットより前から分かれた枝
  g("checkout", "-q", "side");
  put(dir, "app/a.txt", "side\n");
  g("add", "app/a.txt");
  const old = "2000-01-01T00:00:00";
  const saved = [process.env.GIT_AUTHOR_DATE, process.env.GIT_COMMITTER_DATE];
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = old; // 記録のコミットより古い時刻
  try {
    g("commit", "-q", "-m", "side change");
  } finally {
    for (const [k, v] of [["GIT_AUTHOR_DATE", saved[0]], ["GIT_COMMITTER_DATE", saved[1]]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  g("checkout", "-q", branch);
  assert.deepEqual(stale(dir).candidates, [], "マージ前");
  g("merge", "--no-ff", "-q", "-m", "merge side", "side");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${DOC}|app/a.txt|1`], "時刻が古くても、記録の後から HEAD までの範囲に入った");
});

// ---------------------------------------------------------------------------
// 「確かめたが変更なし」（基準4）
// ---------------------------------------------------------------------------

test("確かめたが変更なし（基準4）: 節を足すと候補が消える。節がまだコミットされていなければ今を基準点にする", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "record");
  put(dir, "app/a.txt", "a2\n");
  commit(g, "a2");
  assert.equal(stale(dir).candidates.length, 1);
  confirm(dir, [DOC], "app/a.txt"); // コミットしていない
  assert.deepEqual(stale(dir).candidates, [], "コミット前の節は、今を基準点にする（候補にしない）");
  commit(g, "confirm");
  assert.deepEqual(stale(dir).candidates, []);
  put(dir, "app/a.txt", "a3\n");
  commit(g, "a3");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${DOC}|app/a.txt|1`], "確かめた後の変更は、また候補になる");
});

test("確かめたが変更なし: 確かめたソースの無い節は書かない（無いと候補が消えない）。完了処理は走らせない（記録をコミットするだけ）", () => {
  const { dir } = project();
  assert.throws(() => confirm(dir, [DOC], undefined), /確かめたソースが要る/);
  assert.doesNotThrow(() => confirm(dir, [DOC], "app/a.txt"));
});

test("完了処理の警告: 根拠があるのに確かめたソースが無い（確かめたソースを使い始めた文書群で、根拠にファイルのパスらしい語があるときだけ）", () => {
  const { dir, g } = project();
  rec(dir, [DOC], undefined); // 使い始める前: 根拠だけ
  const briefs = loadBriefs(dir);
  put(dir, DOC, fs.readFileSync(path.join(dir, DOC), "utf-8") + "\n");
  assert.deepEqual(checkDoc(dir, DOC, { briefs }).warnings, [], "使い始める前の記録に、警告を出さない");
  commit(g, "r1");
  rec(dir, [DOC], "app/a.txt");
  commit(g, "r2");
  rec(dir, [DOC], undefined, { 改訂箇所: "手順2" });
  put(dir, DOC, fs.readFileSync(path.join(dir, DOC), "utf-8") + "\n");
  const w = checkDoc(dir, DOC, { briefs }).warnings;
  assert.equal(w.length, 1, w.join("\n"));
  assert.match(w[0], /根拠はあるが確かめたソースが無い/);
  commit(g, "r3");
  rec(dir, [DOC], undefined, { 改訂箇所: "手順3", 根拠: "依頼者の判断（2026-10-07）" });
  put(dir, DOC, fs.readFileSync(path.join(dir, DOC), "utf-8") + "\n");
  assert.deepEqual(checkDoc(dir, DOC, { briefs }).warnings, [], "根拠がファイルでなければ警告しない");
});

// ---------------------------------------------------------------------------
// 状態の出し分け（基準5の後半）
// ---------------------------------------------------------------------------

test("状態: 確かめたソースの無い文書は「追随できない文書」。既定の出力は本数だけ、--stale は一覧", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "record");
  const s = stale(dir);
  assert.deepEqual(s.untraceable, [INDEX]);
  const text = renderText(analyze(dir));
  assert.match(text, /### 7\. 古くなった候補/);
  assert.match(text, /追随できない文書（確かめたソースの記録が無い）: 1 本（--stale で一覧）/);
  assert.doesNotMatch(text, new RegExp(`- ${INDEX}`));
  const detail = renderStale(analyze(dir));
  assert.match(detail, new RegExp(`追随できない文書（確かめたソースの記録が無い）: 1 本\\n- ${INDEX}`));
  assert.doesNotMatch(detail, /### 1\./, "--stale は7つ目の項目だけ");
  const cli = spawnSync(process.execPath, [DOCSET_CLI, "--stale", "--dest", dir], { encoding: "utf-8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`- ${INDEX}`));
  const json = JSON.parse(spawnSync(process.execPath, [DOCSET_CLI, "--json", "--dest", dir], { encoding: "utf-8" }).stdout);
  assert.deepEqual(json.groups.find((x) => x.name === "usage").stale.untraceable, [INDEX]);
});

test("状態: 確かめたソースが追跡されていない・消えた。移した先が git の rename で分かれば添える", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt, app/b.txt");
  commit(g, "record");
  g("mv", "app/a.txt", "app/moved-a.txt");
  fs.unlinkSync(path.join(dir, "app", "b.txt"));
  commit(g, "move a, delete b");
  const s = stale(dir);
  assert.deepEqual(s.candidates, []);
  assert.deepEqual(
    s.lost.map((l) => [l.source, l.movedTo]).sort(),
    [["app/a.txt", "app/moved-a.txt"], ["app/b.txt", null]]
  );
  assert.match(renderText(analyze(dir)), /確かめたソースが追跡されていない・消えた[\s\S]*app\/a\.txt（移した先の候補: app\/moved-a\.txt）/);
});

test("状態: 記録の置き場所が無い（ブリーフが当たらない文書）は分けて出す", () => {
  const { dir } = project({ brief: false });
  const s = stale(dir, "（include 全体）");
  assert.deepEqual(s.noPlace.sort(), [INDEX, DOC].sort());
  assert.deepEqual(s.candidates, []);
  assert.match(renderText(analyze(dir)), /記録の置き場所が無い（この文書群にはブリーフが当たらず、内部の改訂記録が書けない）ので、追随できない: 2 本/);
});

test("状態: git の管理下でない・git コマンドが無いときは、判定しない（ファイルの更新時刻で比べない）", () => {
  const { dir } = project({ git: false });
  rec(dir, [DOC], "app/a.txt");
  put(dir, "app/a.txt", "a2\n"); // 更新時刻は新しい
  const s = stale(dir);
  assert.equal(s.state, "not-repo");
  assert.deepEqual(s.candidates, []);
  assert.match(renderText(analyze(dir)), /git が無い（または git の管理下でない）ので、判定できない/);
  // git コマンドが無い（PATH を空にする）
  const saved = process.env.PATH;
  const savedWin = process.env.Path;
  try {
    process.env.PATH = "";
    if (savedWin !== undefined) process.env.Path = "";
    const ctx = docsetContext(dir);
    assert.equal(staleAnalysis(ctx).state, "no-git");
  } finally {
    process.env.PATH = saved;
    if (savedWin !== undefined) process.env.Path = savedWin;
  }
});

test("状態: 記録の対象の文書にいま無いパスがある（文書の削除・移動）。確かめたソースの無い節だけなら出さない", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  rec(dir, [INDEX], undefined, { 根拠: undefined });
  commit(g, "record");
  g("rm", "-q", "-f", INDEX);
  g("mv", DOC, "docs/usage/call.md");
  commit(g, "remove / move");
  const s = stale(dir);
  assert.deepEqual(s.detached.map((d) => d.key), ["phone.md"]);
  assert.match(renderText(analyze(dir)), /記録と対応が切れた文書[\s\S]*- phone\.md（節「/);
});

// ---------------------------------------------------------------------------
// サブフォルダー・日本語のパス・速さ
// ---------------------------------------------------------------------------

test("リポジトリのサブフォルダーにあるプロジェクトと日本語のパスでも判定できる", () => {
  const files = { "docs/使い方/電話.md": "# 電話\n\n## 手順\n", "アプリ/設定.txt": "設定\n" };
  const { dir, root } = project({ files, sub: "プロジェクト", paths: ["docs/使い方/**"], git: false });
  put(root, "外.md", "# 外\n");
  put(root, "外のソース.txt", "外\n");
  const gr = gitIn(root);
  commit(gr, "init");
  const doc = "docs/使い方/電話.md";
  rec(dir, [doc], "アプリ/設定.txt:3");
  commit(gr, "record");
  assert.deepEqual(stale(dir).candidates, []);
  assert.throws(() => rec(dir, [doc], "../外のソース.txt"), /ルートからのパスでない/);
  put(root, "外のソース.txt", "外2\n"); // プロジェクトの外の変更は関係しない
  put(dir, "アプリ/設定.txt", "設定2\n");
  commit(gr, "change");
  assert.deepEqual(sourcesOfCand(stale(dir)), [`${doc}|アプリ/設定.txt|1`]);
  assert.match(stale(dir).candidates[0].command, /\.\.HEAD -- アプリ\/設定\.txt$/);
  fs.unlinkSync(path.join(dir, "アプリ", "設定.txt")); // rmSync は、この環境の Node で日本語のパスに当たると落ちた
  commit(gr, "delete");
  assert.deepEqual(stale(dir).lost.map((l) => l.source), ["アプリ/設定.txt"]);
});

test("速さ: 文書とソースが数百あっても、本数に比例して git を起動しない（記録の履歴・追跡の一覧・基準点ごとの範囲だけ）", () => {
  const files = { ...FILES };
  const docs = [];
  const sources = [];
  for (let i = 0; i < 250; i++) {
    files[`docs/usage/p${i}.md`] = `# p${i}\n\n## 手順\n`;
    docs.push(`docs/usage/p${i}.md`);
  }
  for (let i = 0; i < 120; i++) {
    files[`app/s${i}.txt`] = `${i}\n`;
    sources.push(`app/s${i}.txt`);
  }
  const { dir, g } = project({ files });
  rec(dir, docs, sources.join(", "));
  commit(g, "record");
  put(dir, "app/s7.txt", "changed\n");
  commit(g, "s7");
  const t0 = Date.now();
  const s = stale(dir);
  const ms = Date.now() - t0;
  assert.equal(s.candidates.length, 250, "s7 を確かめた250本が候補（1本につき1つのソース）");
  assert.ok(s.candidates.every((c) => c.source === "app/s7.txt"));
  assert.ok(ms < 5000, `250本・120ソースで ${ms}ms（本数ぶん git を起動していると、桁が違う）`);
});

// ---------------------------------------------------------------------------
// 対象のアプリの版（ブリーフの項目）
// ---------------------------------------------------------------------------

test("対象のアプリの版: ブリーフの項目として書ける。必須にせず、「仮定」でも確かめる項目に出さない。決まっていなければ文書群の見直しが1行出す", () => {
  const { dir } = project({ readerHistory: "あり" });
  assert.match(renderText(analyze(dir)), /対象のアプリの版: 決まっていない/);
  assert.equal(analyze(dir).groups.find((x) => x.name === "usage").appVersion, null);
  writeBrief(dir, { name: "usage", by: "書き手", set: { 読者向けの改訂履歴: { 対象のアプリの版: "`app/build.gradle` の `versionName`" } } });
  const b = loadBriefs(dir)[0];
  assert.equal(b.group["読者向けの改訂履歴"]["対象のアプリの版"].status, "仮定");
  assert.equal(b.unreadable.length, 0);
  const m = missingItems(b, "phone.md");
  assert.ok(![...m.missing, ...m.assumed].some((x) => x.includes("対象のアプリの版")), "聞く項目にも、確かめる項目にも出さない");
  assert.doesNotMatch(renderText(analyze(dir)), /対象のアプリの版: 決まっていない/);
  assert.match(analyze(dir).groups.find((x) => x.name === "usage").appVersion, /versionName/);
  writeBrief(dir, { name: "usage", set: { 読者向けの改訂履歴: { 対象のアプリの版: "書かない" } } });
  assert.equal(loadBriefs(dir)[0].group["読者向けの改訂履歴"]["対象のアプリの版"].value, "書かない");
});

test("読者向けの改訂履歴が「なし」の文書群には、「対象のアプリの版: 決まっていない」を出さない", () => {
  const { dir } = project({ readerHistory: "なし" });
  assert.doesNotMatch(renderText(analyze(dir)), /対象のアプリの版/);
});

// ---------------------------------------------------------------------------
// 査読で直したもの
// ---------------------------------------------------------------------------

test("記録ファイルを git mv しても、基準点が動かない。雛形のコメントの中の見出しは拾わない", () => {
  const { dir, g } = project();
  rec(dir, [DOC], "app/a.txt");
  commit(g, "record");
  put(dir, "app/a.txt", "a2\n");
  commit(g, "a2");
  assert.equal(stale(dir).candidates.length, 1);
  // 記録のフォルダーごと移す（historyDir の変更）。移したコミットに全部の節が足された行として出ない
  g("mv", "docs-style/history", "docs-style/h2");
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"], historyDir: "docs-style/h2" }));
  commit(g, "move dir");
  assert.equal(stale(dir).candidates.length, 1, "フォルダーごと移しても、基準点が移したコミットに動かない");
  assert.equal(stale(dir).candidates[0].count, 1);
});

test("速さ: 基準点が数十個あっても、基準点の数だけ git を起動しない", () => {
  const files = { ...FILES };
  for (let i = 0; i < 40; i++) files[`app/s${i}.txt`] = `${i}\n`;
  const { dir, g } = project({ files });
  for (let i = 0; i < 40; i++) {
    rec(dir, [DOC], `app/s${i}.txt`, { 改訂箇所: `手順${i}` });
    commit(g, `record ${i}`);
  }
  for (let i = 0; i < 40; i += 2) {
    put(dir, `app/s${i}.txt`, "changed\n");
    commit(g, `change ${i}`);
  }
  const t0 = Date.now();
  const s = stale(dir);
  const ms = Date.now() - t0;
  assert.equal(s.candidates.length, 20);
  assert.ok(s.candidates.every((c) => c.count === 1));
  assert.ok(ms < 3000, `基準点40個で ${ms}ms`);
});

test("記録と対応が切れた文書: 削除済みは分ける。exclude で対象外にした文書・リンクだけ直した文書は出し続けない", () => {
  const files = { ...FILES, "docs/usage/gone.md": "# gone\n", "docs/usage/draft.md": "# draft\n" };
  const { dir, g } = project({ files });
  rec(dir, ["docs/usage/gone.md", "docs/usage/draft.md", DOC], "app/a.txt");
  commit(g, "record");
  g("rm", "-q", "-f", "docs/usage/gone.md");
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"], exclude: ["docs/usage/draft.md"] }));
  commit(g, "delete gone, exclude draft");
  const s = stale(dir);
  assert.deepEqual(s.detached, []);
  assert.deepEqual(s.deleted.map((d) => d.key), ["gone.md"]);
  assert.match(renderText(analyze(dir)), /削除済みの文書.*: 1 本/);
});

test("--brief で絞ったときは、絞った文書群の文書だけで古くなった候補を計算する", () => {
  const files = { ...FILES, "docs/ref/r.md": "# r\n" };
  const { dir, g } = project({ files });
  writeBrief(dir, { name: "ref", title: "リファレンス", paths: ["docs/ref/**"], set: { 読者: { プロファイル: "engineer", 読者像: "開発者" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } }, outOfScope: ["なし"] });
  commit(g, "ref brief");
  const r = analyze(dir, { brief: "ref" });
  assert.deepEqual(r.groups.map((x) => x.name), ["ref"]);
  assert.deepEqual(r.groups[0].stale.untraceable, ["docs/ref/r.md"]);
});
