/**
 * check-docs の HTML 対応の検査。
 * 「本文として読むもの」と「読まないもの」の境界を守る。誤検出は利用者の信頼を最も早く失わせる。
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
  htmlProseLines,
  parseBannedWords,
  parseGlossary,
} from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const scaffoldDir = path.join(repoRoot, "plugins", "harness-doc", "scaffold");
// 検査ロジックの試験には、項目の揃ったハーネス自身の docs-style を使う（scaffold の用語集は空で配る）
const styleDir = path.join(repoRoot, "docs-style");
const scriptPath = path.join(repoRoot, "plugins", "harness-doc", "hooks", "scripts", "check-docs.mjs");

const style = {
  bannedWords: parseBannedWords(fs.readFileSync(path.join(styleDir, "banned-words.txt"), "utf-8")),
  glossary: parseGlossary(fs.readFileSync(path.join(styleDir, "glossary.md"), "utf-8")),
};
const html = (body) => checkDocument(body, { config: DEFAULT_CONFIG, style, format: "html" });
const kinds = (issues) => issues.map((i) => i.kind);

test("本文の曖昧語を検出し、行番号を保つ", () => {
  const issues = html("<html>\n<body>\n<p>必要に応じて再起動する。</p>\n</body>\n</html>\n");
  assert.deepEqual(kinds(issues), ["banned"]);
  assert.equal(issues[0].line, 3);
});

test("HTML のバッククォートはただの文字なので、中の曖昧語も検出する（囲むなら <code>）", () => {
  assert.deepEqual(kinds(html("<p>`適宜` は曖昧語。</p>")), ["banned"]);
});

test("タグをまたいだ語も1語として読む", () => {
  assert.deepEqual(kinds(html("<p>必要に<b>応じて</b>再起動する。</p>")), ["banned"]);
});

test("読まないもの: script / style / pre / code / kbd / コメント / 属性値", () => {
  const body = [
    "<script>const s = '適宜';</script>",
    "<style>/* 適宜 */ .a{}</style>",
    "<pre><code class=\"language-bash\">echo 適宜</code></pre>",
    "<p>語を説明するときは <code>適宜</code> のように囲む。<kbd>適宜</kbd></p>",
    "<!-- 適宜 -->",
    "<img alt=\"適宜\" title=\"サーバ\" src=\"data:image/png;base64,AAAA\">",
    "<template><p>適宜</p></template>",
  ].join("\n");
  assert.deepEqual(html(body), []);
});

test("複数行にまたがる script とコメントの中も読まない", () => {
  const body = "<p>a</p>\n<script>\nconst x = 1;\n// 適宜\n</script>\n<!--\n必要に応じて\n-->\n<p>適宜</p>\n";
  const issues = html(body);
  assert.deepEqual(kinds(issues), ["banned"]);
  assert.equal(issues[0].line, 9);
});

test("用語集: 禁止表記を検出し、推奨表記の一部としての出現は見逃す。文字実体参照も戻して読む", () => {
  assert.deepEqual(kinds(html("<p>サーバーを再起動する。</p>")), []);
  assert.deepEqual(kinds(html("<p>サーバを再起動する。</p>")), ["glossary"]);
  assert.deepEqual(kinds(html("<p>Claude&nbsp;Code と ClaudeCode</p>")), ["glossary"]);
});

test("行内の ignore マーカーで抑止できる", () => {
  assert.deepEqual(html("<p>製品名「〇〇サーバ」</p> <!-- check-docs: ignore 固有名詞 -->"), []);
});

test("skip マーカー: 冒頭にあれば全検査を飛ばす", () => {
  assert.deepEqual(html("<!DOCTYPE html>\n<!-- check-docs: skip 生成物 -->\n<p>適宜</p>"), []);
});

test("コードブロックの言語指定は HTML では検査しない", () => {
  assert.deepEqual(html("<pre>npm install</pre>"), []);
});

test("必須見出し: h1〜h6 の中身（入れ子のタグを除く）で判定する", () => {
  const base =
    "<!-- doc-type: howto -->\n<h1>t</h1>\n<h2>この文書で<em>できること</em></h2>\n<h2>前提条件</h2>\n<h2 id=\"s\">手順</h2>\n<h3>確認</h3>\n";
  const missing = html(base);
  assert.deepEqual(kinds(missing), ["heading"]);
  assert.match(missing[0].message, /「うまくいかない場合」/);
  assert.deepEqual(html(base + "<h2>うまくいかない場合</h2>\n"), []);
});

test("リンク切れ: href / src の相対パスを見る。クエリ・アンカー・外部・テンプレートは扱いを分ける", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-html-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "style.css"), "");
  fs.writeFileSync(path.join(dir, "ok.html"), "");
  const doc = path.join(dir, "page.html");
  const body = [
    '<link rel="stylesheet" href="assets/style.css?v=1.0.2">',
    "<a href='ok.html#top'>ok</a>",
    '<a href="https://example.com/x.html">web</a> <a href="mailto:a@b">m</a> <a href="#top">t</a>',
    '<a href="//cdn.example.com/a.js">cdn</a> <a href="${base}/x.html">tpl</a>',
    '<img src="assets/missing.png">',
    "<!-- <a href=\"commented.html\">x</a> -->",
    "<script>el.innerHTML = '<a href=\"in-script.html\">';</script>",
    '<a href="gone.html">gone</a>',
  ].join("\n");
  const issues = checkDocument(body, { filePath: doc, config: DEFAULT_CONFIG, style });
  assert.deepEqual(
    issues.map((i) => [i.kind, i.line, i.message]),
    [
      ["link", 5, "リンク切れ: assets/missing.png"],
      ["link", 8, "リンク切れ: gone.html"],
    ]
  );
});

test("htmlProseLines: CRLF でも行番号がずれない", () => {
  const lines = htmlProseLines("<p>a</p>\r\n<p>b</p>\r\n");
  assert.equal(lines[1].text, "b");
});

test("checkFile: 既定の include は docs/ 配下の .html も対象にする", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-html-"));
  fs.mkdirSync(path.join(dir, "docs", "web"), { recursive: true });
  const f = path.join(dir, "docs", "web", "index.html");
  fs.writeFileSync(f, "<p>適宜</p>");
  const r = checkFile(f, dir, DEFAULT_CONFIG, style);
  assert.equal(r.rel, "docs/web/index.html");
  assert.deepEqual(kinds(r.issues), ["banned"]);
  const outside = path.join(dir, "web.html");
  fs.writeFileSync(outside, "<p>適宜</p>");
  assert.equal(checkFile(outside, dir, DEFAULT_CONFIG, style), null);
});

test("フック: .html を書くと終了コード 2 で理由を stderr に出す", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-html-proj-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.cpSync(styleDir, path.join(dir, "docs-style"), { recursive: true });
  fs.copyFileSync(path.join(scaffoldDir, ".claude", "doc-harness.config.json"), path.join(dir, ".claude", "doc-harness.config.json"));
  const file = path.join(dir, "docs", "x.html");
  fs.writeFileSync(file, "<!DOCTYPE html>\n<p>しばらく待つ。</p>\n");
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: dir }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /docs\/x\.html に 1 件/);
  assert.match(r.stderr, /L2 +曖昧語「しばらく」/);
});
