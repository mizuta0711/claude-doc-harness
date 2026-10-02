# check-docs フックの検査仕様

<!-- doc-type: spec -->

| 項目 | 内容 |
|---|---|
| 対応ハーネス版 | harness-doc 0.1.0 |
| 実装 | `plugins/harness-doc/hooks/scripts/check-docs.mjs` |
| 検査 | `tests/check-docs.test.mjs` |

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

CLI としても使える。ファイルを引数に渡すと、設定が無くても `**/*.md` を対象に検査する。

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
| 拡張子が `.md` | `checkFile` |
| プロジェクトルート配下 | 同上 |
| `styleDir`（既定 `docs-style/`）の外 | 同上 |
| `include` のいずれかに一致 | `matchesAny` |
| `exclude` のどれにも一致しない | 同上 |

glob は `**`（階層をまたぐ）・`*`（またがない）・`?` だけを解釈する。パス区切りは `/` に正規化する。

### 検査項目

| # | 検査 | 根拠 | 判定 |
|---|---|---|---|
| 1 | 必須見出し | `requiredHeadings[種別]` | 文書種別マーカーがある文書だけ。見出しテキストに語を**含めば**よい（「## 2. 手順」は「手順」に一致） |
| 2 | 曖昧語 | `docs-style/banned-words.txt` | 散文の行に含まれる。コードブロック内・インラインコード内・`<!--` で始まる行は除く |
| 3 | コードブロックの言語指定 | — | 開きフェンス（```` ``` ```` または `~~~`）の直後が空 |
| 4 | 用語集の表記ゆれ | `docs-style/glossary.md` の「禁止表記」列 | 散文に含まれる。禁止表記が推奨表記の先頭部分で、その位置が推奨表記として読めるなら検出しない（`サーバ` / `サーバー`） |
| 5 | リンク切れ | — | `[text](path)` の相対パス。`http:` 等のスキーム付きと `#` 始まりは見ない。`#` 以降は落として解決する |
| 6 | markdownlint / textlint | `node_modules/.bin/` に実行ファイルがある場合だけ | 非ゼロ終了なら出力を指摘に含める。20秒でタイムアウト |

`docs-style/` のファイルが無ければ、その検査だけ飛ばす。

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
| `include` | string[] | `["docs/**/*.md", "README.md"]` | 検査対象 |
| `exclude` | string[] | `["docs/handoff/**", "CHANGELOG.md"]` | 検査対象から外すもの |
| `requiredHeadings` | object | howto / reference / spec の3種 | 文書種別ごとの必須見出し。種別を足せる |
| `linters.markdownlint` | boolean | true | `false` で実行しない |
| `linters.textlint` | boolean | true | `false` で実行しない |

既定値はスクリプト内の `DEFAULT_CONFIG` と `DEFAULT_REQUIRED_HEADINGS` にある。
設定ファイルの値は既定値に**上書き**される（`requiredHeadings` はキー単位で合成）。

## 制約

- PostToolUse はツール実行後に走るため、**書き込みそのものは止められない**。差し戻して直させる方式
- Bash のヒアドキュメント等で書いた `.md` は検査しない（Write / Edit だけが対象）。CLI で手動検査する
- 曖昧語と用語集は**部分一致**。`など` が `などころ`に当たるような誤検出は、行末の `ignore` で逃がす
- 依存パッケージを使わない（Node 標準ライブラリのみ）

## 未確認・未決事項

- 未確認: `MultiEdit` ツールが現行の Claude Code に存在するか（公式文書に記載が無い。matcher に残しても害は無い）
- 未決: textlint / markdownlint の推奨ルールセット（DocumentTemplete backlog C1）
