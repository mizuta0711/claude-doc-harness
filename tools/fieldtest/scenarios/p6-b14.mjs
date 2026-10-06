/**
 * B14（0.19.0）の受け入れ基準 1〜8 を写しで確かめる（設計: DocumentTemplete の docs/active/設計_文書群の設計と接続.md §4）。
 * 写し: _fieldtest/SimplePhone-p6（SimplePhone-p5 の 3ec18d5 から作った。ブリーフに入口の節は無い）。
 * 規模の問いで同じ目的の既存文書の選択肢が出たら「新しく書く」を選ぶ（新規作成の経路を通すため）。ほかは既定（推奨）。
 *
 *   node run.mjs scenarios/p6-b14.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p6";

export const steps = [
  // 基準1・2・3・7（文書群の見直し）・8（入口が無くても止まらない）
  { id: "T1", prompt: "使い方サイト全体を見直して。どれから直せばいい？" },
  // 基準4・5・6・7（新規作成。既存の電話のページと目的が重なる。方法ごとの節がある）
  {
    id: "T2",
    prompt:
      "使い方サイトに、電話のかけ方を3通り（番号を押してかける・連絡先からかける・通話履歴からかけ直す）まとめた新しいページを書いて。どの方法でも最後に、相手につながったかの確かめ方を書いて",
  },
  { id: "T2-commit", prompt: "今の変更をコミットして" },
  // 基準4・6（新規作成の1本。T2 は既存のページに足す案が選ばれ、新規作成の経路を通らなかったので足した）
  {
    id: "T3",
    prompt:
      "使い方サイトに、新しいページを1つ作って。内容は「写真を家族に送る」で、メールで送る方法とメッセージで送る方法の2通りを書き、どちらでも最後に、送れたかの確かめ方を書いて",
  },
  { id: "T3-commit", prompt: "今の変更をコミットして" },
];

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;

export function answer(q) {
  // 同じ目的の既存文書があるときの選択肢（T2 では「既存ページに足す（推奨）」「まとめのページを新しく作る」の形だった）
  if (q.options.some((o) => /新し/.test(o.label)) && q.options.some((o) => /既存/.test(o.label))) return find(q, /新し/);
  return null;
}

export function approve() {
  return false;
}
