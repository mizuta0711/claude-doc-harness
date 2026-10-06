/**
 * 実行役の既定の答え（シナリオが答えを決めなかった問い）。run.mjs から使う（SDK を読み込まずにテストできるよう分けた）。
 *
 * - 依頼者だけが知っている事実の問い（見出しが「事実の確認」か、問いの文に「依頼者だけが知っている」）と、推奨の無い問い
 *   （製品の判断を含む）では、推奨の自動の選択をしない。答えを持たない依頼者に近い、控えめな選択肢を選ぶ
 *   （B1 で、入手先・接続先の問いに推奨が付き、実行役が選び、改訂設計書に「依頼者の回答」として記録された。
 *   DocumentTemplete backlog B38）。控えめな選択肢の順: 「分からない」→「問い合わせのまま／に残す」→「直すまで書かない」→「書かない」
 * - それ以外は「（推奨）」の付いた選択肢
 *
 * 戻り値: { answer, reason }。reason は qa.jsonl に残す（"recommended" / "cautious" / "no-recommendation"）
 */
const CAUTIOUS = [/分からない/, /問い合わせのまま|問い合わせに残す/, /直すまで書かない/, /書かない/];

export function defaultAnswer(q) {
  const options = q.options || [];
  const rec = options.find((o) => /推奨/.test(o.label));
  const fact = /事実の確認/.test(q.header || "") || /依頼者だけが知っている/.test(q.question || "");
  if (!fact && rec) return { answer: rec.label, reason: "recommended" };
  for (const re of CAUTIOUS) {
    const o = options.find((x) => re.test(x.label));
    if (o) return { answer: o.label, reason: "cautious" };
  }
  // 控えめな選択肢も無い: 候補を選ばず、自由入力で「分からない」と答える（AskUserQuestion は選択肢に無い答えを受け付ける）。
  // 記録に残して後で判定する（推奨の無い問いを、書き手が事実の確認の形にしていない兆候）
  return { answer: "分からない（問い合わせに残す）", reason: "no-recommendation" };
}
