#!/usr/bin/env node
/**
 * 完了処理の検査。文書を直したのに、改訂の記録が残っていなければ止める。
 *
 *   node complete-doc.mjs --mark [--reset] [--dest <project-dir>] [文書のパス...]   作業を始める前の基準点を記録する
 *   node complete-doc.mjs --mark --add [文書のパス...]     作業の途中で直す文書が増えたとき、基準点に足す（記録済みは上書きしない）
 *   node complete-doc.mjs --clear                          何も変えずに作業を終えたとき、基準点を消す
 *   node complete-doc.mjs [--dest <project-dir>] [--staged] [--allow-queries] [文書のパス...]
 *
 * 文書のパスを省くと、git の差分から変わった文書（config の include に当たる .md / .html）を集める。
 *   既定: 作業ツリーと HEAD の差分 + 追跡していない新しい文書。基準点があれば、基準点から変わっていない文書（前の作業の分）は除く
 *   --staged: ステージした差分（コミット時の検査で使う。基準点は使わない）
 *
 * 比べる相手（「作業前」）:
 *   --mark で基準点を記録していれば、その時点の中身と比べる。無ければ HEAD と比べる。
 *   基準点が要る理由: 依頼者は作業のあいだにコミットを挟むとは限らない。HEAD と比べるだけだと、前の作業で足した記録や
 *   改訂履歴の行で、今の作業が記録を残していなくても合格してしまう（実地検証 P3a の F2）。
 *   基準点が無く、内部の改訂記録にコミットしていない変更があるとき（記録を足していれば必ず当たる）は「判定できない」で NG にする。
 *   基準点は git のフォルダーの中（.git/harness-doc/baseline.json）に置くので、コミットされない。
 *   同じコミットの上で既に基準点があれば、--mark は上書きせずに足す（--reset で作り直す）。
 *   すべて通り、基準点から変わった文書をすべて検査し終えたら「通過済み」の印を付ける（消さない。検査し直しても同じ結果になるように）。
 *   通過済みの基準点は、その後に何か変わっていれば使わない（次の作業）。次の --mark で作り直す。--clear で消す。
 *
 * 見ること（文書ごと）:
 *   1. 内部の改訂記録（docs-style/history/<文書群>.md）に、その文書の節が足されている。改訂意図が空でない
 *   2. ブリーフで読者向けの改訂履歴が「あり」なら、文書の「改訂履歴」の節が変わっている（新しい文書なら、節があり行がある）
 *   3. 本文に問い合わせの印（<!-- 問い合わせ: -->）が残っていない（--allow-queries で警告にとどめる）
 *   4. check-docs の指摘が、作業前より増えていない（Bash で書き換えてフックを通らなかった文書も、ここで捕まえる。
 *      作業前からある指摘は数えない）
 *   5. 改行コード（CRLF / LF）が作業前と変わっていない（変わっていれば警告。基準点と比べるときだけ）
 *   ほかに警告: 基準点に無い文書・基準点の後のコミット・抑止のマーカー（skip / ignore）の増加
 *
 * 終了コード: 0 = 通過（または git 管理外で検査できない）、1 = 通らない項目がある、2 = 使い方の誤り
 *
 * いまはスキル（plan-doc・manual-writer・change-tone）が完了報告の前に呼ぶ。止める力はスキルの指示と同じで、
 * コミット時のフックで止めるのは次の版（改善計画の P2b）。
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, matchesAny, toPosix, isHtmlPath, DEFAULT_CONFIG, checkDocument, loadStyle } from "../hooks/scripts/check-docs.mjs";
import { loadBriefs, resolveBrief } from "./brief.mjs";
import { historyFile, historyDir, parseSections, mentions } from "./history.mjs";

const NL = "\n";

// ---------------------------------------------------------------------------
// 作業前の基準点（--mark）
// ---------------------------------------------------------------------------

function gitDir(dest) {
  try {
    const d = execFileSync("git", ["-C", dest, "rev-parse", "--git-dir"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.resolve(dest, d);
  } catch {
    return null;
  }
}

function baselineFile(dest) {
  const g = gitDir(dest);
  return g ? path.join(g, "harness-doc", "baseline.json") : null;
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** プロジェクトからの相対パス（`./docs/a.md` と `docs/a.md` を同じキーにする） */
export function relOf(dest, p) {
  return path.posix.normalize(toPosix(path.isAbsolute(p) ? path.relative(dest, p) : p));
}

