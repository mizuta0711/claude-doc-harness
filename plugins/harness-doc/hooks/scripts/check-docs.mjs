/**
 * PostToolUse フック: 文書（.md / .html）の機械チェック
 *
 * Write / Edit で .md か .html が書かれた直後に走り、次を検査する。
 * HTML は本文のテキスト（タグ・属性・script・style・pre・code を除く）と href / src を見る。
 *   1. 必須見出し（文書種別マーカー `<!-- doc-type: howto -->` がある文書だけ）
 *   2. 曖昧語（`docs-style/banned-words.txt`）
 *   3. コードブロックの言語指定（Markdown だけ）
 *   4. 用語集との表記ゆれ（`docs-style/glossary.md` の禁止表記）
 *   5. リンク切れ（相対パスのリンク先が存在するか）
 *   7. 文末の混在（config.voice.endings を設定したときだけ）
 *   6. markdownlint / textlint（Markdown だけ。プロジェクトに入っていれば実行する）
 *
 * 違反があれば理由を stderr に出して終了コード 2 で終わる。
 * PostToolUse の終了コード 2 は「stderr を Claude に見せる」挙動で、Claude が直す。
 *
 * 動作原則（dev-harness と同じ fail-open）:
 *   - `.claude/doc-harness.config.json` が無い → 素通り（ハーネス未導入のプロジェクトを止めない）
 *   - 対象が .md / .html でない / include に当たらない / exclude に当たる → 素通り
 *   - `docs-style/` のファイルが無い → その検査だけ飛ばす
 *
 * CLI としても使える（テスト・CI 向け）:
 *   node check-docs.mjs <file.md|file.html> [...]      指定ファイルを検査し、違反があれば終了コード 2
 *
 * 依存パッケージは使わない（Node 標準ライブラリのみ）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkHtmlStructure, checkMarkdownStructure } from "./structure-checks.mjs";

export const SCHEMA_VERSION = 1;
const CONFIG_RELATIVE_PATH = path.join(".claude", "doc-harness.config.json");

/** 文書種別ごとの必須見出し（config の requiredHeadings で上書きできる） */
export const DEFAULT_REQUIRED_HEADINGS = {
  howto: ["できること", "前提条件", "手順", "確認", "うまくいかない場合"],
  reference: ["できること", "前提条件", "一覧"],
  spec: ["目的", "用語", "仕様", "制約", "未確認"],
};

export const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  styleDir: "docs-style",
  include: ["docs/**/*.md", "docs/**/*.html", "README.md"],
  exclude: ["docs/handoff/**", "CHANGELOG.md"],
  requiredHeadings: DEFAULT_REQUIRED_HEADINGS,
  linters: { markdownlint: true, textlint: true },
  /** プロジェクトが既に持つ用語表（プロジェクトルートからの相対パス）。docs-style/glossary.md に加えて読む */
  glossaryFiles: [],
  /** 文体。endings: "keitai"（です・ます）/ "jotai"（だ・である）/ null（検査しない） */
  voice: { endings: null },
  /** 構造とアクセシビリティの検査（structure-checks.mjs）。false で個別に止められる */
  rules: { imageAlt: true, headingSkip: true, linkText: true, htmlLang: true, anchors: true },
};

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

