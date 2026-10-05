#!/usr/bin/env node
/**
 * 内部の改訂記録（docs-style/history/<文書群の名前>.md）を読み書きする。
 *
 *   node history.mjs show <文書のパス> [--dest <project-dir>] [--limit <n>]   その文書の節を、新しい順に出す
 *   node history.mjs add --json '<JSON>' [--dest <project-dir>]              節を1つ足す（改訂意図が空なら書かない）
 *   node history.mjs add --json-file <path> [--dest <project-dir>]
 *   node history.mjs init <文書群の名前> [--dest <project-dir>]               記録のファイルを雛形から作る（あれば何もしない）
 *
 * 記録は、改訂のたびに「改訂箇所・改訂内容・改訂意図」を残し、次の改訂で読む。
 * 同じ文書群でのこれまでの経緯（なぜそう直したか・何を見送ったか）を踏まえて改訂するためにある。
 *
 * どの記録に書くかは、文書に当たるブリーフ（.claude/rules/doc-brief-<名前>.md）の名前で決める。
 * ブリーフには記録のパスを書かない（ブリーフは読者役にも届き、記録には書き手の意図が入るため）。
 *
 * 置き場所は config の historyDir（既定 docs-style/history）。
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, toPosix } from "../hooks/scripts/check-docs.mjs";
import { loadBriefs, resolveBrief } from "./brief.mjs";

const NL = "\n";
const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE = path.resolve(here, "..", "presets", "history-template.md");
export const DEFAULT_HISTORY_DIR = "docs-style/history";

/** 節の項目（この順に書く） */
export const ITEMS = ["改訂箇所", "改訂内容", "改訂意図", "根拠", "見送ったこと・決めたこと", "依頼のきっかけ", "読者向けの改訂履歴", "変更者・承認者", "改訂設計書"];
const REQUIRED = ["改訂箇所", "改訂内容", "改訂意図", "読者向けの改訂履歴", "変更者・承認者"];

export function historyDir(dest) {
  const { config } = loadConfig(dest);
  return (config && config.historyDir) || DEFAULT_HISTORY_DIR;
}

export function historyFile(dest, name) {
  return path.join(dest, historyDir(dest), `${name}.md`);
}

/** 文書のパス（プロジェクトルートからの相対）から、記録のファイルと、節の見出しに書く文書の名前を決める */
export function locate(dest, relPath) {
  const r = resolveBrief(loadBriefs(dest), relPath);
  if (r.status !== "ok") return r;
  return { status: "ok", brief: r.brief, docKey: r.docKey, file: historyFile(dest, r.brief.name) };
}

/** 雛形から記録のファイルを作る。あれば何もしない */
export function initHistory(dest, name, title) {
  const file = historyFile(dest, name);
  if (fs.existsSync(file)) return { file, created: false };
  const tpl = fs.readFileSync(TEMPLATE, "utf-8").replace("{{文書群の名前}}", title || name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, tpl);
  return { file, created: true };
}

