#!/usr/bin/env node
/**
 * ブリーフ（文書群ごとの決め事）を読み書きする。
 *
 *   node brief.mjs show <文書のパス> [--dest <project-dir>]      その文書に当たるブリーフを出す
 *   node brief.mjs missing <文書のパス> [--dest <project-dir>]   欠けている項目と「仮定」の項目を出す
 *   node brief.mjs list [--dest <project-dir>]                   ブリーフの一覧（名前・文書群・paths）
 *
 * 書き込みは setup-project の apply.mjs --brief から行う（このファイルの writeBrief を使う）。
 *
 * ブリーフは `.claude/rules/doc-brief-<名前>.md` に置く「パス指定ルール」である。
 * frontmatter の `paths` に当たる文書に Claude Code が触れると、ランタイムが中身を読み込む（読者役のサブエージェントにも届く）。
 * ただし `Write` で新規作成したときは読み込まれない（2026-10-04 に対話・非対話の両方で確かめた）ので、
 * スキルは書く前にこのスクリプトで引く。
 *
 * なぜスクリプトか: `.claude/` 配下は Claude Code が書き込みに確認を求める場所で、スキルは Read / Edit しない。
 * 形式（見出しの名前・表の列）をここで1か所に固定し、スキルの側で形式を覚えなくて済むようにする。
 *
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp, toPosix } from "../hooks/scripts/check-docs.mjs";

const NL = "\n";
export const RULES_DIR = ".claude/rules";
export const BRIEF_PREFIX = "doc-brief-";
export const MARKER = "<!-- harness-doc: brief 1 -->";
export const DEFAULT_NAME = "default";

/** 表の見出し（4列）。値の表はすべてこの形 */
const KV_HEADER = ["項目", "値", "状態", "由来"];

/** 文書群の節（見出しの名前で探す。番号に頼らない） */
export const GROUP_SECTIONS = {
  読者: ["プロファイル", "読者像", "読む状況"],
  事実の承認者: ["承認者"],
  読者向けの改訂履歴: ["読者向けの改訂履歴"],
};
/** 文書ごとの決め事の項目 */
export const DOC_ITEMS = ["ゴール", "文書の種類", "受け入れ基準", "扱わないこと", "読者向けの改訂履歴"];

/** 欠けていれば聞く項目。文書ごとの「扱わないこと」「読者向けの改訂履歴」は文書群の既定を上書きするときだけ書くので、欠けても聞かない */
const REQUIRED_GROUP = [
  ["読者", "プロファイル"],
  ["読者", "読者像"],
  ["事実の承認者", "承認者"],
  ["読者向けの改訂履歴", "読者向けの改訂履歴"],
];
// 受け入れ基準は、読者役が判定に使うようになる版（改善計画の P2a）から必須にする。それまでは任意
const REQUIRED_DOC = ["ゴール", "文書の種類"];

// ---------------------------------------------------------------------------
// 読む
// ---------------------------------------------------------------------------

function splitRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  // 値の中の `|` は `\|` で書く（cell()）。エスケープした `|` では区切らない
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseTable(lines) {
  const rows = [];
  let header = null;
  for (const l of lines) {
    if (!/^\s*\|/.test(l)) continue;
    const cells = splitRow(l);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    rows.push(cells);
  }
  return { header, rows };
}

function kvFromTable(lines) {
  const { rows } = parseTable(lines);
  const out = {};
  for (const [key, value = "", status = "", origin = ""] of rows) {
    if (key) out[key] = { value, status, origin };
  }
  return out;
}

/** frontmatter の paths を読む（`paths:` の下の `- "..."` だけを見る簡易な読み取り） */
const unquote = (v) => v.trim().replace(/^["']|["']$/g, "").trim();

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { paths: [], body: text, hasFrontmatter: false };
  const paths = [];
  let inPaths = false;
  for (const line of m[1].split(/\r?\n/)) {
    const head = line.match(/^paths\s*:\s*(.*)$/);
    if (head) {
      const rest = head[1].trim();
      if (rest.startsWith("[")) {
        // paths: ["a", "b"]
        paths.push(...rest.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean));
        inPaths = false;
      } else if (rest) {
        // paths: "a"
        paths.push(unquote(rest));
        inPaths = false;
      } else {
        inPaths = true;
      }
      continue;
    }
    // 字下げあり・なしの両方の `- "a"` を読む
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (inPaths && item) paths.push(unquote(item[1]));
    else if (/^\S/.test(line)) inPaths = false;
  }
  return { paths: paths.filter(Boolean), body: text.slice(m[0].length), hasFrontmatter: true };
}

