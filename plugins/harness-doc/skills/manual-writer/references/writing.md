# 文章の書き方（Google / Microsoft のスタイルガイド）

`manual-writer` の Step 4（本文）で読む。英語固有の規則（大文字小文字・短縮形・コンマ）は日本語に移せないので省いた。移すときに読み替えが要る規則は、その旨を書いた。

## 出典

| タイトル | URL | 参照日 |
|---|---|---|
| Google: Voice and tone | https://developers.google.com/style/tone | 2026-10-02 |
| Google: Procedures | https://developers.google.com/style/procedures | 2026-10-02 |
| Google: Headings and titles | https://developers.google.com/style/headings | 2026-10-02 |
| Google: Lists | https://developers.google.com/style/lists | 2026-10-02 |
| Google: Tables | https://developers.google.com/style/tables | 2026-10-02 |
| Google: UI elements and interaction | https://developers.google.com/style/ui-elements | 2026-10-02 |
| Google: Code samples | https://developers.google.com/style/code-samples | 2026-10-02 |
| Google: Document command-line syntax | https://developers.google.com/style/code-syntax | 2026-10-02 |
| Google: Placeholders | https://developers.google.com/style/placeholders | 2026-10-02 |
| Google: Link text | https://developers.google.com/style/link-text | 2026-10-02 |
| Google: Images | https://developers.google.com/style/images | 2026-10-02 |
| Google: Notes, cautions, warnings | https://developers.google.com/style/notices | 2026-10-02 |
| Google: Writing for a global audience | https://developers.google.com/style/translation | 2026-10-02 |
| Microsoft: Top 10 tips for style and voice | https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice | 2026-10-02 |
| Microsoft: Brand voice | https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human | 2026-10-02 |
| Microsoft: Writing step-by-step instructions | https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions | 2026-10-02 |
| Microsoft: Formatting text in instructions | https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions | 2026-10-02 |
| Microsoft: Headings | https://learn.microsoft.com/en-us/style-guide/scannable-content/headings | 2026-10-02 |
| Microsoft: Lists | https://learn.microsoft.com/en-us/style-guide/scannable-content/lists | 2026-10-02 |
| Microsoft: Tables | https://learn.microsoft.com/en-us/style-guide/scannable-content/tables | 2026-10-02 |
| Microsoft: Code examples | https://learn.microsoft.com/en-us/style-guide/developer-content/code-examples | 2026-10-02 |
| Microsoft: URLs and web addresses | https://learn.microsoft.com/en-us/style-guide/urls-web-addresses | 2026-10-02 |
| Microsoft: Alternative text | https://learn.microsoft.com/en-us/style-guide/accessibility/alternative-text | 2026-10-02 |
| Microsoft: Graphics, design, and media | https://learn.microsoft.com/en-us/style-guide/accessibility/graphics-design-media | 2026-10-02 |
| Microsoft: Writing for all abilities | https://learn.microsoft.com/en-us/style-guide/accessibility/writing-all-abilities | 2026-10-02 |
| Microsoft: Writing tips (global) | https://learn.microsoft.com/en-us/style-guide/global-communications/writing-tips | 2026-10-02 |
| Microsoft: Use simple words, concise sentences | https://learn.microsoft.com/en-us/style-guide/word-choice/use-simple-words-concise-sentences | 2026-10-02 |
| Microsoft Learn 投稿者ガイド: Markdown reference（Writing Style Guide の本体ではない） | https://learn.microsoft.com/en-us/contribute/content/markdown-reference | 2026-10-02 |

## 要点

### 1. 語り口

- 会話的で親しみやすく、敬意のある語り口にする。俗語やくだけすぎた表現は使わない。目標は「読者のやりたいことが分かっている、詳しい友人」（出典: https://developers.google.com/style/tone ）
- 感嘆符・流行語・比喩・ネットスラング・時事ネタを使わない（出典: https://developers.google.com/style/tone ）
- 手順の please は丁寧すぎるとされる。日本語では「〜してください」が普通の指示形なので、この規則はそのまま移せない。移せるのは「お手数ですが」のような過剰な前置きを付けない、という部分（出典: https://developers.google.com/style/tone ）
- 大事なことを先に書き、読者の選択肢と次の行動がはっきり分かるようにする。判断に足りる分だけ書き、余分な語は削る（出典: https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice ）
- 声に出して読み、自然な会話に聞こえるかを確かめる（出典: https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice ）
- 弱い言い回しを削る。日本語では「〜することができます」を「〜できます」に縮める、と読み替える（出典: https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice ）

