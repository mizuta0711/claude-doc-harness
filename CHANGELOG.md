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

## 0.5.0 — 2026-10-02

**見やすさ・構成の知見を出典つきでまとめ、スキルとフックに組み込んだ。**

- `manual-writer/references/` に5本を追加: `structure`（Diátaxis）・`writing`（Google / Microsoft のスタイルガイド）・`japanese`（JTF 第4.0版・公用文作成の考え方）・`web`（NN/g・GOV.UK）・`accessibility`（WCAG 2.2・デジタル庁ガイドブック）。どれも一次資料のページを開いて確かめ、要点ごとに出典の URL を付けた。確かめられなかった点は「未確認」と書いた
- `manual-writer`: Step 3 で文書の種類を1つに決め、結論を先に置く。書き方の規則に、場所→操作→結果・リンクの文言・代替テキスト・方向だけで指さない・例示の語の前に代表例、語を説明するときはコードとして囲む（backlog B4 の1件目）を追加。8番の例から「など」を外した（0.4.0 で初期値から外したのに例に残っていた）
- `doc-reviewer`: 点検の観点に、文書の種類の混在・結論の位置・方向だけで指す表現・代替テキストを追加
- `check-docs`: 構造とアクセシビリティの検査を追加（`structure-checks.mjs`）。画像の代替テキスト・見出しレベルの飛び・行き先の分からないリンク文言・`html` の `lang`。`config.rules` で個別に止められる
- `presets/visuals.md`: 「1行は全角35〜45字」は出典の無い数値だったので、WCAG 2.2 1.4.8（AAA）の「CJK は 40 字以内」に直した。各方向性の数値はハーネスの初期値で出典が無いことを明記した
- `presets/voices.md`: 一文の長さの目安がハーネスの初期値であることと、公用文作成の考え方の「50〜60字」を明記した
- `presets/show.mjs`: `reference <名前>` を追加
- テスト: `structure-checks.test.mjs` を追加

docs 影響: あり（reference/check-docs仕様.md・guide/運用ガイド.md）

## 0.4.1 — 2026-10-02

入門ガイドの読者役レビューで、スキルの側の不足が2件見つかった。

- `manual-writer`: 目次案を見せて**返事を待つ**ことを決まりにした（依頼文で任されたときは待たない）
- `manual-writer`: 完了報告に「未確認」の行を独立させ、省かないことにした。読者役レビューの行は、見送った指摘を1件ずつ内容と理由で書く
- docs: 入門ガイドを追加（読者役レビュー2回・全指摘に対応）

docs 影響: あり（guide/入門ガイド.md）

## 0.4.0 — 2026-10-02

**導入を対話にし、文書のテイストを決めて変えられるようにした。**

- `setup-project` を対話型に書き直した。棚卸し（`scripts/inventory.mjs`）で新規か既存かを見分ける。既存なら、文書の置き場所・文体・表記の好み・用語表・CSS を読み取って踏襲する案を確かめてもらう。新規なら文体の見本（4種）と見た目の方向性（3種）から選んでもらう。質問は `AskUserQuestion`
- `change-tone` スキルを追加。今の文と変えた後の文を並べて合意してから、事実・構成・画面名・コードは変えずに書き換え、`voice.md` も更新する。HTML の見た目は CSS の値だけを変える
- `docs-style/voice.md`（文体と見た目の決まり）を雛形に追加。`manual-writer` は書く前に読み、`doc-reviewer` は沿っているかを点検する
- `check-docs`: 文末の混在検査（`voice.endings`: `keitai` / `jotai`）、既存の用語表の読み込み（`glossaryFiles`）、用語表の列を見出しの語で決める読み方（「使う / 使わない」「❌ / ✅」の表も読める）
- **既定値の見直し（実物検査で判明した課題）。** 雛形の用語集を空にした（「サーバー」などの好みはプロジェクトが決める）。曖昧語の初期値から「など」を外した（例示の正しい用法が多い。行頭の `#` を外せば有効になる）
- `apply.mjs --config`: 決めた値を `.claude/doc-harness.config.json` に書き込む（`.claude/` への Edit は確認が出るため）
- `presets/show.mjs`: 見本集と読者プロファイルを `node` で出力する（プラグインの置き場所はプロジェクトの外で、`Read` だと確認が出る・拒否されるため）
- ハーネス自身の文書用の用語集を、リポジトリ直下の `docs-style/` に分けた
- テスト: `voice-and-glossary.test.mjs`・`inventory.test.mjs` を追加

docs 影響: あり（README.md・guide/ 全体・reference/check-docs仕様.md・diagrams/ 新設・scaffold/docs-style/README.md）

## 0.3.0 — 2026-10-02

**check-docs が HTML を検査する。** 手書きの HTML で書かれた利用者向けサイト・マニュアルにも機械チェックを効かせるため。

- `.html`・`.htm` を対象にした。本文のテキストだけを取り出し、曖昧語・用語集・`href` / `src` のリンク切れ・必須見出し（`h1`〜`h6`）を検査する
- `script`・`style`・`pre`・`code`・`kbd`・`samp`・`template`・`svg`・コメント・属性値は読まない。タグをまたいだ語は1語として読む。文字実体参照は戻す
- コードブロックの言語指定と markdownlint / textlint は Markdown だけ
- 既定の `include` に `docs/**/*.html` を足した（scaffold の設定と `DEFAULT_CONFIG` の両方）。CLI の既定にも `**/*.html`
- 内部: 曖昧語・用語集・見出し・リンクの判定を Markdown と HTML で共有する関数に切り出した
- テスト: `tests/check-docs-html.test.mjs`（14件）。全体で38件
- 実物の HTML（CommSim の `web/` 54本・SimplePhone の `docs/web/` 13本）を読み取りだけで検査し、解析の誤り（タグ・script を本文として読む）が0件であることを確認した

docs 影響: あり（reference/check-docs仕様.md・README.md・scaffold/CLAUDE.section.md・scaffold/docs-style/README.md）

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