/** 今の中身。無ければ null（基準点の「無い」と比べるため） */
function readOrNull(dest, rel) {
  const abs = path.join(dest, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
}

function headOf(dest) {
  try {
    return git(dest, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

/**
 * 基準点を記録する。残すもの:
 *   - 内部の改訂記録のファイル全部
 *   - 渡された文書（無い文書は「無い」として）
 *   - いま最後のコミットから変わっている文書（前の作業で直してコミットしていない文書。引数なしの検査で、今回の変更と区別するため）
 * 既に基準点があり、次のすべてに当たるときだけ、記録済みのファイルは上書きせずに足す（plan-doc で記録した後に
 * manual-writer へ渡ったとき、直した後の中身が「作業前」にならないように）:
 *   同じコミットの上で記録した・まだ検査を通っていない（通過済みの印が無い）・内部の改訂記録が記録のときから変わっていない
 *   （記録が変わっていれば、前の作業が記録まで進んで終わっている。足すと、前の作業の記録で次の作業が通ってしまう）
 * `--add` は、通過済みでなければ足す。作り直すときは reset
 */
export function markBaseline(dest, docs = [], { add = false, reset = false, config = null } = {}) {
  const file = baselineFile(dest);
  if (!file) throw new Error("git 管理外なので基準点を記録できない");
  const head = headOf(dest);
  const cur = loadBaseline(dest);
  const hPrefix = toPosix(historyDir(dest)) + "/";
  const hDir = path.join(dest, historyDir(dest));
  const historyNow = fs.existsSync(hDir)
    ? fs.readdirSync(hDir).filter((f) => f.endsWith(".md")).map((f) => toPosix(path.relative(dest, path.join(hDir, f))))
    : [];
  // 記録のときから、改訂記録のファイルが変わっていない（増えてもいない）
  const historyUnchanged = (b) =>
    historyNow.every((k) => hasOwn(b.files, k)) &&
    Object.keys(b.files)
      .filter((k) => k.startsWith(hPrefix))
      .every((k) => readOrNull(dest, k) === b.files[k]);
  const merge = !!cur && !reset && !cur.passed && (add || (!!head && cur.head === head && historyUnchanged(cur)));
  const base = merge ? cur : { createdAt: new Date().toISOString(), head, files: {} };
  const put = (rel) => {
    if (!hasOwn(base.files, rel)) base.files[rel] = readOrNull(dest, rel);
  };
  for (const k of historyNow) put(k);
  for (const d of docs) put(relOf(dest, d));
  try {
    for (const rel of changedDocs(dest, config || loadConfig(dest).config || DEFAULT_CONFIG, false)) put(rel);
  } catch {
    /* 集められなくても、渡された文書の基準点は残る */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(base, null, 2));
  return { file, count: Object.keys(base.files).length, merged: merge, replaced: !!cur && !merge, createdAt: base.createdAt };
}

/** 基準点を消す（何も変えずに作業を終えたとき。残すと、次の作業が古い基準点と比べてしまう） */
export function clearBaseline(dest) {
  const file = baselineFile(dest);
  if (file && fs.existsSync(file)) {
    fs.rmSync(file);
    return true;
  }
  return false;
}

function loadBaseline(dest) {
  const file = baselineFile(dest);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function git(dest, args) {
  return execFileSync("git", ["-C", dest, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

/** "repo" / "not-repo" / "no-git"（git コマンドが無い） */
function gitState(dest) {
  try {
    return git(dest, ["rev-parse", "--is-inside-work-tree"]).trim() === "true" ? "repo" : "not-repo";
  } catch (e) {
    return e && e.code === "ENOENT" ? "no-git" : "not-repo";
  }
}

function hasHead(dest) {
  try {
    git(dest, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 比べる前の版（HEAD）の中身。無ければ空。
 * パスは `./` を付けて、`-C` のフォルダー（プロジェクト）からの相対として解釈させる。
 * 付けないと、プロジェクトが git リポジトリのサブフォルダーにあるときに、リポジトリのルートからのパスとして読まれる
 */
function beforeOf(dest, rel, baseline = null) {
  if (baseline && hasOwn(baseline.files, rel)) return baseline.files[rel] ?? "";
  if (!hasHead(dest)) return "";
  try {
    return git(dest, ["show", `HEAD:./${rel}`]);
  } catch {
    return "";
  }
}

/** 今の版の中身（--staged ならインデックス） */
function after(dest, rel, staged) {
  if (staged) {
    try {
      return git(dest, ["show", `:./${rel}`]);
    } catch {
      return "";
    }
  }
  const abs = path.join(dest, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
}

/** 今の版に文書があるか（削除した文書は、改訂の記録だけを見る） */
function exists(dest, rel, staged) {
  if (!staged) return fs.existsSync(path.join(dest, rel));
  try {
    git(dest, ["cat-file", "-e", `:./${rel}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 変わった文書（検査対象の .md / .html）を git から集める。削除した文書も含める（削除も改訂として記録する）。
 * `--relative` で、プロジェクトのフォルダーからの相対パスにする（サブフォルダーのプロジェクトでも効くように）
 */
export function changedDocs(dest, config, staged) {
  const names = new Set();
  const add = (out) => out.split("\0").map((s) => s.trim()).filter(Boolean).forEach((f) => names.add(toPosix(f)));
  if (staged) add(git(dest, ["diff", "--cached", "--relative", "--name-only", "--diff-filter=ACMRD", "-z"]));
  else {
    if (hasHead(dest)) add(git(dest, ["diff", "HEAD", "--relative", "--name-only", "--diff-filter=ACMRD", "-z"]));
    else add(git(dest, ["ls-files", "--cached", "-z"])); // HEAD が無いリポジトリでは、ステージした新しい文書も拾う
    add(git(dest, ["ls-files", "--others", "--exclude-standard", "-z"]));
  }
  const styleRel = toPosix(config.styleDir || "docs-style") + "/";
  const historyRel = toPosix(config.historyDir || "docs-style/history") + "/";
  return [...names].filter(
    (rel) =>
      (isHtmlPath(rel) || /\.md$/i.test(rel)) &&
      !rel.startsWith(styleRel) &&
      !rel.startsWith(historyRel) &&
      !rel.startsWith(".claude/") &&
      matchesAny(rel, config.include || []) &&
      !matchesAny(rel, config.exclude || [])
  );
}

const stripMdCode = (s) =>
  s.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
const stripHtmlCode = (s) =>
  s.replace(/<!--[\s\S]*?-->|<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\2\s*>/gi, (m) => (m.startsWith("<!--") ? m : m.replace(/[^\n]/g, " ")));

/**
 * 「改訂履歴」の節の中身（Markdown の見出し・HTML の h1〜h6 のどちらでも）。無ければ null。
 * 見出しの名前は config の revisionHeadings（既定「改訂履歴」。既存のサイトが「更新履歴」なら setup-project が合わせる）。
 * 節は、同じレベルかそれより上の見出しまで（下位の見出しで区切った改訂履歴も1つの節として読む）。コードの中の見出しは見ない
 */
export function revisionSection(text, html, names = ["改訂履歴"]) {
  const src = String(text).replace(/\r\n/g, "\n");
  const hit = (title) => names.some((n) => title.includes(n));
  if (html) {
    const body = stripHtmlCode(src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")));
    const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (!hit(m[2].replace(/<[^>]*>/g, ""))) continue;
      const level = Number(m[1]);
      const rest = body.slice(m.index + m[0].length);
      // 節の後ろのページ送り・フッターのリストを、改訂履歴の行として数えない
      const end = rest.search(new RegExp(`<h[1-${level}]\\b|</body|<footer\\b|</footer\\b|<nav\\b|</section\\b|</article\\b|</main\\b`, "i"));
      return end < 0 ? rest : rest.slice(0, end);
    }
    return null;
  }
  const lines = stripMdCode(src).split("\n");
  const orig = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!h || !hit(h[2])) continue;
    const level = h[1].length;
    let j = i + 1;
    while (j < lines.length) {
      const n = lines[j].match(/^(#{1,6})\s/);
      if (n && n[1].length <= level) break;
      j++;
    }
    return orig.slice(i + 1, j).join("\n");
  }
  return null;
}

/**
 * 改訂履歴の行の数。表でも箇条書きでも数える（検査の都合で文書の書き方を縛らない。実地検証 P3a の F3）。
 * HTML: 表のデータ行（<td> のある <tr>）と <li>。Markdown: 表のデータ行と箇条書き（- / * / 1.）。
 * テンプレートの YYYY-MM-DD の行と、リンクだけの箇条書き（Markdown の末尾のページ送り）は数えない
 */
function dataRows(section, html) {
  const real = (r) => !/YYYY-MM-DD/.test(r);
  if (html) {
    const tr = (section.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).filter((r) => /<td\b/i.test(r));
    const li = section.match(/<li\b[\s\S]*?<\/li>/gi) || [];
    return [...tr, ...li].filter(real).length;
  }
  const lines = section.split("\n");
  const table = lines.filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).slice(1);
  const list = lines.filter((l) => /^\s*([-*+]|\d+\.)\s+\S/.test(l) && !/^\s*([-*+]|\d+\.)\s+\[[^\]]*\]\([^)]*\)\s*$/.test(l));
  return [...table, ...list].filter(real).length;
}

/** check-docs の指摘を、行番号を除いた「種類と文言」の多重集合にする（作業前と比べて増えた分だけを見るため） */
function issueKeys(issues) {
  const m = new Map();
  for (const i of issues) {
    const k = `${i.kind}\u0000${i.message}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

const QUERY_MARK = /<!--\s*問い合わせ\s*[:：]/;

/** 1本の文書を検査する。戻り値: { rel, problems: [], warnings: [] } */
export function checkDoc(dest, rel, { staged = false, allowQueries = false, briefs, config = {}, baseline = null, style = null, strict = false } = {}) {
  const problems = [];
  const warnings = [];
  const before = (d, p) => beforeOf(d, p, baseline);
  const inBaseline = !!baseline && hasOwn(baseline.files, rel);
  if (baseline && !inBaseline)
    warnings.push("基準点に無い文書なので、最後のコミットと比べた（作業の途中で直す文書が増えたら --mark --add で足す）");
  const r = resolveBrief(briefs, rel);
  if (r.status !== "ok") {
    problems.push(
      r.status === "conflict"
        ? `ブリーフが2つ当たる（${r.candidates.map((b) => b.name).join(", ")}）。記録の置き場所が決まらない`
        : "ブリーフが当たらない。記録の置き場所が決まらない（先にブリーフを決める。README のような文書は文書群 default に入れる）"
    );
    return { rel, problems, warnings };
  }
  // 1. 内部の改訂記録: HEAD に無い見出しの節が足され、それがこの文書を対象にしている
  const hFile = toPosix(path.relative(dest, historyFile(dest, r.brief.name)));
  const oldSections = parseSections(before(dest, hFile));
  const oldHeadings = new Set(oldSections.map((s) => s.heading));
  const nowSections = parseSections(after(dest, hFile, staged));
  const added = nowSections.filter((s) => !oldHeadings.has(s.heading) && mentions(s, r.docKey));
  if (!added.length) problems.push(`内部の改訂記録（${hFile}）に、この文書の節が足されていない（history.mjs add で書く）`);
  else if (added.some((s) => !String(s.items["改訂意図"] || "").trim())) problems.push(`内部の改訂記録（${hFile}）の改訂意図が空`);
  else if (strict && !staged && !baseline && beforeOf(dest, hFile) !== after(dest, hFile, false))
    // 基準点が無く、記録にコミットしていない変更がある: 足された節が今回の作業のものか、前の作業のものか区別できない（実地検証 P3a の F2）
    problems.push(
      `判定できない: 作業前の基準点が無く、内部の改訂記録（${hFile}）にコミットしていない変更がある。足された節が今回の作業のものか区別できない。` +
        "直そうとせず、完了報告に「基準点が無く判定できなかった」と書き、今回足した節を示す。" +
        "今から --mark して検査し直さない（今の状態が作業前になり、同じ節を二重に足すことになる）。次の作業からは、始めに --mark を走らせる"
    );
  const nowByHeading = new Map(nowSections.map((s) => [s.heading, s.text]));
  if (oldSections.some((s) => nowByHeading.has(s.heading) && nowByHeading.get(s.heading) !== s.text))
    warnings.push(`内部の改訂記録（${hFile}）の過去の節が書き換えられている（過去の節は書き換えない）`);
  if (!exists(dest, rel, staged)) return { rel, problems, warnings }; // 削除した文書は記録だけを見る
  // 2. 読者向けの改訂履歴
  const docItem = r.brief.docs[r.docKey]?.["読者向けの改訂履歴"]?.value;
  const groupItem = r.brief.group["読者向けの改訂履歴"]?.["読者向けの改訂履歴"]?.value;
  const wantsReader = (docItem || groupItem || "").startsWith("あり");
  const html = isHtmlPath(rel);
  const now = after(dest, rel, staged);
  const names = config.revisionHeadings || ["改訂履歴"];
  if (wantsReader) {
    const cur = revisionSection(now, html, names);
    const old = revisionSection(before(dest, rel), html, names);
    if (cur === null) problems.push(`読者向けの改訂履歴が「あり」なのに、文書に「${names.join("」か「")}」の節が無い`);
    else if (old === null && !dataRows(cur, html)) problems.push("読者向けの改訂履歴の節に、行が無い（新しい文書なら「初版」の行を書く）");
    else if (old !== null && cur.trim() === old.trim()) problems.push("読者向けの改訂履歴が「あり」なのに、改訂履歴の節に行が足されていない");
  }
  // 3. 問い合わせの印（コードの中は見ない）
  if (QUERY_MARK.test(html ? stripHtmlCode(now) : stripMdCode(now))) {
    const msg = "本文に問い合わせの印（<!-- 問い合わせ: -->）が残っている。依頼者の回答で解消したら印を消す";
    (allowQueries ? warnings : problems).push(msg);
  }
  // 4. check-docs の指摘が作業前より増えていないか（Bash で書き換えるとフックが働かないので、ここで捕まえる）
  if (style) {
    const abs = path.join(dest, rel);
    const nowIssues = issueKeys(checkDocument(now, { filePath: abs, config, style, format: html ? "html" : "md" }));
    const prev = before(dest, rel);
    const oldIssues = prev ? issueKeys(checkDocument(prev, { filePath: abs, config, style, format: html ? "html" : "md" })) : new Map();
    const added = [];
    for (const [k, n] of nowIssues) {
      const extra = n - (oldIssues.get(k) || 0);
      if (extra > 0) added.push(`${k.split("\u0000")[1]}${extra > 1 ? `（${extra}件）` : ""}`);
    }
    if (added.length) problems.push(`check-docs の指摘が作業前より増えている: ${added.slice(0, 5).join(" / ")}${added.length > 5 ? " ほか" : ""}`);
  }
  // 抑止のマーカーを足して検査をすり抜けていないか
  const markers = (s) => (String(s).match(/<!--\s*check-docs:\s*(skip|ignore)\b/g) || []).length;
  if (markers(now) > markers(before(dest, rel)))
    warnings.push("検査の抑止（check-docs: skip / ignore）が作業前より増えている。理由が書いてあるか、docs-style/README.md の場合に当たるかを確かめる");
  // 5. 改行コード（基準点と比べるときだけ。HEAD の中身は git の設定 core.autocrlf で改行コードが変わって見えるため）
  const prevText = inBaseline && !staged ? before(dest, rel) : "";
  if (prevText) {
    const crlf = (s) => /\r\n/.test(s);
    if (crlf(prevText) !== crlf(now))
      warnings.push(`改行コードが作業前（${crlf(prevText) ? "CRLF" : "LF"}）から変わっている。差分がファイル全体に出る（Bash の置き換えで起きやすい。Edit で書き直す）`);
  }
  return { rel, problems, warnings };
}

function main() {
  const args = process.argv.slice(2);
  let dest = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let staged = false;
  let allowQueries = false;
  let mark = false;
  let add = false;
  let reset = false;
  let clear = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dest") dest = args[++i];
    else if (a === "--staged") staged = true;
    else if (a === "--allow-queries") allowQueries = true;
    else if (a === "--mark") mark = true;
    else if (a === "--add") add = true;
    else if (a === "--reset") reset = true;
    else if (a === "--clear") clear = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: node complete-doc.mjs --mark [--reset] [文書のパス...]  作業前の基準点を記録する（--reset で作り直す）\n" +
          "       node complete-doc.mjs --mark --add [文書のパス...]      直す文書が増えたとき、基準点に足す\n" +
          "       node complete-doc.mjs --clear                           何も変えずに作業を終えたとき、基準点を消す\n" +
          "       node complete-doc.mjs [--dest <project-dir>] [--staged] [--allow-queries] [文書のパス...]" +
          NL
      );
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`不明な引数: ${a}` + NL);
      process.exit(2);
    } else files.push(a);
  }
  if ((add || reset) && !mark) {
    process.stderr.write("--add と --reset は --mark と一緒に使う" + NL);
    process.exit(2);
  }
  dest = path.resolve(dest);
  const say = (s) => process.stdout.write(s + NL);
  const state = gitState(dest);
  if (state !== "repo") {
    say(
      state === "no-git"
        ? "[complete-doc] git コマンドが見つからないため、完了処理の検査を走らせていない（完了報告にそう書く）"
        : "[complete-doc] git 管理外のため、完了処理の検査を走らせていない（完了報告にそう書く）"
    );
    process.exit(0);
  }
  if (clear) {
    say(clearBaseline(dest) ? "[complete-doc] 基準点を消した" : "[complete-doc] 基準点は無い");
    process.exit(0);
  }
  const loaded = loadConfig(dest);
  const config = loaded.config || DEFAULT_CONFIG;
  if (mark) {
    const r = markBaseline(dest, files, { add, reset, config });
    if (r.merged)
      say(
        `[complete-doc] 既にある基準点（${r.createdAt} に記録）に足した（${r.count}ファイル）。記録済みのファイルは上書きしていない。` +
          "前の作業を途中でやめたときの基準点なら、--mark --reset で作り直す"
      );
    else
      say(
        `[complete-doc] 作業前の基準点を記録した（${r.count}ファイル）。完了処理の検査は、この時点と比べる` +
          (r.replaced ? "（前の基準点は、その後にコミットがあったので作り直した）" : "")
      );
    process.exit(0);
  }
  let baseline = staged ? null : loadBaseline(dest);
  let style = null;
  try {
    style = loadStyle(dest, config);
  } catch {
    style = null;
    say("[complete-doc] 警告: docs-style を読めないので、check-docs の指摘の増加（検査項目4）は見ていない");
  }
  const historyRel = toPosix(config.historyDir || "docs-style/history") + "/";
  const computeTargets = (b) => {
    if (files.length) return [...new Set(files.map((f) => relOf(dest, f)))];
    let t = changedDocs(dest, config, staged);
    if (b) {
      // 前の作業で直してコミットしていない文書（基準点のときから変わっていない）は、今回の変更として数えない
      const since = (rel) => readOrNull(dest, rel) !== b.files[rel];
      t = t.filter((rel) => !hasOwn(b.files, rel) || since(rel));
      for (const rel of Object.keys(b.files)) if (!rel.startsWith(historyRel) && since(rel) && !t.includes(rel)) t.push(rel);
    }
    return t;
  };
  let targets = computeTargets(baseline);
  // 通過済みの基準点は、通ったときから内部の改訂記録が変わっておらず、通ったときに検査した文書だけを検査するときに使う
  // （検査をもう一度走らせた・警告を直して確かめ直した）。記録が変わった・別の文書を直したなら次の作業なので使わない
  // （使うと、前の作業の記録で次の作業が通ってしまう）
  if (baseline && baseline.passed) {
    const snap = baseline.passed.files || {};
    const same =
      Object.keys(snap)
        .filter((k) => k.startsWith(historyRel))
        .every((k) => readOrNull(dest, k) === snap[k]) && targets.every((t) => hasOwn(snap, t));
    if (same && targets.some((t) => readOrNull(dest, t) !== snap[t]))
      say("[complete-doc] 警告: 通過した後に文書が変わっている。警告の手直しならよい。新しい作業なら、作業の始めに --mark を走らせてやり直す");
    if (!same) {
      say("[complete-doc] 基準点は前の作業で通過済みで、その後に変更がある。この作業の基準点としては使わない（作業の始めに --mark を走らせる）");
      baseline = null;
      targets = computeTargets(null);
    }
  }
  if (!baseline && !staged)
    say("[complete-doc] 作業前の基準点が無いので、最後のコミットと比べる（作業の始めに --mark を走らせる）");
  if (baseline && baseline.head && baseline.head !== headOf(dest))
    say(`[complete-doc] 警告: 基準点（${baseline.createdAt} に記録）の後にコミットがある。前の作業の基準点が残っていないか確かめる`);
  const changedSinceMark = (rel) => readOrNull(dest, rel) !== baseline.files[rel];
  const markedDocs = baseline ? Object.keys(baseline.files).filter((k) => !k.startsWith(historyRel)) : [];
  if (!targets.length) {
    say("[complete-doc] 変わった文書は無い");
    process.exit(0);
  }
  const briefs = loadBriefs(dest);
  let failed = false;
  for (const rel of targets) {
    const { problems, warnings } = checkDoc(dest, rel, { staged, allowQueries, briefs, config, baseline, style, strict: true });
    if (problems.length) failed = true;
    say(`[complete-doc] ${problems.length ? "NG" : "OK"}: ${rel}`);
    for (const p of problems) say(`  - ${p}`);
    for (const w of warnings) say(`  - 警告: ${w}`);
  }
  // すべて通り、基準点から変わった文書をすべて検査し終えたら、基準点に「通過済み」の印を付ける（消さない）。
  // 消すと、警告を直して検査し直したときに「判定できない」になる。印の付いた基準点は、次の --mark で作り直される
  if (!failed && baseline && !baseline.passed) {
    const pending = markedDocs.filter((rel) => changedSinceMark(rel) && !targets.includes(rel));
    if (pending.length) say(`[complete-doc] 基準点は通過済みにしていない（基準点から変わったが、まだ検査していない文書: ${pending.join(", ")}）`);
    else {
      const snap = {};
      for (const k of Object.keys(baseline.files)) if (k.startsWith(historyRel)) snap[k] = readOrNull(dest, k);
      const hDir = path.join(dest, historyDir(dest));
      if (fs.existsSync(hDir))
        for (const f of fs.readdirSync(hDir)) if (f.endsWith(".md")) {
          const k = toPosix(path.relative(dest, path.join(hDir, f)));
          snap[k] = readOrNull(dest, k);
        }
      for (const t of targets) snap[t] = readOrNull(dest, t);
      try {
        fs.writeFileSync(baselineFile(dest), JSON.stringify({ ...baseline, passed: { at: new Date().toISOString(), files: snap } }, null, 2));
      } catch {
        /* 書けなくても検査の結果は変わらない */
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
