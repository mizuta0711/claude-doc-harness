#!/usr/bin/env node
/**
 * 文書群の見直し。文書群（ブリーフ）ごとに、文書の一覧・入口から辿れない文書・重複の候補・種類の偏り・リンク切れ・廃止の候補・古くなった候補を出す。
 *
 *   node docset.mjs [--dest <project-dir>] [--brief <名前>] [--json]
 *   node docset.mjs --stale [--dest <project-dir>] [--brief <名前>] [--json]    7つ目の項目（古くなった候補）だけを、追随できない文書の一覧まで詳しく出す
 *   node docset.mjs --reach <文書> [--dest <project-dir>] [--json]    その1本が入口から辿れるか
 *
 * 出すのは候補だけ。孤立は「入口から辿れない」ことしか言えず、重複は「同じ見出し・同じコードの行が多い」ことしか言えない。
 * 要るかどうか・矛盾しているかどうかは人が決める。出力はファイルに残さない（文書群の地図は腐る）。走らせるたびに出す。
 *
 * 文書群の単位はブリーフ（`.claude/rules/doc-brief-<名前>.md`）。ブリーフが無いプロジェクトは、config の include 全体を1つの文書群とする。
 * リンクを辿る範囲は、config の include 全体と、すべてのブリーフの入口のファイル（節「入口」の「入口のファイル」）。
 * 入口は Markdown・HTML とは限らない（サイドバーを JavaScript が持つサイト）。そのときは、文書のファイル名が
 * パスの区切りか引用符で区切られた語として書かれているかで見る（`phone.html` を `iphone.html` に当てない）。
 *
 * 古くなった候補は、内部の改訂記録の項目「確かめたソース」（history.mjs）を、記録の節が入ったコミットを基準点にして、
 * 基準点..HEAD の範囲に そのソースへのコミットがあるかで判定する（時刻では比べない。git の管理下でなければ判定しない）。「古い」とは言わず、候補と言う。
 *
 * 作りは complete-doc.mjs（完了処理の検査が `reachOf`・`docsetContext` を使う）と check-docs.mjs（リンクの収集 linksOf・アンカーの判定）を共有する。
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG,
  loadConfig,
  matchesAny,
  toPosix,
  isHtmlPath,
  isProto,
  linksOf,
  anchorsOf,
  brokenAnchorIssue,
  detectDocType,
  tokenizeLines,
} from "../hooks/scripts/check-docs.mjs";
import { loadBriefs, resolveBrief, entriesOf, globBase, DEFAULT_NAME } from "./brief.mjs";
import { historyFile, parseSections, mentions, sourcesOf } from "./history.mjs";

const NL = "\n";
/** ブリーフが無いプロジェクトの、include 全体の文書群の名前 */
export const WHOLE = "（include 全体）";
/** ブリーフのどれにも当たらない文書（default が無いとき）の文書群の名前 */
export const OUTSIDE = "（ブリーフ外）";
const DIATAXIS = ["tutorial", "howto", "reference", "explanation"];
/** 重複の候補: 同じ行が続く数の下限・出す組の数・「ひな形の繰り返し」とみなす文書の数（半分以上かつ3本以上） */
const RUN_MIN = 3;
const PAIR_LIMIT = 10;
const BOILERPLATE_MIN = 3;

const isDoc = (rel) => isHtmlPath(rel) || /\.md$/i.test(rel);

// ---------------------------------------------------------------------------
// ファイルの一覧と読み取り（作業ツリー。完了処理の --staged では index を差し込む）
// ---------------------------------------------------------------------------

/** 作業ツリーの source。list はプロジェクトの全ファイル（追跡している・追跡していない新しいファイル）、read は中身（無ければ null） */
export function fsSource(dest) {
  return {
    list() {
      let names = null;
      try {
        names = execFileSync("git", ["-C", dest, "ls-files", "-co", "--exclude-standard", "-z"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
        })
          .split("\0")
          .filter(Boolean)
          .map(toPosix)
          .filter((f) => fs.existsSync(path.join(dest, f)));
      } catch {
        names = null;
      }
      return names ?? walk(dest, "");
    },
    read(rel) {
      const abs = path.join(dest, rel);
      try {
        return fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8") : null;
      } catch {
        return null;
      }
    },
  };
}

function walk(dest, rel) {
  const out = [];
  for (const e of fs.readdirSync(path.join(dest, rel), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dest, r));
    else out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文脈（1回の実行の中で、文書の中身とリンクを1度だけ読む）
// ---------------------------------------------------------------------------

/**
 * 文書群の見直しの材料を作る。
 * 文書: config の include に当たり exclude に当たらない .md / .html。検査対象の外（docs-style の下・.claude・試作）は除く
 * 戻り値: { dest, config, briefs, all: 全ファイル, docs: 文書, entries: すべてのブリーフの入口のファイル, read, links(rel), ... }
 */
export function docsetContext(dest, { source = fsSource(dest), config = null, briefs = null } = {}) {
  config = config || loadConfig(dest).config || DEFAULT_CONFIG;
  briefs = briefs || loadBriefs(dest);
  const all = new Set(source.list().map(toPosix));
  const internal = [config.styleDir || "docs-style", config.historyDir || "docs-style/history", config.plansDir || "docs-style/plans"].map(
    (d) => toPosix(d).replace(/\/$/, "") + "/"
  );
  const docs = new Set(
    [...all].filter(
      (rel) =>
        isDoc(rel) &&
        !isProto(rel) &&
        !rel.startsWith(".claude/") &&
        !internal.some((p) => rel.startsWith(p)) &&
        matchesAny(rel, config.include || []) &&
        !matchesAny(rel, config.exclude || [])
    )
  );
  const entries = new Set();
  for (const b of briefs) for (const e of entriesOf(b)) entries.add(e);
  const textCache = new Map();
  const read = (rel) => {
    if (!textCache.has(rel)) textCache.set(rel, source.read(rel));
    return textCache.get(rel);
  };
  const linkCache = new Map();
  const ctx = { dest, config, briefs, all, docs, entries, read, source };
  /** 文書・入口（Markdown・HTML）から出ていくリンクを、行き先ごとに分ける */
  ctx.links = (rel) => {
    if (!linkCache.has(rel)) linkCache.set(rel, collectLinks(ctx, rel));
    return linkCache.get(rel);
  };
  ctx.anchors = anchorsReader(ctx);
  return ctx;
}

function anchorsReader(ctx) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) {
      const t = ctx.read(rel);
      cache.set(rel, t === null ? null : anchorsOf(t, isHtmlPath(rel)));
    }
    return cache.get(rel);
  };
}

