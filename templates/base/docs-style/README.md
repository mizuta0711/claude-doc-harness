# 文書ハーネスの使い方

<!-- doc-type: howto -->

## この文書でできること

Claude Code にマニュアル・手順書・仕様書を書かせるとき、**毎回同じ手順・同じ水準**で
書かせ、予備知識のない読者役のレビューと機械チェックを通した状態で受け取れるようになる。

読者: このプロジェクトで Claude Code に文書を書かせる人。Claude Code の基本操作
（スキルを `/名前` で呼ぶ、サブエージェントが起動する）は知っている前提。

## 前提条件

- Claude Code にプラグイン `harness-doc@doc-harness` が導入されている
  （確認: `claude plugin list` の出力に `harness-doc` がある）
- プロジェクトに次の3つがある（無ければ `claude-doc-harness/tools/apply.mjs` で置く）
  - `.claude/doc-harness.config.json`（検査対象と必須見出しの設定）
  - `docs-style/glossary.md`（用語集）と `docs-style/banned-words.txt`（曖昧語リスト）
  - `CLAUDE.md` の「文書ルール（harness-doc）」の節

## 手順

### 1. 読者とゴールを伝えて、スキルを呼ぶ

```text
/harness-doc:manual-writer 障害時の復旧手順書。読者は運用担当。読み終えたらサービスを再起動して正常を確認できる
```

期待される動き: スキルが読者プロファイル（beginner / operator / developer）を選び、
読者とゴールを1〜2文で確認してくる。曖昧なら質問が返る。

### 2. 事実確認の結果を確認する

スキルは対象のコード・設定を読み、手順に出るコマンドを実行してから目次案を出す。

期待される動き: 「実行して確認した」「確認できなかったので未確認と書く」が項目ごとに報告される。

### 3. 本文が書かれ、`check-docs` フックが走る

`.md` を書くたびにフックが曖昧語・見出し・言語指定・用語集・リンク切れを検査する。

期待される動き: 違反があると次のような指摘が出て、Claude がその場で直す。

```text
[check-docs] docs/guide/復旧手順.md に 2 件の指摘があります。直してから先へ進んでください。
  L12  曖昧語「適宜」: 条件と値を具体的に書く
  L30  コードブロックに言語指定がありません（例: ```bash、```text）
```

### 4. 読者役レビューの結果を見る

`doc-reviewer` エージェントが、文書だけを頼りに作業できるかを点検して指摘を返す。

期待される動き: 指摘ごとに「場所・問題・読者がどう困るか・修正案・重大度」が並び、
スキルが全件に「対応済み／見送り（理由）」を付けて本文へ反映する。

## 確認

- 文書の冒頭に「この文書でできること」と読者が書いてある
- `node <claude-doc-harness>/plugins/harness-doc/hooks/scripts/check-docs.mjs docs/guide/復旧手順.md` を
  実行すると `[check-docs] OK: ...` と出る
- 読者役レビューの指摘が全件「対応済み」か「見送り（理由）」になっている

## うまくいかない場合

| 症状 | 原因 | 対処 |
|---|---|---|
| `/harness-doc:manual-writer` が `Unknown skill` になる | プラグインが入っていない、または Claude Code を再起動していない | `claude plugin install harness-doc@doc-harness --scope user` を実行して再起動する |
| フックが何も言わない | `.claude/doc-harness.config.json` が無い（設定不在は素通りする） | `tools/apply.mjs` で置くか、テンプレートからコピーする |
| フックが検査してほしくないファイルで失敗する | `include` に当たっている | `exclude` に加える。1ファイルだけなら冒頭15行以内に `<!-- check-docs: skip -->` を書く（理由をその行に添える） |
| 曖昧語の説明のために曖昧語そのものを書きたい | 本文に書くと検出される | インラインコード（`` `適宜` ``）で囲む。インラインコードは検査しない |
| 用語集の禁止表記が固有名詞に当たる | 例: 製品名に「サーバ」を含む | その行末に `<!-- check-docs: ignore -->` を書く |
