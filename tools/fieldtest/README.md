# 実地検証の実行役（tools/fieldtest）

harness-doc の実地検証（写しのプロジェクトで、依頼を順に入力し、Claude の問いに答える）を、Claude Agent SDK で自動で走らせる道具。
**ハーネスを直す人向け**で、利用者に配るプラグイン（`plugins/harness-doc/`）には含めない。

## 使い方

```bash
cd tools/fieldtest
npm install
node run.mjs scenarios/p3b.mjs
```

- 許可を省くモードで、インストール済みのプラグイン・フック・`CLAUDE.md` を読み込んで動く。認証は Claude Code のログインをそのまま使う
- 依頼は1つのセッションで続ける。問い（AskUserQuestion）には、シナリオの `answer` の規則で答え、規則に当たらなければ `default-answer.mjs` の既定で答える（推奨を選ぶ。依頼者だけが知っている事実の問い・推奨の無い問いでは「分からない」「問い合わせに残す」のような控えめな選択肢を選ぶ）。フックの承認の求め（`ask`）には `approve` で答える
- ログは `out/<シナリオ>-<時刻>/`（`qa.jsonl`: 問いと答え・承認の求め・各手順の結果。`run.log`: 経過。`session.txt`: セッションの id）。`out/` はコミットしない
- 途中から続けるときは `--resume <セッションの id> --from <手順の id>`

## 判定

この道具は判定しない。判定の正は Claude Code のセッションのログ（`~/.claude/projects/<写しのパス>/<セッションの id>.jsonl`）で、DocumentTemplete の実施記録で判定する。

## 自動にできないこと

- 問いが人にとって分かりやすいか、選択肢が選びやすいか（規則で答えるので測れない）。`qa.jsonl` の問いの一覧を人が見て、気になる問いだけ指摘する
- 人が迷って言い直す流れ
