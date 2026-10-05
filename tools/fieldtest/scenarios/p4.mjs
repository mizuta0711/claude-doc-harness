/**
 * 0.12.0 の確かめ（DocumentTemplete 実装計画_P4 §4）: 前からある指摘のある文書を、規模 S で直す。
 * docs/web/usage/index.html には、目次のカードの動詞の列挙が常体の文末として3件ある（前からある指摘）。
 * 期待: フックがその3件で止めず（additionalContext で件数だけが伝わる）、修正が1回で終わる。コミットも通る。
 *
 *   node run.mjs scenarios/p4.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p3b";

export const steps = [
  {
    id: "S1",
    prompt: "使い方の目次のページ（docs/web/usage/index.html）で、メールのカードの説明の「いちばん項目の多いページです」を「項目がいちばん多いページです」に直して",
  },
  { id: "S1-commit", prompt: "今の変更をコミットして" },
];

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;

export function answer(q, ctx) {
  if (/規模/.test(q.header || "")) return find(q, /\bS\b|規模 S|S で/) || null;
  return null;
}

export function approve() {
  return false;
}
