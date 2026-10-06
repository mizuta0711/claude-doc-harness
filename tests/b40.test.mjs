/**
 * 0.14.0: 実地検証 IndustrialEmulator の欠陥 G1〜G7 の検査（B40）。
 * 依存パッケージは使わない（node:test / node:assert のみ）。git は使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, checkDocument, findProjectDir, loadStyle } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { writeBrief, loadBriefs } from "../plugins/harness-doc/scripts/brief.mjs";
import { addSection } from "../plugins/harness-doc/scripts/history.mjs";
import { checkDoc, commitsAfterBaseline, markBaseline } from "../plugins/harness-doc/scripts/complete-doc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_DOCS = path.join(here, "..", "plugins", "harness-doc", "hooks", "scripts", "check-docs.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const emptyStyle = () => loadStyle(tmp("b40-style-"), DEFAULT_CONFIG);

function writeConfig(dir, config = { include: ["docs/**/*.md", "web/**/*.html"] }) {
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify(config));
}

function gitInit(dir) {
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  return g;
}

// ---------------------------------------------------------------------------
// G1: フックは文書のパスからプロジェクトを探す
// ---------------------------------------------------------------------------

test("G1: findProjectDir は文書から上へ config を探し、無ければセッションのプロジェクトを返す", () => {
  const proj = tmp("b40-g1-");
  writeConfig(proj);
  fs.mkdirSync(path.join(proj, "web", "manual"), { recursive: true });
  const doc = path.join(proj, "web", "manual", "a.html");
  assert.equal(findProjectDir(doc, "/fallback"), proj);
  const none = tmp("b40-g1-none-");
  assert.equal(findProjectDir(path.join(none, "a.md"), "/fallback"), path.resolve("/fallback"));
});

test("G1: セッションを別のフォルダーで開いていても、フックは文書の属するプロジェクトの規則で検査する", () => {
  const proj = tmp("b40-g1-hook-");
  writeConfig(proj);
  fs.mkdirSync(path.join(proj, "docs"), { recursive: true });
  const doc = path.join(proj, "docs", "a.md");
  fs.writeFileSync(doc, "# a\n\n<!-- doc-type: no-such-type -->\n\n本文。\n");
  const session = tmp("b40-g1-session-"); // config の無い、別のリポジトリ
  const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: doc }, cwd: session });
  const r = spawnSync(process.execPath, [CHECK_DOCS], { input: payload, encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: session } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /知らない文書の種類「no-such-type」/);
});

// ---------------------------------------------------------------------------
// G2: ブリーフの知らないキーを止める
// ---------------------------------------------------------------------------

test("G2: writeBrief は知らない最上位のキーを黙って捨てずに止め、set の中に書くよう案内する", () => {
  const dir = tmp("b40-g2-");
  assert.throws(
    () => writeBrief(dir, { name: "m", title: "t", paths: ["web/**"], by: "依頼者", docs: { "a.html": { ゴール: "x" } } }),
    /知らないキー: docs[\s\S]*set の中に書く/
  );
  assert.equal(fs.existsSync(path.join(dir, ".claude", "rules", "doc-brief-m.md")), false);
});

// ---------------------------------------------------------------------------
// G3: 読者向けの改訂履歴をまとめのページに置く
// ---------------------------------------------------------------------------

function siteProject() {
  const dir = tmp("b40-g3-");
  writeConfig(dir);
  writeBrief(dir, {
    name: "manual",
    title: "操作マニュアル",
    paths: ["web/manual/**"],
    by: "依頼者",
    set: {
      読者: { プロファイル: "engineer", 読者像: "初めて使う技術者" },
      読者向けの改訂履歴: { 読者向けの改訂履歴: "あり", 置き場所: "web/manual/history.html" },
    },
    outOfScope: ["なし"],
  });
  fs.mkdirSync(path.join(dir, "web", "manual"), { recursive: true });
  gitInit(dir);
  return dir;
}