### 2. 手順

- 手順の前に導入文を置き、文脈を示す。見出しの繰り返しにしない（出典: https://developers.google.com/style/procedures 、 https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions ）
- 複数ステップの手順は番号付きリストにする。1ステップだけなら番号を付けない（出典: 同上）
- 1ステップに1操作。ただし UI の同じ場所で行う短い操作はまとめてよい（出典: https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions ）
- メニューを順にたどる操作は「**ファイル** > **新規** > **ドキュメント**」のように `>` で1ステップにまとめてよい。`>` の前後に空白を入れ、`>` は太字にしない（出典: 同上、 https://developers.google.com/style/procedures ）
- **場所 → 操作 → 結果**の順に書く。例: 「**デザイン** タブで、**ヘッダー行** を選択する」。結果は操作と同じ段落に置く（出典: https://developers.google.com/style/procedures ）
- 省略できるステップは、行頭に「任意:」と書く。括弧書きにはしない（出典: https://developers.google.com/style/procedures ）
- 手順の完了に必要な操作（**OK** や **適用** を選ぶ）も書く（出典: https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions ）
- 1つの手順にステップを詰め込みすぎない。目安は1画面に収まる量（出典: 同上）
- 同じことを複数の方法でできる場合は、誰でも使える1つの方法を書く。短く簡単で、キーボードで操作できる方法を優先する（出典: https://developers.google.com/style/procedures ）

### 3. 見出し

- 作業の見出しは、何をするかで書く（Google は動詞の原形、Microsoft は不定詞句）。日本語では「〜を作成する」「〜の作成」のどちらかに文書内でそろえる、と読み替える（出典: https://developers.google.com/style/headings 、 https://learn.microsoft.com/en-us/style-guide/scannable-content/headings ）
- 同じ階層の見出しは、文の形をそろえる（出典: https://learn.microsoft.com/en-us/style-guide/scannable-content/headings ）
- H1 はページに1つだけにする。階層を飛ばさない（出典: https://developers.google.com/style/headings 、 https://learn.microsoft.com/en-us/contribute/content/markdown-reference ）
- 見出しの直後には本文を置く。間を埋めるためだけの文は入れない（出典: https://developers.google.com/style/headings ）
- 下位の見出しを作るのは、別の話題が2つ以上あるときだけ（出典: https://learn.microsoft.com/en-us/style-guide/scannable-content/headings ）
- 見出しは短くし、大事な語を先頭に置く。製品名や機能名ではなく、読者が何をできるか・何を知る必要があるかを書く（出典: 同上）
- 見出しにはリンクを入れない。句点で終えない（出典: https://developers.google.com/style/headings 、 https://learn.microsoft.com/en-us/style-guide/scannable-content/headings ）

### 4. リストと表

- 順序に意味がある項目は番号付きリスト、順序のない項目は箇条書き、用語と説明の組は説明リストにする（出典: https://developers.google.com/style/lists ）
- 項目が1つだけならリストにしない。Microsoft は項目数を2以上、できれば7以下にするとしている（出典: https://developers.google.com/style/lists 、 https://learn.microsoft.com/en-us/style-guide/scannable-content/lists ）
- リストの各項目は同じ形にそろえる（全部を名詞にする、全部を動詞で始める）（出典: 同上）
- リストの前には完結した導入文を置く（出典: 同上）
- 表を使うのは、1件ごとに3つ以上の関連データがあるとき。1列だけの表はリストにする。番号付き手順の途中に表を置かない（出典: https://developers.google.com/style/tables ）
- 表の前には、表の目的を説明する文を置く。表があることを事前に読み上げないスクリーンリーダーがあるため（出典: https://developers.google.com/style/tables 、 https://learn.microsoft.com/en-us/style-guide/scannable-content/tables ）
- 行を識別する情報は左端の列に置く。セルは結合しない。空のセルは使わず「該当なし」「なし」と書く（出典: https://learn.microsoft.com/en-us/style-guide/scannable-content/tables ）
- 列見出しは「名前」のような曖昧な語ではなく、「グループ名」「社員名」のように具体的にする（出典: 同上）

