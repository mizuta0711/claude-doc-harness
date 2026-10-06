/**
 * B15（0.20.0）の受け入れ基準 9: p7-b15.mjs の後、製品のソース（strings.xml）を1行変えてコミットしてから、文書群の見直しで候補に出るかを見る。
 * p7-b15.mjs と同じセッションを --resume で続ける。
 *
 *   node run.mjs scenarios/p7-b15-stale.mjs --plugin ../../plugins/harness-doc --resume <セッション>
 */
export const cwd = "D:/Develop/ClaudeCode/_fieldtest/SimplePhone-p7";

export const steps = [{ id: "T3", prompt: "アプリの文言を変えたので、使い方サイト全体を見直して。古くなったページはある？" }];

export function answer() {
  return null;
}

export function approve() {
  return false;
}
