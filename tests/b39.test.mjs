/**
 * 0.13.0: B1（SimplePhone の使い方サイトの書き直し）の評価の指摘への対応（DocumentTemplete backlog B38・B39）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeBrief } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection } from "../plugins/harness-doc/scripts/history.mjs";
import { checkDoc, parsePlan } from "../plugins/harness-doc/scripts/complete-doc.mjs";
import { loadBriefs } from "../plugins/harness-doc/scripts/brief.mjs";
import { loadStyle, loadConfig } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { readCommand, substituteVars } from "../plugins/harness-doc/hooks/scripts/commit-check.mjs";
import { extractSection, writerHandoff } from "../plugins/harness-doc/presets/show.mjs";
import { defaultAnswer } from "../tools/fieldtest/default-answer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(here, "..", "plugins", "harness-doc", "hooks", "scripts", "check-docs.mjs");
const COMPLETE = path.join(here, "..", "plugins", "harness-doc", "scripts", "complete-doc.mjs");
const DOC = "docs/a.md";
const PLAN = "docs-style/plans/20261006_a.md";

const g = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b39-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs-style"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  fs.writeFileSync(path.join(dir, "docs-style", "banned-words.txt"), "適宜\n");
  writeBrief(dir, {
    name: "d",
    title: "文書",
    paths: ["docs/**"],
    set: { 読者: { プロファイル: "beginner", 読者像: "初めての人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
    outOfScope: ["なし"],
  });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  g(dir, "init", "-q");
  g(dir, "config", "core.autocrlf", "false");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "init");
  return dir;
}

function plan({ queries = "", review = "| 1 | 要修正 | 手順1 | 分かりにくい | 対応済み |", mismatch = "", limit = "1.5" } = {}) {
  return `# 改訂設計書: a

| 項目 | 内容 |
|---|---|
| 状態 | 完了 |
| 対象の文書 | \`${DOC}\` |
| 性質と規模 | 改訂・M |

## 受け入れ基準

- [x] 1. 読者ができる

## 改訂方針

| 項目 | 内容 |
|---|---|
| 分量の上限 | 今の ${limit} 倍まで |

## 食い違い

| 番号 | 箇所 | 前の記述 | 今の動き | 根拠 | 今の動きとして書くなら（案の文） | 依頼者の選択 |
|---|---|---|---|---|---|---|
${mismatch}

## 読者役の指摘

| 回 | 重大度 | 場所 | 要旨 | 対応 |
|---|---|---|---|---|
${review}

## 問い合わせ

| 番号 | 確かめられなかった事実 | 何で確かめようとしたか | 回答 |
|---|---|---|---|
${queries}

## 前後確認

事実の変更なし
`;
}

function withPlan(dir, body, planText) {
  fs.writeFileSync(path.join(dir, DOC), body);
  fs.mkdirSync(path.join(dir, "docs-style", "plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, PLAN), planText);
  addSection(dir, { doc: DOC, size: "M", 改訂箇所: "手順", 改訂内容: "直した", 改訂意図: "要った", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者", 改訂設計書: PLAN });
  const { config } = loadConfig(dir);
  return checkDoc(dir, DOC, { briefs: loadBriefs(dir), config, style: loadStyle(dir, config), strict: true });
}

const OLD = "# 題\n\n手順を書く。\n";

test("parsePlan: 問い合わせ・分量の上限・読者役の指摘・食い違いの選択の空を読む", () => {
  const p = parsePlan(plan({ queries: "| Q1 | 入手先 | コード | |\n| Q2 | 接続先 | コード | 2026-10-06 依頼者: x |", mismatch: "| M1 | 手順2 | 鳴る | 鳴らない | TODO | 鳴りません | |" }));
  assert.deepEqual([...p.queries], [["Q1", ""], ["Q2", "2026-10-06 依頼者: x"]]);
  assert.equal(p.limit, 1.5);
  assert.equal(p.reviewRows, 1);
  assert.deepEqual(p.mismatchOpen, ["M1"]);
  assert.equal(parsePlan("# x\n").reviewRows, null, "節の無い古い設計書は数えない");
});

test("問い合わせの印: 未回答の番号は警告、回答済み・表に無い番号は NG（B1 の評価 #3）", () => {
  const dir = project({ [DOC]: OLD });
  const r = withPlan(dir, "# 題\n\n手順を書く。<!-- 問い合わせ: Q1 -->\n入手先。<!-- 問い合わせ: Q2 -->\n接続先。<!-- 問い合わせ: Q9 -->\n", plan({ queries: "| Q1 | a | b | |\n| Q2 | c | d | 依頼者: x |" }));
  assert.match(r.warnings.join("\n"), /未回答の問い合わせの印: Q1/);
  assert.match(r.problems.join("\n"), /回答済みの問い合わせの印が残っている: Q2/);
  assert.match(r.problems.join("\n"), /問い合わせ表に無い番号の印: Q9/);
});

test("問い合わせの印: 番号の無い印は NG。1つの印の番号を全部読む。回答の列は見出しの位置で読む（0.13.0 の査読）", () => {
  const dir = project({ [DOC]: OLD });
  const r = withPlan(
    dir,
    "# 題\n\n入手先。<!-- 問い合わせ: 入手先 -->\n両方。<!-- 問い合わせ: Q1・Q2 -->\n欠け。<!-- 問い合わせ: Q3 -->\n",
    plan({ queries: "| Q1 | a | b | |\n| Q2 | c | d | 依頼者: x |\n| Q3 | e | f |" })
  );
  assert.match(r.problems.join("\n"), /番号の無い問い合わせの印が 1 個/);
  assert.match(r.problems.join("\n"), /回答済みの問い合わせの印が残っている: Q2/);
  assert.match(r.warnings.join("\n"), /未回答の問い合わせの印: Q1・Q3/, "列の欠けた行の「何で確かめようとしたか」を回答と読まない");
});

test("食い違いの印は問い合わせ表の Q 番号で照らす: 「製品を直すまで書かない」は回答が空で警告、選択が空なら NG", () => {
  const dir = project({ [DOC]: OLD });
  const r = withPlan(
    dir,
    "# 題\n\n鳴る。<!-- 問い合わせ: Q5 -->\n",
    plan({ queries: "| Q5 | 鳴るか | コード | |", mismatch: "| Q5 | 手順2 | 鳴る | 鳴らない | TODO | 鳴りません | 製品を直すまで書かない |" })
  );
  assert.deepEqual(r.problems.filter((p) => /問い合わせ|食い違い/.test(p)), []);
  assert.match(r.warnings.join("\n"), /未回答の問い合わせの印: Q5/);
});

test("読者役の指摘の表が空・食い違いの選択が空なら NG", () => {
  const dir = project({ [DOC]: OLD });
  const r = withPlan(dir, OLD + "\n足した。\n", plan({ review: "", mismatch: "| M1 | a | b | c | d | e | |" }));
  assert.match(r.problems.join("\n"), /「読者役の指摘」の表が空/);
  assert.match(r.problems.join("\n"), /依頼者の選択が空の行がある: M1/);
});

test("分量の上限を超えたら警告。推量の表現が増えたら警告", () => {
  const dir = project({ [DOC]: OLD });
  const r = withPlan(dir, OLD + "\nもっと長い説明を足す。さらに説明を足していく。出ないはずです。\n", plan({ limit: "1.2" }));
  assert.match(r.warnings.join("\n"), /分量の上限（1\.2 倍）を超えた/);
  assert.match(r.warnings.join("\n"), /推量の表現.*1 件増えた/);
});

test("compare --limit: 上限を超えたら ⚠️ を出す", () => {
  const dir = project({ [DOC]: OLD });
  spawnSync(process.execPath, [COMPLETE, "--mark", "--dest", dir, DOC]);
  fs.writeFileSync(path.join(dir, DOC), OLD + "\nもっと長い説明を足す。さらに説明を足していく。\n");
  const r = spawnSync(process.execPath, [COMPLETE, "compare", "--limit", "1.2", "--dest", dir, DOC], { encoding: "utf-8" });
  assert.match(r.stdout, /分量の上限（1\.2 倍）を超えた/);
  const r2 = spawnSync(process.execPath, [COMPLETE, "compare", "--limit", "9", "--dest", dir, DOC], { encoding: "utf-8" });
  assert.doesNotMatch(r2.stdout, /分量の上限/);
  const r3 = spawnSync(process.execPath, [COMPLETE, "compare", "--limit", DOC, "--dest", dir], { encoding: "utf-8" });
  assert.equal(r3.status, 2, "値の無い --limit は止める");
});

test("改行コード: .gitattributes で git が改行コードを揃えるなら警告しない。-text なら警告する（B1 の評価 #13）", () => {
  const crlf = "# 題\r\n\r\n手順を書く。\r\n";
  for (const [attr, warn] of [["*.md text eol=lf\n", false], ["*.md -text\n", true]]) {
    const dir = project({ [DOC]: crlf, ".gitattributes": attr });
    spawnSync(process.execPath, [COMPLETE, "--mark", "--dest", dir, DOC]);
    withPlan(dir, "# 題\n\n手順を書く。\n足した。\n", plan());
    const r = spawnSync(process.execPath, [COMPLETE, "--dest", dir, DOC], { encoding: "utf-8" });
    assert.equal(/改行コードが作業前/.test(r.stdout + r.stderr), warn, attr + r.stdout + r.stderr);
  }
});

test("フック: 作業中の基準点に登録された文書へのリンク切れ・アンカー切れは止めない。登録されていない・古い基準点なら止める（B1 の評価 #7）", () => {
  const dir = project({ [DOC]: OLD, "docs/b.md": "# B\n" });
  spawnSync(process.execPath, [COMPLETE, "--mark", "--dest", dir, DOC, "docs/b.md", "docs/c.md"]);
  const hook = () =>
    spawnSync(process.execPath, [CHECK], { input: JSON.stringify({ tool_input: { file_path: path.join(dir, DOC) }, cwd: dir }), encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n[c](c.md) と [b の節](b.md#honnin)\n");
  let r = hook();
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /作業中の文書.*2 件は止めていない/);
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n[d](d.md)\n");
  assert.equal(hook().status, 2, "基準点に無い文書へのリンク切れは止める");
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n[自分](a.md#nothere)\n");
  assert.equal(hook().status, 2, "自分自身の中のアンカー切れは止める");
  fs.writeFileSync(path.join(dir, "x.txt"), "x");
  g(dir, "add", "x.txt");
  g(dir, "commit", "-q", "-m", "after");
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n[c](c.md)\n");
  assert.equal(hook().status, 0, "基準点の文書に触れないコミット（別の作業）の後も、基準点は使う（0.14.0 の G7）");
  fs.writeFileSync(path.join(dir, "docs", "b.md"), "# B\n\n足した。\n");
  g(dir, "add", "docs/b.md");
  g(dir, "commit", "-q", "-m", "touch b");
  assert.equal(hook().status, 2, "基準点の文書に触れたコミットの後の基準点は使わない");
});

test("commit-check: 文だけの変数の代入を置き換える（B1 の評価 #12）", () => {
  const dir = project({ [DOC]: OLD });
  const r = readCommand(`P="docs/a.md docs-style" && git add -- $P && git commit -F - -- $P <<'EOF'\nmsg\nEOF`, { cwd: dir });
  assert.ok(!r.unsupported, r.unsupported);
  assert.equal(r.commits[0].args.trim(), "-F - -- docs/a.md docs-style");
  assert.equal(substituteVars(`git add "$P"`, new Map([["P", "a b.md"]])), `git add "a b.md"`);
  assert.equal(substituteVars(`echo '$P'`, new Map([["P", "x"]])), `echo '$P'`, "単引用符の中は置き換えない");
  const sub = readCommand(`P=$(ls) && git add $P && git commit -m x`, { cwd: dir });
  assert.equal(sub.commits[0].ops[0].args, "$P", "コマンド置換は覚えない");
  const same = readCommand(`P=a.md git add $P && git commit -m x`, { cwd: dir });
  assert.equal(same.commits[0].ops[0].args, "$P", "代入とコマンドが同じ文なら覚えない");
  const quoted = readCommand(`P="docs/a.md" && git add -- $P && git commit -m 'docs: x' -- $P`, { cwd: dir });
  assert.match(quoted.commits[0].args, /-- docs\/a\.md$/, "単引用符の区間の外は置き換える");
  assert.equal(substituteVars(`git commit -m '$P' -- $P`, new Map([["P", "a.md"]])), `git commit -m '$P' -- a.md`);
  const flow = readCommand(`if true; then P=a.md; else P=b.md; fi; git add -- $P && git commit -m x`, { cwd: dir });
  assert.ok(flow.unsupported || flow.commits[0].ops.some((o) => String(o.args || o.text).includes("$P")), "if の中の代入は覚えない");
});

test("実行役の既定の答え: 事実の確認の問いと推奨の無い問いでは「分からない」を選ぶ（B38）", () => {
  const opts = (...l) => l.map((label) => ({ label }));
  assert.deepEqual(defaultAnswer({ header: "規模", question: "M で？", options: opts("M で進める（推奨）", "L") }), { answer: "M で進める（推奨）", reason: "recommended" });
  assert.equal(defaultAnswer({ header: "事実の確認", question: "入手先は？", options: opts("Google Play（推奨）", "分からない（問い合わせに残す）") }).answer, "分からない（問い合わせに残す）");
  assert.equal(defaultAnswer({ header: "入手先", question: "（依頼者だけが知っている事実です。推奨はありません）入手先は？", options: opts("Google Play", "分からない（問い合わせに残す）") }).answer, "分からない（問い合わせに残す）");
  assert.deepEqual(defaultAnswer({ header: "x", question: "y", options: opts("A", "B") }), { answer: "分からない（問い合わせに残す）", reason: "no-recommendation" });
  assert.equal(
    defaultAnswer({ header: "食い違い", question: "製品の判断", options: opts("全部、今の動きとして書く", "全部、製品を直すまで書かない", "番号で選ぶ") }).answer,
    "全部、製品を直すまで書かない",
    "製品の判断は控えめな側"
  );
  assert.equal(
    defaultAnswer({ header: "事実の確認", question: "窓口は？", options: opts("問い合わせ窓口 support@example.com", "分からない（問い合わせに残す）") }).answer,
    "分からない（問い合わせに残す）",
    "「分からない」を先に探す"
  );
});

test("show.mjs writer-handoff: 事実の確認（止まる操作を含む）・書き方の規則・書かないこと・自己点検を抜き出して足す", () => {
  const out = writerHandoff();
  for (const h of ["## 事実の確認（manual-writer の Step 2）", "## 書き方の規則（manual-writer の Step 4）", "## 図と画面（manual-writer の Step 4）", "## 書かないこと（manual-writer の Step 4）", "## 自己点検（manual-writer の Step 5）", "## 参照の読み方"]) assert.ok(out.includes(h), h);
  assert.match(out, /緊急番号/);
  assert.match(out, /撮るときの手順/, "0.17.0: 図と画面の節が並列の書き手に渡る");
  assert.doesNotMatch(out, /<プラグイン>/);
  assert.equal(extractSection("# a\n## b\nx\n### c\ny\n## d\nz\n", "## b"), "## b\nx\n### c\ny");
  assert.equal(extractSection("## b\n```\n## not\n```\nx\n## d\n", "## b"), "## b\n```\n## not\n```\nx");
});
