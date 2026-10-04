/**
 * commit-check.mjs（コミット時の検査）の検査。
 * フックの入力（JSON）を run() に渡し、git が作るコミットの中身で判定しているかを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeBrief } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection } from "../plugins/harness-doc/scripts/history.mjs";
import { run, commitOptions } from "../plugins/harness-doc/hooks/scripts/commit-check.mjs";

const DOC = "docs/usage/phone.md";

function repo({ config = { include: ["docs/**/*.md"] }, brief = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-check-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify(config));
  if (brief)
    writeBrief(dir, {
      name: "usage",
      title: "利用者向けの使い方",
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

const edit = (dir, rel = DOC) => fs.appendFileSync(path.join(dir, rel), "\n2. 話す\n");
const record = (dir, doc = DOC, date = "2026-10-05") =>
  addSection(dir, {
    doc,
    size: "S",
    改訂箇所: "手順2",
    改訂内容: "手順2を足した",
    改訂意図: "通話の始め方が抜けていた",
    読者向けの改訂履歴: "対象外",
    "変更者・承認者": "Claude・依頼者",
  }, date);
const HISTORY = "docs-style/history/usage.md";
const bash = (dir, command, cwd = dir) => run({ tool_name: "Bash", tool_input: { command }, cwd });

test("記録の無い文書: add と commit を1つのコマンドでつないでも、パス指定のコミットでも止める", () => {
  const { dir } = repo();
  edit(dir);
  assert.equal(bash(dir, `git add ${DOC} && git commit -m "x"`).decision, "deny");
  assert.equal(bash(dir, `git commit -m "x" -- ${DOC}`).decision, "deny");
  assert.equal(bash(dir, `git commit -F - -- ${DOC} <<'EOF'\nmsg\nEOF`).decision, "deny", "ヒアドキュメントの文言");
});

test("記録があれば通す。パス指定のコミットに記録のファイルが入っていなければ止める", () => {
  const { dir } = repo();
  edit(dir);
  record(dir);
  assert.equal(bash(dir, `git add ${DOC} ${HISTORY} && git commit -m "x"`).decision, "allow");
  assert.equal(bash(dir, `git commit -m "x" -- ${DOC} ${HISTORY}`).decision, "allow");
  assert.equal(bash(dir, `git commit -m "x" -- ${DOC}`).decision, "deny", "記録はコミットに入らない");
});

test("-a は追跡済みの変更だけを入れる（追跡していない新しい文書は数えない）", () => {
  const { dir, g } = repo();
  edit(dir);
  record(dir); // 記録のファイルを追跡させる
  g("add", "-A");
  g("commit", "-q", "-m", "history");
  edit(dir);
  record(dir, DOC, "2026-10-06");
  fs.writeFileSync(path.join(dir, "docs", "usage", "new.md"), "# 新しい\n");
  assert.equal(bash(dir, `git commit -am "x"`).decision, "allow");
});

test("引用符の中の git commit・config の無いリポジトリ・completeCheck off では何もしない", () => {
  const { dir } = repo();
  edit(dir);
  assert.equal(bash(dir, `echo "git commit -m x"`).decision, "allow");
  const plain = repo({ config: null });
  edit(plain.dir);
  assert.equal(bash(plain.dir, `git commit -am "x"`).decision, "allow");
  const off = repo({ config: { include: ["docs/**/*.md"], completeCheck: "off" } });
  edit(off.dir);
  assert.equal(bash(off.dir, `git commit -am "x"`).decision, "allow");
  const warn = repo({ config: { include: ["docs/**/*.md"], completeCheck: "warn" } });
  edit(warn.dir);
  assert.equal(bash(warn.dir, `git commit -am "x"`).decision, "warn");
});

test("doc-record: skip（理由）は依頼者の承認（ask）。理由が空なら止める", () => {
  const { dir } = repo();
  edit(dir);
  const ask = bash(dir, `git commit -m "README の誤字 doc-record: skip（dev-harness の update-docs が直した）" -- ${DOC}`);
  assert.equal(ask.decision, "ask");
  assert.match(ask.lines[0], /依頼者の承認/);
  assert.equal(bash(dir, `git commit -m "doc-record: skip（）" -- ${DOC}`).decision, "deny");
});

test("ブリーフが無いプロジェクトは警告だけ（setup-project を案内する）", () => {
  const { dir } = repo({ brief: false });
  edit(dir);
  const r = bash(dir, `git commit -am "x"`);
  assert.equal(r.decision, "warn");
  assert.match(r.lines[0], /setup-project/);
});

test("作業中の改訂設計書が同じコミットに入っていれば警告だけ。入っていなければ止める", () => {
  const { dir, g } = repo();
  fs.mkdirSync(path.join(dir, "docs-style", "plans"), { recursive: true });
  const plan = "docs-style/plans/20261005_phone.md";
  fs.writeFileSync(path.join(dir, plan), "# 改訂設計書: phone\n\n| 項目 | 内容 |\n|---|---|\n| 状態 | 作業中 |\n| 対象の文書 | `docs/usage/phone.md` |\n");
  edit(dir);
  assert.equal(bash(dir, `git commit -m "x" -- ${DOC} ${plan}`).decision, "warn");
  g("add", plan);
  g("commit", "-q", "-m", "plan");
  assert.equal(bash(dir, `git commit -m "x" -- ${DOC}`).decision, "deny", "前のコミットに残った「作業中」では外さない");
});

test("--amend は1つ前の版と比べる（記録の入ったコミットの文言だけを直しても止めない）", () => {
  const { dir, g } = repo();
  edit(dir);
  record(dir);
  g("add", "-A");
  g("commit", "-q", "-m", "x");
  assert.equal(bash(dir, `git commit --amend -m "y"`).decision, "allow");
});

test("commit より前に作業ツリーを変えうるコマンドがあれば、分けるよう止める", () => {
  const { dir } = repo();
  edit(dir);
  const r = bash(dir, `node build.mjs && git commit -m "x" -- ${DOC}`);
  assert.equal(r.decision, "deny");
  assert.match(r.lines[0], /分ける/);
});

test("cd で移ってからのコミット・git -C・PowerShell", () => {
  const { dir } = repo();
  edit(dir);
  const p = dir.replace(/\\/g, "/");
  assert.equal(bash(dir, `cd "${p}" && git commit -m "x" -- ${DOC}`, os.tmpdir()).decision, "deny");
  assert.equal(bash(dir, `git -C "${p}" commit -m "x" -- ${DOC}`, os.tmpdir()).decision, "deny");
  const ps = run({ tool_name: "PowerShell", tool_input: { command: `git add ${DOC}; git commit -m "x"` }, cwd: dir });
  assert.equal(ps.decision, "deny");
});

test("commit の引数: 束ねた短いオプション・値を取るオプション・-- の後ろ・リダイレクト", () => {
  assert.deepEqual(commitOptions(`-am "msg"`).paths, []);
  assert.equal(commitOptions(`-am "msg"`).all, true);
  assert.deepEqual(commitOptions(`-q -F - -- a.md b.md <<'EOF'`).paths, ["a.md", "b.md"]);
  assert.deepEqual(commitOptions(`--author "a <a@x>" -m x a.md`).paths, ["a.md"]);
  assert.equal(commitOptions(`--amend --no-edit`).amend, true);
});

// ---------------------------------------------------------------------------
// reviewer-guard.mjs（読者役が改訂記録・改訂設計書を読むのを止める）
// ---------------------------------------------------------------------------

test("読者役だけ、改訂記録・改訂設計書の Read と、それを含む範囲の Grep を止める", async () => {
  const { judge } = await import("../plugins/harness-doc/hooks/scripts/reviewer-guard.mjs");
  const { dir } = repo();
  const r = (tool_name, tool_input, agent_type = "harness-doc:doc-reviewer") => judge({ tool_name, tool_input, agent_type, cwd: dir });
  assert.ok(r("Read", { file_path: path.join(dir, "docs-style", "history", "usage.md") }));
  assert.ok(r("Read", { file_path: "docs-style/plans/20261005_x.md" }));
  assert.equal(r("Read", { file_path: path.join(dir, DOC) }), null);
  assert.ok(r("Grep", { pattern: "意図" }), "path なし（ルート）は記録を含む");
  assert.equal(r("Grep", { pattern: "発信", path: "app/src" }), null);
  assert.equal(r("Glob", { pattern: "**/*.md" }), null, "ファイル名の一覧は通す");
  assert.ok(r("Glob", { pattern: "*.md", path: "docs-style/plans" }));
  assert.equal(r("Read", { file_path: "docs-style/history/usage.md" }, null), null, "メインのエージェントは通す");
  assert.equal(r("Read", { file_path: "docs-style/history/usage.md" }, "general-purpose"), null);
});

// ---------------------------------------------------------------------------
// 0.10.0 の実装の査読で見つかった形
// ---------------------------------------------------------------------------

test("C1: ヒアドキュメントの文言に \" が奇数個あっても、後ろの -- <paths> を見失わない", () => {
  const { dir } = repo();
  edit(dir);
  const cmd = `git commit -m "$(cat <<'EOF'\nfix "quote\nit's\nEOF\n)" -- ${DOC}`;
  assert.equal(bash(dir, cmd).decision, "deny");
  record(dir);
  assert.equal(bash(dir, `git add ${DOC} ${HISTORY} && git commit -m "$(cat <<'EOF'\nsize 5" x\nEOF\n)"`).decision, "allow");
});

test("M1: Git Bash のパス（/c/...）の cd と -C を読む。変数・~ を含む移動先は、プロジェクトの中なら止める", { skip: process.platform !== "win32" }, () => {
  const { dir } = repo();
  edit(dir);
  const gb = dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`);
  assert.equal(bash(dir, `cd ${gb} && git commit -m x -- ${DOC}`, os.tmpdir()).decision, "deny");
  assert.equal(bash(dir, `git -C ${gb} commit -m x -- ${DOC}`, os.tmpdir()).decision, "deny");
  assert.equal(bash(dir, `cd "$PROJ" && git commit -m x -- ${DOC}`, dir).decision, "deny");
});

test("M2・M3・M4: git の出力をファイルへ書く・コミットが2つ・パイプの受け手", () => {
  const { dir } = repo();
  edit(dir);
  record(dir);
  assert.equal(bash(dir, `git show HEAD:${DOC} > ${DOC} && git commit -m x -- ${DOC} ${HISTORY}`).decision, "deny");
  assert.equal(bash(dir, `git commit --allow-empty -m a && git add ${DOC} && git commit -m b`).decision, "deny");
  assert.equal(bash(dir, `git add ${DOC} ${HISTORY} && git diff --cached --stat | tail -3 && git commit -m x`).decision, "allow");
  assert.equal(bash(dir, `export X=1 && git add ${DOC} ${HISTORY} && git commit -m x`).decision, "allow");
});

test("再現できない形でも、文書ハーネスのプロジェクトでなければ止めない", () => {
  const plain = repo({ config: null });
  assert.equal(bash(plain.dir, `node build.mjs && git commit -am x`).decision, "allow");
  assert.equal(bash(plain.dir, `git commit --allow-empty -m a && git commit --allow-empty -m b`).decision, "allow");
});

test("P1: -m\"update\" の値を -a と読まない", () => {
  assert.equal(commitOptions(`-m"update" -- a.md`).all, false);
  assert.deepEqual(commitOptions(`-m"update" -- a.md`).paths, ["a.md"]);
  assert.equal(commitOptions(`-qam x`).all, true);
});

test("M5: 再現に失敗しても一時の index を残さない", () => {
  const { dir } = repo();
  edit(dir);
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("harness-doc-index-")).length;
  assert.equal(bash(dir, `git add no-such-file.md && git commit -m x`).decision, "deny");
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("harness-doc-index-")).length;
  assert.equal(after, before);
});

test("M6: 改訂設計書がコミットに入っていなければ、そう言って止める", () => {
  const { dir } = repo();
  const plan = "docs-style/plans/completed/20261005_phone.md";
  fs.mkdirSync(path.join(dir, "docs-style", "plans", "completed"), { recursive: true });
  fs.writeFileSync(path.join(dir, plan), "# p\n\n| 項目 | 内容 |\n|---|---|\n| 状態 | 完了 |\n\n## 前後確認\n\n事実の変更なし\n");
  edit(dir);
  addSection(dir, { doc: DOC, size: "M", 改訂箇所: "手順2", 改訂内容: "足した", 改訂意図: "抜けていた", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者", 改訂設計書: plan });
  const r = bash(dir, `git commit -m x -- ${DOC} ${HISTORY}`);
  assert.equal(r.decision, "deny");
  assert.match(r.lines.join("\n"), /このコミットに入っていない/);
  assert.equal(bash(dir, `git commit -m x -- ${DOC} ${HISTORY} ${plan}`).decision, "allow");
});

test("P4: 読者役は基準点（.git/harness-doc/）も読めない。サブフォルダーからでもプロジェクトの設定で判定する", async () => {
  const { judge } = await import("../plugins/harness-doc/hooks/scripts/reviewer-guard.mjs");
  const { dir } = repo();
  const r = (input, cwd = dir) => judge({ tool_name: "Read", tool_input: input, agent_type: "harness-doc:doc-reviewer", cwd });
  assert.ok(r({ file_path: path.join(dir, ".git", "harness-doc", "baseline.json") }));
  assert.ok(r({ file_path: path.join(dir, "docs-style", "history", "usage.md") }, path.join(dir, "docs")));
});