export function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/** `**` / `*` / `?` だけを解釈する簡易 glob → RegExp */
export function globToRegExp(glob) {
  let re = "";
  const g = toPosix(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` は 0 階層以上、`**` 単独は何でも
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(relPath, globs) {
  const p = toPosix(relPath);
  return (globs || []).some((g) => globToRegExp(g).test(p));
}

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** stdin の JSON を読む。読めない・壊れている場合は null */
function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

/**
 * config を読む。
 * 戻り値: { status: "ok" | "missing" | "invalid" | "newer", config }
 */
export function loadConfig(dir) {
  const file = path.join(dir, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(file)) return { status: "missing", config: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { status: "invalid", config: null };
  }
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > SCHEMA_VERSION) {
    return { status: "newer", config: null };
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    requiredHeadings: { ...DEFAULT_REQUIRED_HEADINGS, ...(parsed.requiredHeadings || {}) },
    linters: { ...DEFAULT_CONFIG.linters, ...(parsed.linters || {}) },
    voice: { ...DEFAULT_CONFIG.voice, ...(parsed.voice || {}) },
    rules: { ...DEFAULT_CONFIG.rules, ...(parsed.rules || {}) },
  };
  return { status: "ok", config };
}

// ---------------------------------------------------------------------------
// docs-style の読込
// ---------------------------------------------------------------------------

/** 1行1語。空行と `#` 始まりは無視する */
export function parseBannedWords(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const PREFERRED_HEADER = /推奨|使う|✅|正しい/;
const BANNED_HEADER = /禁止|使わない|❌|誤り|避ける/;

function splitRow(t) {
  return t
    .slice(1, t.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((c) => c.trim());
}

/** セルから表記だけを取り出す（インラインコード・強調・✅❌ を外す） */
function cleanTerm(s) {
  return stripInlineCode(s)
    .replace(/\*\*|__/g, "")
    .replace(/[✅❌]/gu, "")
    .trim();
}

/**
 * 用語集の表を読む。**列の並びではなく見出しの語で列を決める。**
 * - 推奨の列: 見出しに「推奨」「使う」「✅」「正しい」を含む列
 * - 禁止の列: 見出しに「禁止」「使わない」「❌」「誤り」「避ける」を含む列
 * 両方の列を持たない表（「役割 | 使う」だけの表など）は読まない。
 * 見出しの無い表は「推奨 | 禁止 | 意味」の順とみなす（0.1.0 からの書式）。
 * 禁止表記は `、` `,` `/` で複数書ける。`—` `-` 空は「禁止表記なし」。
 * プロジェクトが既に持つ用語表（例: `.claude/rules/japanese-terms.md` の「対象 | 使う | 使わない」）もこれで読める。
 * 戻り値: [{ preferred, banned: [...] }]
 */
export function parseGlossary(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  let cols = null; // 今の表の { pref, ban }。null なら既定の 0 / 1
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!t.startsWith("|")) {
      inTable = false;
      cols = null;
      continue;
    }
    const cells = splitRow(t);
    const next = lines[i + 1] || "";
    const isHeader = !inTable && /^\|\s*:?-{2,}/.test(next);
    inTable = true;
    if (isHeader) {
      const pref = cells.findIndex((c) => PREFERRED_HEADER.test(c));
      const ban = cells.findIndex((c) => BANNED_HEADER.test(c));
      cols = pref >= 0 && ban >= 0 ? { pref, ban } : { skip: true };
      i++; // 区切り行を飛ばす
      continue;
    }
    if (cols?.skip) continue;
    const pref = cols ? cols.pref : 0;
    const ban = cols ? cols.ban : 1;
    if (cells.length <= Math.max(pref, ban)) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue;
    const preferred = cleanTerm(cells[pref]);
    const bannedCell = cleanTerm(cells[ban]);
    if (!preferred) continue;
    const banned = /^(—|-|–|なし)?$/.test(bannedCell)
      ? []
      : bannedCell
          .split(/[、,/]/)
          .map((s) => s.trim())
          .filter(Boolean);
    rows.push({ preferred, banned });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 文末（敬体／常体）の混在
// ---------------------------------------------------------------------------

/**
 * voice.endings が "keitai"（です・ます）なら常体の文末を、"jotai"（だ・である）なら敬体の文末を止める。
 * 「」『』の中（画面の文言の引用）は見ない。句点「。」で終わる文だけを見る（体言止め・箇条書きは対象外）。
 */
const ENDING_RULES = {
  // 「た。」は「ました。」「でした。」（敬体の過去形）を除く
  keitai: { re: /(である|のだ|だ|ではない|ない|(?<!まし|でし)た|る)。/, label: "常体", want: "敬体（です・ます）" },
  jotai: { re: /(です|ます|ました|でした|ません|ください|ましょう)。/, label: "敬体", want: "常体（だ・である）" },
};

export function checkEndings(lines, voice) {
  const rule = ENDING_RULES[voice?.endings];
  if (!rule) return [];
  const issues = [];
  for (const l of lines) {
    const t = l.text.replace(/「[^」]*」|『[^』]*』/g, "");
    const m = t.match(rule.re);
    if (m) {
      issues.push({
        line: l.no,
        kind: "voice",
        message: `文末が${rule.label}（「${m[0]}」）: この文書の文体は${rule.want}（docs-style/voice.md）`,
      });
    }
  }
  return issues;
}

function stripInlineCode(s) {
  return s.replace(/`[^`]*`/g, "");
}

export function loadStyle(dir, config) {
  const styleDir = path.join(dir, config.styleDir || "docs-style");
  const read = (name) => {
    const f = path.join(styleDir, name);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null;
  };
  const banned = read("banned-words.txt");
  const glossary = read("glossary.md");
  // プロジェクトが既に持つ用語表（例: .claude/rules/japanese-terms.md）も読む
  const extra = (config.glossaryFiles || [])
    .map((rel) => path.join(dir, rel))
    .filter((f) => fs.existsSync(f))
    .flatMap((f) => parseGlossary(fs.readFileSync(f, "utf-8")));
  const parsed = glossary === null ? null : parseGlossary(glossary);
  return {
    styleDir,
    bannedWords: banned === null ? null : parseBannedWords(banned),
    glossary: parsed === null && !extra.length ? null : [...(parsed || []), ...extra],
  };
}

// ---------------------------------------------------------------------------
// 検査本体
// ---------------------------------------------------------------------------

/**
 * 文書を行ごとに「散文 / コードブロック内」に分類する。
 * 戻り値: { lines: [{ no, text, inCode, fenceOpen, lang }] }
 */
export function tokenizeLines(text) {
  const out = [];
  let fence = null; // { char, len }
  const rows = String(text).split(/\r?\n/);
  rows.forEach((text, i) => {
    const m = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (m) {
      const char = m[1][0];
      const len = m[1].length;
      if (!fence) {
        fence = { char, len };
        out.push({ no: i + 1, text, inCode: true, fenceOpen: true, lang: m[2].trim() });
        return;
      }
      if (fence.char === char && len >= fence.len && m[2].trim() === "") {
        fence = null;
        out.push({ no: i + 1, text, inCode: true, fenceOpen: false, lang: null });
        return;
      }
    }
    out.push({ no: i + 1, text, inCode: !!fence, fenceOpen: false, lang: null });
  });
  return { lines: out };
}

export function detectDocType(text) {
  const head = String(text).split(/\r?\n/).slice(0, 15).join("\n");
  const m = head.match(/<!--\s*doc-type:\s*([a-zA-Z0-9_-]+)\s*-->/);
  return m ? m[1] : null;
}

/** 冒頭15行以内の `<!-- check-docs: skip ... -->`（理由を続けて書いてよい） */
function hasSkipMarker(text) {
  const head = String(text).split(/\r?\n/).slice(0, 15).join("\n");
  return /<!--\s*check-docs:\s*skip\b[^>]*-->/.test(head);
}

/** 行内の `<!-- check-docs: ignore ... -->`（理由を続けて書いてよい） */
function lineIgnored(line) {
  return /<!--\s*check-docs:\s*ignore\b[^>]*-->/.test(line);
}

/**
 * 文書1本を検査する（純関数。ファイル I/O はリンク切れ判定だけ）。
 *
 * @param {string} text            文書の全文
 * @param {object} opts
 * @param {string} opts.filePath   絶対パス（リンク解決と表示に使う）
 * @param {object} opts.config     loadConfig の結果
 * @param {object} opts.style      loadStyle の結果（null なら docs-style 系の検査を飛ばす）
 * @returns {Array<{ line: number|null, kind: string, message: string }>}
 */
export function checkDocument(text, { filePath, config, style, format }) {
  const fmt = format || (filePath && isHtmlPath(filePath) ? "html" : "md");
  if (hasSkipMarker(text)) return [];
  return fmt === "html" ? checkHtml(text, { filePath, config, style }) : checkMarkdown(text, { filePath, config, style });
}

/**
 * 曖昧語と用語集の検査（Markdown・HTML 共通）。
 * @param {Array<{no:number,text:string}>} lines  検査してよい本文だけを残した行
 */
export function checkWords(lines, style) {
  const issues = [];
  const bannedWords = style?.bannedWords || [];
  const glossary = style?.glossary || [];
  for (const l of lines) {
    const t = l.text;
    for (const w of bannedWords) {
      if (t.includes(w)) {
        issues.push({ line: l.no, kind: "banned", message: `曖昧語「${w}」: 条件と値を具体的に書く` });
      }
    }
    for (const row of glossary) {
      for (const b of row.banned) {
        let idx = t.indexOf(b);
        while (idx !== -1) {
          // 禁止表記が推奨表記の先頭部分（例: サーバ / サーバー）なら、その位置は推奨表記として読む
          const isPrefixOfPreferred = row.preferred.startsWith(b) && t.startsWith(row.preferred, idx);
          if (!isPrefixOfPreferred) {
            issues.push({ line: l.no, kind: "glossary", message: `表記ゆれ「${b}」→「${row.preferred}」（用語集）` });
            break;
          }
          idx = t.indexOf(b, idx + b.length);
        }
      }
    }
  }
  return issues;
}

function requiredHeadingIssues(docType, headings, config) {
  if (!docType) return [];
  const required = (config.requiredHeadings || {})[docType];
  if (!Array.isArray(required) || !required.length) return [];
  const missing = required.filter((kw) => !headings.some((h) => h.includes(kw)));
  if (!missing.length) return [];
  return [
    {
      line: null,
      kind: "heading",
      message: `見出し不足（${docType}）: ${missing.map((m) => `「${m}」`).join(" ")}。見出しにこの語を含めてください`,
    },
  ];
}

/** 相対リンク1件を解決し、存在しなければ指摘を返す（Markdown・HTML 共通） */
function brokenLinkIssue(target, baseDir, lineNo) {
  if (!target) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) return null;
  if (/\$\{|\{\{/.test(target)) return null; // テンプレートの埋め込み
  const noAnchor = target.split("#")[0].split("?")[0];
  if (!noAnchor) return null;
  let decoded = noAnchor;
  try {
    decoded = decodeURI(noAnchor);
  } catch {
    /* そのまま */
  }
  const resolved = path.resolve(baseDir, decoded);
  if (fs.existsSync(resolved)) return null;
  return { line: lineNo, kind: "link", message: `リンク切れ: ${target}` };
}

// ---------------------------------------------------------------------------
// アンカー（`#` 以降）
// ---------------------------------------------------------------------------

/**
 * 見出しの文言からアンカーを作る（GitHub と同じ作り方）。
 * 小文字にし、文字・数字・結合文字・連結記号（_）・空白・ハイフン以外を除き、空白をハイフンにする。
 * 静的サイト生成など別の作り方をする描画では合わないことがある。そのときは config の rules.anchors を false にする。
 */
export function slugGithub(text) {
  return String(text)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const HTML_ID_ATTR = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function idsInHtml(text) {
  const ids = new Set();
  const s = String(text).replace(HTML_COMMENT, "");
  let m;
  HTML_ID_ATTR.lastIndex = 0;
  while ((m = HTML_ID_ATTR.exec(s)) !== null) ids.add(m[1] ?? m[2]);
  return ids;
}

/** 文書が持つアンカーの集合。Markdown は見出し（重複は -1, -2 を付ける）と、本文中の HTML の id / name */
export function anchorsOf(text, isHtml) {
  if (isHtml) return idsInHtml(text);
  const ids = idsInHtml(text.replace(/```[\s\S]*?```/g, ""));
  const seen = new Map();
  for (const l of tokenizeLines(text).lines) {
    if (l.inCode) continue;
    const m = l.text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    let heading = m[1];
    const explicit = heading.match(/\s*\{#([^}\s]+)\}\s*$/);
    if (explicit) {
      ids.add(explicit[1]);
      heading = heading.slice(0, explicit.index);
    }
    const base = slugGithub(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.add(n === 0 ? base : `${base}-${n}`);
  }
  return ids;
}

const anchorCache = new Map();

/**
 * リンクの `#` 以降が、行き先の文書に実在するかを見る。
 * 見るのは、この文書から出ていくリンクだけ（同じ文書内の `#...` と、相対パスの .md / .html）。
 * 行き先の見出しを変えたときに、外から入ってくるリンクが切れるのは、このフックでは見つけられない。
 */
function brokenAnchorIssue(target, baseDir, lineNo, self, config) {
  if (config?.rules?.anchors === false) return null;
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  if (/\$\{|\{\{/.test(target)) return null;
  const hash = target.indexOf("#");
  if (hash < 0) return null;
  let frag = target.slice(hash + 1);
  if (!frag || frag === "top") return null;
  try {
    frag = decodeURIComponent(frag);
  } catch {
    /* そのまま */
  }
  const filePart = target.slice(0, hash).split("?")[0];
  let anchors;
  if (!filePart) {
    anchors = anchorsOf(self.text, self.isHtml);
  } else {
    let decoded = filePart;
    try {
      decoded = decodeURI(filePart);
    } catch {
      /* そのまま */
    }
    const resolved = path.resolve(baseDir, decoded);
    const isHtml = isHtmlPath(resolved);
    if (!isHtml && !/\.md$/i.test(resolved)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null; // ファイルの有無はリンク切れの検査が見る
    if (!anchorCache.has(resolved)) anchorCache.set(resolved, anchorsOf(fs.readFileSync(resolved, "utf-8"), isHtml));
    anchors = anchorCache.get(resolved);
  }
  if (anchors.has(frag) || anchors.has(frag.toLowerCase())) return null;
  return {
    line: lineNo,
    kind: "link",
    message: `アンカー切れ: ${target}（行き先に「#${frag}」に当たる見出しや id が無い。見出しの文言を変えていないか確かめる。描画の作り方が GitHub と違うなら config の rules.anchors を false に）`,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function isHtmlPath(p) {
  return /\.html?$/i.test(String(p));
}

/** 改行だけを残して、ほかの文字を消す（行番号を保つ） */
const keepNewlines = (s) => s.replace(/[^\n]/g, "");
/** 改行以外を空白にする（文字位置も保つ） */
const blankKeepLength = (s) => s.replace(/[^\n]/g, " ");

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 本文として読まない要素。中身ごと検査から外す（Markdown のコードブロック・インラインコードに当たる） */
const HTML_NON_PROSE = /<(script|style|pre|code|kbd|samp|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * HTML から本文のテキストだけを行ごとに取り出す。
 * - コメント・script・style・pre・code・kbd・samp・template・svg は中身ごと外す
 * - タグは外す（属性値も検査しない）。タグをまたいだ語（`必要に<b>応じて</b>`）も1語として読めるよう、空白は入れない
 * - 文字実体参照を戻す
 */
export function htmlProseLines(text) {
  const s = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(HTML_COMMENT, keepNewlines)
    .replace(HTML_NON_PROSE, (m) => " " + keepNewlines(m))
    .replace(/<[^>]*>/g, keepNewlines);
  return decodeEntities(s)
    .split("\n")
    .map((t, i) => ({ no: i + 1, text: t }));
}

function checkHtml(text, { filePath, config, style }) {
  const issues = [];
  const raw = String(text).replace(/\r\n?/g, "\n");
  const rawLines = raw.split("\n");

  // 1. 必須見出し（h1〜h6）
  const headings = [];
  const hRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let hm;
  const noComment = raw.replace(HTML_COMMENT, blankKeepLength);
  while ((hm = hRe.exec(noComment)) !== null) {
    headings.push(decodeEntities(hm[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim());
  }
  issues.push(...requiredHeadingIssues(detectDocType(raw), headings, config));

  // 2. 曖昧語 / 4. 用語集
  const prose = htmlProseLines(raw).filter((l) => !lineIgnored(rawLines[l.no - 1] || ""));
  issues.push(...checkWords(prose, style));
  issues.push(...checkEndings(prose, config.voice));

  // 3. 言語指定は HTML では検査しない（Markdown のフェンスに当たる規約が HTML には無い）

  // 8. 構造とアクセシビリティ
  const structureBody = raw
    .replace(HTML_COMMENT, blankKeepLength)
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blankKeepLength);
  issues.push(...checkHtmlStructure(structureBody, rawLines, config, decodeEntities, lineIgnored));

  // 5. リンク切れ（href / src の相対パス）
  if (filePath) {
    const baseDir = path.dirname(filePath);
    const linkSource = raw.replace(HTML_COMMENT, blankKeepLength).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blankKeepLength);
    const aRe = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = aRe.exec(linkSource)) !== null) {
      const lineNo = linkSource.slice(0, m.index).split("\n").length;
      if (lineIgnored(rawLines[lineNo - 1] || "")) continue;
      const target = decodeEntities((m[1] ?? m[2] ?? "").trim());
      // アンカーは <a> と <area> の href だけを見る。SVG の <use href="#icon"> は実行時に差し込む定義への参照で、文書の見出しではない
      const tag = (linkSource.slice(linkSource.lastIndexOf("<", m.index), m.index).match(/^<([a-z0-9-]+)/i) || [])[1];
      const isNavLink = /^(a|area)$/i.test(tag || "") && /^href/i.test(m[0]);
      const issue =
        brokenLinkIssue(target, baseDir, lineNo) ??
        (isNavLink ? brokenAnchorIssue(target, baseDir, lineNo, { text: raw, isHtml: true }, config) : null);
      if (issue) issues.push(issue);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function checkMarkdown(text, { filePath, config, style }) {
  const issues = [];
  const { lines } = tokenizeLines(text);
  const prose = lines.filter((l) => !l.inCode);

  // 1. 必須見出し
  const headings = prose
    .map((l) => l.text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
  issues.push(...requiredHeadingIssues(detectDocType(text), headings, config));

  // 2. 曖昧語 / 4. 用語集
  const proseText = prose
    .filter((l) => !lineIgnored(l.text) && !/^\s*<!--/.test(l.text)) // コメント行
    .map((l) => ({ no: l.no, text: stripInlineCode(l.text) }));
  issues.push(...checkWords(proseText, style));
  issues.push(...checkEndings(proseText, config.voice));

  // 8. 構造とアクセシビリティ
  issues.push(...checkMarkdownStructure(prose, config, stripInlineCode, lineIgnored));

  // 3. コードブロックの言語指定
  for (const l of lines) {
    if (l.fenceOpen && !l.lang) {
      issues.push({ line: l.no, kind: "fence", message: "コードブロックに言語指定がありません（例: ```bash、```text）" });
    }
  }

  // 5. リンク切れ
  if (filePath) {
    const baseDir = path.dirname(filePath);
    const linkRe = /\[[^\]]*\]\(([^)\s<>]+)(?:\s+"[^"]*")?\)/g;
    for (const l of prose) {
      if (lineIgnored(l.text)) continue;
      const t = stripInlineCode(l.text);
      let m;
      while ((m = linkRe.exec(t)) !== null) {
        const issue =
          brokenLinkIssue(m[1], baseDir, l.no) ??
          brokenAnchorIssue(m[1], baseDir, l.no, { text, isHtml: false }, config);
        if (issue) issues.push(issue);
      }
    }
  }

  return issues;
}

/**
 * markdownlint / textlint がプロジェクトに入っていれば実行する。
 * 入っていなければ何もしない（fail-open）。
 */
export function runLinters(dir, filePath, config) {
  const issues = [];
  const binDir = path.join(dir, "node_modules", ".bin");
  const run = (name, args) => {
    const bin = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
    if (!fs.existsSync(bin)) return;
    const r = spawnSync(bin, args, {
      cwd: dir,
      encoding: "utf-8",
      timeout: 20000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (r.error) return;
    if (r.status !== 0) {
      const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
      issues.push({ line: null, kind: name, message: `${name} が失敗しました:\n${out.slice(0, 2000)}` });
    }
  };
  if (config.linters?.markdownlint !== false) run("markdownlint", [filePath]);
  if (config.linters?.textlint !== false) run("textlint", [filePath]);
  return issues;
}

export function formatIssues(relPath, issues) {
  const head = `[check-docs] ${relPath} に ${issues.length} 件の指摘があります。直してから先へ進んでください。`;
  const body = issues.map((i) => `  ${i.line ? `L${String(i.line).padEnd(4)}` : "    "} ${i.message}`);
  return [head, ...body].join("\n");
}

/**
 * ファイル1本を検査して指摘を返す。対象外なら null。
 */
export function checkFile(absPath, dir, config, style) {
  const html = isHtmlPath(absPath);
  if (!html && !/\.md$/i.test(absPath)) return null;
  const rel = toPosix(path.relative(dir, absPath));
  if (rel.startsWith("../") || path.isAbsolute(rel)) return null;
  const styleRel = toPosix(config.styleDir || "docs-style") + "/";
  if (rel.startsWith(styleRel)) return null;
  if (!matchesAny(rel, config.include)) return null;
  if (matchesAny(rel, config.exclude)) return null;
  if (!fs.existsSync(absPath)) return null;
  const text = fs.readFileSync(absPath, "utf-8");
  const issues = checkDocument(text, { filePath: absPath, config, style });
  if (!html) issues.push(...runLinters(dir, absPath, config)); // markdownlint / textlint は Markdown だけ
  return { rel, issues };
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function mainHook() {
  const payload = readPayload();
  if (!payload) process.exit(0);
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const dir = projectDir();
  const { status, config } = loadConfig(dir);
  if (status !== "ok") process.exit(0);

  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(payload.cwd || dir, filePath);
  const style = loadStyle(dir, config);
  const result = checkFile(abs, dir, config, style);
  if (!result || result.issues.length === 0) process.exit(0);

  process.stderr.write(formatIssues(result.rel, result.issues) + "\n");
  process.exit(2);
}

function mainCli(files) {
  const dir = projectDir();
  const { status, config } = loadConfig(dir);
  const effective = status === "ok" ? config : { ...DEFAULT_CONFIG, include: ["**/*.md", "**/*.html", "**/*.htm"], exclude: [] };
  const style = loadStyle(dir, effective);
  let failed = false;
  for (const f of files) {
    const abs = path.resolve(f);
    const result = checkFile(abs, dir, effective, style);
    if (!result) {
      process.stdout.write(`[check-docs] 対象外: ${toPosix(path.relative(dir, abs))}\n`);
      continue;
    }
    if (result.issues.length) {
      failed = true;
      process.stderr.write(formatIssues(result.rel, result.issues) + "\n");
    } else {
      process.stdout.write(`[check-docs] OK: ${result.rel}\n`);
    }
  }
  process.exit(failed ? 2 : 0);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const args = process.argv.slice(2);
  if (args.length) mainCli(args);
  else mainHook();
}