const html = (body) => `<!DOCTYPE html>\n<html lang="ja"><body>\n${body}\n</body></html>\n`;
const section = (doc) => ({
  docs: [doc],
  size: "S",
  改訂箇所: "全体",
  改訂内容: "初版",
  改訂意図: "初めて使う人のため",
  根拠: "実物",
  "見送ったこと・決めたこと": "なし",
  読者向けの改訂履歴: "初版",
  "変更者・承認者": "t",
});

test("G3: 置き場所がまとめのページなら、各文書に改訂履歴の節が無くても、ページに行があれば通る", () => {
  const dir = siteProject();
  fs.writeFileSync(path.join(dir, "web", "manual", "run.html"), html("<h1>起動する</h1><p>本文。</p>"));
  addSection(dir, section("web/manual/run.html"));
  // ページがまだ無い
  let r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir) });
  assert.ok(r.problems.some((p) => /まとめのページ（web\/manual\/history\.html）が無い/.test(p)), r.problems.join("\n"));
  // ページはあるが行が無い
  fs.writeFileSync(path.join(dir, "web", "manual", "history.html"), html("<h1>改訂履歴</h1><p>まだ無い。</p>"));
  r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir) });
  assert.ok(r.problems.some((p) => /まとめのページ（web\/manual\/history\.html）の読者向けの改訂履歴の節に、行が無い/.test(p)), r.problems.join("\n"));
  // ページに行がある
  fs.writeFileSync(path.join(dir, "web", "manual", "history.html"), html("<h1>改訂履歴</h1><ul><li>2026-10-06 初版</li></ul>"));
  r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir) });
  assert.deepEqual(r.problems, []);
});

test("G3: 置き場所が無い・「各文書」なら、前からどおり各文書の節を見る", () => {
  const dir = siteProject();
  writeBrief(dir, { name: "manual", by: "依頼者", set: { 読者向けの改訂履歴: { 置き場所: "各文書" } } });
  fs.writeFileSync(path.join(dir, "web", "manual", "run.html"), html("<h1>起動する</h1><p>本文。</p>"));
  addSection(dir, section("web/manual/run.html"));
  const r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir) });
  assert.ok(r.problems.some((p) => /文書に「改訂履歴」の節が無い/.test(p)), r.problems.join("\n"));
});

// ---------------------------------------------------------------------------
// G4: 文書の種類のマーカー
// ---------------------------------------------------------------------------

test("G4: tutorial・landing・history・explanation は種類として認めて見出しは検査せず、知らない種類は止める", () => {
  const style = emptyStyle();
  const kinds = (text) => checkDocument(text, { config: DEFAULT_CONFIG, style }).filter((i) => i.kind === "heading").map((i) => i.message);
  for (const free of ["tutorial", "landing", "history", "explanation"]) assert.deepEqual(kinds(`# t\n\n<!-- doc-type: ${free} -->\n\n本文。\n`), [], free);
  assert.match(kinds("# t\n\n<!-- doc-type: tutorrial -->\n\n本文。\n").join(), /知らない文書の種類「tutorrial」/);
});

test("G4: config の requiredHeadings に足した独自の種類は、知らない種類として止めない", () => {
  const style = emptyStyle();
  const config = { ...DEFAULT_CONFIG, requiredHeadings: { ...DEFAULT_CONFIG.requiredHeadings, faq: ["よくある質問"] } };
  const issues = checkDocument("# t\n\n<!-- doc-type: faq -->\n\n## よくある質問\n\n本文。\n", { config, style });
  assert.deepEqual(issues.filter((i) => i.kind === "heading"), []);
});

// ---------------------------------------------------------------------------
// G7: 基準点の後のコミットが、基準点のファイルに触れたかを見分ける
// ---------------------------------------------------------------------------

