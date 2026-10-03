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

## 0.8.0 — 2026-10-04

**依頼の大きさで工程を分け、改訂の記録を必ず残す（改善計画の P2a: 工程を軽くする側）。**

- **`plan-doc` スキルを追加。文書を書く・直す依頼の入口。** 性質（新規作成・改訂・誤りの修正・テイスト変更・方針変更・点検だけ）と規模（S/M/L）を判定し、規模と前提を1回の問いで確かめる。**規模 S（1本・見出しを変えない・直す事実が1か所）は、この中で事実確認・修正・同じ記述の横展開・改訂の記録まで済ませ、目次案と読者役レビューを省く。** M・L は `manual-writer`・`change-tone` に渡す
- **内部の改訂記録を追加（必須）。** `docs-style/history/<文書群>.md` に、改訂のたびに改訂箇所・改訂内容・改訂意図・根拠・見送ったことを残し、次の改訂の受付で読む。`scripts/history.mjs`（`show`・`add`・`init`）と雛形 `presets/history-template.md`。改訂意図が空なら書かない。節には「対象の文書」の行が入り、文書ごとに引ける。読者役には渡さない
- **`scripts/complete-doc.mjs` を追加（完了処理の検査）。** 変わった文書ごとに、内部の改訂記録の節があるか、読者向けの改訂履歴が「あり」なら行が足されているか、問い合わせの印が残っていないかを見る。git の差分で判定する（プロジェクトが git リポジトリのサブフォルダーにあっても、HEAD の無いリポジトリでも効く。削除した文書も記録の対象。過去の節を書き換えたら警告）。読者向けの改訂履歴の見出しは config の `revisionHeadings` で変えられる。いまはスキルが完了報告の前に呼ぶ（コミット時に止めるのは次の版）
- `manual-writer`: 入口を `plan-doc` に譲った。目次案と一緒に受け入れ基準の案を出す。**読者役は受け入れ基準で判定し、2回で終える**（2回で満たさなければ利用者に判断を渡す）。読者役は意図を知らずに読み、書き手が意図と照らして反映を決める（意図を理由に見送るときはどの意図かを書く。2回見送ったら意図を確かめる）。**確かめられなかった事実は本文に「未確認」と書かず、問い合わせの印（番号だけ）を置いて完了報告で確かめる**（仕様書は「未確認・未決事項」の節）。仕様と実装が食い違ったら書き手が寄せない。完了報告に問い合わせ・誤っていた指摘・文書の外の問題・依頼者が次にやること
- `change-tone`: 改訂の記録を残す工程（Step 6）
- `setup-project`: 文書群ごとに内部の改訂記録を作る。既存のサイトの改訂履歴の見出し名を読み取る。導入済みのプロジェクトでは、足りないもの（ブリーフ・内部の改訂記録・`CLAUDE.md` の節の最新版）だけを足す（`show.mjs claude-section`）
- `doc-reviewer`: 観点に「期待される出力が推測で書かれていないか」（backlog B4）。「未確認」の観点を、推測の断定の観点に直した
- `CLAUDE.section.md`: 規則1（入口は `plan-doc`。規模の判定を飛ばさない）・規則3（問い合わせ）・規則4（読者役は M・L で、受け入れ基準で判定し2回で終える）・規則6（用語を足す前に確かめる）・規則9（改訂の記録）
- 読者プロファイル: 「未確認と書く」を、問い合わせ・事実として書く形に直した
- `brief.mjs`: 文書ごとの項目（ゴール・種類・受け入れ基準）は聞かずに書き手が案を作る項目として分けて出す。受け入れ基準を必須に戻した
- `plan-doc`・`manual-writer`・`change-tone`: 確かめること（事実の変更・問い合わせ・書き戻し）は**記録を書く前に1回だけ聞き**、答えを反映してから記録する
- config: `historyDir`（既定 `docs-style/history`）・`revisionHeadings`（既定 `["改訂履歴"]`）。`apply.mjs --config` で `rules`・`historyDir`・`revisionHeadings` も書ける
- テスト: `history.test.mjs`（記録の読み書き・完了処理の検査）

docs 影響: あり（README.md・diagrams/01・diagrams/02（書き直し）・diagrams/03・guide/入門ガイド.md・guide/セットアップガイド.md・guide/運用ガイド.md §1・§2・§4・§6・reference/check-docs仕様.md・scaffold/docs-style/README.md・説明文）

## 0.7.0 — 2026-10-04

**一度決めた読者・扱わないことを、文書群ごとのブリーフに残す（改善計画の P1）。** 文書を書くたびに読者を聞き直さない。読者役にも、文書の責任の範囲が届く。

