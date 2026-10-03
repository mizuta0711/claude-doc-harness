# check-docs フックの検査仕様

<!-- doc-type: spec -->

| 項目 | 内容 |
|---|---|
| 対応ハーネス版 | harness-doc 0.7.0 |
| 実装 | `plugins/harness-doc/hooks/scripts/check-docs.mjs` |
| 検査 | `tests/check-docs.test.mjs`・`tests/check-docs-html.test.mjs` |

## 背景と目的

「分かりやすさ」は機械で判定できないが、**分かりにくさの兆候**（曖昧語・言語指定の無いコードブロック・
表記ゆれ・リンク切れ・見出しの欠落）は機械で止められる。このフックは兆候を書いた直後に差し戻し、
読者役レビューの前に機械で潰せるものを潰す。

読者: フックの挙動を変えたい人、設定ファイルを触る人。

## 用語

| 用語 | 意味 |
|---|---|
| 文書種別マーカー | 文書の冒頭15行以内に書く `<!-- doc-type: howto -->`。必須見出しの判定に使う |
| 抑止マーカー | 検査を飛ばすためのコメント。ファイル単位の `skip` と行単位の `ignore` がある |
| 設定不在 | `.claude/doc-harness.config.json` が無い状態。フックは何もしない（素通り） |

## 仕様

### 入力

PostToolUse（matcher: `Write|Edit|MultiEdit`）の stdin JSON。使うのは次のフィールドだけ。

| フィールド | 用途 |
|---|---|
| `tool_input.file_path` | 検査対象。相対パスなら `cwd` から解決する |
| `cwd` | 相対パスの基準 |

環境変数 `CLAUDE_PROJECT_DIR` をプロジェクトルートとする（未設定なら `process.cwd()`）。

CLI としても使える。ファイルを引数に渡すと、設定が無くても `**/*.md`・`**/*.html`・`**/*.htm` を対象に検査する。

```bash
node plugins/harness-doc/hooks/scripts/check-docs.mjs docs/guide/a.md docs/guide/b.md
```

### 出力

| 結果 | 終了コード | 出力 |
|---|---|---|
| 対象外・違反なし | 0 | なし（CLI は `[check-docs] OK: <path>` を stdout に出す） |
| 違反あり | 2 | stderr に件数と指摘の一覧。Claude に渡り、Claude が直す |

```text
[check-docs] docs/guide/a.md に 2 件の指摘があります。直してから先へ進んでください。
  L12  曖昧語「適宜」: 条件と値を具体的に書く
  L30  コードブロックに言語指定がありません（例: ```bash、```text）
```

### 対象の判定

次を**すべて**満たすファイルだけ検査する。

| 条件 | 確認した場所 |
|---|---|
| 拡張子が `.md`・`.html`・`.htm` | `checkFile` |
| プロジェクトルート配下 | 同上 |
| `styleDir`（既定 `docs-style/`）の外 | 同上 |
| `.claude/` の外（ブリーフ `.claude/rules/doc-brief-*.md` や設定は文書ではない） | 同上 |
| `include` のいずれかに一致 | `matchesAny` |
| `exclude` のどれにも一致しない | 同上 |

glob は `**`（階層をまたぐ）・`*`（またがない）・`?` だけを解釈する。パス区切りは `/` に正規化する。

### 検査項目