test("G7: 基準点の文書に触れていないコミットは touching に入らず、触れたコミットだけが入る", () => {
  const dir = tmp("b40-g7-");
  writeConfig(dir);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "x\n");
  const g = gitInit(dir);
  g("add", "-A");
  g("commit", "-qm", "init");
  const baseline = markBaseline(dir, ["docs/a.md"]);
  assert.ok(baseline.count >= 1);
  const loaded = JSON.parse(fs.readFileSync(baseline.file, "utf-8"));
  // 別の作業（基準点のファイルに触れない）
  fs.writeFileSync(path.join(dir, "other.txt"), "y\n");
  g("commit", "-qam", "other work");
  let c = commitsAfterBaseline(dir, loaded);
  assert.equal(c.count, 1);
  assert.deepEqual(c.touching, []);
  // 基準点の文書に触れたコミット
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n\n足した。\n");
  g("commit", "-qam", "touch doc");
  c = commitsAfterBaseline(dir, loaded);
  assert.equal(c.count, 2);
  assert.equal(c.touching.length, 1);
  assert.match(c.touching[0], /touch doc/);
});

// ---------------------------------------------------------------------------
// 0.14.0 の査読で直したもの
// ---------------------------------------------------------------------------

test("G3（査読）: まとめのページも基準点に入り、ページ自身は記録の docs に入れれば通る", () => {
  const dir = siteProject();
  const page = path.join(dir, "web", "manual", "history.html");
  fs.writeFileSync(page, html("<h1>改訂履歴</h1><ul><li>2026-10-01 初版</li></ul>"));
  fs.writeFileSync(path.join(dir, "web", "manual", "run.html"), html("<h1>起動する</h1><p>本文。</p>"));
  const b = markBaseline(dir, ["web/manual/run.html"]);
  const loaded = JSON.parse(fs.readFileSync(b.file, "utf-8"));
  assert.ok(Object.hasOwn(loaded.files, "web/manual/history.html"), Object.keys(loaded.files).join(","));
  // 基準点のときからページが変わっていなければ、前からある行では通らない
  addSection(dir, { ...section("web/manual/run.html"), docs: ["web/manual/run.html", "web/manual/history.html"] });
  let r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir), baseline: loaded });
  assert.ok(r.problems.some((p) => /まとめのページ（web\/manual\/history\.html）に行が足されていない/.test(p)), r.problems.join("\n"));
  fs.writeFileSync(page, html("<h1>改訂履歴</h1><ul><li>2026-10-06 起動の手順を足しました</li><li>2026-10-01 初版</li></ul>"));
  r = checkDoc(dir, "web/manual/run.html", { briefs: loadBriefs(dir), baseline: loaded });
  assert.deepEqual(r.problems, []);
  r = checkDoc(dir, "web/manual/history.html", { briefs: loadBriefs(dir), baseline: loaded });
  assert.deepEqual(r.problems, []);
});

test("G7（査読）: HEAD が基準点より前に戻ったときは、基準点の後のコミットが 0 件になる", () => {
  const dir = tmp("b40-g7b-");
  writeConfig(dir);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n");
  const g = gitInit(dir);
  g("add", "-A");
  g("commit", "-qm", "one");
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  g("add", "-A");
  g("commit", "-qm", "two");
  const b = JSON.parse(fs.readFileSync(markBaseline(dir, ["docs/a.md"]).file, "utf-8"));
  g("reset", "-q", "--hard", "HEAD~1");
  const c = commitsAfterBaseline(dir, b);
  assert.equal(c.count, 0);
});

test("G1（査読）: 基準点の文書に触れないコミットの後も、書きかけの文書へのリンク切れは止めない", async () => {
  const { plannedDocs } = await import("../plugins/harness-doc/hooks/scripts/check-docs.mjs");
  const dir = tmp("b40-planned-");
  writeConfig(dir);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n");
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  const g = gitInit(dir);
  g("add", "-A");
  g("commit", "-qm", "init");
  markBaseline(dir, ["docs/a.md", "docs/b.md"]);
  assert.ok(plannedDocs(dir)?.has("docs/b.md"));
  fs.writeFileSync(path.join(dir, "x.txt"), "y\n");
  g("commit", "-qam", "other session");
  assert.ok(plannedDocs(dir)?.has("docs/b.md"), "別の作業のコミットの後も基準点は有効");
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n\n足した。\n");
  g("commit", "-qam", "touch a");
  assert.equal(plannedDocs(dir), null, "基準点の文書に触れたコミットの後は無効");
});
