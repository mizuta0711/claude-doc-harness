/**
 * check-docs: 前からある指摘を止めず、増えた指摘だけを止める（0.12.0。DocumentTemplete background/08）
 * と、用語集の「例外」の列（L5）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseGlossary, checkWords, tokenizeLines, diffIssues, headText } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { run as commitRun } from "../plugins/harness-doc/hooks/scripts/commit-check.mjs";
import { writeBrief } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection } from "../plugins/harness-doc/scripts/history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "..", "plugins", "harness-doc", "hooks", "scripts", "check-docs.mjs");

const BANNED = "適宜\n";

/** 文書ハーネスを入れた一時のプロジェクト。git=true なら git init して全部をコミットする。sub があればリポジトリのサブフォルダーをプロジェクトにする */
function project({ git = true, sub = "", files = {}, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-"));
  const dir = path.join(root, sub);
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs-style"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md", "docs/**/*.html"], ...config }));
  fs.writeFileSync(path.join(dir, "docs-style", "banned-words.txt"), BANNED);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  if (git) {
    const g = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
    g("init", "-q");
    g("config", "core.autocrlf", "false");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  }
  return dir;
}

function hook(dir, rel) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(dir, rel) }, cwd: dir }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

function cli(dir, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf-8", cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
}

const DOC = "docs/a.md";
const OLD = "# 題\n\n設定は適宜変える。\n";

test("T1: 前からある指摘だけなら止めず、additionalContext で件数を伝える", () => {
  const dir = project({ files: { [DOC]: OLD } });
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n別の行を足した。\n");
  const r = hook(dir, DOC);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /前からある指摘 1 件/);
});

test("T2: 増えた指摘があれば止め、増えた組だけを出し、前からある件数を添える", () => {
  const dir = project({ files: { [DOC]: OLD }, config: { include: ["docs/**/*.md"] } });
  fs.writeFileSync(path.join(dir, "docs-style", "banned-words.txt"), "適宜\nなるべく\n");
  // 前の版も今の決まりで検査するので、「なるべく」を足したときだけ増える
  fs.writeFileSync(path.join(dir, DOC), OLD + "\nなるべく早く。\n");
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /なるべく/);
  assert.doesNotMatch(r.stderr, /「適宜」/);
  assert.match(r.stderr, /前からある指摘 1 件は止めていない/);
});

test("T3: 同じ曖昧語を別の行に足すと（1件 → 2件）止め、組の行を全部出す", () => {
  const dir = project({ files: { [DOC]: OLD } });
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n手順も適宜変える。\n");
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.split("\n").filter((l) => /^\s+L\d+\s+曖昧語「適宜」/.test(l)).length, 2);
  assert.match(r.stderr, /2 件のうち 1 件が増えた/);
});

test("T4: 新しいファイル（未追跡・ステージ済み）は全部止め、前の版を読めなかったと添える", () => {
  const dir = project({ files: { [DOC]: OLD } });
  fs.writeFileSync(path.join(dir, "docs/b.md"), OLD);
  let r = hook(dir, "docs/b.md");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /前の版（直前のコミット）を読めなかった/);
  execFileSync("git", ["-C", dir, "add", "docs/b.md"]);
  r = hook(dir, "docs/b.md");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /前の版（直前のコミット）を読めなかった/);
});

test("T5: git でないフォルダーでは全部止める", () => {
  const dir = project({ git: false, files: { [DOC]: OLD } });
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /曖昧語「適宜」/);
});

test("T6: プロジェクトがリポジトリのサブフォルダーにあっても、前の版を読める", () => {
  const dir = project({ sub: "proj", files: { [DOC]: OLD } });
  assert.equal(headText(path.join(dir, DOC)), OLD);
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n足した。\n");
  assert.equal(hook(dir, DOC).status, 0);
});

test("T7: 名前が日本語のファイル・HTML（CRLF）でも前からある指摘を止めない", () => {
  const html = '<!doctype html><html lang="ja"><body>\r\n<h1>題</h1>\r\n<p>設定は適宜変える。</p>\r\n</body></html>\r\n';
  const dir = project({ files: { "docs/使い方.html": html, "docs/手順.md": OLD } });
  fs.writeFileSync(path.join(dir, "docs/使い方.html"), html.replace("</body>", "<p>足した。</p>\r\n</body>"));
  assert.equal(hook(dir, "docs/使い方.html").status, 0);
  fs.writeFileSync(path.join(dir, "docs/手順.md"), OLD + "\n足した。\n");
  assert.equal(hook(dir, "docs/手順.md").status, 0);
});

test("T8: リンク切れは、前からあっても止める", () => {
  const dir = project({ files: { [DOC]: "# 題\n\n[先](gone.md)\n" } });
  fs.writeFileSync(path.join(dir, DOC), "# 題\n\n[先](gone.md)\n\n足した。\n");
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gone\.md/);
});

