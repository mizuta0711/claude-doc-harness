/**
 * 0.19.0: B14（文書群の設計と接続）の検査。
 * リンクの収集（linksOf）・文書群の見直し（docset.mjs）・ブリーフの入口・完了処理の検査（外から入ってくるリンクの切れ・新しい文書の入口）・コミット時の検査。
 * 依存パッケージは使わない（node:test / node:assert のみ）。git は使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { linksOf } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { writeBrief, loadBriefs, missingItems, parseBrief, renderBrief, entriesOf } from "../plugins/harness-doc/scripts/brief.mjs";
import { analyze, docsetContext, duplicatePairs, mentionedDocs, reachOf, resolveLink, renderText } from "../plugins/harness-doc/scripts/docset.mjs";
import { checkDoc, inboundBreaks, markBaseline, setGitContext, CheckTimeout } from "../plugins/harness-doc/scripts/complete-doc.mjs";
import { addSection } from "../plugins/harness-doc/scripts/history.mjs";
import { run } from "../plugins/harness-doc/hooks/scripts/commit-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPLETE_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "complete-doc.mjs");
const DOCSET_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "docset.mjs");

function project(files, { config = { include: ["docs/**/*.md", "docs/**/*.html", "web/**/*.html", "README.md"] }, git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b14-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  if (git) {
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    g("config", "core.autocrlf", "false");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  }
  return { dir, g };
}
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const brief = (dir, name, paths, { entries = null, readerHistory = "なし" } = {}) =>
  writeBrief(dir, {
    name,
    title: name,
    paths,
    set: {
      読者: { プロファイル: "beginner", 読者像: "初めて使う人" },
      読者向けの改訂履歴: { 読者向けの改訂履歴: readerHistory },
      ...(entries !== null ? { 入口: { 入口のファイル: entries } } : {}),
    },
    outOfScope: ["なし"],
  });

// ---------------------------------------------------------------------------
// リンクの収集
// ---------------------------------------------------------------------------

test("linksOf: Markdown はコードの中と ignore の行を集めず、HTML は a・area の href だけにアンカーを見させる", () => {
  const md = [
    "# t",
    "[一](a.md#x) と `[二](b.md)` と [三](c.md)",
    "```text",
    "[四](d.md)",
    "```",
    "[五](e.md) <!-- check-docs: ignore 理由 -->",
    "",
  ].join("\n");
  assert.deepEqual(
    linksOf(md, false).map((l) => [l.target, l.line, l.nav]),
    [
      ["a.md#x", 2, true],
      ["c.md", 2, true],
    ]
  );
  const html = `<a href="a.html#x">a</a>\n<!-- <a href="no.html">x</a> -->\n<script>var s = '<a href="no2.html">';</script>\n<img src="i.png">\n<svg><use href="#icon"></use></svg>\n<area href='z.html'>`;
  assert.deepEqual(
    linksOf(html, true).map((l) => [l.target, l.line, l.nav]),
    [
      ["a.html#x", 1, true],
      ["i.png", 4, false],
      ["#icon", 5, false],
      ["z.html", 6, true],
    ]
  );
});

// ---------------------------------------------------------------------------
// ブリーフの入口
// ---------------------------------------------------------------------------

