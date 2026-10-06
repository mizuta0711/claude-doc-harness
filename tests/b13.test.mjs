/**
 * 0.17.0: 図・画面の計画と例に使う名前（DocumentTemplete B13）。雛形と経路に、決める場所があることを確かめる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "harness-doc");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf-8");

test("B13: 雛形の voice.md に「図と画面」「例に使う名前」の節があり、撮影の方法が「なし」なら撮らないと書いてある", () => {
  const voice = read("scaffold", "docs-style", "voice.md");
  for (const h of ["## 図と画面", "## 例に使う名前", "## 見た目（HTML の文書だけ）"]) assert.ok(voice.includes(h), h);
  assert.ok(voice.indexOf("## 図と画面") < voice.indexOf("## 見た目（HTML の文書だけ）"));
  assert.match(voice, /なしなら撮らない/);
  assert.doesNotMatch(voice.split("## 見た目（HTML の文書だけ）")[1], /図の描き方/, "図の描き方は「図と画面」に1か所だけ");
});

test("B13: 改訂設計書の目次案に「図・画面」の列があり、既定は「なし」", () => {
  const plan = read("skills", "plan-doc", "TEMPLATE.md");
  assert.match(plan, /\| 見出し \| 図・画面 \| 理由 \|/);
  assert.match(plan, /既定は「なし」/);
});

test("B13: manual-writer は撮影スキルを呼べる（allowed-tools に Skill）", () => {
  const mw = read("skills", "manual-writer", "SKILL.md");
  assert.match(mw.split("---")[1], /allowed-tools: ".*\bSkill\b.*"/);
  assert.match(mw, /### 図と画面/);
});
