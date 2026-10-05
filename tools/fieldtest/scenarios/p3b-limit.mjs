/**
 * 実地検証 P3b の追加: 試作の「調整する」で確認の回数の上限に達したときの扱い（P3b の本走ではシナリオの誤りで起きなかった）。
 * 1本のテイスト変更（規模 M・上限3回）で、最初の試作に「調整する」と答える。
 * 期待: 2回目の試作を見せる前に「次に見せると上限を超える」と添え、「調整して見せる」「今の試作で進める」「やめる」から選ばせる。
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p3b";

export const steps = [
  { id: "T3", prompt: "使い方サイトのカメラのページを、もっとやさしい言葉に変えて" },
  { id: "T3-commit", prompt: "今の変更をコミットして" },
];

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;

export function answer(q, ctx) {
  if (ctx.step !== "T3") return null;
  if (/規模/.test(q.header || "")) return find(q, /\bM\b|規模 M|M で/) || null;
  // 試作の承認の問いだけ（見出しで見分ける。本走では Stage 1 の問いの文に「試作」が入っていて誤って当たった）
  if (q.header === "試作" || /上限/.test(q.header || "")) {
    ctx.seen.proto = (ctx.seen.proto || 0) + 1;
    const all = q.question + q.options.map((o) => o.label + (o.description || "")).join(" ");
    if (/上限/.test(all)) return find(q, /調整して見せる/) || null;
    if (ctx.seen.proto === 1) return "調整する: 一文をもう少し短く";
    return find(q, /この調子|この方針/) || null;
  }
  if (/採用|完了前/.test(`${q.header} ${q.question}`)) return find(q, /このまま採用/) || null;
  return null;
}

export function approve() {
  return false;
}