test("ブリーフ: 入口の節を書き、読み、無いブリーフ（古い形）も読める。必須にせず、「仮定」の入口を確かめる項目に出さない", () => {
  const { dir } = project({});
  writeBrief(dir, { name: "usage", title: "使い方", paths: ["docs/**"], set: { 読者: { プロファイル: "beginner", 読者像: "x" } }, outOfScope: ["なし"] });
  const file = path.join(dir, ".claude", "rules", "doc-brief-usage.md");
  assert.match(fs.readFileSync(file, "utf-8"), /## 入口\n\n（まだ決めていない）/, "どのブリーフにも「入口」の節が足される");
  assert.deepEqual(entriesOf(loadBriefs(dir)[0]), []);
  assert.ok(!missingItems(loadBriefs(dir)[0], "a.md").missing.some((m) => m.includes("入口")), "入口が無くても、聞く項目にしない");
  // 書き手が置いた入口は「仮定」になるが、確かめる項目には出さない
  writeBrief(dir, { name: "usage", by: "書き手", set: { 入口: { 入口のファイル: "docs/index.md, `web/assets/js/main.js`" } } });
  const b = loadBriefs(dir)[0];
  assert.equal(b.group["入口"]["入口のファイル"].status, "仮定");
  assert.deepEqual(entriesOf(b), ["docs/index.md", "web/assets/js/main.js"]);
  assert.ok(!missingItems(b, "a.md").assumed.some((a) => a.includes("入口")));
  // 入口の節が無い古いブリーフ
  const old = renderBrief(parseBrief(fs.readFileSync(file, "utf-8"), "usage")).replace(/## 入口[\s\S]*?(?=## 扱わないこと)/, "");
  assert.deepEqual(entriesOf(parseBrief(old, "usage")), []);
  assert.equal(parseBrief(old, "usage").unreadable.length, 0);
});

// ---------------------------------------------------------------------------
// 文書群の見直し: 孤立
// ---------------------------------------------------------------------------

const orphansOf = (dir, name = "usage") => analyze(dir).groups.find((g) => g.name === name).orphans;

test("孤立: 入口から辿れない文書だけを候補に出す。ディレクトリへのリンクは index に解決し、ルートからのリンクは理由に出す", () => {
  const { dir } = project({
    "docs/usage/index.md": "# 使い方\n\n[一](a.md) [サブ](sub/) [外](/docs/usage/root.md)\n",
    "docs/usage/a.md": "# a\n",
    "docs/usage/sub/index.md": "# サブ\n\n[b](b.md)\n",
    "docs/usage/sub/b.md": "# b\n",
    "docs/usage/c.md": "# c（誰からもリンクされない）\n",
    "docs/usage/root.md": "# ルートからのリンクでだけ指される\n",
    "docs/usage/ref.md": "# 参照形式で指される\n",
    "docs/usage/links.md": "# 辿れない文書\n\n[参照][r]\n\n[r]: ref.md\n",
  });
  brief(dir, "usage", ["docs/usage/**"], { entries: "docs/usage/index.md" });
  const orphans = orphansOf(dir);
  assert.deepEqual(orphans.map((o) => o.rel).sort(), ["docs/usage/c.md", "docs/usage/links.md", "docs/usage/ref.md", "docs/usage/root.md"]);
  const by = Object.fromEntries(orphans.map((o) => [o.rel, o.reasons.join(" / ")]));
  assert.match(by["docs/usage/c.md"], /どの文書・入口からもリンクされていない/);
  assert.match(by["docs/usage/root.md"], /ルートからのリンクは解決していない/);
  assert.match(by["docs/usage/ref.md"], /参照形式のリンク/);
  assert.match(by["docs/usage/ref.md"], /入口から辿れない文書からだけリンクされている|参照形式/);
  const text = renderText(analyze(dir));
  assert.match(text, /### 2\. 入口から辿れない文書（孤立の候補）/);
});

test("孤立: ディレクトリへのリンクは index.html・index.md・README.md の順に解決する。index の無いディレクトリは文書ではない", () => {
  const all = new Set(["a/index.md", "a/README.md", "b/README.md", "c/x.png", "top.md"]);
  assert.deepEqual(resolveLink(all, "top.md", "a/"), { kind: "ok", rel: "a/index.md" });
  assert.deepEqual(resolveLink(all, "top.md", "b"), { kind: "ok", rel: "b/README.md" });
  assert.equal(resolveLink(all, "top.md", "c/").kind, "dir");
  assert.equal(resolveLink(all, "top.md", "nothing.md").kind, "missing");
  assert.equal(resolveLink(all, "a/index.md", "../top.md#x").rel, "top.md");
  assert.equal(resolveLink(all, "top.md", "https://example.com/").kind, "skip");
  assert.equal(resolveLink(all, "top.md", "/usage/x.html").kind, "root");
});

test("孤立: JavaScript の入口は、ファイル名がパスの区切りか引用符で区切られた語として書かれているときだけ当てる（部分一致を当てない）", () => {
  const { dir } = project({
    "web/assets/js/main.js": `const nav = [{ title: "電話", href: "usage/phone.html" }, { title: "別", href: 'usage/other.html#top' }, "iphone-setup.html"];\n`,
    "web/usage/phone.html": `<h1>電話</h1><a href="next.html">次</a>`,
    "web/usage/next.html": `<h1>次</h1>`,
    "web/usage/other.html": `<h1>別</h1>`,
    "web/usage/iphone.html": `<h1>iPhone（main.js には iphone-setup.html とだけある）</h1>`,
    "web/usage/hone.html": `<h1>hone</h1>`,
  });
  brief(dir, "usage", ["web/usage/**"], { entries: "web/assets/js/main.js" });
  assert.deepEqual(orphansOf(dir).map((o) => o.rel).sort(), ["web/usage/hone.html", "web/usage/iphone.html"], "phone は当たり、phone.html の先の next も辿る。iphone・hone は当てない");
  assert.deepEqual(mentionedDocs(`x = "phone.html"; y = "web/iphone.html"`, ["web/phone.html", "web/iphone.html", "web/hone.html"]), ["web/phone.html", "web/iphone.html"]);
  assert.deepEqual(mentionedDocs(`"usage/index.html"`, ["a/usage/index.html", "b/index.html"]), ["a/usage/index.html"], "同じファイル名は、書かれているパスで絞る");
});

test("孤立: 入口が決まっていない文書群・default・ブリーフの無いプロジェクトには出さず、入口が決まっていないと言う", () => {
  const { dir } = project({ "docs/usage/a.md": "# a\n", "README.md": "# README\n" });
  brief(dir, "usage", ["docs/usage/**"]);
  brief(dir, "default", ["README.md"], { entries: "README.md" });
  const groups = analyze(dir).groups;
  assert.equal(groups.find((g) => g.name === "usage").orphans, null);
  assert.equal(groups.find((g) => g.name === "default").orphans, null, "default には孤立を出さない");
  assert.equal(groups.find((g) => g.name === "default").types, null, "default には種類の偏りを出さない");
  assert.match(renderText({ groups }), /入口: 決まっていない/);
  const none = project({ "docs/a.md": "# a\n" });
  const g = analyze(none.dir).groups;
  assert.equal(g.length, 1);
  assert.equal(g[0].orphans, null);
  assert.equal(reachOf(docsetContext(none.dir), "docs/a.md").state, "no-group");
});

test("到達: --reach は入口から辿れる経路を出し、辿れなければ理由を出す", () => {
  const { dir } = project({
    "docs/usage/index.md": "[a](a.md)\n",
    "docs/usage/a.md": "# a\n\n[b](b.md)\n",
    "docs/usage/b.md": "# b\n",
    "docs/usage/z.md": "# z\n",
  });
  brief(dir, "usage", ["docs/usage/**"], { entries: "docs/usage/index.md" });
  const ctx = docsetContext(dir);
  assert.deepEqual(reachOf(ctx, "docs/usage/b.md").via, ["docs/usage/index.md", "docs/usage/a.md", "docs/usage/b.md"]);
  assert.equal(reachOf(ctx, "docs/usage/z.md").state, "orphan");
  const out = spawnSync(process.execPath, [DOCSET_CLI, "--dest", dir, "--reach", "docs/usage/z.md"], { encoding: "utf-8" });
  assert.match(out.stdout, /入口（docs\/usage\/index\.md）から辿れない/);
  const ok = spawnSync(process.execPath, [DOCSET_CLI, "--dest", dir, "--reach", "docs/usage/b.md"], { encoding: "utf-8" });
  assert.match(ok.stdout, /入口から辿れる（docs\/usage\/index\.md → docs\/usage\/a\.md → docs\/usage\/b\.md）/);
});

// ---------------------------------------------------------------------------
// 文書群の見直し: 重複・種類・リンク切れ・廃止
// ---------------------------------------------------------------------------

test("重複: 文書の組ごとに、同じ見出しと3行以上続く同じコードの行を数える。必須見出しの語・改訂履歴・ひな形の繰り返しは除く。文書群をまたがない", () => {
  const code = "```bash\nnpm install\nnpm run build\nnpm test\n```\n";
  const shared = (extra) => `# t\n\n## 手順\n\n本文。\n\n## 共通の注意\n\n本文。\n\n## 改訂履歴\n\n- x\n\n${extra}`;
  const { dir } = project({
    "docs/usage/a.md": shared(`## 事前の準備\n\n${code}`),
    "docs/usage/b.md": shared(`## 事前の準備\n\n${code}\n## b だけ\n`),
    "docs/usage/c.md": shared("## c だけ\n"),
    "docs/usage/d.md": shared("## d だけ\n"),
    "docs/ref/e.md": shared("## 事前の準備\n\n本文。\n"),
  });
  brief(dir, "usage", ["docs/usage/**"]);
  brief(dir, "ref", ["docs/ref/**"]);
  const g = analyze(dir).groups.find((x) => x.name === "usage");
  assert.equal(g.duplicates.length, 1, "手順・改訂履歴（必須見出しの語）と、4本すべてにある「共通の注意」は除かれる");
  assert.deepEqual([g.duplicates[0].a, g.duplicates[0].b, g.duplicates[0].headings, g.duplicates[0].codeRuns], ["docs/usage/a.md", "docs/usage/b.md", ["事前の準備"], 1]);
  assert.equal(analyze(dir).groups.find((x) => x.name === "ref").duplicates.length, 0, "別の文書群の文書とは組にしない");
});

test("重複: 同じ行が2行しか続かなければ数えず、上位10組だけ出す", () => {
  const files = {};
  for (let i = 0; i < 24; i++) files[`docs/u/${String(i).padStart(2, "0")}.md`] = `# ${i}\n\n## 見出し${Math.floor(i / 2)}\n\n\`\`\`text\nx${i}\n\`\`\`\n`;
  files["docs/u/p.md"] = "# p\n\n```text\nA\nB\n```\n";
  files["docs/u/q.md"] = "# q\n\n```text\nA\nB\n```\n";
  const { dir } = project(files);
  brief(dir, "u", ["docs/u/**"]);
  const ctx = docsetContext(dir);
  const rels = [...ctx.docs].sort();
  const { top, all } = duplicatePairs(ctx, rels);
  assert.equal(all.length, 12, "見出しを共有する12組。p と q は2行なので数えない");
  assert.equal(top.length, 10);
  assert.ok(!all.some((p) => p.a.endsWith("p.md")));
});

test("種類の偏り・リンク切れ・廃止の候補", () => {
  const { dir } = project({
    "docs/usage/index.md": "# 使い方\n\n[a](a.md#無い) [切れ](gone.md) [ok](a.md#手順)\n",
    "docs/usage/a.md": "# a\n\n<!-- doc-type: howto -->\n\n## 手順\n\n## 事前の準備\n\n```text\none\ntwo\nthree\n```\n",
    "docs/usage/dup.md": "# dup\n\n<!-- doc-type: howto -->\n\n## 事前の準備\n\n```text\none\ntwo\nthree\n```\n",
  });
  brief(dir, "usage", ["docs/usage/**"], { entries: "docs/usage/index.md" });
  const g = analyze(dir).groups.find((x) => x.name === "usage");
  assert.equal(g.types.counts.howto, 2);
  assert.equal(g.types.counts["（マーカー無し）"], 1);
  assert.deepEqual(g.types.noDiataxis, ["tutorial", "reference", "explanation"]);
  assert.deepEqual(g.broken.map((b) => [b.target, b.kind]).sort(), [["a.md#無い", "anchor"], ["gone.md", "file"]]);
  assert.deepEqual(g.orphans.map((o) => o.rel), ["docs/usage/dup.md"]);
  assert.deepEqual(g.abolish, [{ rel: "docs/usage/dup.md", partners: ["docs/usage/a.md"] }], "孤立で、重複の上位にも出る文書だけ。重複の相手も出す");
  const cfg = project({ "docs/a.md": "# a\n\n## x\n\n[b](b.md#無い)\n", "docs/b.md": "# b\n" }, { config: { include: ["docs/**/*.md"], rules: { anchors: false } } });
  assert.deepEqual(analyze(cfg.dir).groups[0].broken, [], "rules.anchors が false ならアンカーは見ない");
});

test("docset.mjs の CLI: --json と --brief", () => {
  const { dir } = project({ "docs/a.md": "# a\n", "docs/b.md": "# b\n" });
  brief(dir, "usage", ["docs/a.md"]);
  brief(dir, "other", ["docs/b.md"]);
  const all = JSON.parse(spawnSync(process.execPath, [DOCSET_CLI, "--dest", dir, "--json"], { encoding: "utf-8" }).stdout);
  assert.deepEqual(all.groups.map((g) => g.name).sort(), ["other", "usage"]);
  const one = JSON.parse(spawnSync(process.execPath, [DOCSET_CLI, "--dest", dir, "--brief", "usage", "--json"], { encoding: "utf-8" }).stdout);
  assert.deepEqual(one.groups.map((g) => g.name), ["usage"]);
  assert.equal(spawnSync(process.execPath, [DOCSET_CLI, "--dest", dir, "--brief", "none"], { encoding: "utf-8" }).status, 2);
});

// ---------------------------------------------------------------------------
// 完了処理: 外から入ってくるリンクの切れ
// ---------------------------------------------------------------------------

const LINKS = {
  "docs/usage/a.md": "# a\n\n## 手順\n\n本文。\n",
  "docs/usage/b.md": "# b\n\n[a の手順](a.md#手順)\n",
  "docs/ref/c.md": "# c\n\n[a の手順](../usage/a.md#手順)\n",
  "README.md": "# README\n\n[手順](docs/usage/a.md#手順)\n",
};
const A = "docs/usage/a.md";
const probs = (r) => r.flatMap((e) => e.problems);
const warns = (r) => r.flatMap((e) => e.warnings);

test("外から入ってくるリンクの切れ: 見出しを変えたら、同じ文書群・ほかの文書群・README からのリンクの切れを止める", () => {
  const { dir } = project(LINKS, { git: true });
  put(dir, A, "# a\n\n## 作業の流れ\n\n本文。\n");
  const r = inboundBreaks(dir, { targets: [A] });
  assert.equal(probs(r).length, 3);
  assert.match(probs(r).join("\n"), /docs\/usage\/b\.md:3/);
  assert.match(probs(r).join("\n"), /docs\/ref\/c\.md:3/);
  assert.match(probs(r).join("\n"), /README\.md:3/);
  assert.match(probs(r)[0], /「#手順」に当たる見出しや id が無い/);
  // 見出しを変えずに文を直しただけなら切れない
  put(dir, A, "# a\n\n## 手順\n\n本文を直した。\n");
  assert.deepEqual(inboundBreaks(dir, { targets: [A] }), []);
});

test("外から入ってくるリンクの切れ: 文書を消す・git mv する。移した先の文書を指すリンクは切れない", () => {
  const { dir, g } = project(LINKS, { git: true });
  fs.rmSync(path.join(dir, A));
  const del = inboundBreaks(dir, { targets: [A] });
  assert.equal(probs(del).length, 3);
  assert.match(probs(del)[0], /行き先 docs\/usage\/a\.md が無い/);
  fs.writeFileSync(path.join(dir, A), LINKS[A]);
  // git mv: 変更として出るのは新しいパスだけ。旧パスへのリンクの切れも止める
  g("mv", A, "docs/usage/moved.md");
  const mv = inboundBreaks(dir, { targets: ["docs/usage/moved.md"] });
  assert.equal(probs(mv).length, 3, "targets に旧パスが無くても、git の差分から旧パスを拾う");
  assert.ok(probs(mv).every((p) => p.includes("docs/usage/a.md")));
  // リンク元を新しいパスに直せば通る
  put(dir, "docs/usage/b.md", "# b\n\n[a の手順](moved.md#手順)\n");
  put(dir, "docs/ref/c.md", "# c\n\n[a の手順](../usage/moved.md#手順)\n");
  put(dir, "README.md", "# README\n\n[手順](docs/usage/moved.md#手順)\n");
  assert.deepEqual(inboundBreaks(dir, { targets: ["docs/usage/moved.md"] }), []);
});

test("外から入ってくるリンクの切れ: 前からある切れは止めず、警告にする。直した結果が前と同じなら何も言わない", () => {
  const files = { ...LINKS, "docs/usage/b.md": "# b\n\n[前から無い](a.md#無い見出し) [ok](a.md#手順)\n" };
  const { dir } = project(files, { git: true });
  put(dir, A, "# a\n\n## 作業の流れ\n\n本文。\n");
  const r = inboundBreaks(dir, { targets: [A] });
  assert.equal(probs(r).length, 3, "b.md の ok のリンクと、c・README が切れた分");
  assert.ok(!probs(r).some((p) => p.includes("無い見出し")));
  assert.match(warns(r).join("\n"), /作業前から切れている: docs\/usage\/b\.md:3 の a\.md#無い見出し/);
});

test("外から入ってくるリンクの切れ: rules.anchors=false ならアンカーは見ないが、行き先の消失は止める", () => {
  const { dir } = project(LINKS, { git: true, config: { include: ["docs/**/*.md", "README.md"], rules: { anchors: false } } });
  const config = { include: ["docs/**/*.md", "README.md"], rules: { anchors: false } };
  put(dir, A, "# a\n\n## 作業の流れ\n");
  assert.deepEqual(inboundBreaks(dir, { targets: [A], config }), []);
  fs.rmSync(path.join(dir, A));
  assert.equal(probs(inboundBreaks(dir, { targets: [A], config })).length, 3);
});

test("外から入ってくるリンクの切れ: 基準点があれば、基準点の中身を作業前とする（作業の途中でコミットしても見る）", () => {
  const { dir, g } = project(LINKS, { git: true });
  markBaseline(dir, [A]);
  put(dir, A, "# a\n\n## 作業の流れ\n");
  g("commit", "-q", "-m", "heading", "--", A); // 作業の途中のコミット。HEAD は今の見出しになる
  const baseline = JSON.parse(fs.readFileSync(path.join(dir, ".git", "harness-doc", "baseline.json"), "utf-8"));
  assert.equal(probs(inboundBreaks(dir, { targets: [A], baseline })).length, 3);
  assert.deepEqual(probs(inboundBreaks(dir, { targets: [A], baseline: null })), [], "基準点が無ければ HEAD と比べるので、増えた切れではない（警告になる）");
});

test("外から入ってくるリンクの切れ: staged はリンク元も行き先も index の中身で見る", () => {
  const { dir, g } = project(LINKS, { git: true });
  put(dir, A, "# a\n\n## 作業の流れ\n");
  g("add", A);
  assert.equal(probs(inboundBreaks(dir, { targets: [A], staged: true })).length, 3);
  // 作業ツリーでリンク元を直しても、index に入れていなければ切れたまま
  put(dir, "docs/usage/b.md", "# b\n\n[a の手順](a.md#作業の流れ)\n");
  assert.equal(probs(inboundBreaks(dir, { targets: [A], staged: true })).length, 3);
  g("add", "docs/usage/b.md");
  assert.equal(probs(inboundBreaks(dir, { targets: [A], staged: true })).length, 2);
  // 行き先を index に入れていなければ（作業ツリーだけで変えた）、index の見出しは前のまま
  const other = project(LINKS, { git: true });
  put(other.dir, A, "# a\n\n## 作業の流れ\n");
  assert.deepEqual(inboundBreaks(other.dir, { targets: [], staged: true }), []);
});

test("外から入ってくるリンクの切れ: 入口のファイルからのリンクも見る", () => {
  const { dir } = project(
    { "docs/a.md": "# a\n\n## 手順\n", "docs/b.md": "# b\n", "web/assets/nav.md": "[手順](../../docs/a.md#手順)\n" },
    { git: true, config: { include: ["docs/**/*.md"] } }
  );
  brief(dir, "x", ["docs/**"], { entries: "web/assets/nav.md" });
  put(dir, "docs/a.md", "# a\n\n## 作業の流れ\n");
  const r = inboundBreaks(dir, { targets: ["docs/a.md"], config: { include: ["docs/**/*.md"] } });
  assert.match(probs(r).join("\n"), /web\/assets\/nav\.md:1/);
});

test("完了処理の CLI: 止める。リンク元を --mark --add で足して直し、記録に並べれば通る", () => {
  const { dir } = project(LINKS, { git: true });
  brief(dir, "usage", ["docs/usage/**"]);
  brief(dir, "ref", ["docs/ref/**"]);
  brief(dir, "default", ["README.md"]);
  const cli = (...a) => spawnSync(process.execPath, [COMPLETE_CLI, "--dest", dir, ...a], { encoding: "utf-8" });
  assert.equal(cli("--mark", A).status, 0);
  put(dir, A, "# a\n\n## 作業の流れ\n");
  const rec = (docs) =>
    addSection(dir, { docs, size: "S", 改訂箇所: "手順", 改訂内容: "見出しを変えた", 改訂意図: "分かりやすくするため", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者" }, "2026-10-06");
  rec([A]);
  const ng = cli();
  assert.equal(ng.status, 1);
  assert.match(ng.stdout, /NG: docs\/usage\/a\.md（外から入ってくるリンク）/);
  assert.match(ng.stdout, /README\.md:3/);
  // 直し方: リンク元を基準点に足し、リンクを直し、記録の対象の文書に並べる
  assert.equal(cli("--mark", "--add", "docs/usage/b.md", "docs/ref/c.md", "README.md").status, 0);
  put(dir, "docs/usage/b.md", "# b\n\n[a の手順](a.md#作業の流れ)\n");
  put(dir, "docs/ref/c.md", "# c\n\n[a の手順](../usage/a.md#作業の流れ)\n");
  put(dir, "README.md", "# README\n\n[手順](docs/usage/a.md#作業の流れ)\n");
  const fixed = cli();
  assert.doesNotMatch(fixed.stdout, /外から入ってくるリンクが切れた/, "切れは直った");
  assert.match(fixed.stdout, /NG: docs\/usage\/b\.md/, "直したリンク元は、改訂の記録が要る（例外は作らない）");
  assert.match(fixed.stdout, /NG: README\.md/);
});

// ---------------------------------------------------------------------------
// 完了処理: 新しい文書が入口から辿れない（警告）
// ---------------------------------------------------------------------------

test("新しい文書: 入口から辿れなければ警告（止めない）。入口に足せば出ない。ブリーフに入口が無くても何も言わず、止まらない", () => {
  const files = { "docs/usage/index.md": "# 使い方\n\n[a](a.md)\n", "docs/usage/a.md": "# a\n" };
  const { dir } = project(files, { git: true });
  const withEntry = (entries) => {
    brief(dir, "usage", ["docs/usage/**"], { entries });
    return loadBriefs(dir);
  };
  const config = { include: ["docs/**/*.md"] };
  put(dir, "docs/usage/new.md", "# 新しい\n");
  const briefs = withEntry("docs/usage/index.md");
  const r = checkDoc(dir, "docs/usage/new.md", { briefs, config });
  assert.match(r.warnings.join("\n"), /新しい文書が、文書群の入口（docs\/usage\/index\.md）から辿れない/);
  put(dir, "docs/usage/index.md", "# 使い方\n\n[a](a.md) [新](new.md)\n");
  assert.ok(!checkDoc(dir, "docs/usage/new.md", { briefs, config }).warnings.some((w) => w.includes("入口")));
  // 入口が決まっていない
  put(dir, "docs/usage/index.md", "# 使い方\n\n[a](a.md)\n");
  const none = checkDoc(dir, "docs/usage/new.md", { briefs: withEntry("") && loadBriefs(dir), config });
  assert.ok(!none.warnings.some((w) => w.includes("入口")));
  // 既存の文書には言わない
  const old = checkDoc(dir, "docs/usage/a.md", { briefs: withEntry("docs/usage/index.md"), config });
  assert.ok(!old.warnings.some((w) => w.includes("入口")));
});

// ---------------------------------------------------------------------------
// コミット時の検査
// ---------------------------------------------------------------------------

test("コミット時の検査: 見出しを変えたコミットで、ほかの文書からのリンクが切れたら止める。記録の承認（doc-record: skip）では通さない", () => {
  const { dir, g } = project(LINKS, { git: true });
  brief(dir, "usage", ["docs/usage/**"]);
  brief(dir, "ref", ["docs/ref/**"]);
  brief(dir, "default", ["README.md"]);
  g("add", "-A");
  g("commit", "-q", "-m", "briefs");
  put(dir, A, "# a\n\n## 作業の流れ\n");
  addSection(dir, { doc: A, size: "S", 改訂箇所: "手順", 改訂内容: "見出しを変えた", 改訂意図: "分かりやすくするため", 読者向けの改訂履歴: "対象外", "変更者・承認者": "Claude・依頼者" }, "2026-10-06");
  const bash = (command) => run({ tool_name: "Bash", tool_input: { command }, cwd: dir });
  const history = "docs-style/history/usage.md";
  const r = bash(`git commit -m "x" -- ${A} ${history}`);
  assert.equal(r.decision, "deny");
  assert.match(r.lines.join("\n"), /外から入ってくるリンク/);
  assert.match(r.lines.join("\n"), /docs\/ref\/c\.md:3/);
  const skip = bash(`git commit -m "x doc-record: skip（改訂の記録なしでコミットする: テスト）" -- ${A} ${history}`);
  assert.equal(skip.decision, "deny", "リンクの切れは記録の承認では通さない");
  // リンク元を同じコミットで直せば通る（リンク元の記録は別の話。ここでは切れだけを見る）
  put(dir, "docs/usage/b.md", "# b\n\n[a の手順](a.md#作業の流れ)\n");
  put(dir, "docs/ref/c.md", "# c\n\n[a の手順](../usage/a.md#作業の流れ)\n");
  put(dir, "README.md", "# README\n\n[手順](docs/usage/a.md#作業の流れ)\n");
  const fixed = bash(`git add ${A} ${history} docs/usage/b.md docs/ref/c.md README.md && git commit -m "x"`);
  assert.ok(!fixed.lines.join("\n").includes("外から入ってくるリンク"), fixed.lines.join("\n"));
  setGitContext();
});

// ---------------------------------------------------------------------------
// 実装の査読（別エージェント）の指摘への対応
// ---------------------------------------------------------------------------

test("重複: 入口のファイルと landing の文書は比べず、題名（最初の見出し）だけが同じ組は数えない", () => {
  const { dir } = project({
    "docs/u/index.md": "# 使い方\n\n## 3. 電話\n\n要約。\n\n[電話](phone.md) [カメラ](camera.md)\n",
    "docs/u/top.md": "# トップ\n\n<!-- doc-type: landing -->\n\n## 3. 電話\n\n要約。\n",
    "docs/u/phone.md": "# 3. 電話\n\n本文。\n",
    "docs/u/camera.md": "# 3. 電話のカメラ\n\n## 3. 電話\n\n本文。\n",
    "docs/u/mail.md": "# メール\n\n## 削除する\n",
    "docs/u/sms.md": "# SMS\n\n## 削除する\n",
  });
  brief(dir, "u", ["docs/u/**"], { entries: "docs/u/index.md" });
  const g = analyze(dir).groups.find((x) => x.name === "u");
  assert.deepEqual(g.duplicates.map((p) => [p.a, p.b]), [["docs/u/mail.md", "docs/u/sms.md"]], "index（入口）・top（landing）・題名だけの一致は除かれる");
});

test("廃止の候補: 出力する上位10組に出る文書だけ。重複の相手も出す", () => {
  const files = { "docs/u/index.md": "# 入口\n" };
  for (let i = 0; i < 26; i++) files[`docs/u/p${String(i).padStart(2, "0")}.md`] = `# ${i}\n\n## 見出し${Math.floor(i / 2)}\n`;
  const { dir } = project(files);
  brief(dir, "u", ["docs/u/**"], { entries: "docs/u/index.md" });
  const g = analyze(dir).groups.find((x) => x.name === "u");
  assert.equal(g.duplicates.length, 10);
  assert.equal(g.abolish.length, 20, "13組のうち上位10組の両方の文書。下位3組の文書は出さない");
  assert.ok(g.abolish.every((a) => a.partners.length === 1));
});

test("リンク: ディレクトリのリンクの行き先の index を消したら切れ。ディレクトリ経由のアンカーは見ない", () => {
  const { dir } = project(
    { "docs/usage/index.md": "# 使い方\n\n## 手順\n", "docs/top.md": "# top\n\n[使い方](usage/) [手順](usage/#手順)\n" },
    { git: true }
  );
  fs.rmSync(path.join(dir, "docs/usage/index.md"));
  put(dir, "docs/usage/other.md", "# other\n"); // ディレクトリは残る（index だけ無い）
  const r = inboundBreaks(dir, { targets: ["docs/usage/index.md"] });
  assert.equal(probs(r).length, 2);
  assert.match(probs(r)[0], /docs\/top\.md:3 の usage\//);
  // 見出しを変えただけなら、ディレクトリ経由のアンカーは見ない
  const other = project({ "docs/usage/index.md": "# 使い方\n\n## 手順\n", "docs/top.md": "# top\n\n[手順](usage/#手順)\n" }, { git: true });
  put(other.dir, "docs/usage/index.md", "# 使い方\n\n## 流れ\n");
  assert.deepEqual(inboundBreaks(other.dir, { targets: ["docs/usage/index.md"] }), []);
});

test("リンク: 新しい文書へのリンクの切れは、警告ではなく止める", () => {
  const { dir } = project({ "docs/a.md": "# a\n" }, { git: true });
  put(dir, "docs/new.md", "# new\n\n## 手順\n");
  put(dir, "docs/a.md", "# a\n\n[新](new.md#無い)\n");
  const r = inboundBreaks(dir, { targets: ["docs/new.md"] });
  assert.match(probs(r)[0], /新しい文書へのリンクが切れている: docs\/a\.md:3/);
  assert.deepEqual(warns(r), []);
});

test("リンク: 入口が JavaScript のとき、消した文書のファイル名が残っていたら警告（止めない）", () => {
  const config = { include: ["web/**/*.html"] };
  const { dir } = project(
    { "web/nav.js": 'const nav = ["usage/phone.html", "usage/iphone.html"];\n', "web/usage/phone.html": "<h1>電話</h1>", "web/usage/iphone.html": "<h1>i</h1>" },
    { git: true, config }
  );
  brief(dir, "w", ["web/usage/**"], { entries: "web/nav.js" });
  fs.rmSync(path.join(dir, "web/usage/phone.html"));
  const r = inboundBreaks(dir, { targets: ["web/usage/phone.html"], config });
  assert.deepEqual(probs(r), []);
  assert.match(warns(r).join("\n"), /入口のファイル web\/nav\.js に、消した・移した文書 web\/usage\/phone\.html/);
  assert.equal(warns(r).length, 1, "iphone.html には当てない");
});

test("リンク: gitignore 済みのファイルへのリンクはリンク切れにしない。意図して残すリンクは ignore の行で外せる", () => {
  const { dir } = project(
    {
      ".gitignore": "docs/secret.md\n",
      "docs/secret.md": "# s\n",
      "docs/a.md": "# a\n\n[s](secret.md) [x](gone.md)\n",
      "docs/b.md": "# b\n\n[x](gone.md) <!-- check-docs: ignore 意図して残す -->\n",
    },
    { git: true }
  );
  const g = analyze(dir).groups[0];
  assert.deepEqual(g.broken.map((b) => [b.source, b.target]), [["docs/a.md", "gone.md"]]);
});

test("入口の判定: CRLF の行末でも当たる", () => {
  const text = 'const a = [\r\n  "usage/phone.html"\r\n];\r\nx = "usage/mail.html"\r\n';
  assert.deepEqual(mentionedDocs(text, ["web/usage/phone.html", "web/usage/mail.html"]), ["web/usage/phone.html", "web/usage/mail.html"]);
});

test("外から入ってくるリンクの切れ: staged の git mv（旧パスへのリンクの切れ）", () => {
  const { dir, g } = project(LINKS, { git: true });
  g("mv", A, "docs/usage/moved.md"); // index に入る
  const r = inboundBreaks(dir, { targets: ["docs/usage/moved.md"], staged: true });
  assert.equal(probs(r).length, 3);
  assert.ok(probs(r).every((p) => p.includes("docs/usage/a.md")));
});

test("日本語のパスと、リポジトリのサブフォルダーにあるプロジェクト", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b14-sub-"));
  const dir = path.join(root, "プロジェクト");
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  put(dir, "docs/使い方/電話.md", "# 電話\n\n## 手順\n");
  put(dir, "docs/使い方/目次.md", "# 目次\n\n[電話の手順](電話.md#手順) [encoded](%E9%9B%BB%E8%A9%B1.md)\n");
  put(root, "外.md", "# 外\n");
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const T = "docs/使い方/電話.md";
  put(dir, T, "# 電話\n\n## 流れ\n");
  assert.equal(probs(inboundBreaks(dir, { targets: [T] })).length, 1, "見出しを変えた（URL エンコードのリンクは、ファイルがあるので切れない）");
  g("add", "-A");
  assert.equal(probs(inboundBreaks(dir, { targets: [T], staged: true })).length, 1, "staged でも同じ");
  fs.unlinkSync(path.join(dir, T)); // rmSync は、この環境の Node で日本語のパスに当たると落ちた
  assert.equal(probs(inboundBreaks(dir, { targets: [T] })).length, 2, "消した: 日本語のファイル名と URL エンコードの両方");
});

test("コミット時の検査の速さ: staged で数百本の文書があっても、文書の数だけ git を起動しない。deadline を超えたら打ち切る", () => {
  const files = { "docs/hub.md": "# hub\n\n[a](p000.md#手順)\n" };
  for (let i = 0; i < 400; i++) files[`docs/p${String(i).padStart(3, "0")}.md`] = `# p${i}\n\n## 手順\n\n[hub](hub.md)\n`;
  const { dir, g } = project(files, { git: true });
  put(dir, "docs/p000.md", "# p0\n\n## 流れ\n");
  g("add", "docs/p000.md");
  const t0 = Date.now();
  const r = inboundBreaks(dir, { targets: ["docs/p000.md"], staged: true });
  const ms = Date.now() - t0;
  assert.equal(probs(r).length, 1);
  assert.ok(ms < 4000, `400本で ${ms}ms（文書ごとに git を起動していると約8秒かかる）`);
  assert.throws(() => inboundBreaks(dir, { targets: ["docs/p000.md"], staged: true, deadline: Date.now() - 1 }), CheckTimeout);
});

test("リンク: 大文字小文字の違い（readme.md と README.md）は、大文字小文字を区別しない環境（Windows）ではリンク切れにしない", { skip: process.platform !== "win32" }, () => {
  const { dir } = project({ "docs/README.md": "# r\n", "docs/a.md": "# a\n\n[r](readme.md)\n" }, { git: true });
  assert.deepEqual(analyze(dir).groups[0].broken, []);
});
