/**
 * 0.13.0 の確かめ（DocumentTemplete 実装計画_B38-B39 §4）: 写しのリモート制御のページを規模 M で書き直す。
 * 見ること: 接続先のような依頼者だけが知っている事実の問いに推奨が付かず、実行役が「分からない」を選ぶ／
 * 食い違い・安全に関わる記述が完了前の確認に並ぶ（推奨なし）／完了報告が表の形で、新しい行がある。
 *
 *   node run.mjs scenarios/b39.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p3b";

export const steps = [
  {
    id: "M1",
    prompt: "リモート制御のページ（docs/web/usage/remote-control.html）を、離れて暮らす家族が初めてつなぐときに迷わないように書き直して",
  },
  { id: "M1-commit", prompt: "今の変更をコミットして" },
];

const find = (q, re) => (q.options.find((o) => re.test(o.label)) || {}).label;

export function answer(q) {
  if (/規模/.test(q.header || "")) return find(q, /\bM\b|規模 M|M で/) || null;
  if (/採用|完了前/.test(`${q.header} ${q.question}`)) return find(q, /このまま採用/) || null;
  return null; // 既定（事実の確認・推奨なしは「分からない」）
}

export function approve() {
  return false;
}
