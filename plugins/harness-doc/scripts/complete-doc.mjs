#!/usr/bin/env node
/**
 * 完了処理の検査。文書を直したのに、改訂の記録が残っていなければ止める。
 *
 *   node complete-doc.mjs --mark [--reset] [--dest <project-dir>] [文書のパス...]   作業を始める前の基準点を記録する
 *   node complete-doc.mjs --mark --add [文書のパス...]     作業の途中で直す文書が増えたとき、基準点に足す（記録済みは上書きしない）
 *   node complete-doc.mjs --clear                          何も変えずに作業を終えたとき、基準点を消す
 *   node complete-doc.mjs compare [--limit <倍率>] <文書...>  基準点と今の文書の数値・見出しを比べる（前後確認）。--limit は改訂設計書の分量の上限
 *   node complete-doc.mjs restore <文書...>                文書を基準点の中身に戻す（依頼者が「やり直す」を選んだとき）
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
 * スキル（plan-doc・manual-writer・change-tone）が完了報告の前に呼ぶ。コミットの時点では、フック（hooks/scripts/commit-check.mjs）が
 * 同じ検査をステージした中身で行い、記録が無ければ止める。
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, matchesAny, toPosix, isHtmlPath, isProto, DEFAULT_CONFIG, checkDocument, loadStyle, diffIssues } from "../hooks/scripts/check-docs.mjs";
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

// コミット時の検査（hooks/scripts/commit-check.mjs）が、一時の index と比べる版（--amend なら HEAD~1）を差し替える
const ctx = { env: null, base: "HEAD" };

/** git の呼び出しに使う index と、比べる版を差し替える。引数なしで元に戻す */
export function setGitContext({ indexFile = null, base = "HEAD" } = {}) {
  ctx.env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : null;
  ctx.base = base;
}

function git(dest, args) {
  return execFileSync("git", ["-C", dest, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: ctx.env || process.env });
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
    git(dest, ["rev-parse", "--verify", ctx.base]);
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
    return git(dest, ["show", `${ctx.base}:./${rel}`]);
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
  if (staged) add(git(dest, ["diff", "--cached", ...(hasHead(dest) ? [ctx.base] : []), "--relative", "--name-only", "--diff-filter=ACMRD", "-z"]));
  else {
    if (hasHead(dest)) add(git(dest, ["diff", ctx.base, "--relative", "--name-only", "--diff-filter=ACMRD", "-z"]));
    else add(git(dest, ["ls-files", "--cached", "-z"])); // HEAD が無いリポジトリでは、ステージした新しい文書も拾う
    add(git(dest, ["ls-files", "--others", "--exclude-standard", "-z"]));
  }
  const styleRel = toPosix(config.styleDir || "docs-style") + "/";
  const historyRel = toPosix(config.historyDir || "docs-style/history") + "/";
  const plansRel = toPosix(config.plansDir || "docs-style/plans") + "/";
  return [...names].filter(
    (rel) =>
      (isHtmlPath(rel) || /\.md$/i.test(rel)) &&
      !isProto(rel) &&
      !rel.startsWith(styleRel) &&
      !rel.startsWith(historyRel) &&
      !rel.startsWith(plansRel) &&
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

// ---------------------------------------------------------------------------
// 改訂設計書（plan-doc が M・L で作る。docs-style/plans/YYYYMMDD_<名前>.md）
// ---------------------------------------------------------------------------

/** 改訂設計書の「## 見出し」の節の本文（無ければ null） */
function planSection(text, title) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const i = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`).test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^##\s/.test(lines[j])) j++;
  return lines.slice(i + 1, j).join("\n");
}

/**
 * 改訂設計書を読む。
 * 戻り値: { state, docs, unchecked: [文言], beforeAfter: 前後確認の節の中身（コメントを除く。無ければ ""） }
 * 未チェックは「受け入れ基準」と「タスク一覧」の節の `- [ ]`。完了処理のタスクは、検査の時点ではまだ済んでいないので数えない。
 * 「対象外（理由）」と書いた行も数えない（黙って消すことはできない。設計 §11）
 */
export function parsePlan(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  const row = (name) => {
    const m = src.match(new RegExp(`^\\|\\s*${name}\\s*\\|(.*)\\|\\s*$`, "m"));
    return m ? m[1].trim() : "";
  };
  const docs = [...row("対象の文書").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const unchecked = [];
  for (const title of ["受け入れ基準", "タスク一覧"]) {
    const body = planSection(src, title) || "";
    for (const l of body.split("\n")) {
      const m = l.match(/^\s*[-*]\s+\[ \]\s+(.*)$/);
      // 満たさないと決めた項目は「対象外（理由）」と書けば数えない（理由の無い「対象外」は数える）
      // 「対象外（理由）」は行末だけで見る（雛形の説明の中の「対象外（新規作成）」に当てない）。完了処理のタスクは行頭で見る
      if (m && !/^完了処理/.test(m[1].trim()) && !/対象外[（(][^）)]+[）)]\s*$/.test(m[1])) unchecked.push(m[1].trim());
    }
  }
  const beforeAfter = (planSection(src, "前後確認") || "").replace(/<!--[\s\S]*?-->/g, "").trim();
  // 問い合わせの表: 番号 → 回答（空なら未回答）。B1 の評価 #3（印を残すのは未回答の番号だけ）
  const queries = new Map();
  // 回答の列は見出しの「回答」の位置で読む（列の欠けた行で、ほかの列を回答と読まない）。番号のセルは強調・コードを外す
  const qBody = planSection(src, "問い合わせ");
  const qHead = tableHeader(qBody);
  const ansCol = qHead ? qHead.findIndex((c) => /回答/.test(c)) : -1;
  for (const r of tableRows(qBody)) {
    const no = (r[0] || "").replace(/[*`]/g, "").trim();
    if (/^Q\d+$/.test(no)) queries.set(no, ansCol >= 0 ? (r[ansCol] || "").trim() : "");
  }
  // 分量の上限: 「今の 1.5 倍まで」の数値。無ければ null（B1 の評価 #6）
  const lim = row("分量の上限").match(/(\d+(?:\.\d+)?)\s*倍/);
  // 読者役の指摘と、仕様と実装の食い違い（0.13.0 の雛形から。節が無い古い設計書は null）
  const reviewBody = planSection(src, "読者役の指摘");
  const mismatchBody = planSection(src, "食い違い");
  return {
    state: row("状態"),
    docs,
    unchecked,
    beforeAfter,
    queries,
    limit: lim ? Number(lim[1]) : null,
    reviewRows: reviewBody === null ? null : tableRows(reviewBody).length,
    // 依頼者の選択（最後の列）が空の食い違い
    mismatchOpen: mismatchBody === null ? [] : tableRows(mismatchBody).filter((r) => !(r[r.length - 1] || "").trim()).map((r) => r[0]),
  };
}

