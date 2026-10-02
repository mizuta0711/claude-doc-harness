# claude-doc-harness — 開発ルール

**このファイルは「ハーネス自体を開発するとき」の規律である。**
ハーネスが置くプロジェクト側の `CLAUDE.md` の節（`templates/base/CLAUDE.section.md`）とは別物。

リポジトリの構成・提供物・利用側の手順は [README.md](README.md) にある。ここには複製しない。
対話は日本語で行うこと。

## 作業前に読むもの

| 文書 | いつ読むか |
|------|-----------|
| [docs/reference/check-docs仕様.md](docs/reference/check-docs仕様.md) | フック・設定ファイルの契約に触れるとき |
| [docs/background/](docs/background/) | 「なぜこの設計なのか」で迷ったとき |
| [CHANGELOG.md](CHANGELOG.md) | 変更を入れる前後（**書式の規約が冒頭にある**） |

**本リポジトリは実装だけを持つ。** 調査・作業指示・レビュー結果・実測記録は
**DocumentTemplete リポジトリ**（非公開）に残す。本リポジトリは public であり、
「今どうなっているか」を引く場所である。

## 1. コミットは必ずパス指定

```bash
git commit -- <path...>      # ○
git add -A && git commit     # ✗ deny される
git commit --amend           # ⚠️ インデックス全体を取り込む
```

`.claude/hooks/repo-guard.js`（`claude-dev-harness` と同一内容のコピー。正本は dev-harness 側）が
`git add -A` / `git add .` を deny し、push 前に `claude plugin validate --strict` を走らせる。
複数セッションが同時にこのリポジトリを触るため、コミット前に必ず `git status --short` を見て、
**自分が触った覚えのないファイルは含めない**。

## 2. 版番号は2ファイルを同時に上げる

`plugins/harness-doc/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の `version` は
**常に一致させる**。`plugins/` の中身を変えたら版を上げる（上げないとキャッシュに反映されない）。

| 変更 | 版 |
|---|---|
| skills / agents / hooks の挙動が変わる | minor（0.x.0） |
| 文言・誤字・テンプレート層だけ | patch（0.0.x） |

## 3. CHANGELOG に `docs 影響` を書く

`docs/guide/` と `docs/reference/` は機械では実装との乖離を検出しない。
変更ごとに **`docs 影響: あり（対象） / なし`** を1行書き、「あり」なら push 前に更新する。

## 4. このリポジトリ自身がハーネスの検査対象

`.claude/settings.json` で `check-docs` を自分の `docs/` と `plugins/` の `.md` に当てている
（`.claude/doc-harness.config.json` の `styleDir` は `templates/base/docs-style` を指す）。
**ハーネスの文書が、ハーネスの規則に違反していてはいけない。**

- 曖昧語の説明に曖昧語そのものを書くときは、インラインコードで囲む
- `examples/bad.md` は意図して違反しているので `exclude` と skip マーカーの両方で外してある
- `node --test` は同梱の良い例・テンプレートが検査を通ることも確かめる

## 5. push 前

```bash
node --test
claude plugin validate . --strict
```

両方通ってから `git push`。**push はユーザーの指示を待つ**（public リポジトリなので公開に直結する）。
