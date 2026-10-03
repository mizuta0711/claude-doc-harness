/**
 * check-docs.mjs の判定ロジックの検査。
 * 依存パッケージは使わない（node:test / node:assert のみ）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_CONFIG,
  checkDocument,
  checkFile,
  detectDocType,
  globToRegExp,
  matchesAny,
  parseBannedWords,
  parseGlossary,
  tokenizeLines,
} from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const scriptPath = path.join(repoRoot, "plugins", "harness-doc", "hooks", "scripts", "check-docs.mjs");
const scaffoldDir = path.join(repoRoot, "plugins", "harness-doc", "scaffold");
// 検査ロジックの試験には、項目の揃ったハーネス自身の docs-style を使う（scaffold の用語集は空で配る）
const styleDir = path.join(repoRoot, "docs-style");

const style = {
  bannedWords: parseBannedWords(fs.readFileSync(path.join(styleDir, "banned-words.txt"), "utf-8")),
  glossary: parseGlossary(fs.readFileSync(path.join(styleDir, "glossary.md"), "utf-8")),
};

const kinds = (issues) => issues.map((i) => i.kind);

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

test("globToRegExp: ** は階層をまたぎ、* はまたがない", () => {
  assert.ok(globToRegExp("docs/**/*.md").test("docs/a.md"));
  assert.ok(globToRegExp("docs/**/*.md").test("docs/guide/a.md"));
  assert.ok(!globToRegExp("docs/*.md").test("docs/guide/a.md"));
  assert.ok(globToRegExp("README.md").test("README.md"));
  assert.ok(!globToRegExp("README.md").test("docs/README.md"));
  assert.ok(matchesAny("docs\\handoff\\x.md", ["docs/handoff/**"]), "Windows 区切りも一致する");
});

// ---------------------------------------------------------------------------
// docs-style の読込
// ---------------------------------------------------------------------------

test("parseBannedWords: 空行と # 行を無視する", () => {
  assert.deepEqual(parseBannedWords("# c\n\n適宜\n など \n"), ["適宜", "など"]);
});

test("parseGlossary: 見出し行・区切り行を飛ばし、禁止表記を複数に割る", () => {
  const rows = parseGlossary(
    "| 推奨表記 | 禁止表記 | 意味 |\n|---|---|---|\n| サーバー | サーバ | x |\n| Claude Code | ClaudeCode、claude code | y |\n| 固有 | — | z |\n"
  );
  assert.deepEqual(rows, [
    { preferred: "サーバー", banned: ["サーバ"] },
    { preferred: "Claude Code", banned: ["ClaudeCode", "claude code"] },
    { preferred: "固有", banned: [] },
  ]);
});

// ---------------------------------------------------------------------------
// 字句
// ---------------------------------------------------------------------------

test("tokenizeLines: フェンスの中を散文として扱わない", () => {
  const { lines } = tokenizeLines("a\n```bash\n適宜\n```\nb");
  assert.deepEqual(
    lines.map((l) => [l.no, l.inCode, l.fenceOpen, l.lang]),
    [
      [1, false, false, null],
      [2, true, true, "bash"],
      [3, true, false, null],
      [4, true, false, null],
      [5, false, false, null],
    ]
  );
});

test("detectDocType: 冒頭のマーカーだけを見る", () => {
  assert.equal(detectDocType("# t\n\n<!-- doc-type: howto -->\n"), "howto");
  assert.equal(detectDocType("# t\n" + "x\n".repeat(20) + "<!-- doc-type: howto -->\n"), null);
});

// ---------------------------------------------------------------------------
// 検査
// ---------------------------------------------------------------------------

