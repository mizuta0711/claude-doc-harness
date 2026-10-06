/**
 * B1: SimplePhone 本体の使い方サイト（docs/web）を、文書ハーネスで書き直す（依頼者の指示。2026-10-06）。
 * 写しではなく本体で、作業用のブランチ docs/harness-doc-web-rewrite の上で進める。push はしない。
 * 問いには「推奨」で答える（依頼者は、途中の判断を実行役に任せ、最後に差分で見ると決めた）。
 *
 *   node run.mjs scenarios/b1-simplephone.mjs
 */
export const cwd = "D:/Develop/android/SimplePhone";

export const steps = [
  { id: "setup", prompt: "このプロジェクトに文書ハーネスを入れて" },
  { id: "setup-commit", prompt: "今の変更をコミットして" },
  {
    id: "rewrite",
    prompt:
      "使い方サイト（docs/web）を、初めてスマホを使うシニア本人と、離れて暮らして設定を手伝う家族が迷わないように、全体を分かりやすく書き直して",
  },
  { id: "rewrite-commit", prompt: "今の変更をコミットして" },
];

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;

export function answer(q) {
  // 試作の調整は求めない。完了前の確認は採用する。それ以外は推奨
  if (q.header === "試作") return find(q, /この方針|この調子/) || null;
  if (/採用|完了前/.test(`${q.header} ${q.question}`)) return find(q, /このまま採用/) || null;
  return null;
}

export function approve() {
  return false;
}
