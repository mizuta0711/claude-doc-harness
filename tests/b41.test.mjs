/**
 * 0.15.0: B40 の残り（0.14.0 の査読 R16・R17）と B41（リファレンスの必須見出し）の検査。
 * 依存パッケージは使わない（node:test / node:assert のみ）。git は使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DEFAULT_CONFIG, checkDocument, detectDocType, loadStyle } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { markBaseline } from "../plugins/harness-doc/scripts/complete-doc.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const emptyStyle = () => loadStyle(tmp("b41-style-"), DEFAULT_CONFIG);
const headingIssues = (text, config = DEFAULT_CONFIG) =>
  checkDocument(text, { config, style: emptyStyle() }).filter((i) => i.kind === "heading").map((i) => i.message);

// ---------------------------------------------------------------------------
// R16: ASCII でない種類の値も読む
// ---------------------------------------------------------------------------

test("R16: `doc-type: 手順書` を読み落とさず、知らない種類として止める", () => {
  assert.equal(detectDocType("# t\n\n<!-- doc-type: 手順書 -->\n"), "手順書");
  assert.equal(detectDocType("# t\n\n<!-- doc-type:howto-->\n"), "howto");
  assert.match(headingIssues("# t\n\n<!-- doc-type: 手順書 -->\n\n本文。\n").join(), /知らない文書の種類「手順書」/);
  assert.equal(detectDocType("# t\n\nマーカーは `<!-- doc-type: <種別> -->` と書く。\n"), null, "プレースホルダーは拾わない");
});

test("R16: config の requiredHeadings に足せば、ASCII でない種類も使える", () => {
  const config = { ...DEFAULT_CONFIG, requiredHeadings: { ...DEFAULT_CONFIG.requiredHeadings, よくある質問: ["質問"] } };
  assert.deepEqual(headingIssues("# t\n\n<!-- doc-type: よくある質問 -->\n\n## 質問の一覧\n\n本文。\n", config), []);
});

// ---------------------------------------------------------------------------
// B41: リファレンスの必須見出しは「一覧」だけ
// ---------------------------------------------------------------------------

test("B41: リファレンスは「一覧」の見出しがあれば通り、「できること」「前提条件」を求めない", () => {
  assert.deepEqual(headingIssues("# 設定項目\n\n<!-- doc-type: reference -->\n\n設定を引く文書。\n\n## 一覧\n\n本文。\n"), []);
  assert.match(headingIssues("# 設定項目\n\n<!-- doc-type: reference -->\n\n## 各項目\n\n本文。\n").join(), /見出し不足（reference）: 「一覧」/);
});

// ---------------------------------------------------------------------------
// R17: 別の作業のコミットの後の --mark は、基準点を作り直さずに足す
// ---------------------------------------------------------------------------

function repo() {
  const dir = tmp("b41-r17-");
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "doc-harness.config.json"), JSON.stringify({ include: ["docs/**/*.md"] }));
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n");
  fs.writeFileSync(path.join(dir, "docs", "b.md"), "# b\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "x\n");
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { dir, g };
}
const baselineOf = (r) => JSON.parse(fs.readFileSync(r.file, "utf-8"));

test("R17: 基準点のファイルに触れないコミットの後の --mark は、記録済みのファイルを上書きせずに足す", () => {
  const { dir, g } = repo();
  markBaseline(dir, ["docs/a.md"]);
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n\n直した。\n"); // この作業で直した（コミットしていない）
  fs.writeFileSync(path.join(dir, "other.txt"), "y\n");
  g("commit", "-qm", "other work", "--", "other.txt"); // 別のセッションのコミット
  const r = markBaseline(dir, ["docs/b.md"]);
  assert.equal(r.merged, true);
  const b = baselineOf(r);
  assert.equal(b.files["docs/a.md"], "# a\n", "直した後の中身を作業前にしない");
  assert.equal(b.files["docs/b.md"], "# b\n");
});

test("R17: 基準点のファイルに触れたコミットの後・ブランチを切り替えた後の --mark は、前どおり作り直す", () => {
  const { dir, g } = repo();
  markBaseline(dir, ["docs/a.md"]);
  fs.writeFileSync(path.join(dir, "docs", "a.md"), "# a\n\n直した。\n");
  g("commit", "-qam", "touch a");
  let r = markBaseline(dir, ["docs/b.md"]);
  assert.equal(r.merged, false);
  assert.equal(Object.hasOwn(baselineOf(r).files, "docs/a.md"), false, "前の基準点を引き継がない");

  const other = repo();
  other.g("checkout", "-qb", "side");
  fs.writeFileSync(path.join(other.dir, "other.txt"), "side\n");
  other.g("commit", "-qam", "side");
  markBaseline(other.dir, ["docs/a.md"]);
  other.g("checkout", "-q", "-");
  fs.writeFileSync(path.join(other.dir, "other.txt"), "main\n");
  other.g("commit", "-qam", "main");
  r = markBaseline(other.dir, ["docs/b.md"]);
  assert.equal(r.merged, false, "HEAD が基準点の子孫でなければ別の作業");
});

test("R17: reset で HEAD が基準点より前に戻った後・通過済みの基準点の後の --mark は、作り直す", () => {
  const { dir, g } = repo();
  fs.writeFileSync(path.join(dir, "other.txt"), "y\n");
  g("commit", "-qam", "two");
  markBaseline(dir, ["docs/a.md"]);
  g("reset", "-q", "--hard", "HEAD~1");
  assert.equal(markBaseline(dir, ["docs/b.md"]).merged, false, "reset の後は別の作業");

  const other = repo();
  const r = markBaseline(other.dir, ["docs/a.md"]);
  const passed = { ...baselineOf(r), passed: { at: "2026-10-06", files: {} } };
  fs.writeFileSync(r.file, JSON.stringify(passed));
  fs.writeFileSync(path.join(other.dir, "other.txt"), "y\n");
  other.g("commit", "-qam", "other work");
  assert.equal(markBaseline(other.dir, ["docs/b.md"]).merged, false, "通過済みの基準点には足さない");
});