| # | 検査 | 根拠 | 判定 |
|---|---|---|---|
| 1 | 必須見出し | `requiredHeadings[種別]` | 文書種別マーカーがある文書だけ。見出しテキストに語を**含めば**よい（「## 2. 手順」は「手順」に一致） |
| 2 | 曖昧語 | `docs-style/banned-words.txt` | 本文の行に含まれる。Markdown はコードブロック内・インラインコード内・`<!--` で始まる行を除く。HTML は下の「HTML の本文」を見る |
| 3 | コードブロックの言語指定 | — | 開きフェンス（```` ``` ```` または `~~~`）の直後が空 |
| 4 | 用語集の表記ゆれ | `docs-style/glossary.md` と `glossaryFiles` の表の「禁止」列（下の「用語表の読み方」） | 散文に含まれる。禁止表記が推奨表記の先頭部分で、その位置が推奨表記として読めるなら検出しない（`サーバ` / `サーバー`） |
| 5 | リンク切れ | — | `[text](path)` の相対パス。`http:` 等のスキーム付きは見ない。`#` 以降は落としてファイルを解決する |
| 5-2 | アンカー切れ | `rules.anchors` | `#` 以降が行き先に実在するか。同じ文書内の `#...` と、相対パスの `.md`・`.html` への `path#...` を見る。Markdown の見出しは GitHub と同じ作り方でアンカーにする（小文字にし、文字・数字・`_`・空白・`-` 以外を除き、空白を `-` にする。同じ見出しは `-1`・`-2` を付ける）。見出し末尾の `{#id}` と、本文中の HTML の `id`・`name` 属性も認める。`#top` は見ない。**見るのは、書いた文書から出ていくリンクだけ**（見出しを変えたときに、ほかの文書から入ってくるリンクが切れるのは、このフックでは見つけられない） |
| 6 | markdownlint / textlint | `node_modules/.bin/` に実行ファイルがある場合だけ | 非ゼロ終了なら出力を指摘に含める。20秒でタイムアウト |
| 7 | 文末の混在 | `voice.endings` | `keitai` なら常体の文末（`る。`・`た。`・`だ。`・`ない。`・`である。`）、`jotai` なら敬体の文末（`です。`・`ます。`・`ください。` ほか）を止める。`keitai` のとき、敬体の過去形（`ました。`・`でした。`）は `た。` に当たっても止めない（0.6.0 で直した誤判定）。句点で終わる文だけを見る。「」『』の中（画面の文言の引用）は見ない。`null` なら検査しない |
| 8 | 構造とアクセシビリティ | `rules` | 画像の代替テキスト（Markdown は `![](...)` の空、HTML は `alt` 属性の無い `img`。`alt=""` は飾りとして認める。WCAG 2.2 1.1.1）、見出しレベルの飛び（h2 の次に h4。WCAG の不適合ではなく W3C G141 の推奨）、行き先の分からないリンク文言（「こちら」「ここ」「詳しくはこちら」「click here」だけ。完全一致。WCAG 2.2 2.4.4）、`lang` の無い `html` 要素（WCAG 2.2 3.1.1）。実装は `structure-checks.mjs` |

`docs-style/` のファイルが無ければ、その検査だけ飛ばす。

### HTML の本文

HTML（`.html`・`.htm`）は、本文のテキストだけを取り出して検査する。行番号は元のファイルのものを保つ。

| 扱い | 対象 |
|---|---|
| 本文として読む | タグの外のテキスト。文字実体参照（`&nbsp;`・`&amp;`・`&#12354;` の形）は文字に戻す。タグをまたいだ語（`必要に<b>応じて</b>`）は1語として読む |
| 読まない（中身ごと） | コメント、`script`・`style`・`pre`・`code`・`kbd`・`samp`・`template`・`svg` 要素 |
| 読まない | 属性値（`alt`・`title` を含む） |
| リンク切れの対象 | `href`・`src` 属性の相対パス。`?` 以降と `#` 以降は落として解決する。コメントと `script`・`style` の中は見ない |
| アンカー切れの対象 | `<a>`・`<area>` の `href` だけ。SVG の `<use href="#icon">` は、実行時に差し込む定義への参照なので見ない |
| 検査しない | コードブロックの言語指定（Markdown の規約で、HTML には当たる規約が無い）、markdownlint / textlint |
| 必須見出し | `h1`〜`h6` の中身（入れ子のタグを除いたテキスト） |

HTML では、バッククォートはただの文字でインラインコードにならない。語を説明するために曖昧語を書くときは `<code>` で囲む。

