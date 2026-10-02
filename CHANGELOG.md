# CHANGELOG

このリポジトリの変更履歴。バージョンは `harness-doc` プラグインの semver を指す。
経緯・設計判断の詳細は DocumentTemplete リポジトリの `docs/` にある。

## 書式

各エントリの末尾に **`docs 影響: あり（対象） / なし`** を1行書く。
`docs/guide/` と `docs/reference/` は機械では実装との乖離を検出しないため、変更時に自分で申告する。

```text
docs 影響: あり（reference/check-docs仕様.md — 検査項目が増えたため）
docs 影響: なし
```

---

## 0.2.0 — 2026-10-02

**利用者がコマンドを打たずに導入できるようにした。** 0.1.0 はテンプレート層を `tools/apply.mjs` で
人が置く前提だったが、利用者はコマンドを打たない。

- `setup-project` スキルを追加。「このプロジェクトに文書ハーネスを入れて」で、エージェントが
  `CLAUDE.md` の節・`docs-style/`・`.claude/doc-harness.config.json` を置く。既存ファイルは上書きしない
- テンプレート層 `templates/base/` を **プラグイン内の `plugins/harness-doc/scaffold/` へ移した**。
  プラグインのキャッシュ単体で導入でき、ネットワークも clone も要らない。版もプラグインと1つになる
- `tools/apply.mjs` を `skills/setup-project/scripts/apply.mjs` へ移した。`--dest` 省略時は今のプロジェクト、`--json` で計画を返す
- **claude-dev-harness との併用。** `.claude/harness.config.json` があるプロジェクトでは、
  `docs/設計書/`・`docs/features/`・`docs/reviews/`・`docs/handoff/` を検査対象から外した設定を置く
  （harness-core の `update-docs` が設計書を書くたびに止まらないように）。CLAUDE.md の節にも対象範囲を書いた
- `manual-writer` に Step 0 を追加。設定が無いプロジェクトでは導入を提案し、了承を得て `setup-project` を通す。
  `exclude` に当たる文書（設計書）は対象外として harness-core に任せる
- `docs-style/README.md` とセットアップガイドを「Claude Code に頼む」形に書き直した
- テスト: `tests/apply.test.mjs`（6件）を追加

docs 影響: あり（README.md・guide/セットアップガイド.md・scaffold/docs-style/README.md）

## 0.1.0 — 2026-10-02

初版。

- `manual-writer` スキル: 読者とゴールの決定 → 事実確認 → 目次案 → 本文 → 自己点検 →
  読者役レビュー → 機械チェック、の7ステップ。テンプレート3種（howto / reference / spec）、
  読者プロファイル3種（beginner / operator / developer）、良い例・悪い例
- `doc-reviewer` エージェント: 読み取り専用（Read / Grep / Glob）。指摘を
  「場所・問題・読者がどう困るか・修正案」＋重大度（致命的／要修正／提案）で返す
- `check-docs` フック（PostToolUse: Write / Edit）: 必須見出し・曖昧語・コードブロックの言語指定・
  用語集との表記ゆれ・リンク切れ・markdownlint / textlint（入っていれば）。違反は終了コード 2 で差し戻す
- テンプレート層: `CLAUDE.section.md` / `docs-style/`（glossary.md・banned-words.txt・README.md）/
  `.claude/doc-harness.config.json`。`tools/apply.mjs` で既存プロジェクトへ追記・コピーする

docs 影響: あり（初版のため全文書）
