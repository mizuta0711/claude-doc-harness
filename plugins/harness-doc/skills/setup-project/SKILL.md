---
name: setup-project
description: 今開いているプロジェクトに文書ハーネス（harness-doc）を導入する。CLAUDE.md の文書ルールの節・docs-style/（用語集・曖昧語リスト・使い方）・.claude/doc-harness.config.json を置き、check-docs フックが動く状態にする。claude-dev-harness 導入済みのプロジェクトでは設計書・機能設計書・レビュー記録・引き継ぎを検査対象から外す。「このプロジェクトに文書ハーネスを入れて」「マニュアル作成の準備をして」の入口。manual-writer が設定不在を検出したときにも使う。
argument-hint: "[導入先のパス（省略時は今のプロジェクト）]"
allowed-tools: "Bash(node:*), Bash(ls:*), Bash(git status:*), Read, Glob"
---

# setup-project

今のプロジェクトに、文書ハーネスのプロジェクト側のファイルを置く。**利用者にコマンドを打たせない。**
すべてこのスキルの中でエージェントが実行する。

> **なぜ要るか。** プラグイン（スキル・エージェント・フック）は入れた時点で全プロジェクトに届くが、
> CLAUDE.md の節・用語集・検査対象の設定は**プロジェクトごとに置いて育てるもの**で、プラグインからは
> 自動で置けない。`check-docs` フックは設定ファイルが無いプロジェクトでは何もしないので、
> このスキルを通すまでフックは動かない。

スクリプトは `${CLAUDE_SKILL_DIR}/scripts/apply.mjs`。以降 `${APPLY}` と書くが、**シェル変数ではない**。
実行時はこの絶対パス（区切りは `/`）に置き換えて書く。置くファイルの原本はプラグインに同梱されている
（ネットワークは使わない）。

## Step 1: 導入先を決める

$ARGUMENTS にパスがあればそれ、無ければ今のプロジェクトのルートを導入先にする。
導入先が分からない（ホームディレクトリで起動している等）場合だけ、利用者に聞く。

## Step 2: 何が起きるかを確かめる

```bash
node "${APPLY}" --dest "<導入先>" --dry-run --json
```

返る JSON の読み方:

| フィールド | 意味 |
|---|---|
| `devHarness` | `true` なら claude-dev-harness 導入済み。下の「dev-harness 併用時」を読む |
| `items[].action` | `copy`（新しく置く）/ `create`（CLAUDE.md を新規作成）/ `append`（CLAUDE.md の末尾に節を足す）/ `skip`（既にあるので触らない） |

**すべて `skip` なら導入済み。** Step 4 の確認だけ行って終える。

**既存ファイルは上書きしない**（スクリプトの仕様）。変更が入る既存ファイルは `CLAUDE.md`（`append`）だけ。

## Step 3: 適用する

このスキルが呼ばれたこと自体を導入の依頼として扱い、確認なしで適用してよい。
**ただし `manual-writer` から、別の作業の途中から来た場合は**、Step 2 の結果を1〜2行で示して了承を得てから適用する
（利用者は導入を頼んでいないため）。

```bash
node "${APPLY}" --dest "<導入先>"
```

## Step 4: 動くことを確かめる

1. `.claude/doc-harness.config.json` と `docs-style/` が導入先にあることを `ls` で確かめる
2. フックの検査が通ることを、同梱の使い方ページで確かめる。導入先のルートで実行する

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../hooks/scripts/check-docs.mjs" docs-style/README.md
   ```

   `対象外` と出れば正常（`docs-style/` は検査対象の外に置かれている）。エラーで落ちたら報告する

**フックは再起動なしで有効になる**（フック自体はプラグインとして既に読み込まれていて、
設定ファイルは書き込みのたびに読み直されるため）。

## dev-harness 併用時（`devHarness: true`）

claude-dev-harness（harness-core）が管理する次のフォルダは、**検査対象から自動で外れる**。

| フォルダ | 書くのは | 外す理由 |
|---|---|---|
| `docs/設計書/` | `update-docs` / `sync-check` | 開発者向けの記録。検査すると実装のたびに止まる |
| `docs/features/` | `new-feature` / `complete-feature` | 同上 |
| `docs/reviews/` | 各レビュー系スキル | 記録であり、読み手向けの文書ではない |
| `docs/handoff/` | 引き継ぎ | 受け渡し専用 |

残る `docs/` 配下（利用マニュアル・運用手順・企画書）と `README.md` が検査対象になる。
利用者に、どのフォルダが検査対象かを報告する（実際に存在する `docs/` 直下のフォルダを `ls` して、
対象と対象外に分けて示す）。

**用語集が2つになる点も伝える。** 役割が違うので両方残してよい。

| 用語集 | 役割 |
|---|---|
| `docs-style/glossary.md`（このハーネス） | **表記ゆれの機械検出。**`サーバ` → `サーバー` のように禁止表記を持ち、`check-docs` が止める |
| `.claude/rules/` の用語集（harness-core の `glossary-keeper`。あれば） | **固有語を増やしてよいかの判断。** 新しい用語の採否を決める |

## 完了報告

| 項目 | 内容 |
|---|---|
| 導入先 | パス（dev-harness 併用ならそう書く） |
| 置いたもの | `copy` / `create` / `append` になった項目 |
| 触らなかったもの | `skip` の項目と理由 |
| 検査対象 | config の `include` と `exclude`。dev-harness 併用なら、実在するフォルダを対象／対象外に分けて示す |
| 次にできること | 「`〇〇の手順書を書いて`」と頼めば `manual-writer` が動く。既存文書の書き換えも同じスキルで頼める |
