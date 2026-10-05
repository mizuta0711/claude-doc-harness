/**
 * commit-check.mjs: コマンドの形の読み取り（0.10.0 の実装の確かめ直しで見つかった形 N1〜N7）。
 * 記録の無い文書を含むコミットを、どの形でも見失わないか。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeBrief } from "../plugins/harness-doc/scripts/brief.mjs";
import { run, stripHeredocs, readCommand } from "../plugins/harness-doc/hooks/scripts/commit-check.mjs";

const DOC = "docs/usage/phone.md";

function repo({ config = { include: ["docs/**/*.md"] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-forms-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify(config));
    writeBrief(dir, {
      name: "usage",
      title: "利用者向けの使い方",
      paths: ["docs/usage/**"],
      set: { 読者: { プロファイル: "beginner", 読者像: "初めて使う人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
      outOfScope: ["なし"],
    });
  }
  fs.mkdirSync(path.join(dir, "docs", "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, DOC), "# 電話\n\n1. 押す\n");
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  fs.appendFileSync(path.join(dir, DOC), "\n2. 話す\n"); // 記録の無い変更
  return dir;
}

const bash = (cwd, command) => run({ tool_name: "Bash", tool_input: { command }, cwd }).decision;
const ps = (cwd, command) => run({ tool_name: "PowerShell", tool_input: { command }, cwd }).decision;

test("stripHeredocs: 印・本文・終わりの行を消し、同じ行の残りと後ろのコマンドを残す", () => {
  assert.equal(stripHeredocs("cat <<'EOF'\nhi\nEOF\ngit commit -m x -- a.md"), "cat \ngit commit -m x -- a.md");
  assert.equal(stripHeredocs(`git commit -m "$(cat <<'EOF'\nfix "q\nEOF\n)" -- a.md`), `git commit -m "$(cat \n)" -- a.md`);
  assert.equal(stripHeredocs("git commit -F - -- a.md <<'EOF'\nmsg\n  EOF\nEOF"), "git commit -F - -- a.md ", "<< の終わりの行は行頭から");
  assert.equal(stripHeredocs("cat <<-EOF\n\tmsg\n\tEOF\nls"), "cat \nls", "<<- は行頭のタブを許す");
  assert.equal(stripHeredocs("git commit -m @'\nit's\n'@ -- a.md", "powershell"), "git commit -m '' -- a.md");
});

test("N1: ヒアドキュメントの後ろのコミットを見失わない", () => {
  const dir = repo();
  assert.equal(bash(dir, `cat <<'EOF'\nhi\nEOF\ngit commit -m x -- ${DOC}`), "deny");
  assert.equal(bash(dir, `git add ${DOC}\ncat <<'EOF'\nhi\nEOF\ngit commit -m x`), "deny");
  assert.equal(bash(dir, `cat > ${DOC} <<'EOF'\nhi\nEOF\ngit commit -m x -- ${DOC}`), "deny", "文書を書き換えてからのコミット");
});

test("N2: 作業フォルダーが文書ハーネスでなくても、cd・-C の先がそうなら、再現できない形を止める", () => {
  const proj = repo();
  const plain = repo({ config: null });
  const p = proj.replace(/\\/g, "/");
  assert.equal(bash(plain, `cd "${p}" && git commit -m a -- ${DOC} && git commit -m b -- ${DOC}`), "deny");
  assert.equal(bash(plain, `git -C "${p}" commit -m a -- ${DOC} && git -C "$X" commit -m b`), "deny");
  const q = plain.replace(/\\/g, "/");
  assert.equal(bash(proj, `git -C "${q}" commit --allow-empty -m a && git -C "${q}" commit --allow-empty -m b`), "deny", "作業フォルダーのプロジェクトも数える（安全側）");
  assert.equal(readCommand(`cd "${p}" && git commit -m a`, { cwd: plain }).dirs.length, 2);
});

test("N3: リダイレクトの付いたコミットも、コミットとして数える", () => {
  const dir = repo();
  assert.equal(bash(dir, `git commit -m x -- ${DOC} > out.txt`), "deny");
  assert.equal(bash(dir, `git commit -m x -- ${DOC} 2> err.log`), "deny");
});

test("N4: if の条件の中の書き換えを見逃さない", () => {
  const dir = repo();
  assert.equal(bash(dir, `if sed -i s/a/b/ ${DOC}; then git commit -m x -- ${DOC}; fi`), "deny");
});

test("N5: PowerShell のヒアストリングの文言（引用符を含む）でも、後ろのパスを見失わない", () => {
  const dir = repo();
  assert.equal(ps(dir, `git commit -m @"\nfix "a\n"@ -- ${DOC}`), "deny");
  assert.equal(ps(dir, `git commit -m @'\nit's fixed\n'@ -- ${DOC}`), "deny");
});

test("N6・N7: cmd /c の cd /d を読む。cd - は行き先を決められない", () => {
  const dir = repo();
  const r = readCommand(`cmd /c "cd /d ${dir} && git commit -m x"`, { cwd: os.tmpdir() });
  assert.equal(r.commits[0].dir, dir);
  assert.ok(readCommand(`cd - && git commit -m x`, { cwd: dir }).unsupported);
});

test("G2: skip の理由は「改訂の記録なしでコミットする: <理由>」の形だけ受け付ける（承認の画面の本文で読めるように）", () => {
  const dir = repo();
  assert.equal(bash(dir, `git commit -m "doc-record: skip（ツールが直した）" -- ${DOC}`), "deny");
  const r = run({ tool_name: "Bash", tool_input: { command: `git commit -m "doc-record: skip（ツールが直した）" -- ${DOC}` }, cwd: dir });
  assert.match(r.lines.join("\n"), /改訂の記録なしでコミットする: <理由>/);
  assert.equal(bash(dir, `git commit -m "doc-record: skip（改訂の記録なしでコミットする: ツールが直した）" -- ${DOC}`), "ask");
});
