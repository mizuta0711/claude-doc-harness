# 文書群の構成（Diátaxis）

`manual-writer` の Step 3（目次案）で読む。**1つの文書に1つの役割**を持たせ、種類の違う内容はリンクで渡す。

## 出典

| タイトル | URL | 参照日 |
|---|---|---|
| Diátaxis（トップ） | https://diataxis.fr/ | 2026-10-02 |
| Start here | https://diataxis.fr/start-here/ | 2026-10-02 |
| Tutorials | https://diataxis.fr/tutorials/ | 2026-10-02 |
| How-to guides | https://diataxis.fr/how-to-guides/ | 2026-10-02 |
| Reference | https://diataxis.fr/reference/ | 2026-10-02 |
| Explanation | https://diataxis.fr/explanation/ | 2026-10-02 |
| The compass | https://diataxis.fr/compass/ | 2026-10-02 |
| Workflow（How to use Diátaxis） | https://diataxis.fr/how-to-use-diataxis/ | 2026-10-02 |
| The map | https://diataxis.fr/map/ | 2026-10-02 |
| Tutorials と how-to の違い | https://diataxis.fr/tutorials-how-to/ | 2026-10-02 |
| Reference と explanation の違い | https://diataxis.fr/reference-explanation/ | 2026-10-02 |

## このハーネスの型との対応

| Diátaxis | このハーネスの型（`templates/`） |
|---|---|
| チュートリアル（学ぶ） | `tutorial.md`（マーカー `tutorial`。見出しは検査しない。テンプレートの「到達点」「準備」「次に読む」を推奨する） |
| 手順書（how-to。作業する） | `howto.md`（手順書） |
| リファレンス（引く） | `reference.md` |
| 解説（理解する） | 型は無い。`spec.md` の「背景と目的」に近い。単独の文書にするときは下の「解説」の規則で書き、マーカーは `explanation`（見出しは検査しない） |

`spec.md`（仕様書）はリファレンスと解説の両方を含む。仕様書が長くなったら、表（リファレンス）と「なぜ」（解説）を分ける。

## 要点

1. 文書は4種類に分ける。チュートリアル（学習向け）、手順書（how-to。作業向け）、リファレンス（情報向け）、解説（理解向け）の4つで、1つの文書には1つの役割だけを持たせる。（出典: https://diataxis.fr/map/ ）
2. 種類の境界をぼかさない。サイトは「crossing or blurring the boundaries described in the map is at the heart of a vast number of problems in documentation」と書いている。（出典: https://diataxis.fr/start-here/ ）
3. チュートリアルは学習中の読者のための文書で、手順書は作業中の読者のための文書である。前者の責務は学習を成功させること、後者の責務は作業を達成させること。（出典: https://diataxis.fr/tutorials-how-to/ ）
4. チュートリアルでは、到達点を冒頭で示す。（出典: https://diataxis.fr/tutorials/ ）
5. チュートリアルでは、すべての手順で目に見える結果を出す（「Every step the learner follows should produce a comprehensible result, however small.」）。（出典: https://diataxis.fr/tutorials/ ）
6. チュートリアルには期待する出力を書く（「The output should look something like …」）。（出典: https://diataxis.fr/tutorials/ ）
7. チュートリアルでは説明を徹底して削る（「Ruthlessly minimise explanation」）。詳しい話は解説の文書へリンクする。（出典: https://diataxis.fr/tutorials/ 、 https://diataxis.fr/start-here/ ）
8. チュートリアルには選択肢や代替手段を書かない。到達に要る手順だけを書く。（出典: https://diataxis.fr/tutorials/ ）
9. チュートリアルは、どの読者がいつ実行しても失敗しない作りにする（「works for every user, every time」）。主語には一人称複数（「私たち」）を使う。（出典: https://diataxis.fr/tutorials/ ）
10. 手順書の読者は、達成したいことを自分で分かっている人である。教育・説明・脱線は書かない（「no digression, explanation, teaching」）。（出典: https://diataxis.fr/how-to-guides/ ）
11. 手順書の分岐は条件の形で書く（「If you want x, do y.」）。網羅性より実用性を優先する（「practical usability is more helpful than completeness」）。（出典: https://diataxis.fr/how-to-guides/ ）
12. 手順書の題名には、その文書で何ができるかをそのまま書く。良い例として「How to integrate application performance monitoring」が挙がっている。（出典: https://diataxis.fr/how-to-guides/ ）
13. 手順書は、意味のある地点で始めて意味のある地点で終える。そこから先を自分の作業につなぐのは読者に任せる。（出典: https://diataxis.fr/how-to-guides/ ）
14. リファレンスには記述だけを書く（「Describe and only describe」）。中立で簡素な文体（austere）を保ち、手順や意見は入れない。（出典: https://diataxis.fr/reference/ ）
15. リファレンスは構成のパターンを揃える（「Reference material is useful when it is consistent.」）。（出典: https://diataxis.fr/reference/ ）
16. リファレンスの構成は製品の構成に合わせる（「should mirror the structure of the product」）。例は載せてよいが、例を説明したり手順にしたりしない。（出典: https://diataxis.fr/reference/ ）
17. 解説には「なぜそうなっているか」を書く。設計判断、歴史的経緯、技術的制約が中身になる。（出典: https://diataxis.fr/explanation/ ）
18. 解説では代替案や反例も扱う。（出典: https://diataxis.fr/explanation/ ）
19. 解説の題名は、頭に「〜について（about）」を付けても通じる形にする。（出典: https://diataxis.fr/explanation/ ）
20. 解説には手順や技術仕様を混ぜない（「it tends to absorb other things」）。混ぜると、それらが本来あるべき場所から見えなくなる。（出典: https://diataxis.fr/explanation/ ）
21. 4つの区分はあらかじめ立てる計画ではない。上から構造を作らず、改善を積み重ねた結果として形ができるようにする。（出典: https://diataxis.fr/how-to-use-diataxis/ ）
22. 既存の文書群は1か所ずつ直す。手順は「対象を1つ選ぶ → 評価する → 次の一手を1つ決める → 実行して公開する」で、これを繰り返す。（出典: https://diataxis.fr/how-to-use-diataxis/ ）
23. 正しい方向への1歩は、それぞれすぐに公開する。大きな変更にまとめない。（出典: https://diataxis.fr/how-to-use-diataxis/ ）
24. 読者は文書群のどこからでも入ってくる前提で作る。（出典: https://diataxis.fr/map/ ）
25. 大規模な文書群の階層設計（ランディングページ、利用者別と種類別のどちらで分けるか）は未確認。https://diataxis.fr/complex-hierarchies/ は 404 だった。

