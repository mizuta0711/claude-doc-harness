#!/usr/bin/env node
/**
 * 完了処理の検査。文書を直したのに、改訂の記録が残っていなければ止める。
 *
 *   node complete-doc.mjs [--dest <project-dir>] [--staged] [--allow-queries] [文書のパス...]
 *
 * 文書のパスを省くと、git の差分から変わった文書（config の include に当たる .md / .html）を集める。
 *   既定: 作業ツリーと HEAD の差分 + 追跡していない新しい文書
 *   --staged: ステージした差分（コミット時の検査で使う）
 *
 * 見ること（文書ごと）:
 *   1. 内部の改訂記録（docs-style/history/<文書群>.md）に、その文書の節が足されている。改訂意図が空でない
 *   2. ブリーフで読者向けの改訂履歴が「あり」なら、文書の「改訂履歴」の節が変わっている（新しい文書なら、節があり行がある）
 *   3. 本文に問い合わせの印（<!-- 問い合わせ: -->）が残っていない（--allow-queries で警告にとどめる）
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
import { loadConfig, matchesAny, toPosix, isHtmlPath, DEFAULT_CONFIG } from "../hooks/scripts/check-docs.mjs";
import { loadBriefs, resolveBrief } from "./brief.mjs";
import { historyFile, parseSections, mentions } from "./history.mjs";

const NL = "\n";

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
function before(dest, rel) {
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
      const end = rest.search(new RegExp(`<h[1-${level}]\\b|</body`, "i"));
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

/** 表のデータ行（見出し行と区切り行を除く）。テンプレートの YYYY-MM-DD の行は数えない */
function dataRows(section, html) {
  if (html) return (section.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).filter((r) => /<td\b/i.test(r) && !/YYYY-MM-DD/.test(r)).length;
  const rows = section.split("\n").filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));
  return rows.slice(1).filter((r) => !/YYYY-MM-DD/.test(r)).length;
}

const QUERY_MARK = /<!--\s*問い合わせ\s*[:：]/;

/** 1本の文書を検査する。戻り値: { rel, problems: [], warnings: [] } */
export function checkDoc(dest, rel, { staged = false, allowQueries = false, briefs, config = {} } = {}) {
  const problems = [];
  const warnings = [];
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
  return { rel, problems, warnings };
}

function main() {
  const args = process.argv.slice(2);
  let dest = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let staged = false;
  let allowQueries = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dest") dest = args[++i];
    else if (a === "--staged") staged = true;
    else if (a === "--allow-queries") allowQueries = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: node complete-doc.mjs [--dest <project-dir>] [--staged] [--allow-queries] [文書のパス...]" + NL);
      process.exit(0);
    } else if (a.startsWith("--")) {
      process.stderr.write(`不明な引数: ${a}` + NL);
      process.exit(2);
    } else files.push(a);
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
  const loaded = loadConfig(dest);
  const config = loaded.config || DEFAULT_CONFIG;
  const targets = files.length
    ? files.map((f) => toPosix(path.isAbsolute(f) ? path.relative(dest, f) : f))
    : changedDocs(dest, config, staged);
  if (!targets.length) {
    say("[complete-doc] 変わった文書は無い");
    process.exit(0);
  }
  const briefs = loadBriefs(dest);
  let failed = false;
  for (const rel of targets) {
    const { problems, warnings } = checkDoc(dest, rel, { staged, allowQueries, briefs, config });
    if (problems.length) failed = true;
    say(`[complete-doc] ${problems.length ? "NG" : "OK"}: ${rel}`);
    for (const p of problems) say(`  - ${p}`);
    for (const w of warnings) say(`  - 警告: ${w}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