test("T9: markdownlint / textlint の指摘は比べずに止める", () => {
  const dir = project({ files: { [DOC]: "# 題\n\n本文。\n" } });
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "markdownlint.cmd"), "@echo lint-error 1>&2\r\n@exit /b 1\r\n");
  else {
    fs.writeFileSync(path.join(bin, "markdownlint"), "#!/bin/sh\necho lint-error >&2\nexit 1\n");
    fs.chmodSync(path.join(bin, "markdownlint"), 0o755);
  }
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /markdownlint が失敗しました/);
});

test("T10: CLI は全部を出す。--changed を付けると増えた分だけで判定する", () => {
  const dir = project({ files: { [DOC]: OLD } });
  fs.writeFileSync(path.join(dir, DOC), OLD + "\n足した。\n");
  assert.equal(cli(dir, [DOC]).status, 2);
  const r = cli(dir, ["--changed", DOC]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK: docs\/a\.md（前からある指摘 1 件/);
});

test("diffIssues: 件数で比べ、リンクは比べない", () => {
  const i = (kind, message) => ({ kind, message, line: 1 });
  const d = diffIssues([i("banned", "x"), i("banned", "x"), i("link", "l")], [i("banned", "x"), i("link", "l")]);
  assert.equal(d.kept, 1);
  assert.deepEqual(d.groups.map((g) => [g.message, g.total, g.extra]), [["x", 2, 1], ["l", 1, 1]]);
});