test("曖昧語: 本文で検出し、コードブロックとインラインコードでは検出しない", () => {
  const text = "# t\n\n必要に応じて直す。\n\n`適宜` は曖昧語。\n\n```bash\necho 適宜\n```\n";
  const issues = checkDocument(text, { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(issues), ["banned"]);
  assert.equal(issues[0].line, 3);
  assert.match(issues[0].message, /必要に応じて/);
});

test("用語集: 禁止表記を検出し、推奨表記の先頭部分としての出現は見逃す", () => {
  const ok = checkDocument("# t\n\nサーバーを再起動する。ユーザーに通知する。\n", { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(ok), []);
  const ng = checkDocument("# t\n\nサーバを再起動する。\n", { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(ng), ["glossary"]);
  assert.match(ng[0].message, /「サーバ」→「サーバー」/);
});

test("用語集: 行末の ignore マーカーで抑止できる（理由を続けて書ける）", () => {
  const text = "# t\n\n製品名「〇〇サーバ」 <!-- check-docs: ignore 固有名詞 -->\n";
  assert.deepEqual(kinds(checkDocument(text, { config: DEFAULT_CONFIG, style })), []);
});

test("コードブロック: 言語指定が無い開きフェンスを検出する", () => {
  const text = "# t\n\n```\nnpm install\n```\n\n```text\nok\n```\n";
  const issues = checkDocument(text, { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(issues), ["fence"]);
  assert.equal(issues[0].line, 3);
});

test("必須見出し: doc-type がある文書だけ検査し、見出しに語を含めば通る", () => {
  const base = "<!-- doc-type: howto -->\n# t\n\n## この文書でできること\n## 前提条件\n## 手順\n## 確認\n";
  const missing = checkDocument(base, { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(missing), ["heading"]);
  assert.match(missing[0].message, /「うまくいかない場合」/);
  const ok = checkDocument(base + "## うまくいかない場合\n", { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(ok), []);
  const untyped = checkDocument("# t\n\n## 概要\n", { config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(untyped), []);
});

test("リンク切れ: 相対パスだけを見て、外部 URL は無視する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
  const doc = path.join(dir, "a.md");
  fs.writeFileSync(path.join(dir, "exists.md"), "# e\n\n## sec\n");
  const text =
    "# t\n\n[ok](exists.md) [ok2](./exists.md#sec) [web](https://example.com/x.md#nope) [anchor](#top) [ng](missing.md#sec)\n";
  const issues = checkDocument(text, { filePath: doc, config: DEFAULT_CONFIG, style });
  assert.deepEqual(kinds(issues), ["link"]);
  assert.match(issues[0].message, /リンク切れ: missing\.md/);
});

test("アンカー: 行き先の見出しが無ければ止める（Markdown・同じ文書内・HTML の id）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
  const doc = path.join(dir, "a.md");
  fs.writeFileSync(
    path.join(dir, "b.md"),
    "# B\n\n## 設定する\n\n## Step 1: 準備 `config.json`\n\n## 設定する\n\n```bash\n# コメント見出しではない\n```\n"
  );
  fs.writeFileSync(path.join(dir, "c.html"), '<html lang="ja"><body><h2 id="font">文字</h2><a name="old"></a></body></html>');
  const text = [
    "# t",
    "",
    "## 自分の節",
    "",
    "[1](b.md#設定する) [2](b.md#設定する-1) [3](b.md#step-1-準備-configjson) [4](b.md#%E8%A8%AD%E5%AE%9A%E3%81%99%E3%82%8B)",
    "[5](c.html#font) [6](c.html#old) [7](#自分の節)",
    "[ng1](b.md#設定します) [ng2](c.html#size) [ng3](#無い節) [ng4](b.md#コメント見出しではない)",
    "",
  ].join("\n");
  const issues = checkDocument(text, { filePath: doc, config: DEFAULT_CONFIG, style });
  assert.deepEqual(
    issues.map((i) => i.message.match(/^アンカー切れ: ([^\s（]+)/)?.[1]),
    ["b.md#設定します", "c.html#size", "#無い節", "b.md#コメント見出しではない"]
  );
  const off = { ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules, anchors: false } };
  assert.deepEqual(kinds(checkDocument(text, { filePath: doc, config: off, style })), []);
});

test("アンカー: HTML から出ていくリンクも見る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
  const doc = path.join(dir, "a.html");
  fs.writeFileSync(path.join(dir, "b.html"), '<html lang="ja"><body><h2 id="font">文字</h2></body></html>');
  const html =
    '<html lang="ja"><body><h1 id="top-title">t</h1><p><a href="b.html#font">文字の設定</a> <a href="b.html#size">大きさの設定</a> <a href="#top-title">先頭へ</a></p>' +
    '<svg class="mi" aria-hidden="true"><use href="#i-call"></use></svg></body></html>';
  const issues = checkDocument(html, { filePath: doc, config: DEFAULT_CONFIG, style, format: "html" });
  assert.deepEqual(
    issues.filter((i) => i.kind === "link").map((i) => i.message.match(/^アンカー切れ: ([^\s（]+)/)?.[1]),
    ["b.html#size"]
  );
});

test("skip マーカー: 冒頭にあれば全検査を飛ばす", () => {
  const text = "# t\n<!-- check-docs: skip 悪い例 -->\n\n適宜 サーバ\n```\nx\n```\n";
  assert.deepEqual(kinds(checkDocument(text, { config: DEFAULT_CONFIG, style })), []);
});

// ---------------------------------------------------------------------------
// 対象判定（checkFile）
// ---------------------------------------------------------------------------

test("checkFile: include / exclude / styleDir / 拡張子で対象を絞る", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
  const mk = (rel, body = "# t\n") => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };
  const config = { ...DEFAULT_CONFIG, include: ["docs/**/*.md"], exclude: ["docs/handoff/**"] };
  assert.equal(checkFile(mk("docs/a.md"), dir, config, style)?.rel, "docs/a.md");
  assert.equal(checkFile(mk("docs/handoff/h.md"), dir, config, style), null, "exclude");
  assert.equal(checkFile(mk("src/a.md"), dir, config, style), null, "include 外");
  assert.equal(checkFile(mk("docs-style/glossary.md"), dir, config, style), null, "styleDir");
  assert.equal(checkFile(mk("docs/a.txt"), dir, config, style), null, "拡張子");
  const wide = { ...config, include: ["**/*.md"] };
  assert.equal(checkFile(mk(".claude/rules/doc-brief-usage.md"), dir, wide, style), null, "ブリーフは include が広くても検査しない");
});

// ---------------------------------------------------------------------------
// フックとして（stdin → 終了コード）
// ---------------------------------------------------------------------------

function runHook(projectDir, payload) {
  return spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-proj-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.cpSync(styleDir, path.join(dir, "docs-style"), { recursive: true });
  fs.copyFileSync(
    path.join(scaffoldDir, ".claude", "doc-harness.config.json"),
    path.join(dir, ".claude", "doc-harness.config.json")
  );
  return dir;
}

test("フック: 曖昧語を含む .md を書くと終了コード 2 で理由を stderr に出す（受け入れ基準3）", () => {
  const dir = makeProject();
  const file = path.join(dir, "docs", "x.md");
  fs.writeFileSync(file, "# t\n\n必要に応じて再起動する。\n");
  const r = runHook(dir, { tool_name: "Write", tool_input: { file_path: file }, cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[check-docs\] docs\/x\.md に 1 件/);
  assert.match(r.stderr, /曖昧語「必要に応じて」/);
});

test("フック: 違反が無ければ終了コード 0 で何も出さない", () => {
  const dir = makeProject();
  const file = path.join(dir, "docs", "ok.md");
  fs.writeFileSync(file, "# t\n\n```bash\necho ok\n```\n");
  const r = runHook(dir, { tool_name: "Write", tool_input: { file_path: file }, cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("フック: config が無いプロジェクトでは素通りする", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-noconf-"));
  fs.mkdirSync(path.join(dir, "docs"));
  const file = path.join(dir, "docs", "x.md");
  fs.writeFileSync(file, "# t\n\n適宜\n");
  const r = runHook(dir, { tool_name: "Write", tool_input: { file_path: file }, cwd: dir });
  assert.equal(r.status, 0);
});

test("フック: .md 以外・壊れた stdin は素通りする", () => {
  const dir = makeProject();
  const r1 = runHook(dir, { tool_name: "Write", tool_input: { file_path: path.join(dir, "a.ts") } });
  assert.equal(r1.status, 0);
  const r2 = spawnSync(process.execPath, [scriptPath], { input: "{broken", encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(r2.status, 0);
});

// ---------------------------------------------------------------------------
// 同梱物の自己検査
// ---------------------------------------------------------------------------

test("同梱の良い例とテンプレートは検査を通る。悪い例は skip マーカーで対象外になる", () => {
  const skillDir = path.join(repoRoot, "plugins", "harness-doc", "skills", "manual-writer");
  const good = path.join(skillDir, "examples", "good.md");
  const issues = checkDocument(fs.readFileSync(good, "utf-8"), { filePath: good, config: DEFAULT_CONFIG, style });
  assert.deepEqual(issues, [], "good.md: " + issues.map((i) => i.message).join(" / "));
  for (const name of ["howto.md", "reference.md", "spec.md"]) {
    const f = path.join(skillDir, "templates", name);
    const t = checkDocument(fs.readFileSync(f, "utf-8"), { filePath: f, config: DEFAULT_CONFIG, style });
    assert.deepEqual(t, [], `${name}: ` + t.map((i) => i.message).join(" / "));
  }
  const bad = path.join(skillDir, "examples", "bad.md");
  assert.deepEqual(checkDocument(fs.readFileSync(bad, "utf-8"), { filePath: bad, config: DEFAULT_CONFIG, style }), []);
});
