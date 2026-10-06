/**
 * B13（0.17.0）の受け入れ基準 1・2・4・5 を写しで確かめる（DocumentTemplete の docs/reviews/20261006_harness-doc0.17.0_B13_実施記録.md §4）。
 * 写し: _fieldtest/SimplePhone-p5（SimplePhone-p3b の dab3d97 から作った。harness-doc は 0.10 台で導入済み、voice.md に図と画面の節が無い）。
 * 問いには既定（推奨）で答える。手元の 0.17.0 で走らせる:
 *
 *   node run.mjs scenarios/p5-b13.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p5";

export const steps = [
  // 基準5: 導入済みのプロジェクトに足すモードで、voice.md に図と画面・例に使う名前の節が足され、例の名前の多数派を読み取る
  { id: "T0", prompt: "このプロジェクトに文書ハーネスを入れて" },
  { id: "T0-commit", prompt: "今の変更をコミットして" },
  // 基準1・2: 図を足す依頼（M）。目次案に図・画面の列（「なし」も）。撮影の方法が無ければ撮らない
  { id: "T1", prompt: "使い方サイトのホーム画面のページに、画面のどこに何があるかが分かる図を足して" },
  { id: "T1-commit", prompt: "今の変更をコミットして" },
  // 基準4: 文字の擬似図のある Markdown を読者役で点検する（本文に同じ内容があるかを見るか）
  { id: "T2", prompt: "docs/usage/HISTORY.md を、読者役で点検だけして" },
];

export function answer() {
  return null;
}

export function approve() {
  return false;
}
