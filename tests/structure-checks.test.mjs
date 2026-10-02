/**
 * 0.5.0: 構造とアクセシビリティの検査（画像の代替テキスト・見出しの飛び・リンク文言・html の lang）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, checkDocument } from "../plugins/harness-doc/hooks/scripts/check-docs.mjs";
import { headingSkipIssues, isVagueLinkText } from "../plugins/harness-doc/hooks/scripts/structure-checks.mjs";

const md = (t, config = DEFAULT_CONFIG) => checkDocument(t, { config, style: null, format: "md" });
const html = (t, config = DEFAULT_CONFIG) => checkDocument(t, { config, style: null, format: "html" });
const kl = (issues) => issues.map((i) => [i.kind, i.line]);

test("リンク文言: 「こちら」「ここ」だけのリンクを止め、行き先を含む文言は止めない", () => {
  assert.ok(isVagueLinkText(" こちら "));
  assert.ok(isVagueLinkText("Click here"));
  assert.ok(!isVagueLinkText("こちらの手順"));
  assert.ok(!isVagueLinkText("設定の手順"));
});

test("見出しの飛び: 下げる方向の飛びだけを止め、上げる方向は止めない", () => {
  const levels = [1, 2, 4, 2, 3, 1].map((level, i) => ({ level, line: i + 1 }));
  assert.deepEqual(kl(headingSkipIssues(levels)), [["heading-skip", 3]]);
});

test("Markdown: 代替テキストの無い画像・飛んだ見出し・曖昧なリンク文言を止める。コードの中は見ない", () => {
  const t = [
    "# t", // 1
    "", // 2
    "### 飛んだ", // 3
    "", // 4
    "![](a.png) ![画面の全体](b.png)", // 5
    "", // 6
    "詳しくは[こちら](https://example.com)。[設定の手順](https://example.com)も見る。", // 7
    "", // 8
    "```markdown", // 9
    "#### コードの中", // 10
    "![](c.png) [こちら](x)", // 11
    "```", // 12
  ].join("\n");
  assert.deepEqual(kl(md(t)), [["heading-skip", 3], ["alt", 5], ["link-text", 7]]);
});

test("HTML: alt 属性の無い img を止め、alt=\"\"（飾り）は認める", () => {
  const t = '<html lang="ja">\n<img src="a.png">\n<img src="b.png" alt="">\n<img src="c.png" alt="設定画面">\n</html>';
  assert.deepEqual(kl(html(t)), [["alt", 2]]);
});

test("HTML: 見出しの飛び・曖昧なリンク文言（入れ子のタグを除いて判定）・lang の無い html を止める", () => {
  const t = [
    "<html>", // 1
    "<h1>t</h1>", // 2
    "<h3>飛んだ</h3>", // 3
    '<p>詳しくは<a href="https://example.com"><span>こちら</span></a>。</p>', // 4
    '<p><a href="https://example.com">設定の手順</a></p>', // 5
    "<!-- <h5>コメントの中</h5> <img src='x'> -->", // 6
    "<script>const s = '<a href=\"x\">ここ</a><img src=\"y\">';</script>", // 7
    "</html>",
  ].join("\n");
  assert.deepEqual(kl(html(t)), [["heading-skip", 3], ["link-text", 4], ["lang", 1]]);
});

test("config.rules で個別に止められる", () => {
  const config = { ...DEFAULT_CONFIG, rules: { imageAlt: false, headingSkip: false, linkText: false, htmlLang: false } };
  assert.deepEqual(md("# t\n\n### x\n\n![](a.png) [こちら](x)\n", config), []);
  assert.deepEqual(html("<html><h1>a</h1><h3>b</h3><img src='a'><a href='x'>ここ</a></html>", config), []);
});
