# claude-doc-harness

Claude Code でマニュアル・手順書・仕様書を**同じ水準で再現可能に書く**ためのドキュメント作成ハーネス。
プログラムにテスト・リンタ・CI を整えるのと同じ考え方で、文書作成にも
**型・手順・自動チェック・レビュー**を整備する。

共通部分を**プラグイン**（`plugins/harness-doc`）として配信し、プロジェクトごとに違うもの
（用語集・曖昧語リスト・`CLAUDE.md` の節・検査対象の設定）は薄い**テンプレート層**（`templates/base`）で置く。
構成は開発ハーネス [claude-dev-harness](https://github.com/mizuta0711/claude-dev-harness) と同じ。

**このリポジトリは、ハーネスを自分のプロジェクトへ導入して使う人向け。**
「なぜこの設計か」「次に何を変えるか」を決める側の検討・査読・作業指示は、
別リポジトリ（DocumentTemplete。非公開）が持つ。

## 何が入っているか

| 種類 | 名前 | 役割 |
|---|---|---|
| スキル | `/harness-doc:manual-writer` | 文書を書く手順の本体。読者とゴールの決定 → 事実確認 → 目次案 → 本文 → 自己点検 → 読者役レビュー → 機械チェック |
| エージェント | `doc-reviewer` | 予備知識のない読者になりきり、文書だけで作業できるかを点検する。文書は書き換えず指摘だけ返す |
| フック | `check-docs` | `.md` を書くたびに曖昧語・必須見出し・コードブロックの言語指定・用語集との表記ゆれ・リンク切れを検査する。違反は Claude に差し戻す |
| テンプレート層 | `templates/base/` | `CLAUDE.md` の文書ルールの節、`docs-style/`（用語集・曖昧語リスト・使い方）、`.claude/doc-harness.config.json` |

文書の種類（手順書・リファレンス・仕様書）によらず進め方は共通で、種類ごとに変えるのは
**読者プロファイル・テンプレート・検証方法の3点だけ**。読者プロファイルは
beginner（初めて使う人）/ operator（障害時に焦って読む運用担当）/ developer（保守・拡張する開発者）の3つ。

## クイックスタート

```bash
# 1. プラグインを入れる（このマシンの全プロジェクト共通）
claude plugin marketplace add mizuta0711/claude-doc-harness
claude plugin install harness-doc@doc-harness --scope user

# 2. プロジェクトへテンプレート層を置く（既存ファイルは上書きしない。CLAUDE.md には追記する）
node <claude-doc-harness のパス>/tools/apply.mjs --dest <プロジェクトのパス>

# 3. Claude Code を再起動する
```

期待される状態: `claude plugin list` に `harness-doc` が出る。プロジェクトに `docs-style/` と
`.claude/doc-harness.config.json` がある。`CLAUDE.md` の末尾に「文書ルール（harness-doc）」の節がある。

使い方は、適用したプロジェクトの `docs-style/README.md`（1ページ）に書いてある。
導入の詳細とつまずきは [docs/guide/セットアップガイド.md](docs/guide/セットアップガイド.md)。

> ⚠️ **`claude plugin install` を飛ばすとスキルも hooks も動かない。** `apply.mjs` はテンプレート層しか置かない。
>
> ⚠️ **フックは `.claude/doc-harness.config.json` が無いプロジェクトでは何もしない**（設定不在は素通り）。
> 検査が動かないときは、まずこのファイルの有無を見る。

## ドキュメント

| ディレクトリ | 誰向けか | 読み方 |
|---|---|---|
| [`guide/`](docs/guide/) | ハーネスを**使う人** | 通しで読む。導入・運用の手順 |
| [`reference/`](docs/reference/) | ハーネスを**直す人・設定を触る人** | **引く。** 仕様と方針 |
| [`background/`](docs/background/) | 両方 | **なぜこの設計なのか**で迷ったとき |

| 文書 | 内容 |
|---|---|
| [セットアップガイド](docs/guide/セットアップガイド.md) | 導入・確認・取り外し。**このハーネス自身で書いたサンプル文書**でもある |
| [check-docs 仕様](docs/reference/check-docs仕様.md) | フックの検査項目・設定ファイルの契約・抑止マーカー |
| [設計の前提](docs/background/01_設計の前提.md) | なぜプラグイン＋テンプレート層か、なぜ読者役を分離するか |

## 開発

```bash
node --test                      # 判定ロジックの検査
claude plugin validate . --strict   # マニフェストの整合
```

ハーネス自体を直すときの規律は [CLAUDE.md](CLAUDE.md)。変更履歴は [CHANGELOG.md](CHANGELOG.md)。

## ライセンス

MIT
