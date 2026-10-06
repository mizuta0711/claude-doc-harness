#!/usr/bin/env node
/**
 * 文書群の見直し。文書群（ブリーフ）ごとに、文書の一覧・入口から辿れない文書・重複の候補・種類の偏り・リンク切れ・廃止の候補を出す。
 *
 *   node docset.mjs [--dest <project-dir>] [--brief <名前>] [--json]
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
import { loadBriefs, resolveBrief, entriesOf, DEFAULT_NAME } from "./brief.mjs";

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
// 集計
// ---------------------------------------------------------------------------

/** 文書群ごとの見直しの材料を作る。戻り値: { groups: [...] } */
export function analyze(dest, { source = fsSource(dest), brief = null } = {}) {
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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dest") dest = args[++i];
    else if (a === "--brief") brief = args[++i];
    else if (a === "--reach") reach = args[++i];
    else if (a === "--json") json = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: node docset.mjs [--dest <project-dir>] [--brief <名前>] [--json]\n       node docset.mjs --reach <文書> [--dest <project-dir>] [--json]" + NL);
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
  process.stdout.write(json ? JSON.stringify(result, (k, v) => (k === "brief" ? undefined : v), 2) + NL : renderText(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