/** ファイルの集合に含まれるディレクトリの集合（集合ごとに1度だけ作る） */
const dirCache = new WeakMap();
const isDirIn = (all, rel) => {
  if (rel === "") return true;
  let dirs = dirCache.get(all);
  if (!dirs) {
    dirs = new Set();
    for (const f of all) for (let d = path.posix.dirname(f); d !== "." && d !== "/" && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
    dirCache.set(all, dirs);
  }
  return dirs.has(rel.replace(/\/$/, ""));
};

/**
 * リンク1件の行き先を、プロジェクトのルートからのパスに解決する。
 * 戻り値: { kind: "skip" }（外部・同じ文書内・テンプレートの埋め込み）
 *       | { kind: "root", target }（`/usage/x.html`。サイトのルートが分からないので解決しない）
 *       | { kind: "ok", rel }（ファイル。ディレクトリへのリンクは index.html・index.md・README.md の順に解決する）
 *       | { kind: "dir", rel }（index の無いディレクトリ）
 *       | { kind: "missing", rel }（行き先が無い）
 *       | { kind: "outside" }（プロジェクトの外）
 */
export function resolveLink(all, sourceRel, target) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) return { kind: "skip" };
  if (/\$\{|\{\{/.test(target)) return { kind: "skip" };
  let t = target.split("#")[0].split("?")[0];
  if (!t) return { kind: "skip" };
  if (t.startsWith("/")) return { kind: "root", target };
  try {
    t = decodeURI(t);
  } catch {
    /* そのまま */
  }
  let base = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRel), t)).replace(/\/$/, "");
  if (base === "..") base = "../";
  if (base.startsWith("../")) return { kind: "outside" };
  if (base === ".") base = "";
  const trailing = /\/$/.test(t) || t === "." || base === "";
  if (!trailing && all.has(base)) return { kind: "ok", rel: base };
  if (trailing || isDirIn(all, base)) {
    for (const name of ["index.html", "index.md", "README.md"]) {
      const c = base ? `${base}/${name}` : name;
      if (all.has(c)) return { kind: "ok", rel: c };
    }
    return isDirIn(all, base) ? { kind: "dir", rel: base } : { kind: "missing", rel: base };
  }
  return { kind: "missing", rel: base };
}

/**
 * 実在するか（作業ツリー）。gitignore 済みのファイルへのリンクや、Windows の大文字小文字の違い（readme.md と README.md）を、
 * リンク切れにしない。孤立・到達の計算には使わない
 */
export function existsOnDisk(dest, rel) {
  try {
    return fs.existsSync(path.join(dest, rel));
  } catch {
    return false;
  }
}

