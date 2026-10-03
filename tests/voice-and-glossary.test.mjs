/**
 * 0.4.0: 用語表の列を見出しで決める読み込み・既存の用語表（glossaryFiles）・文末の混在検査。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  checkDocument,
  checkEndings,
  loadStyle,
  parseGlossary,
} from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";

test("用語表: 「対象 | 使う | 使わない」の表を見出しで読み、強調と ❌ を外す", () => {
  const rows = parseGlossary(
    [
      "| 対象 | 使う | 使わない |",
      "|------|------|---------|",
      "| 正式名称 | **高性能開発用通信スタブツール** | — |",
      "| 種別の呼称 | **スタブツール** | ❌ **シミュレータ** |",
    ].join("\n")
  );
  assert.deepEqual(rows, [
    { preferred: "高性能開発用通信スタブツール", banned: [] },
    { preferred: "スタブツール", banned: ["シミュレータ"] },
  ]);
});

test("用語表: 「❌ | ✅」のように禁止が先の表も読む", () => {
  const rows = parseGlossary("| ❌ | ✅ |\n|----|----|\n| 向かい先 | 接続先 |\n| 正源 | 唯一の正 |\n");
  assert.deepEqual(rows, [
    { preferred: "接続先", banned: ["向かい先"] },
    { preferred: "唯一の正", banned: ["正源"] },
  ]);
});

test("用語表: 禁止の列が無い表（「役割 | 使う」）は読まない。表が変わると列の判定もやり直す", () => {
  const rows = parseGlossary(
    [
      "| 役割 | 使う |",
      "|------|------|",
      "| 本物のデバイス | **実機** |",
      "",
      "| 推奨表記 | 禁止表記 | 意味 |",
      "|---|---|---|",
      "| サーバ | サーバー | 長音なしで統一 |",
    ].join("\n")
  );
  assert.deepEqual(rows, [{ preferred: "サーバ", banned: ["サーバー"] }]);
});

test("glossaryFiles: プロジェクトの既存の用語表も読む", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));
  fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "rules", "terms.md"), "| 使わない | 使う |\n|---|---|\n| 被テストアプリ | テスト対象アプリ |\n");
  const style = loadStyle(dir, { ...DEFAULT_CONFIG, glossaryFiles: [".claude/rules/terms.md", "missing.md"] });
  assert.deepEqual(style.glossary, [{ preferred: "テスト対象アプリ", banned: ["被テストアプリ"] }]);
  const issues = checkDocument("# t\n\n被テストアプリに接続する。\n", { config: DEFAULT_CONFIG, style });
  assert.deepEqual(issues.map((i) => i.kind), ["glossary"]);
});

test("文末: 敬体の設定では常体の文末を止め、「」の中と体言止めは見ない", () => {
  const voice = { endings: "keitai" };
  const lines = [
    { no: 1, text: "電話をかけます。" },
    { no: 2, text: "設定を保存する。" },
    { no: 3, text: "画面に「保存した。」と出ます。" },
    { no: 4, text: "- ホーム画面" },
    { no: 5, text: "ボタンを押してください。" },
    { no: 6, text: "これは仕様である。" },
  ];
  assert.deepEqual(
    checkEndings(lines, voice).map((i) => i.line),
    [2, 6]
  );
});

test("文末: 敬体の過去形（ました。でした。）は常体と誤判定しない", () => {
  const voice = { endings: "keitai" };
  const lines = [
    { no: 1, text: "保存しました。" },
    { no: 2, text: "設定は空でした。" },
    { no: 3, text: "設定を保存した。" },
    { no: 4, text: "画面が開いた。" },
  ];
  assert.deepEqual(
    checkEndings(lines, voice).map((i) => i.line),
    [3, 4]
  );
});

test("文末: 常体の設定では敬体の文末を止める。設定が無ければ何もしない", () => {
  const lines = [
    { no: 1, text: "設定を保存する。" },
    { no: 2, text: "ボタンを押してください。" },
    { no: 3, text: "保存されます。" },
  ];
  assert.deepEqual(checkEndings(lines, { endings: "jotai" }).map((i) => i.line), [2, 3]);
  assert.deepEqual(checkEndings(lines, { endings: null }), []);
  assert.deepEqual(checkEndings(lines, undefined), []);
});

test("文末: Markdown と HTML の両方で効き、コードの中は見ない", () => {
  const config = { ...DEFAULT_CONFIG, voice: { endings: "keitai" } };
  const md = checkDocument("# t\n\n保存する。\n\n```bash\necho する。\n```\n", { config, style: null });
  assert.deepEqual(md.map((i) => [i.kind, i.line]), [["voice", 3]]);
  const html = checkDocument("<p>保存します。</p>\n<p>保存する。</p>\n<pre>する。</pre>", { config, style: null, format: "html" });
  assert.deepEqual(html.map((i) => [i.kind, i.line]), [["voice", 2]]);
});