### 用語表の読み方

**列の並びではなく、表の見出しの語で列を決める。** プロジェクトが既に持つ用語表をそのまま読むため。

| 列 | 見出しに含む語 |
|---|---|
| 推奨 | 推奨・使う・✅・正しい |
| 禁止 | 禁止・使わない・❌・誤り・避ける |

- 推奨と禁止の両方の列を持たない表は読まない（「役割 | 使う」だけの表）
- 見出しの無い表は「推奨 | 禁止 | 意味」の順とみなす
- セルの強調（`**`）と ✅・❌、インラインコードは外して表記だけを取り出す

### 抑止マーカー

| マーカー | 位置 | 効果 |
|---|---|---|
| `<!-- check-docs: skip 理由 -->` | 冒頭15行以内 | ファイル全体を検査しない |
| `<!-- check-docs: ignore 理由 -->` | 行末 | その行の曖昧語・用語集・リンク切れを検査しない |

**理由を続けて書く。** 理由を書けない抑止は、規則の方を疑う。

### 設定ファイル `.claude/doc-harness.config.json`

| キー | 型 | 既定値 | 意味 |
|---|---|---|---|
| `schemaVersion` | number | 1 | 契約の版。フックの想定より新しければ素通りする |
| `styleDir` | string | `"docs-style"` | 用語集と曖昧語リストの置き場（プロジェクトルートからの相対） |
| `include` | string[] | `["docs/**/*.md", "docs/**/*.html", "README.md"]` | 検査対象 |
| `exclude` | string[] | `["docs/handoff/**", "CHANGELOG.md"]` | 検査対象から外すもの |
| `requiredHeadings` | object | howto / reference / spec の3種 | 文書種別ごとの必須見出し。種別を足せる |
| `linters.markdownlint` | boolean | true | `false` で実行しない |
| `linters.textlint` | boolean | true | `false` で実行しない |
| `glossaryFiles` | string[] | `[]` | プロジェクトが既に持つ用語表（プロジェクトルートからの相対パス）。`docs-style/glossary.md` に加えて読む |
| `voice.endings` | string | null | `null` | `keitai`（です・ます）/ `jotai`（だ・である）/ `null`（検査しない）。`setup-project` と `change-tone` が `docs-style/voice.md` と揃えて書く。**文書群ごとに文末が違う**（ブリーフの「文体の差分」で一部の文書群だけ文末を変えた）ときは `null` にする（この検査はプロジェクト全体に一律で効くため） |
| `rules.imageAlt` / `rules.headingSkip` / `rules.linkText` / `rules.htmlLang` | boolean | すべて `true` | 検査 8 を個別に止める。見出しの飛びを意図して使っているプロジェクトは `headingSkip` を `false` にする |
| `rules.anchors` | boolean | `true` | 検査 5-2（アンカー切れ）を止める。見出しからアンカーを作る規則が GitHub と違う描画（MkDocs・Docusaurus のような静的サイト生成で、設定によって違う）を使う場合は `false` にする |

既定値はスクリプト内の `DEFAULT_CONFIG` と `DEFAULT_REQUIRED_HEADINGS` にある。
設定ファイルの値は既定値に**上書き**される（`requiredHeadings` はキー単位で合成）。

## 制約

- PostToolUse はツール実行後に走るため、**書き込みそのものは止められない**。差し戻して直させる方式
- Bash のヒアドキュメントで書いた文書は検査しない（Write / Edit だけが対象）。CLI で手動検査する
- 曖昧語と用語集は**部分一致**。`など` が `などころ`に当たるような誤検出は、行末の `ignore` で逃がす
- 依存パッケージを使わない（Node 標準ライブラリのみ）

## 未確認・未決事項

- 未確認: `MultiEdit` ツールが現行の Claude Code に存在するか（公式文書に記載が無い。matcher に残しても害は無い）
- 未決: textlint / markdownlint の推奨ルールセット（DocumentTemplete backlog C1）