test("T12: コミット時の検査が、直前のコミットより増えた指摘を止める", () => {
  const dir = project({ files: { [DOC]: "# 題\n\n本文。\n" }, config: { include: ["docs/**/*.md"] } });
  writeBrief(dir, {
    name: "d",
    title: "文書",
    paths: ["docs/**"],
    set: { 読者: { プロファイル: "beginner", 読者像: "初めての人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
    outOfScope: ["なし"],
  });
  fs.writeFileSync(path.join(dir, DOC), "# 題\n\n本文。適宜変える。\n");
  addSection(dir, { doc: DOC, size: "S", 改訂箇所: "本文", 改訂内容: "足した", 改訂意図: "要った", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者" });
  const r = commitRun({ tool_name: "Bash", tool_input: { command: `git add -A && git commit -m x` }, cwd: dir });
  assert.equal(r.decision, "deny", r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /check-docs の指摘が直前のコミットより増えている: 曖昧語「適宜」/);
});

/** 記録まで足した、コミットを頼む直前の状態を作る */
function readyToCommit(files, edit) {
  const dir = project({ files, config: { include: ["docs/**/*.md"] } });
  writeBrief(dir, {
    name: "d",
    title: "文書",
    paths: ["docs/**"],
    set: { 読者: { プロファイル: "beginner", 読者像: "初めての人" }, 読者向けの改訂履歴: { 読者向けの改訂履歴: "なし" } },
    outOfScope: ["なし"],
  });
  edit(dir);
  addSection(dir, { doc: DOC, size: "S", 改訂箇所: "本文", 改訂内容: "足した", 改訂意図: "要った", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者" });
  return dir;
}
const commit = (dir, msg = "x") => commitRun({ tool_name: "Bash", tool_input: { command: `git add -A && git commit -m "${msg}"` }, cwd: dir });

test("コミット時の検査: 前からある指摘・前からあるリンク切れだけなら通す", () => {
  const dir = readyToCommit({ [DOC]: "# 題\n\n設定は適宜変える。\n\n[先](gone.md)\n" }, (d) => fs.appendFileSync(path.join(d, DOC), "\n足した。\n"));
  const r = commit(dir);
  assert.ok(["allow", "warn"].includes(r.decision), r.lines.join("\n"));
});

test("コミット時の検査: 増えた指摘は doc-record: skip でも通さない（記録の承認に見せない）", () => {
  const dir = readyToCommit({ [DOC]: "# 題\n\n本文。\n" }, (d) => fs.appendFileSync(path.join(d, DOC), "\n適宜変える。\n"));
  const r = commit(dir, "doc-record: skip（改訂の記録なしでコミットする: テスト）");
  assert.equal(r.decision, "deny", r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /直前のコミットより増えている/);
  assert.match(r.lines.join("\n"), /doc-record: skip では通らない/);
});

test("フック: 前からあるリンク切れは止めるが、前からあると添える", () => {
  const dir = project({ files: { [DOC]: "# 題\n\n[先](gone.md)\n" } });
  fs.appendFileSync(path.join(dir, DOC), "\n足した。\n");
  const r = hook(dir, DOC);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /直前のコミットにもある。リンク切れは前からあっても止める/);
});

test("--changed をファイル無しで呼ぶと、標準入力を待たずに使い方を出す", () => {
  const r = spawnSync(process.execPath, [scriptPath, "--changed"], { encoding: "utf-8", input: "", timeout: 10000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test("loadStyle が読み込み元を渡し、メッセージに出る（docs-style と glossaryFiles）", async () => {
  const { loadStyle, loadConfig } = await import("../plugins/harness-doc/hooks/scripts/check-docs.mjs");
  const dir = project({ git: false, files: { ".claude/rules/terms.md": "| 使う | 使わない |\n|---|---|\n| ユーザー | ユーザ |\n" }, config: { glossaryFiles: [".claude/rules/terms.md"] } });
  fs.writeFileSync(path.join(dir, "docs-style", "glossary.md"), "| 推奨表記 | 禁止表記 |\n|---|---|\n| サーバー | サーバ |\n");
  const style = loadStyle(dir, loadConfig(dir).config);
  const msgs = checkWords(tokenizeLines("サーバとユーザ。").lines, { bannedWords: [], glossary: style.glossary }).map((i) => i.message);
  assert.ok(msgs.some((m) => m.includes("（docs-style/glossary.md）")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes("（.claude/rules/terms.md）")), msgs.join("\n"));
});

// ---------------------------------------------------------------------------
// 用語集の「例外」の列
// ---------------------------------------------------------------------------

test("見出しに「例外」を含む禁止の列（禁止（例外あり））の表も、今までどおり読む", () => {
  assert.deepEqual(parseGlossary("| 推奨 | 禁止（例外あり） | 意味 |\n|---|---|---|\n| ユーザー | ユーザ | 使う人 |\n"), [{ preferred: "ユーザー", banned: ["ユーザ"] }]);
});

const words = (text, glossary) => checkWords(tokenizeLines(text).lines, { bannedWords: [], glossary });

test("T13: 例外の列の無い表は、今までどおり except を持たない", () => {
  assert.deepEqual(parseGlossary("| 推奨表記 | 禁止表記 | 意味 |\n|---|---|---|\n| ユーザー | ユーザ | 使う人 |\n"), [{ preferred: "ユーザー", banned: ["ユーザ"] }]);
});

test("T14: 例外の語の一部としての禁止表記は検出しない。例外に無い語の途中は止まる", () => {
  const g = parseGlossary("| 推奨表記 | 禁止表記 | 例外 | 意味 |\n|---|---|---|---|\n| ユーザー | ユーザ | ユーザビリティ | 使う人 |\n");
  assert.deepEqual(g[0].except, ["ユーザビリティ"]);
  assert.equal(words("ユーザビリティを上げる。", g).length, 0);
  assert.equal(words("エンドユーザに渡す。", g).length, 1);
});

test("T15: 例外に無い語は止まる。同じ行に例外の語と禁止表記があれば止まる", () => {
  const g = parseGlossary("| 推奨表記 | 禁止表記 | 例外 | 意味 |\n|---|---|---|---|\n| ユーザー | ユーザ | ユーザビリティ | 使う人 |\n");
  assert.equal(words("ユーザインタフェースを見る。", g).length, 1);
  assert.equal(words("ユーザビリティとユーザの話。", g).length, 1);
});

test("T16: 例外の列が左にある・見出しが「例外（そのまま使う語）」・値がバッククォート・— ・除く", () => {
  const left = parseGlossary("| 例外（そのまま使う語） | 推奨表記 | 禁止表記 |\n|---|---|---|\n| `ユーザビリティ`、`ユーザ車` | ユーザー | ユーザ |\n");
  assert.deepEqual(left, [{ preferred: "ユーザー", banned: ["ユーザ"], except: ["ユーザビリティ", "ユーザ車"] }]);
  const none = parseGlossary("| 推奨表記 | 禁止表記 | 例外 |\n|---|---|---|\n| サーバー | サーバ | — |\n");
  assert.deepEqual(none[0].except, []);
  const exclude = parseGlossary("| 使う | 使わない | 除く語 |\n|---|---|---|\n| ユーザー | ユーザ | ユーザビリティ |\n");
  assert.deepEqual(exclude[0].except, ["ユーザビリティ"]);
  const short = parseGlossary("| 推奨表記 | 禁止表記 | 例外 | 意味 |\n|---|---|---|---|\n| サーバー | サーバ | 機械 |\n");
  assert.deepEqual(short[0].except, [], "列の数が足りない行は、意味の列を例外と取り違えない");
  const banHead = parseGlossary("| 使う | 使わない（固有名詞を除く） |\n|---|---|\n| ユーザー | ユーザ |\n");
  assert.deepEqual(banHead, [{ preferred: "ユーザー", banned: ["ユーザ"] }], "禁止の列の見出しの「除く」は例外の列にしない");
});

test("T17: メッセージに読み込み元のファイル名と、例外の列への案内がある", () => {
  const g = parseGlossary("| 使う | 使わない |\n|---|---|\n| ユーザー | ユーザ |\n", ".claude/rules/japanese-terms.md");
  const [i] = words("ユーザが押す。", g);
  assert.match(i.message, /（\.claude\/rules\/japanese-terms\.md）。この語を認めるなら、その表の「例外」の列に足す（列が無ければ足す）/);
});

test("T16: HTML の本文でも例外が効く（フック）", () => {
  const html = '<!doctype html><html lang="ja"><body><h1>題</h1><p>ユーザビリティを上げる。</p></body></html>\n';
  const dir = project({ git: false, files: { "docs/a.html": html } });
  fs.writeFileSync(path.join(dir, "docs-style", "glossary.md"), "| 推奨表記 | 禁止表記 | 例外 |\n|---|---|---|\n| ユーザー | ユーザ | ユーザビリティ |\n");
  const r = hook(dir, "docs/a.html");
  assert.equal(r.status, 0, r.stderr);
});