## 種類の見分け方

コンパスの2つの問いで判定する。（出典: https://diataxis.fr/compass/ ）

| 問い1：その内容が支えるのは | 問い2：読者の状態は | 種類 | 読者の問い（出典: https://diataxis.fr/map/ ） |
|---|---|---|---|
| 行動（action：手を動かす） | 習得中（acquisition：学習） | チュートリアル | 「〜を教えてくれる？」 |
| 行動（action） | 適用中（application：作業） | 手順書 | 「〜はどうやるの？」 |
| 認識（cognition：知識） | 適用中（application） | リファレンス | 「〜とは何か？」 |
| 認識（cognition） | 習得中（acquisition） | 解説 | 「なぜ〜なのか？」 |

- コンパスは、迷ったときや作業がうまく進まないときに使う。文単位にも文書単位にも当てはめられる。（出典: https://diataxis.fr/compass/ ）
- 退屈で記憶に残らない内容は、おそらくリファレンスである。（出典: https://diataxis.fr/reference-explanation/ ）
- 一覧（クラス・メソッド・属性の一覧）と表は、大半がリファレンスに属する。（出典: https://diataxis.fr/reference-explanation/ ）
- 風呂で読む姿が想像できる内容は、おそらく解説である。（出典: https://diataxis.fr/reference-explanation/ ）

## 書くときのチェック項目

書き手と読者役のどちらも、各項目を「はい／いいえ」で判定できる。

- [ ] この文書の種類を1つ言えるか。言えない場合は分割する
- [ ] 【チュートリアル】冒頭に到達点が書いてあるか
- [ ] 【チュートリアル】各手順に、目に見える結果か期待する出力が書いてあるか
- [ ] 【チュートリアル】選択肢・代替手段・原理の説明が本文に入っていないか
- [ ] 【チュートリアル】予備知識のない読者が、書いてあるとおりに実行して完走できるか
- [ ] 【手順書】題名は「〜する」の形で、達成できることを表しているか
- [ ] 【手順書】背景説明や仕様の全項目列挙が入っていないか。入っていればリンクに置き換える
- [ ] 【手順書】分岐を「〜したい場合は〜する」の形で書いているか
- [ ] 【リファレンス】同じ種類の項目が、同じ見出し構成・同じ順序で並んでいるか
- [ ] 【リファレンス】項目の並びは、製品の構成（画面・コマンド・API の構造）に沿っているか
- [ ] 【リファレンス】手順・意見・推奨が混ざっていないか
- [ ] 【解説】「なぜ」に答えているか（設計判断・経緯・制約のどれか）
- [ ] 【解説】題名の頭に「〜について」を付けても通じるか
- [ ] 【解説】手順や仕様表が混ざっていないか
- [ ] 種類の違う内容は、本文に書かずにリンクで渡しているか
- [ ] 既存の文書群を直すとき、今回の変更は1つの改善に絞ってあるか

## 機械で検査できそうなこと（未実装の候補）

- 手順書の題名が「〜する」で終わるかを、パターン照合で確かめる
- 解説や手順書に大きな表やパラメータ一覧が入っていないかを、表の行数で確かめる。リファレンスの混入を疑う目安になる
- リファレンスで、同じ階層の項目の見出し構成（小見出しの名前と順序）が揃っているかを比べる

このハーネスでは、文書の種類を冒頭の `<!-- doc-type: ... -->` で示す（Diátaxis はこの表示を求めていない。ハーネス側の運用である）。
書ける値は `howto`・`reference`・`spec`（必須見出しを検査する）と、`tutorial`・`landing`（サイトの入口・案内）・`history`（読者向けの改訂履歴のページ）・`explanation`（解説）（見出しは検査しない）。
これ以外の値は、書き間違いとして `check-docs` が指摘する。プロジェクト独自の種類は config の `requiredHeadings` に足す。