/** 節の中の最初の表の見出しの行（セルの配列。無ければ null） */
function tableHeader(body) {
  if (!body) return null;
  const l = String(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .find((x) => /^\s*\|/.test(x));
  return l ? l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()) : null;
}

/** 節の中の表の行（見出しの行と区切りの行を除く）。セルの配列の配列 */
function tableRows(body) {
  if (!body) return [];
  const rows = String(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => /^\s*\|/.test(l));
  return rows
    .filter((l, i) => i > 0 && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
}

/**
 * 改訂設計書の一覧（completed/ は除く）。
 * staged なら index の中身を読み、そのコミットで変わったものに inCommit を付ける。ageDays はファイル名の日付から
 */
export function planStates(dest, config, { staged = false } = {}) {
  const dir = toPosix(config.plansDir || "docs-style/plans").replace(/\/$/, "");
  let files = [];
  let changed = new Set();
  if (staged) {
    try {
      files = git(dest, ["ls-files", "-z", "--", dir]).split("\0").filter(Boolean);
      const diff = git(dest, ["diff", "--cached", ...(hasHead(dest) ? [ctx.base] : []), "--relative", "--name-only", "-z", "--", dir]);
      changed = new Set(diff.split("\0").filter(Boolean));
    } catch {
      files = [];
    }
  } else if (fs.existsSync(path.join(dest, dir))) {
    files = fs.readdirSync(path.join(dest, dir)).map((f) => `${dir}/${f}`);
  }
  const today = Date.now();
  return files
    .map(toPosix)
    .filter((f) => f.endsWith(".md") && path.posix.dirname(f) === dir && !/TEMPLATE\.md$/i.test(f))
    .map((f) => {
      const p = parsePlan(after(dest, f, staged));
      const d = path.posix.basename(f).match(/^(\d{4})(\d{2})(\d{2})_/);
      const ageDays = d ? Math.floor((today - Date.UTC(+d[1], +d[2] - 1, +d[3])) / 86400000) : 0;
      return { file: f, ...p, inCommit: changed.has(f), ageDays };
    });
}

/**
 * 作業前と今の内部の改訂記録の節を比べる。戻り値: { added: 足された節, rewritten: 過去の節が書き換えられたか }
 * 見出しでは比べない。同じ日に同じ文書を2回直すと同じ見出しの節が2つでき、見出しで比べると取り違える
 * （実地検証 P3a-3 の G1: 誤った「書き換えられている」の警告と、足した節を「足されていない」とする誤り）。
 * 新しい節は上に足すので、今の記録の末尾が作業前の記録と同じなら、先頭の残りが足した節。
 * そうでなければ、中身の多重集合で比べる（作業前に無かった中身の節が足した節、作業前の中身が今に無ければ書き換え・削除）。
 * どちらでも、作業前にある節と同じ中身の節は「足した節」にしない（過去の節を写しただけで通さない。0.10.1 の査読 1）。
 * history.mjs add は同じ見出しに（2）を付けるので、正当に足した節が過去の節と同じ中身になることは無い
 */
export function diffSections(oldSections, nowSections) {
  const oldTexts = new Set(oldSections.map((s) => s.text));
  const n = nowSections.length - oldSections.length;
  if (n >= 0 && oldSections.every((s, i) => nowSections[n + i].text === s.text)) {
    const head = nowSections.slice(0, n);
    return { added: head.filter((s) => !oldTexts.has(s.text)), rewritten: false, copied: head.filter((s) => oldTexts.has(s.text)), gone: [] };
  }
  const count = new Map();
  for (const s of oldSections) count.set(s.text, (count.get(s.text) || 0) + 1);
  const unmatched = [];
  for (const s of nowSections) {
    const c = count.get(s.text) || 0;
    if (c > 0) count.set(s.text, c - 1);
    else unmatched.push(s);
  }
  // 中身が合わなかった作業前の節。見出しが同じ今の節は、書き換えた節であって足した節ではない
  const gone = oldSections.filter((s) => {
    const c = count.get(s.text) || 0;
    if (c > 0) {
      count.set(s.text, c - 1);
      return true;
    }
    return false;
  });
  // 見出しで対にするときは下（古い側）から探す。同じ見出しの節で書き換えと追加が同時に起きたとき、
  // 上の新しい節を書き換えと取り違えないように（0.10.1 の査読 4）
  const goneHeadings = gone.map((s) => s.heading);
  const paired = new Set();
  for (let k = unmatched.length - 1; k >= 0; k--) {
    const i = goneHeadings.indexOf(unmatched[k].heading);
    if (i < 0) continue;
    goneHeadings.splice(i, 1);
    paired.add(unmatched[k]);
  }
  const added = unmatched.filter((s) => !paired.has(s) && !oldTexts.has(s.text));
  return { added, rewritten: gone.length > 0, copied: [], gone };
}

/** プロジェクトの中の試作のファイル（追跡しているものと、無視されていない追跡外のもの） */
export function protoFiles(dest) {
  try {
    return git(dest, ["ls-files", "-co", "--exclude-standard", "-z"])
      .split("\0")
      .filter((f) => f && isProto(f) && fs.existsSync(path.join(dest, f)))
      .map(toPosix);
  } catch {
    return [];
  }
}

/** 内部の改訂記録の節の規模（見出しの「規模 M」）。無ければ null */
const sizeOf = (s) => (s.heading.match(/規模\s*([SML])/) || [])[1] || null;

const QUERY_MARK = /<!--\s*問い合わせ\s*[:：]/;

/** 1本の文書を検査する。戻り値: { rel, problems: [], warnings: [] } */
/** check-docs の指摘が増えたときの問題の書き出し。コミット時の検査が、記録の問題と分けるために使う（skip で通さない） */
export const CHECK_DOCS_NG = "check-docs の指摘が";

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
  // 1. 内部の改訂記録: 作業前に無かった節が足され、それがこの文書を対象にしている
  const hFile = toPosix(path.relative(dest, historyFile(dest, r.brief.name)));
  const oldSections = parseSections(before(dest, hFile));
  const nowSections = parseSections(after(dest, hFile, staged));
  const diff = diffSections(oldSections, nowSections);
  const added = diff.added.filter((s) => mentions(s, r.docKey));
  if (!added.length) problems.push(`内部の改訂記録（${hFile}）に、この文書の節が足されていない（history.mjs add で書く）`);
  else if (added.some((s) => !String(s.items["改訂意図"] || "").trim())) problems.push(`内部の改訂記録（${hFile}）の改訂意図が空`);
  else if (strict && !staged && !baseline && beforeOf(dest, hFile) !== after(dest, hFile, false))
    // 基準点が無く、記録にコミットしていない変更がある: 足された節が今回の作業のものか、前の作業のものか区別できない（実地検証 P3a の F2）
    problems.push(
      `判定できない: 作業前の基準点が無く、内部の改訂記録（${hFile}）にコミットしていない変更がある。足された節が今回の作業のものか区別できない。` +
        "直そうとせず、完了報告に「基準点が無く判定できなかった」と書き、今回足した節を示す。" +
        "今から --mark して検査し直さない（今の状態が作業前になり、同じ節を二重に足すことになる）。次の作業からは、始めに --mark を走らせる"
    );
  if (diff.rewritten)
    warnings.push(
      `内部の改訂記録（${hFile}）の過去の節が書き換えられているか消されている（過去の節は書き換えない）: ${diff.gone.map((s) => `「${s.heading}」`).join("・")}`
    );
  if (diff.copied.length)
    warnings.push(`内部の改訂記録（${hFile}）に、過去の節と同じ中身の節が足されている（写しは今回の記録として数えない）: ${diff.copied.map((s) => `「${s.heading}」`).join("・")}`);
  // 試作のファイル（<元の名前>.proto-N.<拡張子>）が残っていたら止める。承認の後に消す決まりで、残すと公開物に混ざる
  // 文書の隣だけでなくプロジェクト全体を探す（試作の CSS は文書と別のフォルダーにある。0.11.0 の査読 R2）
  if (!staged) {
    const left = protoFiles(dest);
    if (left.length) problems.push(`試作のファイルが残っている: ${left.join(", ")}（見本を改訂設計書の「試作」の節に写してから消す）`);
  }
  // 改訂設計書: 規模 M・L の改訂（テイスト変更を含む）には要る。未チェックの基準・タスクと、前後確認の空を止める
  const docPlans = [];
  for (const s of added) {
    const size = sizeOf(s);
    if (size !== "M" && size !== "L") continue;
    const ref = String(s.items["改訂設計書"] || "").replace(/`/g, "").trim();
    if (!ref || /^なし/.test(ref)) {
      problems.push(`規模 ${size} の改訂なのに、内部の改訂記録に改訂設計書のパスが無い（plan-doc の M・L の経路で改訂設計書を作る）`);
      continue;
    }
    const planRel = relOf(dest, ref);
    const planText = after(dest, planRel, staged);
    if (!planText) {
      problems.push(
        staged && fs.existsSync(path.join(dest, planRel))
          ? `改訂設計書（${planRel}）がこのコミットに入っていない（文書・記録と一緒にコミットする）`
          : `改訂設計書（${planRel}）が無い`
      );
      continue;
    }
    const plan = parsePlan(planText);
    docPlans.push({ planRel, plan });
    if (plan.reviewRows === 0)
      problems.push(`改訂設計書（${planRel}）の「読者役の指摘」の表が空（読者役の結果が返ったら、直す前に指摘と対応を写す）`);
    if (plan.mismatchOpen.length)
      problems.push(`改訂設計書（${planRel}）の「食い違い」に、依頼者の選択が空の行がある: ${plan.mismatchOpen.slice(0, 3).join(" / ")}（完了前の確認で依頼者に選んでもらう）`);
    if (plan.unchecked.length)
      problems.push(`改訂設計書（${planRel}）に未チェックの受け入れ基準・タスクが残っている: ${plan.unchecked.slice(0, 3).join(" / ")}${plan.unchecked.length > 3 ? " ほか" : ""}（満たさないと決めたものは、行を消さずに末尾に「対象外（理由）」と書く）`);
    if (before(dest, rel) && exists(dest, rel, staged) && !plan.beforeAfter)
      problems.push(`改訂設計書（${planRel}）の「前後確認」が空（既存の文書を変えたときは、compare の結果と事実の変更の一覧を書く）`);
  }
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
  const body = html ? stripHtmlCode(now) : stripMdCode(now);
  if (QUERY_MARK.test(body)) {
    const withTable = docPlans.filter((p) => p.plan.queries.size);
    if (withTable.length) {
      // 改訂設計書の問い合わせ表で見る（B1 の評価 #3）: 未回答の番号の印は残ってよい（警告）。
      // 回答済みの番号・表に無い番号の印は NG（回答を本文に反映していない・表に載せていない）
      const answer = (no) => withTable.map((p) => p.plan.queries.get(no)).find((a) => a !== undefined);
      // 1つの印に番号が2つ以上あれば全部読む。番号の無い印は NG（表と照らせない。並列の書き手の印の振り直し忘れ）
      const marks = [...body.matchAll(/<!--\s*問い合わせ\s*[:：]([\s\S]*?)-->/g)].map((m) => m[1]);
      const nums = marks.flatMap((m) => m.match(/Q\d+/g) || []);
      const noNumber = marks.filter((m) => !/Q\d+/.test(m)).length;
      if (noNumber) problems.push(`番号の無い問い合わせの印が ${noNumber} 個ある（改訂設計書の問い合わせ表の番号「Q1」を書く）`);
      const open = nums.filter((n) => answer(n) === "");
      const answered = nums.filter((n) => answer(n));
      const unknown = nums.filter((n) => answer(n) === undefined);
      if (open.length) warnings.push(`未回答の問い合わせの印: ${[...new Set(open)].join("・")}（回答を待つあいだ残る。完了報告の「問い合わせ」に全部載せる）`);
      if (answered.length) problems.push(`回答済みの問い合わせの印が残っている: ${[...new Set(answered)].join("・")}（回答を本文に反映して印を消す）`);
      if (unknown.length) problems.push(`改訂設計書の問い合わせ表に無い番号の印: ${[...new Set(unknown)].join("・")}（表に載せる）`);
    } else {
      const msg = "本文に問い合わせの印（<!-- 問い合わせ: -->）が残っている。依頼者の回答で解消したら印を消す";
      (allowQueries ? warnings : problems).push(msg);
    }
  }
  // 分量の上限（改訂設計書の「分量の上限」。B1 の評価 #6）。超えたら完了前の確認で判断を求める
  const prevBody = before(dest, rel);
  for (const { planRel, plan } of docPlans) {
    if (!plan.limit || !prevBody) continue;
    const ratio = bodyChars(now, html) / Math.max(1, bodyChars(prevBody, html));
    if (ratio > plan.limit)
      warnings.push(`本文の字数が改訂設計書（${planRel}）の分量の上限（${plan.limit} 倍）を超えた（${ratio.toFixed(2)} 倍）。完了前の確認で判断を求める`);
  }
  // 推量の表現（B1 の評価 #14）。書かないことに入っているが、並列の書き手に渡らず残った。増えたら警告
  const guess = (s) => (String(s || "").match(/はずです|はずだ|かもしれ|可能性があります/g) || []).length;
  const g = guess(body) - guess(prevBody ? (html ? stripHtmlCode(prevBody) : stripMdCode(prevBody)) : "");
  if (g > 0) warnings.push(`推量の表現（はずです・かもしれ・可能性があります）が作業前より ${g} 件増えた。確かめて言い切るか、問い合わせにする`);
  // 4. check-docs の指摘が作業前より増えていないか（Bash で書き換えるとフックが働かないので、ここで捕まえる）
  if (style) {
    const abs = path.join(dest, rel);
    // 数え方はフックと同じ（check-docs の diffIssues）。ただしリンク切れも比べる（フックだけが毎回止める）。
    // 比べないと、前からあるリンク切れで関係の無い修正の完了とコミットが止まる。リンク先を消したときのリンク切れは、
    // 前の版でも今の配置で判定されるので、ここでは捕まえられない（既知の制限。その文書を次に書いたときにフックが止める）
    const nowIssues = checkDocument(now, { filePath: abs, config, style, format: html ? "html" : "md" });
    const prev = before(dest, rel);
    const oldIssues = prev ? checkDocument(prev, { filePath: abs, config, style, format: html ? "html" : "md" }) : [];
    const added = diffIssues(nowIssues, oldIssues, { always: new Set() }).groups.map((g) => `${g.message}${g.extra > 1 ? `（${g.extra}件）` : ""}`);
    if (added.length)
      problems.push(`${CHECK_DOCS_NG}${staged ? "直前のコミット" : "作業前"}より増えている: ${added.slice(0, 5).join(" / ")}${added.length > 5 ? " ほか" : ""}`);
  }
  // 抑止のマーカーを足して検査をすり抜けていないか
  const markers = (s) => (String(s).match(/<!--\s*check-docs:\s*(skip|ignore)\b/g) || []).length;
  if (markers(now) > markers(before(dest, rel)))
    warnings.push("検査の抑止（check-docs: skip / ignore）が作業前より増えている。理由が書いてあるか、docs-style/README.md の場合に当たるかを確かめる");
  // 5. 改行コード（基準点と比べるときだけ。HEAD の中身は git の設定 core.autocrlf で改行コードが変わって見えるため）
  const prevText = inBaseline && !staged ? before(dest, rel) : "";
  if (prevText && !gitNormalizesEol(dest, rel)) {
    const crlf = (s) => /\r\n/.test(s);
    if (crlf(prevText) !== crlf(now))
      warnings.push(`改行コードが作業前（${crlf(prevText) ? "CRLF" : "LF"}）から変わっている。差分がファイル全体に出る（Bash の置き換えで起きやすい。Edit で書き直す）`);
  }
  return { rel, problems, warnings };
}

/**
 * git がコミットのときに改行コードを揃えるか（.gitattributes の text / eol か、core.autocrlf）。
 * 揃えるなら、作業ツリーの改行コードの違いは git の変換の結果なので警告しない（B1 の評価 #13）
 */
function gitNormalizesEol(dest, rel) {
  try {
    const out = execFileSync("git", ["-C", dest, "check-attr", "text", "eol", "--", rel], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const attr = (name) => (out.match(new RegExp(`: ${name}: (\\S+)`)) || [])[1];
    const text = attr("text");
    const eol = attr("eol");
    if (text === "unset") return false; // -text: 変換しない
    if (text === "set" || text === "auto" || (eol && eol !== "unspecified")) return true;
    const ac = execFileSync("git", ["-C", dest, "config", "--get", "core.autocrlf"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return ac === "true" || ac === "input";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 前後確認の数値（compare）と、作業前に戻す（restore）
// ---------------------------------------------------------------------------

/** 文書の見出し（Markdown の # と HTML の h1〜h6。コードの中は見ない） */
function headingsOf(text, html) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  if (html) {
    const body = stripHtmlCode(src);
    return [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((m) => `${"#".repeat(+m[1])} ${m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()}`);
  }
  return stripMdCode(src)
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.replace(/\s*#*\s*$/, "").trim());
}

/** 本文の字数（タグ・記法・空白を除く） */
function bodyChars(text, html) {
  let s = String(text || "");
  if (html) s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/&[a-z]+;|&#\d+;/gi, "x");
  else s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/^(```|~~~).*$/gm, "").replace(/[#>*_`|\-[\]()!]/g, "");
  return s.replace(/\s+/g, "").length;
}

/** 図の数: <img>・<svg>・<figure>・Markdown の画像・mermaid のコードブロック（CSS で描いた図は数えない） */
function figuresOf(text, html) {
  const s = String(text || "");
  if (html) return (s.match(/<(img|svg|figure)\b/gi) || []).length;
  return (s.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length + (s.match(/^(```|~~~)\s*mermaid/gm) || []).length;
}

/** 前後の数値と見出しの比較。before が null なら新しい文書 */
export function compareDoc(beforeText, afterText, html) {
  const m = (t) =>
    t === null
      ? null
      : {
          lines: String(t).split(/\r?\n/).length,
          chars: bodyChars(t, html),
          headings: headingsOf(t, html),
          figures: figuresOf(t, html),
          queries: (String(t).match(/<!--\s*問い合わせ\s*[:：]/g) || []).length,
        };
  const b = m(beforeText);
  const a = m(afterText);
  const ratio = b && b.chars ? a.chars / b.chars : null;
  const added = b ? a.headings.filter((h) => !b.headings.includes(h)) : a.headings;
  const removed = b ? b.headings.filter((h) => !a.headings.includes(h)) : [];
  // 設計 §3-3 の「書いた後の条件」。当たれば前後確認を必須にする
  const condition = ratio !== null && (ratio >= 1.5 || ratio <= 0.67);
  return { before: b, after: a, ratio, added, removed, condition };
}

function printCompare(rel, r, say, limit = null) {
  say(`[complete-doc] ${rel}`);
  if (!r.before) {
    say(`  新しい文書: ${r.after.lines}行・本文 ${r.after.chars}字・見出し ${r.after.headings.length}・図 ${r.after.figures}・問い合わせの印 ${r.after.queries}`);
    return;
  }
  const row = (name, k) => `  ${name}: ${r.before[k]} → ${r.after[k]}`;
  say(row("行数", "lines"));
  say(`  本文の字数: ${r.before.chars} → ${r.after.chars}${r.ratio !== null ? `（${r.ratio.toFixed(2)} 倍）` : ""}`);
  say(`  見出しの数: ${r.before.headings.length} → ${r.after.headings.length}`);
  say(row("図の数", "figures"));
  say(row("問い合わせの印", "queries"));
  if (r.added.length) say(`  増えた見出し: ${r.added.join(" / ")}`);
  if (r.removed.length) say(`  消えた見出し: ${r.removed.join(" / ")}`);
  if (r.condition) say("  ⚠️ 本文の字数が 1.5 倍以上か 0.67 倍以下に変わった。前後確認を必須にする（S なら完了報告の問いに前後確認を含める）");
  // 改訂設計書の分量の上限（B1 の評価 #6）。超えたら完了前の確認で判断を求める
  if (limit && r.ratio !== null && r.ratio > limit) say(`  ⚠️ 改訂設計書の分量の上限（${limit} 倍）を超えた（${r.ratio.toFixed(2)} 倍）。完了前の確認で判断を求める`);
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
  let limit = null;
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
    else if (a === "--limit") {
      limit = Number(args[++i]);
      // 値が無い（次の文書のパスを飲む）・数でない形を止める
      if (!(limit > 0)) {
        process.stderr.write("--limit には正の倍率を渡す（改訂設計書に分量の上限が無ければ --limit を付けない）" + NL);
        process.exit(2);
      }
    }
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: node complete-doc.mjs --mark [--reset] [文書のパス...]  作業前の基準点を記録する（--reset で作り直す）\n" +
          "       node complete-doc.mjs --mark --add [文書のパス...]      直す文書が増えたとき、基準点に足す\n" +
          "       node complete-doc.mjs --clear                           何も変えずに作業を終えたとき、基準点を消す\n" +
          "       node complete-doc.mjs compare [--limit <倍率>] <文書のパス...>  基準点と今の文書の数値と見出しを比べる（前後確認）。--limit は改訂設計書の分量の上限\n" +
          "       node complete-doc.mjs restore <文書のパス...>           文書を基準点の中身に戻す（依頼者が「やり直す」を選んだとき）\n" +
          "       node complete-doc.mjs [--dest <project-dir>] [--staged] [--allow-queries] [文書のパス...]" +
          NL
      );
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`不明な引数: ${a}` + NL);
      process.exit(2);
    } else files.push(a);
  }
  const sub = files[0] === "compare" || files[0] === "restore" ? files.shift() : null;
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
  if (sub) {
    const b = loadBaseline(dest);
    if (!b) {
      say("[complete-doc] 作業前の基準点が無いので、比べる・戻すことができない（作業の始めに --mark を走らせる）");
      process.exit(1);
    }
    if (!files.length) {
      process.stderr.write(`${sub} には文書のパスを渡す` + NL);
      process.exit(2);
    }
    if (b.passed || (b.head && b.head !== headOf(dest)))
      say(`[complete-doc] 警告: 基準点（${b.createdAt} に記録）は${b.passed ? "前の作業で通過済み" : "その後にコミットがある"}。この作業の作業前かを確かめる（違えば作業の始めに --mark を走らせる）`);
    let bad = false;
    for (const rel of [...new Set(files.map((f) => relOf(dest, f)))]) {
      if (!hasOwn(b.files, rel)) {
        say(`[complete-doc] ${rel}: 基準点に無い（--mark --add で足していない文書）`);
        bad = true;
        continue;
      }
      if (sub === "compare") printCompare(rel, compareDoc(b.files[rel], readOrNull(dest, rel) ?? "", isHtmlPath(rel)), say, limit);
      else {
        const abs = path.join(dest, rel);
        if (b.files[rel] === null) fs.rmSync(abs, { force: true });
        else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, b.files[rel]);
        }
        say(`[complete-doc] ${rel}: 作業前の中身に戻した${b.files[rel] === null ? "（作業前は無かったので消した）" : ""}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }
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