### 5. 画面要素（UI）の書き方

- UI 要素の名前は太字にし、画面の文言と完全に一致させる。ラベルの末尾の「:」や「…」は書かない（出典: https://developers.google.com/style/ui-elements 、 https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions ）
- 「〜ボタン」「〜メニュー」のような要素の種類は、分かりにくくなるときだけ付ける（出典: 同上）
- UI の名前を説明するより、読者がすることを説明する（出典: https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions ）
- エラーメッセージは引用符（日本語では「」）で囲んで書く（出典: 同上）
- 動詞の選び方は2社で違う。Google は click や tap を挙げている。Microsoft は入力方法に依存する動詞を避け、どの入力方法にも合う動詞（選択する）を使うとしている（出典: https://developers.google.com/style/ui-elements 、 https://learn.microsoft.com/en-us/style-guide/accessibility/writing-all-abilities ）

### 6. コード例とコマンド

- コード例の前に導入文を置く（出典: https://developers.google.com/style/code-samples ）
- 省略した部分は、そのコードの言語のコメントで示す。「…」は使わない（出典: 同上）
- プレースホルダーは初出で説明する。複数あるときは「次の値を置き換えてください:」と書き、出てくる順に一覧にする（出典: https://developers.google.com/style/placeholders 、 https://developers.google.com/style/code-syntax ）
- プレースホルダーの書式は2社で違う（Google は `PROJECT_ID`、Microsoft は `<version>`）。プロジェクトで1つに決めてそろえる（出典: 同上、 https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions ）
- コマンド構文では、省略できる引数を `[ ]`、どれか1つを選ぶ引数を `{A|B}`、繰り返せる引数を `...` で示す（出典: https://developers.google.com/style/code-syntax ）
- 出力は役に立つときだけ載せ、「出力は次のようになります:」と書いてから示す。省略した行は、独立した行に `...` を書いて示す（出典: 同上）
- コード例は必ず実行して確かめる。コピーして実行しやすい形にする。前提条件と依存関係を書く。パスワードを直接書き込まない（出典: https://learn.microsoft.com/en-us/style-guide/developer-content/code-examples ）

### 7. リンクの文言

- リンクの文言は、短く、他と区別でき、リンク先が分かる語句にする。「こちら」「この文書」は使わない（出典: https://developers.google.com/style/link-text 、 https://learn.microsoft.com/en-us/style-guide/urls-web-addresses ）
- リンク先のページの題名や見出しと同じ文言にする。URL をそのままリンクの文言にしない（出典: https://developers.google.com/style/link-text ）
- ファイルのダウンロードやメールの起動につながるリンクは、文言でそれと分かるようにし、ファイル形式も書く（出典: 同上）
- 同じページ内で、同じリンク先へのリンクを何度も張らない（出典: 同上）

### 8. 画像・スクリーンショット

- 画像を使うのは、言葉では説明しにくいときだけ。コード、テキスト、端末の出力は画像にせず、文字で載せる（出典: https://developers.google.com/style/images ）
- スクリーンショットは、説明に必要な部分だけを切り抜く。個人を特定できる情報は、ぼかしではなく不透明の塗りつぶしで隠す（出典: 同上）
- 文章だけでも画像だけでも内容が全部伝わるようにする（出典: https://learn.microsoft.com/en-us/style-guide/accessibility/graphics-design-media ）
- 代替テキストを「画像:」で始めない。ファイル名を代替テキストにしない。周りの本文をそのまま繰り返さない（出典: https://learn.microsoft.com/en-us/style-guide/accessibility/alternative-text ）
- ボタンやリンクの画像の代替テキストには、見た目ではなく機能を書く（例: 「設定を開く」）（出典: 同上）
- 「上の図」「左側」のような方向の言葉だけで場所を示さない。図は番号で参照する（出典: https://developers.google.com/style/images 、 https://learn.microsoft.com/en-us/style-guide/accessibility/writing-all-abilities ）

### 9. 誰にでも伝わる平易な文

