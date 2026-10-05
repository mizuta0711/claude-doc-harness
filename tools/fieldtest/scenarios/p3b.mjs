/**
 * 実地検証 P3b（DocumentTemplete の docs/active/実地検証_P3b.md）: L の改訂とテイスト変更（L）を通す。
 * 返事の規則は作業指示の「返事のしかた」をそのまま写したもの。規則に当たらない問いは推奨を選ぶ。
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p3b";

export const steps = [
  { id: "T0", prompt: "このプロジェクトに文書ハーネスを入れて" },
  { id: "T0-commit", prompt: "今の変更をコミットして" },
  { id: "T1", prompt: "使い方サイトの、電話をかけるページと通話履歴のページが分かりにくいと家族に言われた。直して" },
  { id: "T1-commit", prompt: "今の変更をコミットして" },
  { id: "T2", prompt: "使い方サイトのメールのページとメッセージのページを、もっとやさしい言葉に変えて。専門用語は言い換えて" },
  { id: "T2-commit", prompt: "今の変更をコミットして" },
];

const READER = "SimplePhone を初めて使うシニア。設定は家族が手伝う";
const OUT_OF_SCOPE = "端末 OS の設定（機内モード・SIM・電源）";

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;
const text = (q) => `${q.header || ""} ${q.question}`;

export function answer(q, ctx) {
  const t = text(q);
  // T0: 導入
  if (ctx.step === "T0") {
    if (q.multiSelect && /場所|置き場所|検査/.test(t)) {
      const picks = q.options.filter((o) => /docs\/web|README/i.test(o.label)).map((o) => o.label);
      if (picks.length) return picks.join(", ");
    }
    if (/読者/.test(q.header || "") && !q.options.some((o) => /推奨/.test(o.label))) return READER;
    if (/扱わない/.test(t) && !find(q, /推奨/)) return OUT_OF_SCOPE;
    if (/改訂履歴/.test(t)) return find(q, /あり/) || null;
    if (/文体/.test(t)) return find(q, /踏襲|このまま/) || null;
    return null;
  }
  // T1: L の改訂。規模は L。最初の試作は調整、上限の案内では「調整して見せる」、2回目の試作は承認
  if (ctx.step === "T1") {
    if (/規模/.test(t)) return find(q, /\bL\b|規模 L|L で/) || null;
    // 試作の承認の問いだけに当てる（見出しで見分ける。問いの文で見ると「…試作に進んでよいですか」の Stage 1 の問いに当たった。2026-10-06 の本走）
    if (q.header === "試作" || /上限/.test(q.header || "")) {
      ctx.seen.proto = (ctx.seen.proto || 0) + 1;
      if (/上限/.test(t + q.options.map((o) => o.label + o.description).join(" "))) return find(q, /調整して見せる/) || null;
      if (ctx.seen.proto === 1) return "調整する: 一文をもう少し短く";
      return find(q, /この方針|全体を書く/) || null;
    }
    if (/完了前|採用/.test(t)) return find(q, /このまま採用/) || null;
    return null;
  }
  // T2: テイスト変更。voice.md に書くかは「書く」
  if (ctx.step === "T2") {
    if (/voice\.md|文体の差分/.test(t)) return find(q, /^書く|書き戻す|書く（推奨）/) || null;
    if (/完了前|採用/.test(t)) return find(q, /このまま採用/) || null;
    return null;
  }
  return null;
}

/** フックが承認を求めたとき（doc-record: skip）。この検証では起きない想定なので、起きたら拒否して記録に残す */
export function approve() {
  return false;
}
