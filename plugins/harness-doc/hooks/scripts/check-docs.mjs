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

/**
 * 用語集の表を読む。列は「推奨表記 | 禁止表記 | 意味」の順。
 * 禁止表記は `、` `,` `/` で複数書ける。`—` `-` 空は「禁止表記なし」。
 * 戻り値: [{ preferred, banned: [...] }]
 */
export function parseGlossary(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t
      .slice(1, t.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue; // 区切り行
    if (/推奨/.test(cells[0]) && /禁止/.test(cells[1])) continue; // 見出し行
    const preferred = stripInlineCode(cells[0]).trim();
    const bannedCell = stripInlineCode(cells[1]).trim();
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
  return {
    styleDir,
    bannedWords: banned === null ? null : parseBannedWords(banned),
    glossary: glossary === null ? null : parseGlossary(glossary),
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

  // 3. 言語指定は HTML では検査しない（Markdown のフェンスに当たる規約が HTML には無い）

  // 5. リンク切れ（href / src の相対パス）
  if (filePath) {
    const baseDir = path.dirname(filePath);
    const linkSource = raw.replace(HTML_COMMENT, blankKeepLength).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blankKeepLength);
    const aRe = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = aRe.exec(linkSource)) !== null) {
      const lineNo = linkSource.slice(0, m.index).split("\n").length;
      if (lineIgnored(rawLines[lineNo - 1] || "")) continue;
      const issue = brokenLinkIssue(decodeEntities((m[1] ?? m[2] ?? "").trim()), baseDir, lineNo);
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
        const issue = brokenLinkIssue(m[1], baseDir, l.no);
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