- 文を短くする。読点が多い文は分ける。込み入った文や段落は、リストや表に置き換える（出典: https://developers.google.com/style/translation 、 https://learn.microsoft.com/en-us/style-guide/global-communications/writing-tips ）
- 1つの概念には1つの用語を使い、文書全体で同じ表記にする（出典: 同上）
- 慣用句、口語、特定の文化に依存する話題を避ける（出典: 同上）
- 手順の中で simply、It's easy、quickly を使わない。日本語では「簡単に」「単に」「すぐに」に当たる（出典: https://developers.google.com/style/tone ）
- 意味に必要のない副詞を削る。修飾語は修飾される語の近くに置く。指示語が何を指すかをはっきりさせる（出典: https://learn.microsoft.com/en-us/style-guide/word-choice/use-simple-words-concise-sentences 、 https://developers.google.com/style/translation ）
- 略語は一般的なものか、用語集で定義したものだけを使う（出典: https://learn.microsoft.com/en-us/style-guide/global-communications/writing-tips ）

### 10. 注記・警告

- 注記は役割で分ける。Note（役に立つが必須ではない情報）、Caution（慎重に進めるべき操作）、Warning（してはいけない、または元に戻せない操作）（出典: https://developers.google.com/style/notices ）
- 前提条件、手順のステップ、成功に不可欠な情報は注記にしない。本文に書く（出典: 同上）
- 注記を多用しない。2つ以上の注記を続けて置かない。迷ったら、まず本文として書いてから決める（出典: 同上）
- Microsoft Learn の投稿者ガイドは、注記を使う場合は1記事に1〜2個までとしている（出典: https://learn.microsoft.com/en-us/contribute/content/markdown-reference ）

## 書くときのチェック項目

- [ ] 最初の段落を読めば、何ができるのかと次に何をすればよいかが分かるか
- [ ] 手順の前に導入文があり、見出しの繰り返しになっていないか
- [ ] 手順は番号付きで、1ステップ1操作になっているか
- [ ] 各ステップで、場所 → 操作 → 結果の順に書いているか
- [ ] 省略できるステップの行頭に「任意:」を付けたか。完了の操作（**OK**）まで書いたか
- [ ] UI の名前は太字で、画面の文言と完全に一致しているか。末尾の「…」や「:」を取ったか
- [ ] 見出しは階層を飛ばしていないか。H1 は1つか。同じ階層で形がそろっているか。直後に本文があるか
- [ ] リストの項目は同じ形か。項目が1つだけのリストは無いか
- [ ] 表の前に目的を書いた文があるか。空のセルは無いか。列見出しは具体的か
- [ ] 1つの概念に1つの用語を使っているか（用語集と照らし合わせる）
- [ ] 「簡単に」「単に」「すぐに」のような、読者の手間を軽く見せる語を使っていないか
- [ ] リンクの文言は、リンク先の題名や内容を表しているか
- [ ] 画像に代替テキストがあるか。「画像:」で始めていないか。ファイル名を使っていないか
- [ ] スクリーンショットは必要な部分だけを切り抜き、個人情報を塗りつぶしたか
- [ ] コード例は実行して確かめたか。プレースホルダーの説明と、出力の例があるか
- [ ] 注記は1ページに1〜2個までか。続けて置いていないか

## 機械で検査できそうなこと

- 行き先の分からないリンクの文言（**実装済み**: `linkText`）
- 代替テキストが空の画像（**実装済み**: `imageAlt`）。代替テキストがファイル名と一致するもの、「画像」で始まるもの、150字を超えるもの（未実装）
- 見出しの階層飛ばし（**実装済み**: `headingSkip`）。H1 が2つ以上、空の見出し、見出しの中のリンク・末尾の句点（未実装）
- 読者の手間を軽く見せる語（「簡単に」「単に」「すぐに」）。曖昧語リストに足せば `check-docs` で止められる
- 本文中の感嘆符、項目が1つだけのリスト、表の空セル、注記の多用（未実装）
- 方向だけで場所を示す語（「上の図」「右側の」）（未実装。警告にとどめる）

## 確認できなかったこと

- Microsoft のスタイルガイド本体で、simply や just を個別に禁じる項目があるか（原文ページは開いていない）
- Microsoft のスタイルガイド本体で、注記・警告をどう使うかの規定（確認できたのは Learn 投稿者ガイドの記述だけ）