/**
 * ブリーフのファイルを読んで、形を持ったものにする。
 * 戻り値: { name, title, paths, group: { 節: { 項目: {value,status,origin} } }, outOfScope: [{value, origin}],
 *          styleDiff, docs: { 相対パス: { 項目: {...} } } }
 */
export function parseBrief(text, name = "") {
  const { paths, body } = parseFrontmatter(String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
  const lines = body.split("\n");
  const title = (lines.find((l) => /^#\s+/.test(l)) || "").replace(/^#\s+(文書群:\s*)?/, "").trim();
  // unreadable: このスクリプトの形で読めなかったもの。書き戻すと消えるので、writeBrief はこれがあれば書かない
  const brief = { name, title, paths, group: {}, outOfScope: [], styleDiff: "", docs: {}, unreadable: [] };
  const KNOWN = new Set([...Object.keys(GROUP_SECTIONS), "扱わないこと", "文体の差分", "文書ごとの決め事"]);
  const PLACEHOLDER = /^（.*）$/;
  const strayText = (buf) => buf.filter((l) => l.trim() && !/^\s*\|/.test(l) && !PLACEHOLDER.test(l.trim()));
  let section = null;
  let docKey = null;
  let buf = [];
  const flush = () => {
    if (!section) {
      buf = []; // 最初の節より前（題名・前書き）は読まない
      return;
    }
    if (!KNOWN.has(section)) {
      brief.unreadable.push(`知らない節「${section}」`);
      buf = [];
      return;
    }
    if (section !== "文体の差分" && strayText(buf).length) {
      brief.unreadable.push(`「${section}${docKey ? ` / ${docKey}` : ""}」の表でない本文: ${strayText(buf)[0].trim()}`);
    }
    if (section === "文書ごとの決め事") {
      if (docKey) brief.docs[docKey] = kvFromTable(buf);
    } else if (section === "扱わないこと") {
      brief.outOfScope = parseTable(buf)
        .rows.filter((r) => r[0])
        .map(([value, origin = ""]) => ({ value, origin }));
    } else if (section === "文体の差分") {
      brief.styleDiff = buf.join("\n").trim();
    } else if (GROUP_SECTIONS[section]) {
      brief.group[section] = kvFromTable(buf);
    }
    buf = [];
  };
  for (const l of lines) {
    const h2 = l.match(/^##\s+(.+?)\s*$/);
    const h3 = l.match(/^###\s+(.+?)\s*$/);
    if (h2) {
      flush();
      section = h2[1];
      docKey = null;
      continue;
    }
    if (h3 && section === "文書ごとの決め事") {
      flush();
      docKey = h3[1];
      continue;
    }
    buf.push(l);
  }
  flush();
  return brief;
}

// ---------------------------------------------------------------------------
// 書く
// ---------------------------------------------------------------------------

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function kvTable(map, keys) {
  const out = [`| ${KV_HEADER.join(" | ")} |`, "|---|---|---|---|"];
  const ordered = [...keys.filter((k) => map[k]), ...Object.keys(map).filter((k) => !keys.includes(k))];
  for (const k of ordered) {
    const v = map[k];
    out.push(`| ${cell(k)} | ${cell(v.value)} | ${cell(v.status)} | ${cell(v.origin)} |`);
  }
  return out.join(NL);
}

/** 形を持ったブリーフを、ファイルの文字列にする */
export function renderBrief(brief) {
  const out = [];
  out.push("---", "paths:", ...brief.paths.map((p) => `  - "${p}"`), "---", "");
  out.push(`# 文書群: ${brief.title}`, MARKER, "");
  out.push(
    "このファイルは harness-doc が読み書きする（`apply.mjs --brief`）。手で直すときは、見出しの名前と表の列を崩さない。",
    "この文書群の文書を書く人・点検する人は、ここに書いた決め事に沿う。**書き手の意図や作業の状態はここに書かない**（点検する人にも届くため）。",
    ""
  );
  for (const [section, keys] of Object.entries(GROUP_SECTIONS)) {
    out.push(`## ${section}`, "");
    const map = brief.group[section] || {};
    out.push(Object.keys(map).length ? kvTable(map, keys) : "（まだ決めていない）", "");
  }
  out.push("## 扱わないこと", "");
  if (brief.outOfScope.length) {
    out.push("| 項目 | 由来 |", "|---|---|", ...brief.outOfScope.map((o) => `| ${cell(o.value)} | ${cell(o.origin)} |`));
  } else {
    out.push("（まだ決めていない）");
  }
  out.push("", "## 文体の差分", "", brief.styleDiff || "voice.md と同じ。", "");
  out.push("## 文書ごとの決め事", "");
  const docKeys = Object.keys(brief.docs).sort();
  if (!docKeys.length) out.push("（まだ無い。見出しは `paths` の基点からの相対パスにする）", "");
  for (const k of docKeys) {
    out.push(`### ${k}`, "", kvTable(brief.docs[k], DOC_ITEMS), "");
  }
  return out.join(NL);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 値を { value, status, origin } にする。文字列なら、書き手が置いた値は「仮定」、依頼者が決めた値は「確定」 */
function entry(v, by, date) {
  const origin = `${date} ${by}`;
  const writer = by.startsWith("書き手");
  if (v && typeof v === "object") return { value: v.value ?? "", status: v.status || (writer ? "仮定" : "確定"), origin };
  return { value: String(v), status: writer ? "仮定" : "確定", origin };
}

/**
 * ブリーフに値を書き込む（無ければ作る）。
 * input: {
 *   name, title?, paths?,           作るときは title と paths が要る
 *   by: "依頼者" | "書き手",          由来に書く。書き手が置いた値は既定で「仮定」
 *   note?: 文字列                    由来に添える補足（例: "change-policy。前は シニア本人"）
 *   set?: { 読者?: {プロファイル?, 読者像?, 読む状況?}, 事実の承認者?: {承認者?}, 読者向けの改訂履歴?: {読者向けの改訂履歴?},
 *           文書ごとの決め事?: { 相対パス: { ゴール?, 文書の種類?, 受け入れ基準?, 扱わないこと?, 読者向けの改訂履歴? } } },
 *   outOfScope?: [文字列]            足す（同じ文言は足さない）
 *   removeOutOfScope?: [文字列]      外す（文言が完全に一致するものだけ。無ければエラー）
 *   styleDiff?: 文字列               置き換える
 * }
 * 値は文字列か { value, status }。
 */
export function writeBrief(dest, input, date = today()) {
  if (!input || !/^[a-z0-9][a-z0-9-]*$/i.test(input.name || "")) throw new Error("name は英数字とハイフンで指定する（ファイル名 doc-brief-<name>.md になる）");
  const by = (input.by === "書き手" ? "書き手" : "依頼者") + (input.note ? `（${input.note}）` : "");
  const file = path.join(dest, RULES_DIR, `${BRIEF_PREFIX}${input.name}.md`);
  let brief;
  if (input.paths && input.paths.some((g) => /[{}]/.test(g)))
    throw new Error("paths に { } を使わない（check-docs と brief.mjs が解釈しない）。パターンを分けて並べる");
  if (fs.existsSync(file)) {
    brief = parseBrief(fs.readFileSync(file, "utf-8"), input.name);
    if (brief.unreadable.length)
      throw new Error(
        `手で直した部分がこのスクリプトの形で読めないので、書き戻すと消える。書き込まずに止める: ${brief.unreadable.join(" / ")}（${file}）`
      );
    if (input.title) brief.title = input.title;
    if (input.paths) brief.paths = input.paths;
    if (!brief.paths.length) throw new Error(`paths が読めない。paths を渡すか、frontmatter を直す（paths の無いルールは常に読み込まれる）: ${file}`);
  } else {
    if (!input.title || !Array.isArray(input.paths) || !input.paths.length)
      throw new Error(`ブリーフが無いので作る。title と paths が要る: ${file}`);
    brief = { name: input.name, title: input.title, paths: input.paths, group: {}, outOfScope: [], styleDiff: "", docs: {} };
  }
  const set = input.set || {};
  for (const [section, items] of Object.entries(set)) {
    if (section === "文書ごとの決め事") {
      for (const [docKey, docItems] of Object.entries(items || {})) {
        const unknown = Object.keys(docItems).filter((k) => !DOC_ITEMS.includes(k));
        if (unknown.length) throw new Error(`文書ごとの決め事に無い項目: ${unknown.join(", ")}`);
        brief.docs[docKey] = brief.docs[docKey] || {};
        for (const [k, v] of Object.entries(docItems)) brief.docs[docKey][k] = entry(v, by, date);
      }
      continue;
    }
    if (!GROUP_SECTIONS[section]) throw new Error(`知らない節: ${section}`);
    const unknown = Object.keys(items).filter((k) => !GROUP_SECTIONS[section].includes(k));
    if (unknown.length) throw new Error(`${section} に無い項目: ${unknown.join(", ")}`);
    brief.group[section] = brief.group[section] || {};
    for (const [k, v] of Object.entries(items)) brief.group[section][k] = entry(v, by, date);
  }
  for (const v of input.outOfScope || []) {
    if (v === "なし" && brief.outOfScope.some((o) => o.value !== "なし")) continue; // 項目があるのに「なし」は足さない
    if (v !== "なし") brief.outOfScope = brief.outOfScope.filter((o) => o.value !== "なし"); // 項目を足したら「なし」を外す
    if (!brief.outOfScope.some((o) => o.value === v)) brief.outOfScope.push({ value: v, origin: `${date} ${by}` });
  }
  for (const v of input.removeOutOfScope || []) {
    const before = brief.outOfScope.length;
    brief.outOfScope = brief.outOfScope.filter((o) => o.value !== v);
    if (brief.outOfScope.length === before) throw new Error(`扱わないことに無い: ${v}（文言を完全に一致させる）`);
  }
  if (typeof input.styleDiff === "string") brief.styleDiff = input.styleDiff;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderBrief(brief));
  const warnings = overlapWarnings(loadBriefs(dest), brief);
  return { file, brief, warnings };
}

/**
 * ほかのブリーフと paths が重なっていそうなら警告する（書いた時点で気づけるように）。
 * 厳密な判定ではない。互いの paths の基点に、相手のパターンが当たるかを見る。
 * default が他の文書群と重なると、Claude Code は両方を読み込む（読者が二重に届く）ので、これも警告する。
 */
export function overlapWarnings(briefs, target) {
  const out = [];
  const probe = (g) => globBase(g) + "__probe__.md";
  for (const other of briefs) {
    if (other.name === target.name) continue;
    for (const p of target.paths) {
      for (const q of other.paths) {
        if (globToRegExp(q).test(probe(p)) || globToRegExp(p).test(probe(q)) || p === q) {
          out.push(`paths「${p}」が、ブリーフ「${other.name}」の「${q}」と重なっているかもしれない`);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 引く
// ---------------------------------------------------------------------------

/** プロジェクトのブリーフをすべて読む */
export function loadBriefs(dest) {
  const dir = path.join(dest, RULES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(BRIEF_PREFIX) && f.endsWith(".md"))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const name = f.slice(BRIEF_PREFIX.length, -3);
      return { file, ...parseBrief(fs.readFileSync(file, "utf-8"), name) };
    });
}

/** glob の静的な部分（最初の * ? [ { より前のフォルダー）。文書ごとの決め事の見出しは、ここからの相対パスにする */
export function globBase(glob) {
  const g = toPosix(glob);
  const i = g.search(/[*?[{]/);
  const head = i < 0 ? g : g.slice(0, i);
  return head.includes("/") ? head.slice(0, head.lastIndexOf("/") + 1) : "";
}

/**
 * 文書のパス（プロジェクトルートからの相対）に当たるブリーフを探す。
 * 戻り値: { status: "ok" | "none" | "conflict", brief?, docKey?, candidates? }
 * - default 以外のブリーフが2つ以上当たれば conflict（どちらが正かを機械で決めない）
 * - どれにも当たらなければ default（doc-brief-default.md）の paths を見る。それにも当たらなければ none
 *
 * default も paths を持つ（どの文書群にも入らない文書、たとえば README.md を列挙する）。
 * paths の無いルールはセッションの開始時に常に読み込まれ、`**` にするとコードに触れたときにも読み込まれるため。
 */
export function resolveBrief(briefs, relPath) {
  const rel = toPosix(relPath).replace(/^\.\//, "");
  const match = (b) => b.paths.find((g) => globToRegExp(g).test(rel));
  const hits = [];
  for (const b of briefs) {
    if (b.name === DEFAULT_NAME) continue;
    const glob = match(b);
    if (glob) hits.push({ brief: b, glob });
  }
  if (hits.length > 1) return { status: "conflict", candidates: hits.map((h) => h.brief) };
  let hit = hits[0];
  if (!hit) {
    const def = briefs.find((b) => b.name === DEFAULT_NAME);
    const glob = def && match(def);
    if (!glob) return { status: "none" };
    hit = { brief: def, glob };
  }
  const base = globBase(hit.glob);
  const docKey = base && rel.startsWith(base) ? rel.slice(base.length) : rel;
  return { status: "ok", brief: hit.brief, docKey };
}

/** 欠けている項目と「仮定」の項目 */
export function missingItems(brief, docKey) {
  const missing = [];
  const assumed = [];
  for (const [section, key] of REQUIRED_GROUP) {
    const v = brief.group[section]?.[key];
    if (!v || !v.value) missing.push(`${section} / ${key}`);
  }
  for (const [section, items] of Object.entries(brief.group)) {
    for (const [key, v] of Object.entries(items)) {
      if (v.value && v.status === "仮定") assumed.push(`${section} / ${key}: ${v.value}`);
    }
  }
  if (!brief.outOfScope.length) missing.push("扱わないこと（無ければ「なし」と書く）");
  const doc = brief.docs[docKey] || {};
  for (const key of REQUIRED_DOC) {
    const v = doc[key];
    if (!v || !v.value) missing.push(`文書ごとの決め事（${docKey}） / ${key}`);
    else if (v.status === "仮定") assumed.push(`文書ごとの決め事（${docKey}） / ${key}: ${v.value}`);
  }
  for (const [key, v] of Object.entries(doc)) {
    if (!REQUIRED_DOC.includes(key) && v.status === "仮定") assumed.push(`文書ごとの決め事（${docKey}） / ${key}: ${v.value}`);
  }
  return { missing, assumed };
}

/** show の出力。文書群の節と、その文書の決め事だけを出す（ほかの文書の決め事は出さない） */
export function renderForDoc(brief, docKey) {
  const only = { ...brief, docs: brief.docs[docKey] ? { [docKey]: brief.docs[docKey] } : {} };
  const text = renderBrief(only).replace(/^---[\s\S]*?---\n\n/, "");
  const note = brief.docs[docKey] ? "" : `\n（この文書「${docKey}」の決め事はまだ無い）\n`;
  return text + note;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let dest = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dest") dest = args[++i];
    else rest.push(args[i]);
  }
  dest = path.resolve(dest);
  const [cmd, docPath] = rest;
  const say = (s) => process.stdout.write(s + NL);
  const briefs = loadBriefs(dest);

  if (cmd === "list") {
    if (!briefs.length) return say("ブリーフはまだ無い（.claude/rules/doc-brief-*.md）");
    for (const b of briefs) say(`${b.name}\t${b.title}\t${b.paths.join(", ") || "（paths なし）"}`);
    return;
  }
  if ((cmd !== "show" && cmd !== "missing") || !docPath) {
    process.stderr.write("usage: node brief.mjs show <文書のパス> | missing <文書のパス> | list   [--dest <project-dir>]" + NL);
    process.exit(1);
  }
  const rel = toPosix(path.isAbsolute(docPath) ? path.relative(dest, docPath) : docPath);
  const r = resolveBrief(briefs, rel);
  if (r.status === "conflict") {
    process.stderr.write(
      `ブリーフが2つ以上当たる（どちらが正かを決めて、片方の paths を直す）: ${r.candidates.map((b) => b.name).join(", ")}` + NL
    );
    process.exit(2);
  }
  if (r.status === "none") {
    say(`文書: ${rel}`);
    say("ブリーフ: 無い。読者・扱わないこと・受け入れ基準を依頼者に確かめ、apply.mjs --brief で作る");
    return;
  }
  if (cmd === "show") {
    say(`文書: ${rel}`);
    say(`ブリーフ: ${RULES_DIR}/${BRIEF_PREFIX}${r.brief.name}.md（文書群「${r.brief.title}」・文書ごとの見出し「${r.docKey}」）`);
    say("");
    say(renderForDoc(r.brief, r.docKey));
    return;
  }
  const { missing, assumed } = missingItems(r.brief, r.docKey);
  say(`文書: ${rel}（ブリーフ: ${r.brief.name}・文書ごとの見出し「${r.docKey}」）`);
  say(missing.length ? "欠けている項目（聞く）:" : "欠けている項目: なし");
  for (const m of missing) say(`  - ${m}`);
  say(assumed.length ? "「仮定」の項目（確かめる）:" : "「仮定」の項目: なし");
  for (const a of assumed) say(`  - ${a}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