- **ブリーフ**（`.claude/rules/doc-brief-<名前>.md`）を追加。文書群ごとの読者・扱わないこと・事実の承認者・読者向けの改訂履歴の有無・文体の差分と、文書ごとのゴール・種類・受け入れ基準を持つ。Claude Code の「パス指定ルール」なので、対象の文書を読むとランタイムが中身を読み込み、読者役のサブエージェントにも届く（対話・非対話の両方で確かめた。`Write` で新規作成したときは読み込まれないので、スキルはスクリプトで引く）
- `scripts/brief.mjs` を追加（`show`・`missing`・`list`）。書き込みは `setup-project` の `apply.mjs --brief`。同じ層のブリーフが2つ当たる文書では止める。手で直したブリーフがこのスクリプトの形で読めない（知らない節・表でない本文・`paths` が読めない）ときは、書き戻すと消えるので書き込まずに止める。値の中の `|` はエスケープして往復させる。`paths` に `{a,b}` は使わせない。ほかのブリーフと `paths` が重なっていそうなら書いた時点で警告する。`--brief-file` で JSON をファイルから渡せる。`note` で由来に補足（前の値）を残せる。受け入れ基準は、読者役が判定に使う版（次の版）まで必須にしない
- `change-policy` スキルを追加。読者・扱わないことを変え、合わなくなる文書を一覧にして `change-tone` か `manual-writer` に振り分ける
- `setup-project`: 文書群ごとの読者・扱わないこと・読者向けの改訂履歴の有無を決めてブリーフに書く工程（Step 2C）。**導入済みでブリーフの無いプロジェクトには、ブリーフだけを足す**
- `manual-writer`: Step 1 でブリーフを引き、埋まっていれば前提を1行で示すだけにする。欠けた項目と「仮定」の項目だけをまとめて1回で聞く。Step 6 で読者役にブリーフを渡す。書き方の規則7（UI 名の囲み方は `voice.md` が優先）・規則11（用語集に足す前に依頼者に確かめる）。完了報告に「書き戻し」の1問
- `change-tone`: 一部の文書群だけ変えるときは、`voice.md` ではなくブリーフの「文体の差分」に書く。文末が文書群ごとに違うことになったら `voice.endings` を `null` にする
- `doc-reviewer`: ブリーフを受け取る。「扱わないこと」に当たる指摘は致命的にしない。文書の種類で読み方を変える（リファレンス・FAQ は節ごとに読む）。`docs-style/history/`・`docs-style/plans/` を開かない
- 雛形 `voice.md`: 要素ごとの見本の文・表記・警告の表し方・変えてはいけない文言・読者向けの改訂履歴の節を追加
- `CLAUDE.section.md`: 規則8（ブリーフに従う）を追加
- `check-docs`: `.claude/` 配下を検査しない（ブリーフは文書ではない）
- テスト: `brief.test.mjs` を追加

docs 影響: あり（README.md・diagrams/01_全体構成図.md・diagrams/03_導入フロー図.md・guide/セットアップガイド.md・guide/入門ガイド.md・guide/運用ガイド.md §1〜§3・reference/check-docs仕様.md・scaffold/docs-style/README.md・marketplace.json と plugin.json の説明）

## 0.6.0 — 2026-10-04

**設計の要らない直し（改善計画の P0）。** 確かめるための実行で環境を壊さない・秘匿情報を写さない、アンカー切れを止める、文末の誤判定を直す、テンプレートに改訂履歴の節を置く。

- `check-docs`: **アンカー切れの検査を追加**（検査 5-2）。リンクの `#` 以降が行き先の見出し・`id` に実在するかを見る。Markdown の見出しは GitHub と同じ作り方でアンカーにする。見るのは書いた文書から出ていくリンクだけ（入ってくるリンクはフックでは見つけられない）。HTML は `<a>`・`<area>` の `href` だけを見る（SVG の `<use href="#icon">` は見ない。実地検証のサイトで誤検出したため）。`config.rules.anchors` で止められる
- `check-docs`: `voice.endings` が `keitai` のとき、敬体の過去形（`ました。`・`でした。`）を常体と誤判定していたのを直した（実地検証で見つかった不具合）
- `manual-writer`: Step 2 に「実行する前に止まる操作」（削除・上書き・サービスの停止・本番や共有の環境・外部への送信は、依頼者に確かめてから）と「出力を写すときに伏せるもの」（トークン・実名の入ったパス・内部のホスト名・個人情報）を追加。Step 5 の自己点検に伏せたかの確認を追加
- テンプレート（`howto`・`reference`・`spec`）: 末尾に読者向けの「改訂履歴」の節を追加（いつ・どこを・どう変えたか）。必須見出しにはしていない
- テスト: アンカー切れ（Markdown・同じ文書内・HTML・SVG を見ないこと・止めたとき）と、敬体の過去形の判定を追加

docs 影響: あり（reference/check-docs仕様.md — 検査 5-2 と rules.anchors・文末の判定。diagrams/04_フック検査の流れ図.md。guide/運用ガイド.md §5）

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
