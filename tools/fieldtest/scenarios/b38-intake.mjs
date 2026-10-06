/**
 * 0.13.0 の確かめ: 受付の時点の「依頼者だけが知っている事実」の問いが、事実の確認の形（推奨なし・「分からない」あり）で出るか。
 *
 *   node run.mjs scenarios/b38-intake.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p3b";

export const steps = [{ id: "S1", prompt: "使い方の目次のページ（docs/web/usage/index.html）の最初に、SimplePhone をどこから入れればよいかを1行書き足して" }];

export function answer() {
  return null; // すべて既定（事実の確認・推奨なしは控えめな選択肢）
}

export function approve() {
  return false;
}
