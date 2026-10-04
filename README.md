# claude-doc-harness

Claude Code でマニュアル・手順書・仕様書を**同じ水準で再現可能に書く**ためのドキュメント作成ハーネス。
プログラムにテスト・リンタ・CI を整えるのと同じ考え方で、文書作成にも
**型・手順・自動チェック・レビュー**を整備する。

スキル・エージェント・フック・プロジェクト側に置くファイルの原本を、すべて**1つのプラグイン**（`plugins/harness-doc`）として配る。
プロジェクトへの導入もスキル（`setup-project`）が行うので、**利用者はコマンドを打たずに Claude Code に頼むだけでよい**。
開発ハーネス [claude-dev-harness](https://github.com/mizuta0711/claude-dev-harness) と併用できる。

**このリポジトリは、ハーネスを自分のプロジェクトへ導入して使う人向け。**
「なぜこの設計か」「次に何を変えるか」を決める側の検討・査読・作業指示は、
別リポジトリ（DocumentTemplete。非公開）が持つ。

## 何が入っているか

| 種類 | 名前 | 役割 |
|---|---|---|
| スキル | `/harness-doc:plan-doc` | **文書を書く・直す依頼の入口。** 依頼の性質と規模（S/M/L）を判定し、規模に合った工程だけを通す。小さな修正はこの中で、事実確認・修正・同じ記述の横展開・改訂の記録まで済ませる。規模 M・L は改訂設計書（受け入れ基準と目次案）を作って承認を取り、`manual-writer` に渡す |
| スキル | `/harness-doc:manual-writer` | 文書を書く手順の本体（規模 M・L。`plan-doc` から使う）。改訂設計書に沿って、事実確認 → 本文 → 自己点検 → 読者役レビュー（受け入れ基準で判定し、2回で終える）→ 完了前の確認（前後確認）→ 改訂の記録と完了処理 |
| エージェント | `doc-reviewer` | 予備知識のない読者になりきり、文書だけで作業できるかを点検する。文書は書き換えず指摘だけ返す |
| フック | `check-docs` | Markdown（`.md`）か HTML（`.html`）を書くたびに曖昧語・必須見出し・コードブロックの言語指定・用語集との表記ゆれ・リンク切れを検査する。違反は Claude に差し戻す |
| フック | `commit-check` | Claude が `git commit` するとき、コミットの中身を再現して、文書の改訂の記録があるかを確かめる。無ければ止める（`doc-record: skip（理由）` は利用者の承認を求める）。設定 `completeCheck` で警告だけにも、切ることもできる |
| フック | `reviewer-guard` | 読者役（`doc-reviewer`）が、内部の改訂記録と改訂設計書を読むのを止める（書き手の意図を知ると追認になるため） |
| スキル | `/harness-doc:change-tone` | 既存の文書のテイスト（文体・表記・HTML の見た目）を変える。見本で合意してから、事実と構成は変えずに書き換える |
| スキル | `/harness-doc:change-policy` | 文書群の決め事（読者・扱わないこと・事実の承認者・読者向けの改訂履歴の有無）を変える。変えた決め事に合わなくなる文書を一覧にし、直し方を振り分ける（`plan-doc` から使う） |
| スキル | `/harness-doc:setup-project` | 今のプロジェクトへ**対話で**導入する。既存の文書があれば文体・用語表・見た目を読み取って踏襲し、新規なら見本の文から選んでもらう。`CLAUDE.md` の文書ルールの節・`docs-style/`（用語集・曖昧語リスト・使い方）・`.claude/doc-harness.config.json` と、文書群ごとの読者・扱わないことを残すブリーフ（`.claude/rules/doc-brief-*.md`）を置く。原本は `plugins/harness-doc/scaffold/` |

文書の種類（手順書・リファレンス・仕様書）によらず進め方は共通で、種類ごとに変えるのは
**読者プロファイル・テンプレート・検証方法の3点だけ**。読者プロファイルは
beginner（初めて使う人）/ operator（障害時に焦って読む運用担当）/ developer（保守・拡張する開発者）の3つ。

## クイックスタート

**このマシンで初めて使うとき（1回だけ）。** Claude Code に次のように頼む。

```text
次の2つのコマンドを実行して、文書ハーネスのプラグインを入れて。
claude plugin marketplace add mizuta0711/claude-doc-harness
claude plugin install harness-doc@doc-harness --scope user
```

終わったら Claude Code を再起動する。

**プロジェクトごとに（1回だけ）。** そのプロジェクトで Claude Code に頼む。

```text
このプロジェクトに文書ハーネスを入れて
```

`setup-project` スキルが `CLAUDE.md` に節を足し、`docs-style/` と設定ファイルを置く。既存ファイルは上書きしない。
claude-dev-harness を導入済みのプロジェクトでは、設計書・機能設計書・レビュー記録・引き継ぎを検査対象から自動で外す。
導入しないまま文書を頼んだ場合も、`plan-doc`（または `manual-writer`）が導入を提案する。

**あとは頼むだけ。**

```text
障害時の復旧手順書を書いて。読者は運用担当
```

使い方は、導入したプロジェクトの `docs-style/README.md`（1ページ）にある。
導入の詳細とつまずきは [docs/guide/セットアップガイド.md](docs/guide/セットアップガイド.md)。

> ⚠️ **フックは `.claude/doc-harness.config.json` が無いプロジェクトでは何もしない**（設定不在は素通り）。
> 検査が動かないときは「このプロジェクトに文書ハーネスを入れて」と頼む。

## ドキュメント

| ディレクトリ | 誰向けか | 読み方 |
|---|---|---|
| [`guide/`](docs/guide/) | ハーネスを**使う人** | 通しで読む。導入・運用の手順 |
| [`reference/`](docs/reference/) | ハーネスを**直す人・設定を触る人** | **引く。** 仕様と方針 |
| [`diagrams/`](docs/diagrams/) | 両方 | 構造・流れを掴むとき（mermaid の図） |
| [`background/`](docs/background/) | 両方 | **なぜこの設計なのか**で迷ったとき |

| 文書 | 内容 |
|---|---|
| [入門ガイド](docs/guide/入門ガイド.md) | **初めて使う人向け。** 期待してよいこと・3つの原則・最初の1本・つまずきポイント |
| [運用ガイド](docs/guide/運用ガイド.md) | スキルの使い分け・決まり（docs-style）の育て方・dev-harness との併用 |
| [図（diagrams/）](docs/diagrams/) | 全体構成 / 文書作成フロー / 導入フロー / フック検査の流れ / テイスト変更フロー の5本 |
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