/** 1本から出ていくリンク。resolved: 辿れた行き先、unresolved: 辿れなかったリンク（ルートからのリンク・参照形式のリンク）、broken: 切れ */
function collectLinks(ctx, rel) {
  const out = { resolved: [], unresolved: [], broken: [] };
  const text = ctx.read(rel);
  if (text === null || !isDoc(rel)) return out;
  const html = isHtmlPath(rel);
  const seen = new Set();
  for (const { target, line } of linksOf(text, html)) {
    const r = resolveLink(ctx.all, rel, target);
    if (r.kind === "root") out.unresolved.push({ line, target, reason: "ルートからのリンク", root: target.split("#")[0].split("?")[0] });
    else if (r.kind === "ok") {
      if (!seen.has(r.rel)) {
        seen.add(r.rel);
        out.resolved.push(r.rel);
      }
    } else if (r.kind === "missing" && !existsOnDisk(ctx.dest, r.rel)) out.broken.push({ source: rel, line, target, kind: "file" });
  }
  // アンカー（`#` 以降）。ファイルが実在するリンクだけを見る（切れたファイルは上で数えた）
  const baseDir = path.join(ctx.dest, path.dirname(rel));
  for (const { target, line, nav } of linksOf(text, html)) {
    if (!nav || !target.includes("#")) continue;
    const r = resolveLink(ctx.all, rel, target);
    if (r.kind !== "ok" && !target.startsWith("#")) continue;
    const issue = brokenAnchorIssue(target, baseDir, line, { text, isHtml: html }, ctx.config, {
      anchorsFor: (abs) => ctx.anchors(toPosix(path.relative(ctx.dest, abs))),
    });
    if (issue) out.broken.push({ source: rel, line, target, kind: "anchor" });
  }
  if (!html) {
    // 参照形式のリンク（`[名前]: 行き先`）は辿らない。孤立の理由に出す
    const lines = tokenizeLines(text).lines;
    for (const l of lines) {
      if (l.inCode) continue;
      const m = l.text.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
      if (!m) continue;
      const r = resolveLink(ctx.all, rel, m[1]);
      out.unresolved.push({ line: l.no, target: m[1], reason: "参照形式のリンク", rel: r.kind === "ok" ? r.rel : null });
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Markdown・HTML でない入口（JavaScript のサイドバーなど）が、どの文書を指しているか。
 * 文書のファイル名が、パスの区切り（/ \）か引用符（' " `）の直後に始まり、引用符か # ? で終わる語として書かれているものだけを当てる。
 * 同じファイル名の文書が複数あれば、書かれているパスの後ろが文書のパスの後ろと合うものに絞る（パスが書かれていなければ全部に当てる）
 */
export function mentionedDocs(text, docRels) {
  const hits = [];
  for (const rel of docRels) {
    const base = path.posix.basename(rel);
    const re = new RegExp(`(^|["'\`/\\\\])${escapeRe(base)}(?=["'\`#?\r]|$)`, "gm");
    let m;
    while ((m = re.exec(text)) !== null) {
      // 書かれているパス: 直前の引用符の後ろから、このファイル名の終わりまで
      const end = m.index + m[0].length;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const startQuote = Math.max(text.lastIndexOf('"', m.index), text.lastIndexOf("'", m.index), text.lastIndexOf("`", m.index), lineStart - 1);
      const written = toPosix(text.slice(startQuote + 1, end)).replace(/^(\.{1,2}\/)+/, "").replace(/^\//, "");
      if (written === base || rel.endsWith("/" + written) || rel === written) {
        hits.push(rel);
        break;
      }
    }
  }
  return hits;
}

/** 入口の rel から出る辺（文書 rel のリスト）。Markdown・HTML はリンク、それ以外は文書のファイル名の言及 */
function edgesOf(ctx, rel) {
  if (isDoc(rel)) return ctx.links(rel).resolved.filter((r) => ctx.docs.has(r) || ctx.entries.has(r));
  const t = ctx.read(rel);
  return t === null ? [] : mentionedDocs(t, ctx.docs);
}

/** 入口から辿れる文書の集合（幅優先）。戻り値: Map<rel, 1つ手前の rel（入口は null）> */
export function reachFrom(ctx, entries) {
  const parent = new Map();
  const queue = [];
  for (const e of entries) {
    if (!ctx.all.has(e)) continue;
    parent.set(e, null);
    queue.push(e);
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const next of edgesOf(ctx, cur)) {
      if (parent.has(next)) continue;
      parent.set(next, cur);
      queue.push(next);
    }
  }
  return parent;
}

/** ブリーフから見た文書群の名前と、そのブリーフ */
export function groupOf(ctx, rel) {
  if (!ctx.briefs.length) return { name: WHOLE, brief: null };
  const r = resolveBrief(ctx.briefs, rel);
  if (r.status === "ok") return { name: r.brief.name, brief: r.brief };
  if (r.status === "conflict") return { name: OUTSIDE, brief: null };
  return { name: OUTSIDE, brief: null };
}

const isLoose = (name) => name === DEFAULT_NAME || name === OUTSIDE;

/** 1本の文書が、自分の文書群の入口から辿れるか。完了処理の検査（新しい文書の警告）と --reach が使う */
export function reachOf(ctx, rel) {
  const g = groupOf(ctx, rel);
  const entries = g.brief ? entriesOf(g.brief) : [];
  const res = { rel, group: g.name, entries, state: null, reachable: null, via: [], reasons: [] };
  if (isLoose(g.name) || !g.brief) {
    res.state = "no-group";
    return res;
  }
  if (!entries.length) {
    res.state = "no-entry";
    return res;
  }
  if (!ctx.docs.has(rel) && !ctx.entries.has(rel)) {
    res.state = "not-doc";
    return res;
  }
  const parent = reachFrom(ctx, entries);
  if (entries.includes(rel)) {
    res.state = "entry";
    res.reachable = true;
    res.via = [rel];
    return res;
  }
  if (parent.has(rel)) {
    res.state = "reachable";
    res.reachable = true;
    for (let c = rel; c !== null; c = parent.get(c)) res.via.unshift(c);
    return res;
  }
  res.state = "orphan";
  res.reachable = false;
  res.reasons = orphanReasons(ctx, rel);
  return res;
}

/** 辿れなかった理由。リンクされている文書があるか・解決できなかったリンクが指していないか */
function orphanReasons(ctx, rel) {
  const reasons = [];
  const from = [];
  for (const s of [...ctx.docs, ...ctx.entries]) {
    if (s === rel) continue;
    if (isDoc(s) ? ctx.links(s).resolved.includes(rel) : mentionedDocs(ctx.read(s) || "", [rel]).length) from.push(s);
  }
  if (from.length) reasons.push(`入口から辿れない文書からだけリンクされている: ${from.slice(0, 3).join("・")}${from.length > 3 ? " ほか" : ""}`);
  for (const s of [...ctx.docs, ...ctx.entries]) {
    if (!isDoc(s)) continue;
    for (const u of ctx.links(s).unresolved) {
      if (u.root && (rel === u.root.replace(/^\//, "") || rel.endsWith(u.root))) reasons.push(`${s}:${u.line} の ${u.target} が指していそうだが、ルートからのリンクは解決していない`);
      if (u.rel === rel) reasons.push(`${s}:${u.line} の参照形式のリンク（${u.target}）で指されているが、辿っていない`);
    }
  }
  if (!reasons.length) reasons.push("どの文書・入口からもリンクされていない");
  return reasons;
}

// ---------------------------------------------------------------------------
// 重複の候補
// ---------------------------------------------------------------------------

/** 文書の見出し（最初のものがタイトル）とコードブロックの行 */
export function outlineOf(text, html) {
  const headings = [];
  const code = [];
  if (html) {
    const noComment = String(text).replace(/<!--[\s\S]*?-->/g, "");
    for (const m of noComment.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) headings.push(clean(m[2].replace(/<[^>]*>/g, "")));
    for (const m of noComment.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi)) {
      const body = m[1].replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      code.push(body.split(/\r?\n/).map((l) => l.trim()));
    }
    return { headings, code };
  }
  let block = null;
  for (const l of tokenizeLines(text).lines) {
    if (l.inCode) {
      if (l.fenceOpen) block = [];
      else if (block && /^\s*(`{3,}|~{3,})\s*$/.test(l.text)) {
        code.push(block);
        block = null;
      } else if (block) block.push(l.text.trim());
      continue;
    }
    const m = l.text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) headings.push(clean(m[1]));
  }
  if (block) code.push(block);
  return { headings, code };
}

const clean = (s) => String(s).replace(/\s+/g, " ").trim();
const norm = (s) => clean(s).toLowerCase();

/**
 * 文書の組ごとに、同じ見出しの数と、コードブロックの中で同じ行が RUN_MIN 行以上続く箇所の数を数え、多い順に上位 PAIR_LIMIT 組を返す。
 * 比べるのは同じ文書群の文書だけ（README と手順書の重複は見ない）。
 * 除くもの: 入口のファイルと doc-type: landing の文書・各文書の最初の見出し（題名）・必須見出しの語を含む見出し・「改訂履歴」・
 * 文書群の半分以上（かつ3本以上）の文書に出る見出しと行（ひな形の繰り返し）
 */
export function duplicatePairs(ctx, rels, { limit = PAIR_LIMIT } = {}) {
  const required = [...new Set(Object.values(ctx.config.requiredHeadings || {}).flat()), "改訂履歴", ...(ctx.config.revisionHeadings || [])];
  const outlines = new Map();
  for (const rel of rels) {
    // 入口のファイルと doc-type: landing の文書は、ほかの文書の見出しを並べて案内するだけなので比べない
    if (ctx.entries.has(rel)) continue;
    const t = ctx.read(rel);
    if (t === null || detectDocType(t) === "landing") continue;
    const o = outlineOf(t, isHtmlPath(rel));
    // 最初の見出しは文書の題名。題名だけが同じ組（子ページの題名と、一覧のページの節の見出し）は重複の根拠にしない
    outlines.set(rel, { headings: o.headings.slice(1), code: o.code });
  }
  const n = outlines.size;
  const threshold = Math.max(BOILERPLATE_MIN, Math.ceil(n / 2));
  const countIn = (pick) => {
    const m = new Map();
    for (const o of outlines.values()) for (const k of new Set(pick(o))) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const headingCount = countIn((o) => o.headings.map(norm));
  const lineCount = countIn((o) => o.code.flat().filter(Boolean));
  const headingOk = (h) => !required.some((w) => h.includes(w)) && (headingCount.get(norm(h)) || 0) < threshold;
  const lineOk = (l) => !!l && (lineCount.get(l) || 0) < threshold;
  const prepared = new Map();
  for (const [rel, o] of outlines) {
    prepared.set(rel, {
      headings: new Map(o.headings.filter(headingOk).map((h) => [norm(h), h])),
      code: o.code.map((b) => b.map((l) => (lineOk(l) ? l : null))),
    });
  }
  const names = [...prepared.keys()].sort();
  const runs = commonRunsByPair(names.map((nm) => prepared.get(nm).code));
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = prepared.get(names[i]);
      const b = prepared.get(names[j]);
      const headings = [...a.headings.keys()].filter((k) => b.headings.has(k)).map((k) => a.headings.get(k));
      const codeRuns = runs.get(i * names.length + j) || 0;
      if (headings.length || codeRuns) pairs.push({ a: names[i], b: names[j], headings, codeRuns });
    }
  }
  pairs.sort((x, y) => y.headings.length + y.codeRuns - (x.headings.length + x.codeRuns) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return limit ? { top: pairs.slice(0, limit), all: pairs } : { top: pairs, all: pairs };
}

/**
 * 文書の組ごとの、同じ行が RUN_MIN 行以上続く箇所の数（箇所は、続きの途中から数え直さない）。
 * 行 → （文書・ブロック・位置）の逆引きを作り、同じ行を持つ組の、続きの始まりだけを延ばす（全組の総当たりをしない）
 * 戻り値: Map<i * 文書数 + j（i < j）, 箇所の数>
 */
function commonRunsByPair(codeByDoc) {
  const n = codeByDoc.length;
  const index = new Map();
  codeByDoc.forEach((blocks, d) =>
    blocks.forEach((block, b) =>
      block.forEach((line, p) => {
        if (line === null) return;
        if (!index.has(line)) index.set(line, []);
        index.get(line).push([d, b, p]);
      })
    )
  );
  const result = new Map();
  codeByDoc.forEach((blocks, di) =>
    blocks.forEach((A, bi) =>
      A.forEach((line, i) => {
        if (line === null) return;
        for (const [dj, bj, j] of index.get(line)) {
          if (dj <= di) continue;
          const B = codeByDoc[dj][bj];
          if (i > 0 && j > 0 && A[i - 1] !== null && A[i - 1] === B[j - 1]) continue; // 続きの途中
          let len = 0;
          while (i + len < A.length && j + len < B.length && A[i + len] !== null && A[i + len] === B[j + len]) len++;
          if (len >= RUN_MIN) result.set(di * n + dj, (result.get(di * n + dj) || 0) + 1);
        }
      })
    )
  );
  return result;
}

// ---------------------------------------------------------------------------
// 古くなった候補（確かめたソースが、確かめた後に変わった文書）
// ---------------------------------------------------------------------------

/** git を呼ぶ（プロジェクトがリポジトリのサブフォルダーでも、日本語のパスでも読めるように -C と quotepath=false を付ける） */
function gitOut(dest, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", "-C", dest, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** "repo" | "not-repo"（git の管理下でない）| "no-git"（git コマンドが無い） */
function gitStateOf(dest) {
  try {
    return gitOut(dest, ["rev-parse", "--is-inside-work-tree"]).trim() === "true" ? "repo" : "not-repo";
  } catch (e) {
    return e && e.code === "ENOENT" ? "no-git" : "not-repo";
  }
}

/** 引数の長さの上限（Windows のコマンドラインは約 32,000 文字）に収まるように、パスを分ける */
function chunkPaths(paths, max = 12000) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 1 > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 内部の改訂記録のファイルについて、節の見出し → その見出しが最初に入ったコミット（最も古いもの）。
 * `git log -S"## <見出し>"` を節ごとに呼ぶ代わりに、記録のファイルの履歴を1回だけ読み、追加された「## 見出し」の行を拾う（同じ結果）。
 * `--follow` で新しい順に読み、同じ見出しは後から出た（古い）コミットで上書きする。記録のファイルを `git mv` しても、移したコミットに
 * 全部の節が足された行として出ない（`--reverse` と `--no-renames` では、基準点が全部「移したコミット」に動き、候補が黙って消える）。
 * 雛形のコメントの中の例の見出しは拾わない。コミットされていない節は含まれない
 */
function headingCommits(dest, relFile) {
  const map = new Map();
  let out = "";
  try {
    out = gitOut(dest, ["log", "--follow", "--format=%x01%H", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--", relFile]);
  } catch {
    return map;
  }
  let commit = null;
  let inComment = false;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("\x01")) {
      commit = line.slice(1).trim();
      inComment = false;
    } else if (line.startsWith("@@")) inComment = false;
    else if (commit && line.startsWith("+") && !line.startsWith("+++")) {
      const body = line.slice(1);
      if (inComment) {
        if (body.includes("-->")) inComment = false;
        continue;
      }
      if (body.includes("<!--") && !body.includes("-->")) {
        inComment = true;
        continue;
      }
      if (body.startsWith("## ")) {
        const heading = body.slice(3).trim();
        if (heading) map.set(heading, commit); // 新しい順に読むので、古いコミットが最後に残る
      }
    }
  }
  return map;
}

/** HEAD から辿れる全コミットの親の一覧（1回）。戻り値: Map<コミット, 親の配列> */
function commitGraph(dest) {
  const g = new Map();
  try {
    for (const line of gitOut(dest, ["rev-list", "--parents", "HEAD"]).split("\n")) {
      const [c, ...parents] = line.trim().split(" ").filter(Boolean);
      if (c) g.set(c, parents);
    }
  } catch {
    /* 空: すべての節が未コミット */
  }
  return g;
}

/** コミット base とその祖先の集合（親の一覧から手元で作る） */
function ancestorsOf(graph, base) {
  const seen = new Set();
  const stack = [base];
  while (stack.length) {
    const c = stack.pop();
    if (seen.has(c)) continue;
    seen.add(c);
    for (const p of graph.get(c) || []) stack.push(p);
  }
  return seen;
}

/**
 * 各ソースに触れたコミットの集合（HEAD から辿れる全履歴。パスで絞って1回だけ読む。パスが多ければ分けて読む）。
 * 基準点ごとの「base..HEAD」は、ここで読んだ集合から、base の祖先を除いて手元で数える（基準点ごとに git を起動しない）
 */
function touchingCommits(dest, sources) {
  const touched = new Map(); // source → Set<コミット>
  for (const chunk of chunkPaths(sources)) {
    let out = "";
    try {
      out = gitOut(dest, ["--literal-pathspecs", "log", "--name-only", "--no-renames", "--relative", "--format=%x01%H", "HEAD", "--", ...chunk]);
    } catch {
      continue;
    }
    let commit = null;
    for (const raw of out.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("\x01")) commit = line.slice(1).trim();
      else if (line && commit) {
        if (!touched.has(line)) touched.set(line, new Set());
        touched.get(line).add(commit);
      }
    }
  }
  return touched;
}

/** 消した・移したソースの、移した先（git が rename として見つけたもの）。履歴の rename と削除を1回だけ読む。戻り値: Map<旧パス, 新パス> */
function renamesOf(dest, lost) {
  const out = new Map();
  if (!lost.size) return out;
  let text = "";
  try {
    text = gitOut(dest, ["log", "-M", "--diff-filter=R", "--name-status", "--relative", "--format=", "HEAD"]);
  } catch {
    return out;
  }
  const next = new Map();
  for (const raw of text.split("\n")) {
    const m = raw.replace(/\r$/, "").match(/^R\d*\t([^\t]+)\t([^\t]+)$/);
    if (m && !next.has(m[1])) next.set(m[1], m[2]); // 新しい順なので、最初のものが最後の移動
  }
  for (const src of lost) {
    let cur = src;
    const seen = new Set();
    while (next.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = next.get(cur);
    }
    if (cur !== src) out.set(src, cur);
  }
  return out;
}

/** 履歴で削除と分かるパスの集合（rename は含めない）。1回だけ読む */
function deletedPaths(dest) {
  const set = new Set();
  try {
    for (const raw of gitOut(dest, ["log", "-M", "--diff-filter=D", "--name-only", "--relative", "--format=", "HEAD"]).split("\n")) {
      const l = raw.replace(/\r$/, "");
      if (l) set.add(l);
    }
  } catch {
    /* 空 */
  }
  return set;
}

/** 差分を見るコマンド（ソースの名前に空白があれば引用符で囲む） */
export const diffCommand = (base, source) => `git log -p ${base.slice(0, 7)}..HEAD -- ${/[\s"']/.test(source) ? `"${source}"` : source}`;

/**
 * 古くなった候補。文書ごとに、内部の改訂記録でその文書を対象にした節の「確かめたソース」を全部合わせ、
 * ソースごとに「そのソースを挙げた最新の節が記録に入ったコミット」を基準点にして、基準点..HEAD に そのソースへのコミットがあれば候補にする。
 * docs を渡すと、その文書だけを対象にする（--brief で絞ったとき）。
 * git の呼び出しは、記録のファイルごとに1回・コミットの親の一覧に1回・追跡の一覧に1回・ソースに触れたコミットに1回（パスが多ければ分ける）・
 * 移した先に1回・削除した文書に1回で、基準点・文書・ソースの本数に比例しない。
 * 戻り値: { state: "ok" | "no-git" | "not-repo", docs: Map<rel, { state, candidates, lost }>, detached: [{ group, key, heading, deleted }] }
 *   docs の state: "ok" | "no-place"（ブリーフが当たらず、記録の置き場所が無い）| "untraceable"（確かめたソースの記録が無い）
 *   candidates: [{ source, base, count }]、lost: [{ source, movedTo }]（追跡していない・消えた）
 */
export function staleAnalysis(ctx, { docs = null } = {}) {
  const dest = ctx.dest;
  const res = { state: "ok", docs: new Map(), detached: [] };
  const gs = gitStateOf(dest);
  if (gs !== "repo") {
    res.state = gs;
    return res;
  }
  const targets = docs ? [...ctx.docs].filter((r) => docs.has(r)) : [...ctx.docs];
  // 文書 → ブリーフと見出しの名前
  const perBrief = new Map(); // ブリーフの名前 → { brief, sections, commits, keys: 今ある文書の見出しの名前の集合 }
  const place = new Map();
  for (const rel of targets) {
    const r = resolveBrief(ctx.briefs, rel);
    if (r.status !== "ok") {
      res.docs.set(rel, { state: "no-place", candidates: [], lost: [] });
      continue;
    }
    place.set(rel, r);
    if (!perBrief.has(r.brief.name)) {
      const file = historyFile(ctx.dest, r.brief.name);
      let sections = [];
      let commits = new Map();
      if (fs.existsSync(file)) {
        sections = parseSections(fs.readFileSync(file, "utf-8"));
        commits = headingCommits(dest, toPosix(path.relative(dest, file)));
      }
      perBrief.set(r.brief.name, { brief: r.brief, sections, commits, keys: new Set() });
    }
    perBrief.get(r.brief.name).keys.add(r.docKey);
  }
  // 文書ごとに、ソース → そのソースを挙げた最新の節の見出し（記録のファイルは新しい順）
  const wanted = new Map(); // rel → Map<source, heading>
  const allSources = new Set();
  for (const [rel, r] of place) {
    const pb = perBrief.get(r.brief.name);
    const m = new Map();
    for (const s of pb.sections.filter((x) => mentions(x, r.docKey))) for (const src of sourcesOf(s)) if (!m.has(src)) m.set(src, s.heading);
    wanted.set(rel, m);
    for (const src of m.keys()) allSources.add(src);
  }
  // 追跡しているか（1回）。追跡していても作業ツリーに無ければ「消えた」
  let tracked = new Set();
  if (allSources.size) {
    try {
      tracked = new Set(gitOut(dest, ["ls-files", "-z"]).split("\0").filter(Boolean).map(toPosix));
    } catch {
      /* 空のまま: すべて「追跡されていない」になる */
    }
  }
  const isLost = (src) => !tracked.has(src) || !fs.existsSync(path.join(dest, src));
  const live = [...allSources].filter((s) => !isLost(s));
  const graph = live.length ? commitGraph(dest) : new Map();
  const touched = live.length ? touchingCommits(dest, live) : new Map();
  const ancestors = new Map(); // base → 祖先の集合（基準点ごとに1回、手元で作る）
  const countFrom = (base, src) => {
    const set = touched.get(src);
    if (!set || !graph.has(base)) return 0;
    if (!ancestors.has(base)) ancestors.set(base, ancestorsOf(graph, base));
    const anc = ancestors.get(base);
    let n = 0;
    for (const c of set) if (!anc.has(c)) n++;
    return n;
  };
  const lostAll = new Set();
  for (const m of wanted.values()) for (const src of m.keys()) if (isLost(src)) lostAll.add(src);
  const moved = renamesOf(dest, lostAll);
  for (const [rel, r] of place) {
    const m = wanted.get(rel);
    if (!m.size) {
      res.docs.set(rel, { state: "untraceable", candidates: [], lost: [] });
      continue;
    }
    const commits = perBrief.get(r.brief.name).commits;
    const candidates = [];
    const lost = [];
    for (const [src, heading] of m) {
      if (isLost(src)) {
        lost.push({ source: src, movedTo: moved.get(src) || null });
        continue;
      }
      const base = commits.get(heading); // 無ければ未コミットの節: 今を基準点にする
      const n = base ? countFrom(base, src) : 0;
      if (n >= 1) candidates.push({ source: src, base, count: n });
    }
    res.docs.set(rel, { state: "ok", candidates, lost });
  }
  // 記録と対応が切れた文書: 確かめたソースのある節が対象にしている文書の名前のうち、今はどの文書にも当たらないもの。
  // 作業ツリーにファイルがある（config の exclude で対象外にした文書）ものは出さない。履歴で削除と分かるものは deleted にする
  let deleted = null;
  for (const pb of perBrief.values()) {
    const seen = new Set();
    const bases = [...new Set(pb.brief.paths.map((g) => globBase(g)))];
    for (const s of pb.sections) {
      if (!sourcesOf(s).length) continue;
      for (const key of (s.items["対象の文書"] || "").split(/[、,]\s*/).map((t) => t.trim()).filter(Boolean)) {
        if (pb.keys.has(key) || seen.has(key)) continue;
        seen.add(key);
        const cands = bases.map((b) => b + key);
        if (cands.some((c) => ctx.all.has(c) || fs.existsSync(path.join(dest, c)))) continue;
        deleted = deleted || deletedPaths(dest);
        res.detached.push({ group: pb.brief.name, key, heading: s.heading, deleted: cands.some((c) => deleted.has(c)) });
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** 文書群1つ分の、古くなった候補の表示用のまとめ */
function groupStale(st, g) {
  const out = { state: st.state, candidates: [], lost: [], untraceable: [], noPlace: [], detached: [], deleted: [] };
  if (st.state !== "ok") return out;
  for (const rel of g.rels) {
    const d = st.docs.get(rel);
    if (!d) continue;
    if (d.state === "no-place") out.noPlace.push(rel);
    else if (d.state === "untraceable") out.untraceable.push(rel);
    for (const c of d.candidates) out.candidates.push({ doc: rel, source: c.source, count: c.count, base: c.base, command: diffCommand(c.base, c.source) });
    for (const l of d.lost) out.lost.push({ doc: rel, source: l.source, movedTo: l.movedTo });
  }
  out.detached = st.detached.filter((d) => d.group === g.name && !d.deleted);
  out.deleted = st.detached.filter((d) => d.group === g.name && d.deleted);
  return out;
}

/** 文書群ごとの見直しの材料を作る。戻り値: { groups: [...] }。stale: false なら古くなった候補を調べない（git を呼ばない） */
export function analyze(dest, { source = fsSource(dest), brief = null, stale = true } = {}) {
  const ctx = docsetContext(dest, { source });
  const byGroup = new Map();
  const ensure = (name, b) => {
    if (!byGroup.has(name)) byGroup.set(name, { name, title: b?.title || name, paths: b?.paths || [], brief: b, rels: [] });
    return byGroup.get(name);
  };
  for (const b of ctx.briefs) ensure(b.name, b);
  for (const rel of [...ctx.docs].sort()) {
    const g = groupOf(ctx, rel);
    ensure(g.name, g.brief).rels.push(rel);
  }
  // 古くなった候補は、--brief で絞った文書群の文書だけで計算する
  const picked = (g) => !brief || g.name === brief || g.title === brief;
  const staleResult = stale ? staleAnalysis(ctx, { docs: new Set([...byGroup.values()].filter(picked).flatMap((g) => g.rels)) }) : null;
  // 入ってくるリンクの数（入口からのものも数える）
  const inbound = new Map();
  for (const s of [...ctx.docs, ...ctx.entries]) {
    const targets = isDoc(s) ? ctx.links(s).resolved : ctx.read(s) === null ? [] : mentionedDocs(ctx.read(s), ctx.docs);
    for (const t of new Set(targets)) if (t !== s) inbound.set(t, (inbound.get(t) || 0) + 1);
  }
  const groups = [];
  for (const g of byGroup.values()) {
    if (brief && g.name !== brief && g.title !== brief) continue;
    const loose = isLoose(g.name);
    const entries = g.brief ? entriesOf(g.brief) : [];
    const docs = g.rels.map((rel) => {
      const text = ctx.read(rel) || "";
      const o = outlineOf(text, isHtmlPath(rel));
      return {
        rel,
        docType: detectDocType(text),
        title: o.headings[0] || "",
        out: ctx.links(rel).resolved.filter((r) => r !== rel && ctx.docs.has(r)).length,
        in: inbound.get(rel) || 0,
      };
    });
    const out = { name: g.name, title: g.title, paths: g.paths, entries, entryMissing: entries.filter((e) => !ctx.all.has(e)), docs };
    // 孤立: 入口が決まっている文書群だけ。default のような文書群には出さない（入口も種類のまとまりも無い）
    if (loose || !g.brief) out.orphans = null;
    else if (!entries.length) out.orphans = null;
    else {
      const parent = reachFrom(ctx, entries);
      out.orphans = g.rels.filter((r) => !parent.has(r)).map((rel) => ({ rel, reasons: orphanReasons(ctx, rel) }));
    }
    const dup = duplicatePairs(ctx, g.rels);
    out.duplicates = dup.top;
    // 種類の偏り
    if (loose) out.types = null;
    else {
      const counts = {};
      for (const d of docs) counts[d.docType || "（マーカー無し）"] = (counts[d.docType || "（マーカー無し）"] || 0) + 1;
      out.types = { counts, noDiataxis: DIATAXIS.filter((t) => !counts[t]) };
    }
    out.broken = g.rels.flatMap((rel) => ctx.links(rel).broken);
    // 廃止の候補: 孤立の候補で、出力する重複の上位の組にも出る文書（重複の相手の文書も添える）
    out.abolish = (out.orphans || [])
      .map((o) => ({
        rel: o.rel,
        partners: dup.top.filter((p) => p.a === o.rel || p.b === o.rel).map((p) => (p.a === o.rel ? p.b : p.a)),
      }))
      .filter((a) => a.partners.length);
    if (staleResult) out.stale = groupStale(staleResult, g);
    // 対象のアプリの版（ブリーフの節「読者向けの改訂履歴」の項目）。決まっているかだけを見る。書き方は機械では検査しない
    // 読者向けの改訂履歴が「なし」の文書群には、版を添える先が無いので出さない
    if (!loose && g.brief && !String(g.brief.group["読者向けの改訂履歴"]?.["読者向けの改訂履歴"]?.value || "").startsWith("なし"))
      out.appVersion = g.brief.group["読者向けの改訂履歴"]?.["対象のアプリの版"]?.value || null;
    groups.push(out);
  }
  // 入口のファイルから出るリンクの切れも、入口を持つ文書群に数える
  for (const g of groups) {
    for (const e of g.entries) if (isDoc(e)) for (const b of ctx.links(e).broken) if (!g.broken.some((x) => x.source === b.source && x.line === b.line && x.target === b.target)) g.broken.push(b);
  }
  return { groups };
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

/** 7つ目の項目（古くなった候補）。detail なら、追随できない文書の一覧まで出す */
function staleLines(g, detail) {
  const out = ["### 7. 古くなった候補（確かめたソースが、確かめた後に変わった文書）"];
  const s = g.stale;
  if (!s) return out.concat("（調べていない）");
  if (s.state !== "ok") return out.concat("git が無い（または git の管理下でない）ので、判定できない。ファイルの更新時刻はコピーやチェックアウトで変わるため、根拠にしない");
  if (s.noPlace.length && s.noPlace.length === g.docs.length) {
    out.push(`記録の置き場所が無い（この文書群にはブリーフが当たらず、内部の改訂記録が書けない）ので、追随できない: ${s.noPlace.length} 本`);
    if (detail) for (const r of s.noPlace) out.push(`- ${r}`);
    return out;
  }
  if (s.noPlace.length) {
    out.push(`記録の置き場所が無い（ブリーフが当たらない）文書: ${s.noPlace.length} 本${detail ? "" : "（--stale で一覧）"}`);
    if (detail) for (const r of s.noPlace) out.push(`- ${r}`);
  }
  if (!s.candidates.length) out.push("なし");
  else {
    out.push("", "| 文書 | 変わったソース | 基準点からのコミット | 差分を見るコマンド |", "|---|---|---|---|");
    for (const c of s.candidates) out.push(`| ${c.doc} | ${c.source} | ${c.count} | ${c.command} |`);
  }
  if (s.lost.length) {
    out.push("", "確かめたソースが追跡されていない・消えた（直すか、移した先で確かめ直すかは、人が決める）:");
    for (const l of s.lost) out.push(`- ${l.doc}: ${l.source}${l.movedTo ? `（移した先の候補: ${l.movedTo}）` : ""}`);
  }
  if (s.detached.length) {
    out.push("", "記録と対応が切れた文書（記録の対象の文書に、今は無いパスがある。移したなら、新しいパスで1節を足す。消したなら、対応は要らない）:");
    for (const d of s.detached) out.push(`- ${d.key}（節「${d.heading}」）`);
  }
  if (s.deleted.length) out.push("", `削除済みの文書（git の履歴で削除と分かる。記録だけが残っている。対応は要らない）: ${s.deleted.length} 本${detail ? "" : "（--stale で一覧）"}`);
  if (detail) for (const d of s.deleted) out.push(`- ${d.key}（節「${d.heading}」）`);
  out.push("", `追随できない文書（確かめたソースの記録が無い）: ${s.untraceable.length} 本${detail || !s.untraceable.length ? "" : "（--stale で一覧）"}`);
  if (detail) for (const r of s.untraceable) out.push(`- ${r}`);
  return out;
}

export function renderText(result) {
  const out = [];
  const say = (s = "") => out.push(s);
  for (const g of result.groups) {
    say(`## 文書群: ${g.name}${g.title && g.title !== g.name ? `（${g.title}）` : ""} — ${g.docs.length} 本`);
    say(g.entries.length ? `入口: ${g.entries.join(", ")}${g.entryMissing.length ? `（無いファイル: ${g.entryMissing.join(", ")}）` : ""}` : "入口: 決まっていない（ブリーフの節「入口」に書く）");
    say();
    say("### 1. 文書の一覧");
    if (!g.docs.length) say("（文書なし）");
    else {
      say("| 文書 | doc-type | 最初の見出し | 出る | 入る |");
      say("|---|---|---|---|---|");
      for (const d of g.docs) say(`| ${d.rel} | ${d.docType || "-"} | ${d.title.replace(/\|/g, "\\|") || "-"} | ${d.out} | ${d.in} |`);
    }
    say();
    say("### 2. 入口から辿れない文書（孤立の候補）");
    if (g.orphans === null) say(isLoose(g.name) ? "（この文書群には出さない）" : "入口が決まっていないので、見ていない");
    else if (!g.orphans.length) say("なし");
    else for (const o of g.orphans) say(`- ${o.rel}\n    - ${o.reasons.join("\n    - ")}`);
    say();
    say("### 3. 重複の候補（上位の組。矛盾しているかは人が読んで決める）");
    if (!g.duplicates.length) say("なし");
    else
      for (const p of g.duplicates)
        say(`- ${p.a} と ${p.b}: 同じ見出し ${p.headings.length}${p.headings.length ? `（${p.headings.slice(0, 3).join(" / ")}${p.headings.length > 3 ? " ほか" : ""}）` : ""}・同じコードの行が続く箇所 ${p.codeRuns}`);
    say();
    say("### 4. 種類の偏り");
    if (g.types === null) say("（この文書群には出さない）");
    else {
      say(Object.entries(g.types.counts).map(([k, v]) => `${k} ${v}`).join("・") || "文書なし");
      say(`Diátaxis の4種のうち、この文書群に無い種類: ${g.types.noDiataxis.join("・") || "なし"}（欠けかどうかは読者の目的による。機械では決めない）`);
    }
    say();
    say("### 5. リンク切れ");
    if (!g.broken.length) say("なし");
    else for (const b of g.broken) say(`- ${b.source}:${b.line} ${b.target}（${b.kind === "file" ? "行き先が無い" : "アンカーが無い"}）`);
    say();
    say("### 6. 廃止の候補（孤立の候補で、上の重複の候補にも出る。決めるのは人）");
    say(g.abolish.length ? g.abolish.map((a) => `- ${a.rel}（重複の相手: ${a.partners.join("・")}）`).join(NL) : "なし");
    say();
    if (g.stale) {
      for (const l of staleLines(g, false)) say(l);
      say();
    }
    if (g.appVersion === null) {
      say("対象のアプリの版: 決まっていない（ブリーフの節「読者向けの改訂履歴」の項目「対象のアプリの版」。書かないなら「書かない」と決めておく）");
      say();
    }
  }
  return out.join(NL) + NL;
}

/** --stale: 7つ目の項目だけを、文書群ごとに詳しく出す */
export function renderStale(result) {
  const out = [];
  for (const g of result.groups) {
    out.push(`## 文書群: ${g.name}${g.title && g.title !== g.name ? `（${g.title}）` : ""} — ${g.docs.length} 本`, "");
    out.push(...staleLines(g, true), "");
  }
  return out.join(NL) + NL;
}

export function renderReach(r) {
  const head = `${r.rel}（文書群: ${r.group}）`;
  switch (r.state) {
    case "no-group":
      return `${head}: 文書群のブリーフが無い・default なので、入口から辿れるかは見ない`;
    case "no-entry":
      return `${head}: 入口が決まっていない（ブリーフの節「入口」に書く）`;
    case "not-doc":
      return `${head}: 検査対象の文書ではない`;
    case "entry":
      return `${head}: 入口のファイル`;
    case "reachable":
      return `${head}: 入口から辿れる（${r.via.join(" → ")}）`;
    default:
      return `${head}: 入口（${r.entries.join(", ")}）から辿れない\n  - ${r.reasons.join("\n  - ")}`;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let dest = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let brief = null;
  let reach = null;
  let json = false;
  let staleOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dest") dest = args[++i];
    else if (a === "--brief") brief = args[++i];
    else if (a === "--reach") reach = args[++i];
    else if (a === "--json") json = true;
    else if (a === "--stale") staleOnly = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: node docset.mjs [--dest <project-dir>] [--brief <名前>] [--stale] [--json]\n       node docset.mjs --reach <文書> [--dest <project-dir>] [--json]" + NL);
      process.exit(0);
    } else {
      process.stderr.write(`不明な引数: ${a}` + NL);
      process.exit(2);
    }
  }
  dest = path.resolve(dest);
  if (reach !== null) {
    if (!reach) {
      process.stderr.write("--reach には文書のパスを渡す" + NL);
      process.exit(2);
    }
    const rel = path.posix.normalize(toPosix(path.isAbsolute(reach) ? path.relative(dest, reach) : reach));
    const r = reachOf(docsetContext(dest), rel);
    process.stdout.write((json ? JSON.stringify(r, null, 2) : renderReach(r)) + NL);
    return;
  }
  const result = analyze(dest, { brief });
  if (brief && !result.groups.length) {
    process.stderr.write(`文書群「${brief}」が無い` + NL);
    process.exit(2);
  }
  process.stdout.write(json ? JSON.stringify(result, (k, v) => (k === "brief" ? undefined : v), 2) + NL : staleOnly ? renderStale(result) : renderText(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
