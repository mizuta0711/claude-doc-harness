/**
 * brief.mjs（ブリーフの読み書き）の検査。
 * 依存パッケージは使わない（node:test / node:assert のみ）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  globBase,
  loadBriefs,
  missingItems,
  parseBrief,
  renderBrief,
  renderForDoc,
  resolveBrief,
  writeBrief,
} from "../plugins/harness-doc/scripts/brief.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIEF_CLI = path.join(here, "..", "plugins", "harness-doc", "scripts", "brief.mjs");
const APPLY_CLI = path.join(here, "..", "plugins", "harness-doc", "skills", "setup-project", "scripts", "apply.mjs");
const run = (cli, args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf-8" });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));

const usage = {
  name: "usage",
  title: "利用者向けの使い方",
  paths: ["docs/web/usage/**"],
  by: "依頼者",
  set: {
    読者: { プロファイル: "beginner", 読者像: "初めて使うシニア" },
    事実の承認者: { 承認者: "依頼者" },
    読者向けの改訂履歴: { 読者向けの改訂履歴: "あり" },
    文書ごとの決め事: { "phone.html": { ゴール: "発信できる", 文書の種類: "手順書", 受け入れ基準: "1. 発信できる" } },
  },
  outOfScope: ["端末 OS の設定"],
};

test("書いて読み戻すと同じ内容になる。由来は日付と書いた人、書き手の値は「仮定」", () => {
  const dir = tmp();
  writeBrief(dir, usage, "2026-10-05");
  writeBrief(dir, { name: "usage", by: "書き手", set: { 読者: { 読む状況: "画面を見ながら" } }, outOfScope: ["端末 OS の設定"] }, "2026-10-06");
  const [b] = loadBriefs(dir);
  assert.equal(b.name, "usage");
  assert.equal(b.title, "利用者向けの使い方");
  assert.deepEqual(b.paths, ["docs/web/usage/**"]);
  assert.deepEqual(b.group.読者.プロファイル, { value: "beginner", status: "確定", origin: "2026-10-05 依頼者" });
  assert.deepEqual(b.group.読者.読む状況, { value: "画面を見ながら", status: "仮定", origin: "2026-10-06 書き手" });
  assert.equal(b.outOfScope.length, 1, "同じ文言は足さない");
  assert.equal(b.docs["phone.html"].ゴール.value, "発信できる");
  // 読み戻したものをもう一度書いても変わらない
  assert.equal(renderBrief(parseBrief(renderBrief(b), "usage")), renderBrief(b));
});

test("ファイルは .claude/rules/doc-brief-<name>.md で、frontmatter に paths を持つ（パス指定ルールとして読み込まれる形）", () => {
  const dir = tmp();
  const { file } = writeBrief(dir, usage, "2026-10-05");
  assert.equal(path.relative(dir, file).split(path.sep).join("/"), ".claude/rules/doc-brief-usage.md");
  const text = fs.readFileSync(file, "utf-8");
  assert.match(text, /^---\npaths:\n {2}- "docs\/web\/usage\/\*\*"\n---\n/);
  assert.doesNotMatch(text, /docs-style\/history|docs-style\/plans/, "内部の記録や改訂設計書のパスを書かない");
});

test("作るときは title と paths が要る。知らない節・項目は拒否する", () => {
  const dir = tmp();
  assert.throws(() => writeBrief(dir, { name: "x", set: {} }), /title と paths/);
  writeBrief(dir, usage);
  assert.throws(() => writeBrief(dir, { name: "usage", set: { 読者: { 年齢: "70" } } }), /読者 に無い項目/);
  assert.throws(() => writeBrief(dir, { name: "usage", set: { 用語: {} } }), /知らない節/);
  assert.throws(() => writeBrief(dir, { name: "../x", set: {} }), /name/);
});

test("扱わないことを外せる。無い文言を外そうとしたら止める", () => {
  const dir = tmp();
  writeBrief(dir, usage);
  writeBrief(dir, { name: "usage", outOfScope: ["課金"] });
  writeBrief(dir, { name: "usage", removeOutOfScope: ["端末 OS の設定"] });
  assert.deepEqual(loadBriefs(dir)[0].outOfScope.map((o) => o.value), ["課金"]);
  assert.throws(() => writeBrief(dir, { name: "usage", removeOutOfScope: ["無い項目"] }), /扱わないことに無い/);
});

test("引く: paths の基点からの相対パスで文書の決め事を探す。ほかの文書の決め事は出さない", () => {
  const dir = tmp();
  writeBrief(dir, usage);
  writeBrief(dir, { name: "usage", set: { 文書ごとの決め事: { "settings/font.html": { ゴール: "文字を大きくできる" } } } });
  const briefs = loadBriefs(dir);
  const r = resolveBrief(briefs, "docs/web/usage/settings/font.html");
  assert.equal(r.status, "ok");
  assert.equal(r.docKey, "settings/font.html");
  const out = renderForDoc(r.brief, r.docKey);
  assert.match(out, /### settings\/font\.html/);
  assert.doesNotMatch(out, /phone\.html/);
  assert.doesNotMatch(out, /^---/m, "frontmatter は出さない");
});

test("引く: 同じ層のブリーフが2つ当たれば止める。default は、どれにも当たらない文書の paths だけで当てる", () => {
  const dir = tmp();
  writeBrief(dir, usage);
  writeBrief(dir, { ...usage, name: "web", title: "サイト全体", paths: ["docs/web/**"] });
  writeBrief(dir, { ...usage, name: "default", title: "その他", paths: ["README.md"] });
  const briefs = loadBriefs(dir);
  assert.equal(resolveBrief(briefs, "docs/web/usage/phone.html").status, "conflict");
  assert.equal(resolveBrief(briefs, "docs/web/index.html").brief.name, "web");
  assert.equal(resolveBrief(briefs, "README.md").brief.name, "default");
  assert.equal(resolveBrief(briefs, "src/app.ts").status, "none", "default でもコードには当てない");
});

test("欠け: 必須の項目が無ければ挙げ、「仮定」の項目は確かめる側に挙げる", () => {
  const dir = tmp();
  writeBrief(dir, { name: "g", title: "t", paths: ["docs/**"], by: "書き手", set: { 読者: { プロファイル: "operator", 読む状況: "障害時" } } });
  const [b] = loadBriefs(dir);
  const { missing, assumed, draft } = missingItems(b, "a.md");
  assert.ok(missing.includes("読者 / 読者像"));
  assert.ok(missing.includes("事実の承認者 / 承認者"));
  assert.ok(missing.some((m) => m.startsWith("扱わないこと")));
  assert.ok(!missing.some((m) => m.includes("文書ごとの決め事")), "文書ごとの項目は聞く側に入れない");
  assert.deepEqual(draft, [
    "文書ごとの決め事（a.md） / ゴール",
    "文書ごとの決め事（a.md） / 文書の種類",
    "文書ごとの決め事（a.md） / 受け入れ基準",
  ]);
  assert.deepEqual(assumed, ["読者 / プロファイル: operator", "読者 / 読む状況: 障害時"]);
});

test("globBase: 最初のワイルドカードより前のフォルダー", () => {
  assert.equal(globBase("docs/web/usage/**"), "docs/web/usage/");
  assert.equal(globBase("docs/*.md"), "docs/");
  assert.equal(globBase("README.md"), "");
});


test("手で直したファイル: 字下げ無し・1行・文字列の paths と BOM を読む", () => {
  const body = "\n# 文書群: t\n\n## 読者\n\n| 項目 | 値 | 状態 | 由来 |\n|---|---|---|---|\n| プロファイル | beginner | 確定 | x |\n";
  assert.deepEqual(parseBrief('---\npaths:\n- "docs/a/**"\n- docs/b/**\n---' + body).paths, ["docs/a/**", "docs/b/**"]);
  assert.deepEqual(parseBrief('---\npaths: ["docs/a/**", "docs/b/**"]\n---' + body).paths, ["docs/a/**", "docs/b/**"]);
  assert.deepEqual(parseBrief('---\npaths: "docs/a/**"\n---' + body).paths, ["docs/a/**"]);
  assert.deepEqual(
    parseBrief('﻿---\r\npaths:\r\n  - "docs/a/**"\r\n---' + body.replace(/\n/g, "\r\n")).paths,
    ["docs/a/**"]
  );
});

test("手で直したファイル: 知らない節や表でない本文があれば、書き戻さずに止める（黙って消さない）", () => {
  const dir = tmp();
  const { file } = writeBrief(dir, usage);
  const original = fs.readFileSync(file, "utf-8");
  fs.writeFileSync(file, original + "\n## メモ\n\n家族への説明は別紙\n");
  assert.throws(() => writeBrief(dir, { name: "usage", outOfScope: ["課金"] }), /知らない節「メモ」/);
  fs.writeFileSync(file, original.replace("## 事実の承認者\n", "## 事実の承認者\n\n承認者は依頼者。\n"));
  assert.throws(() => writeBrief(dir, { name: "usage", outOfScope: ["課金"] }), /表でない本文/);
});

test("paths が読めなくなったファイルには書かない（paths の無いルールは常に読み込まれる）", () => {
  const dir = tmp();
  const { file } = writeBrief(dir, usage);
  fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(/^---[\s\S]*?---\n/, ""));
  assert.throws(() => writeBrief(dir, { name: "usage", outOfScope: ["課金"] }), /paths が読めない/);
});

test("値の中の | は往復で崩れない", () => {
  const dir = tmp();
  writeBrief(dir, { ...usage, set: { 読者: { 読者像: "本人 | 家族" } } });
  writeBrief(dir, { name: "usage", set: { 読者: { 読む状況: "画面を見ながら" } } });
  const [b] = loadBriefs(dir);
  assert.equal(b.group.読者.読者像.value, "本人 | 家族");
  assert.equal(b.group.読者.読者像.status, "確定");
});

test("paths に { } を使わせない。由来に補足を添えられる。「なし」は項目があれば消える", () => {
  const dir = tmp();
  assert.throws(() => writeBrief(dir, { ...usage, paths: ["docs/{a,b}/**"] }), /\{ \}/);
  writeBrief(dir, { ...usage, outOfScope: ["なし"] }, "2026-10-05");
  writeBrief(
    dir,
    { name: "usage", outOfScope: ["課金"], note: "change-policy。前は なし", set: { 読者: { 読者像: "家族" } } },
    "2026-10-06"
  );
  writeBrief(dir, { name: "usage", outOfScope: ["なし"] });
  const [b] = loadBriefs(dir);
  assert.deepEqual(
    b.outOfScope.map((o) => o.value),
    ["課金"],
    "最初は「なし」だけ。項目を足したら「なし」が消え、そのあとの「なし」は足さない"
  );
  assert.equal(b.group.読者.読者像.origin, "2026-10-06 依頼者（change-policy。前は なし）");
});

test("重なりの警告: 同じ層や default と paths が重なっていそうなら知らせる", () => {
  const dir = tmp();
  writeBrief(dir, usage);
  const { warnings } = writeBrief(dir, { ...usage, name: "web", title: "サイト", paths: ["docs/web/**"] });
  assert.ok(warnings.some((w) => w.includes("usage")));
  const ok = writeBrief(dir, { ...usage, name: "ref", title: "リファレンス", paths: ["docs/reference/**"] });
  assert.deepEqual(ok.warnings, []);
});

test("CLI: apply.mjs --brief は書いて中身を出し、JSON の誤りは1行のエラーで止まる", () => {
  const dir = tmp();
  const okRun = run(APPLY_CLI, ["--dest", dir, "--brief", JSON.stringify(usage)]);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.match(okRun.stdout, /書き込んだ: \.claude\/rules\/doc-brief-usage\.md/);
  const bad = run(APPLY_CLI, ["--dest", dir, "--brief", "{name:"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JSON が読めない/);
  assert.doesNotMatch(bad.stderr, /at JSON\.parse/, "スタックトレースを出さない");
  const file = path.join(dir, "in.json");
  fs.writeFileSync(file, JSON.stringify({ name: "usage", outOfScope: ["課金"] }));
  assert.equal(run(APPLY_CLI, ["--dest", dir, "--brief-file", file]).status, 0);
});

test("CLI: brief.mjs は絶対パスと \\ 区切りの文書のパスを受け付け、重なりは終了コード 2", () => {
  const dir = tmp();
  writeBrief(dir, usage);
  const abs = path.join(dir, "docs", "web", "usage", "phone.html");
  const shown = run(BRIEF_CLI, ["show", abs, "--dest", dir]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /文書ごとの見出し「phone\.html」/);
  assert.equal(run(BRIEF_CLI, ["missing", "docs\\web\\usage\\phone.html", "--dest", dir]).status, 0);
  writeBrief(dir, { ...usage, name: "web", title: "サイト", paths: ["docs/web/**"] });
  assert.equal(run(BRIEF_CLI, ["show", "docs/web/usage/phone.html", "--dest", dir]).status, 2);
});