/** 記録を節に分ける。戻り値: [{ heading, body, text }]（ファイルの順 = 新しい順） */
export function parseSections(text) {
  const src = String(text).replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/^##/gm, "#​#"));
  const out = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (cur) out.push(cur);
      cur = { heading: h[1], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => {
    const body = s.lines.join("\n").trim();
    const items = {};
    for (const l of body.split("\n")) {
      const m = l.match(/^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
      if (m && m[1] !== "項目" && !/^-+$/.test(m[1])) items[m[1]] = m[2];
    }
    return { heading: s.heading, body, items, text: `## ${s.heading}\n\n${body}` };
  });
}

/** その文書に触れた節か（見出しか改訂箇所に、文書の名前が出てくる） */
export function mentions(section, docKey) {
  // 「対象の文書」の行（add が必ず書く）と完全に一致するものだけ。見出しの部分一致だと iphone.html が phone.html に当たる
  const targets = (section.items["対象の文書"] || "").split(/[、,]\s*/).map((t) => t.trim());
  return targets.includes(docKey);
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 節の文字列を作る */
export function renderSection(input, date = today()) {
  const docs = Array.isArray(input.docs) ? input.docs : [input.doc];
  const label = input.label || (docs.length > 1 ? `${docs[0]} ほか${docs.length - 1}本` : docs[0]);
  const meta = [input.version ? `版 ${input.version}` : null, input.size ? `規模 ${input.size}` : null].filter(Boolean).join("・");
  const out = [`## ${input.date || date} ${label}${meta ? `（${meta}）` : ""}`, "", "| 項目 | 内容 |", "|---|---|"];
  out.push(`| 対象の文書 | ${cell(docs.join("、"))} |`); // show が文書ごとに引くための行（見出しには1本しか出ないことがある）
  for (const k of ITEMS) {
    const v = input[k];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    out.push(`| ${k} | ${cell(v)} |`);
  }
  return out.join(NL);
}

/**
 * 節を1つ足す。必須の項目（改訂箇所・改訂内容・改訂意図・読者向けの改訂履歴・変更者・承認者）が空なら書かない。
 * input: { doc: "<文書のパス>" | docs: [...], 改訂箇所, 改訂内容, 改訂意図, 根拠?, ..., version?, size?, label?, date? }
 * 記録のファイルが無ければ、ブリーフの文書群の名前で雛形から作る。
 */
export function addSection(dest, input, date = today()) {
  const docs = Array.isArray(input.docs) ? input.docs : input.doc ? [input.doc] : [];
  if (!docs.length) throw new Error("doc（文書のパス）か docs（文書のパスの配列）を渡す");
  const empty = REQUIRED.filter((k) => !input[k] || !String(input[k]).trim());
  if (empty.length) throw new Error(`空の項目があるので書かない: ${empty.join("・")}（改訂意図は空にしない。誤字の修正なら「誤字の修正」）`);
  const located = docs.map((d) => ({ d, ...locate(dest, toPosix(path.isAbsolute(d) ? path.relative(dest, d) : d)) }));
  const bad = located.filter((l) => l.status !== "ok");
  if (bad.length) throw new Error(`ブリーフが当たらない（または2つ当たる）文書がある: ${bad.map((b) => b.d).join(", ")}。先にブリーフを決める`);
  const names = [...new Set(located.map((l) => l.brief.name))];
  if (names.length > 1) throw new Error(`文書群をまたいでいる（${names.join(", ")}）。文書群ごとに分けて足す`);
  const { file, brief } = located[0];
  if (!fs.existsSync(file)) initHistory(dest, brief.name, brief.title);
  let section = renderSection({ ...input, docs: located.map((l) => l.docKey) }, date);
  const text = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
  // 同じ見出しの節を作らない（同じ日に同じ文書を2回直したとき）。見出しで節を引く人と道具が取り違えないように（P3a-3 の G1）
  const headings = new Set(parseSections(text).map((s) => s.heading));
  const first = section.split(NL)[0].replace(/^##\s+/, "");
  if (headings.has(first)) {
    let k = 2;
    while (headings.has(`${first}（${k}）`)) k++;
    section = section.replace(/^[^\n]*/, () => `## ${first}（${k}）`); // 関数で渡す（見出しの $ を置換の記号と読ませない）
  }
  // 最初の節（コメントの外の「## 」）の前に差し込む。無ければ末尾
  const masked = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const idx = masked.search(/^## /m);
  const next = idx < 0 ? text.replace(/\n*$/, "\n\n") + section + NL : text.slice(0, idx) + section + NL + NL + text.slice(idx);
  fs.writeFileSync(file, next);
  return { file, section };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let dest = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let json = null;
  let limit = Infinity;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dest") dest = args[++i];
    else if (args[i] === "--json") json = args[++i];
    else if (args[i] === "--json-file") json = fs.readFileSync(args[++i], "utf-8");
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else rest.push(args[i]);
  }
  dest = path.resolve(dest);
  const [cmd, arg] = rest;
  const say = (s) => process.stdout.write(s + NL);
  const fail = (s) => {
    process.stderr.write(s + NL);
    process.exit(1);
  };

  if (cmd === "init" && arg) {
    const brief = loadBriefs(dest).find((b) => b.name === arg);
    const { file, created } = initHistory(dest, arg, brief?.title);
    return say(`${created ? "作った" : "既にある"}: ${toPosix(path.relative(dest, file))}`);
  }
  if (cmd === "show" && arg) {
    const rel = toPosix(path.isAbsolute(arg) ? path.relative(dest, arg) : arg);
    const l = locate(dest, rel);
    if (l.status !== "ok") return say(`文書: ${rel}\n記録: ブリーフが当たらないので、記録の置き場所が決まらない`);
    say(`文書: ${rel}（記録: ${toPosix(path.relative(dest, l.file))}・見出しの名前「${l.docKey}」）`);
    if (!fs.existsSync(l.file)) return say("この文書群の記録はまだ無い（初めての改訂）");
    const hits = parseSections(fs.readFileSync(l.file, "utf-8")).filter((s) => mentions(s, l.docKey));
    if (!hits.length) return say("この文書の節はまだ無い（初めての改訂）");
    say(`この文書の節: ${hits.length}（新しい順）\n`);
    for (const s of hits.slice(0, limit)) say(s.text + "\n");
    return;
  }
  if (cmd === "add") {
    if (!json) fail("add には --json か --json-file が要る");
    let input;
    try {
      input = JSON.parse(json);
    } catch (e) {
      fail(`JSON が読めない: ${e.message}`);
    }
    try {
      const { file, section } = addSection(dest, input);
      say(`足した: ${toPosix(path.relative(dest, file))}\n\n${section}`);
    } catch (e) {
      fail(`記録に書けない: ${e.message}`);
    }
    return;
  }
  fail("usage: node history.mjs show <文書のパス> | add --json '<JSON>' | init <文書群の名前>   [--dest <project-dir>]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
