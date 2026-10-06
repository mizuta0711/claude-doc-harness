/**
 * B15（0.20.0）の受け入れ基準 7・8 を写しで確かめる（設計: DocumentTemplete の docs/active/設計_陳腐化の追随.md §4）。
 * 写し: _fieldtest/SimplePhone-p7（SimplePhone-p6 の 41161e6 に、本体の app/build.gradle.kts を足した 6e3a628）。
 * 続きは p7-b15-stale.mjs（製品のソースを変えた後の文書群の見直し。基準9）。問いには既定（推奨）で答える。
 *
 *   node run.mjs scenarios/p7-b15.mjs --plugin ../../plugins/harness-doc
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p7";

export const steps = [
  // 基準8（方針変更で、対象のアプリの版を読む場所を決める）
  { id: "T0", prompt: "使い方サイトの改訂履歴に、どのアプリの版で確かめたかを書くようにして。版は app/build.gradle.kts の versionName にある" },
  { id: "T0-commit", prompt: "今の変更をコミットして" },
  // 基準7・8（事実を確かめる小さな直し）
  { id: "T1", prompt: "使い方サイトの連絡先のページで、ボタンの名前が実物と違っていないか確かめて、違っていたら直して" },
  { id: "T1-commit", prompt: "今の変更をコミットして" },
  // 基準7・8（M）
  { id: "T2", prompt: "使い方サイトの設定のページに、文字の大きさを変える手順を足して" },
  { id: "T2-commit", prompt: "今の変更をコミットして" },
];

export function answer() {
  return null;
}

export function approve() {
  return false;
}
