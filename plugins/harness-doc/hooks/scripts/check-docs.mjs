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
 * **フックは直前のコミット（HEAD）の中身と比べ、増えた指摘だけを止める**（0.12.0。前からある指摘は件数だけを
 * additionalContext で伝える）。リンク切れと lint は比べずに毎回止める。前の版を読めなければ全部を止める。
 * 曖昧語・用語集・文末は1行につき同じ語を1件しか出さないので、前からある違反と同じ行に同じ違反を足しても増えない（既知の制限）。
 *
 * 動作原則（dev-harness と同じ fail-open）:
 *   - `.claude/doc-harness.config.json` が無い → 素通り（ハーネス未導入のプロジェクトを止めない）
 *   - 対象が .md / .html でない / include に当たらない / exclude に当たる → 素通り
 *   - `docs-style/` のファイルが無い → その検査だけ飛ばす
 *
 * CLI としても使える（テスト・CI 向け）:
 *   node check-docs.mjs <file.md|file.html> [...]      指定ファイルを検査し、違反があれば終了コード 2（全部の指摘）
 *   node check-docs.mjs --changed <file> [...]        フックと同じく、直前のコミットより増えた指摘だけで判定する
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
  // リファレンスは引くための文書なので「一覧」だけを要る見出しにする。「できること」「前提条件」は手順書の見出しで、
  // リファレンスの冒頭に並ぶと、読者役が手順書の見出しと受け取った（実地検証 IndustrialEmulator）
  reference: ["一覧"],
  spec: ["目的", "用語", "仕様", "制約", "未確認"],
  // チュートリアルは種類として認めるが、見出しは決めない（読者によって形が違う。シニア向けの基本操作と、技術者向けのサンプルの通し）。
  // 推奨の見出しは templates/tutorial.md にある
  tutorial: [],
};

/**
 * 必須見出しを持たない文書の種類。マーカーは書くが、見出しは検査しない
 * （landing: サイトの入口・案内 / history: 読者向けの改訂履歴のページ / explanation: 解説）。
 * これと requiredHeadings のどちらにも無い種類は、書き間違いとして指摘する
 * （実地検証 IndustrialEmulator の G4: 知らない種類を黙って素通りさせ、必須見出しの検査が外れていた）
 */
export const FREE_DOC_TYPES = ["landing", "history", "explanation"];

export const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  styleDir: "docs-style",
  include: ["docs/**/*.md", "docs/**/*.html", "README.md"],
  exclude: ["docs/handoff/**", "CHANGELOG.md"],
  requiredHeadings: DEFAULT_REQUIRED_HEADINGS,
  linters: { markdownlint: true, textlint: true },
  /** プロジェクトが既に持つ用語表（プロジェクトルートからの相対パス）。docs-style/glossary.md に加えて読む */
  glossaryFiles: [],
  /** 内部の改訂記録の置き場所（scripts/history.mjs）。styleDir の下なので検査の対象外 */
  historyDir: "docs-style/history",
  /** 改訂設計書の置き場所（plan-doc が M・L で作る）。完了したら <plansDir>/completed/ に移す。styleDir の下なので検査の対象外 */
  plansDir: "docs-style/plans",
  /** コミット時の検査（hooks/scripts/commit-check.mjs）: "block"（止める）/ "warn"（警告だけ）/ "off"（何もしない） */
  completeCheck: "block",
  /** 読者向けの改訂履歴の節の見出し（scripts/complete-doc.mjs が探す）。既存のサイトが「更新履歴」なら setup-project が合わせる */
  revisionHeadings: ["改訂履歴"],
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

/**
 * 文書の属するプロジェクトのルート。
 * 1. 文書がセッションのプロジェクト（CLAUDE_PROJECT_DIR か作業フォルダー）の中にあり、そこに config があれば、そのプロジェクト
 *    （今までどおり。プロジェクトの中に config の雛形を置いたフォルダー（ハーネス自身の scaffold/）があっても、そちらに切り替えない。
 *    ただしセッションをほかのリポジトリで開いて scaffold/ の下を書くと、2 で雛形の config が見つかり、雛形の規則で検査される）
 * 2. そうでなければ、文書のフォルダーから上へ、config（.claude/doc-harness.config.json）のある最初のフォルダー
 * 3. 見つからなければ、セッションのプロジェクト
 * セッションを別のリポジトリで開いたまま、ほかのプロジェクトの文書を書いたときにも、そのプロジェクトの規則で検査する
 * （実地検証 IndustrialEmulator の G1: 作業フォルダーのプロジェクトしか見ず、フックが1回も走らなかった）
 */
export function findProjectDir(file, fallback = projectDir()) {
  const abs = path.resolve(file);
  const base = path.resolve(fallback);
  const inside = (() => {
    const r = path.relative(base, abs);
    return !!r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
  })();
  if (inside && fs.existsSync(path.join(base, CONFIG_RELATIVE_PATH))) return base;
  let d = path.dirname(abs);
  for (;;) {
    if (fs.existsSync(path.join(d, CONFIG_RELATIVE_PATH))) return d;
    const up = path.dirname(d);
    if (up === d) return base;
    d = up;
  }
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
const EXCEPT_HEADER = /^例外/;
const EXCLUDE_HEADER = /除く/;
const NONE_CELL = /^(—|-|–|なし)?$/;

/** セルを語の並びに分ける（`、` `,` `/`）。`—` `-` `なし` 空は語なし */
function termList(cell) {
  return NONE_CELL.test(cell)
    ? []
    : cell
        .split(/[、,/]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

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
 * - 例外の列（任意）: 見出しが「例外」で始まる列。無ければ、「除く」を含み、推奨・禁止の語を含まない列。
 *   推奨・禁止の列より先に決め、その列を除いてから推奨・禁止の列を探す（「例外（そのまま使う語）」を推奨の列と取り違えない）。
 *   例外に書いた語の一部として禁止表記が現れたら検出しない（`ユーザ` の行に `ユーザビリティ`）。値のバッククォートは外して中身を残す
 * 戻り値: [{ preferred, banned: [...], except?: [...] }]。except は例外の列がある表の行だけに付く。
 * source（読み込み元。指摘のメッセージに出す）は列挙されないプロパティで持つ（deepEqual で比べるテストを壊さない）
 */
export function parseGlossary(text, source = null) {
  const rows = [];
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  let cols = null; // 今の表の { pref, ban, ex }。null なら既定の 0 / 1（例外の列なし）
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
      // 例外の列: 見出しが「例外」で始まる列（「例外（そのまま使う語）」も。「禁止（例外あり）」は始まらないので当たらない）。
      // 無ければ「除く」を含み、推奨・禁止の語を含まない列（「使わない（固有名詞を除く）」は禁止の列）
      const plain = (c) => !PREFERRED_HEADER.test(c) && !BANNED_HEADER.test(c);
      let ex = cells.findIndex((c) => EXCEPT_HEADER.test(c));
      if (ex < 0) ex = cells.findIndex((c) => EXCLUDE_HEADER.test(c) && plain(c));
      const find = (re, skip) => cells.findIndex((c, k) => k !== skip && re.test(c));
      let pref = find(PREFERRED_HEADER, ex);
      let ban = find(BANNED_HEADER, ex);
      if (ex >= 0 && (pref < 0 || ban < 0)) {
        // 例外の列を除くと推奨・禁止がそろわないなら、例外の列は無いものとして読み直す（既存の表を読めなくしない）
        ex = -1;
        pref = find(PREFERRED_HEADER, -1);
        ban = find(BANNED_HEADER, -1);
      }
      cols = pref >= 0 && ban >= 0 ? { pref, ban, ex, width: cells.length } : { skip: true };
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
    const row = { preferred, banned: termList(bannedCell) };
    // 列の数が見出しと違う行（例外の列を足す前の書式で書いた行）は、例外の列を読まない（意味の列を例外と取り違えない）
    if (cols && cols.ex >= 0) row.except = cells.length === cols.width ? termList(String(cells[cols.ex] ?? "").replace(/`/g, "").trim()) : [];
    Object.defineProperty(row, "source", { value: source, enumerable: false });
    rows.push(row);
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
    .filter((rel) => fs.existsSync(path.join(dir, rel)))
    .flatMap((rel) => parseGlossary(fs.readFileSync(path.join(dir, rel), "utf-8"), toPosix(rel)));
  const parsed = glossary === null ? null : parseGlossary(glossary, `${toPosix(config.styleDir || "docs-style")}/glossary.md`);
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
  // 値は ASCII に限らず読む。`手順書` のような値を読み落とすと、マーカーが無い文書として必須見出しの検査が黙って外れる（0.14.0 の査読 R16）
  // `<` `>` は値に含めない（説明文の `<!-- doc-type: <種別> -->` のようなプレースホルダーを値として拾わない）
  const m = head.match(/<!--\s*doc-type:\s*([^\s<>]+?)\s*-->/);
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
/** 行 t の位置 idx から len 文字が、例外の語のどれかの一部として現れているか */
function insideException(t, idx, len, except) {
  for (const e of except || []) {
    let p = t.indexOf(e);
    while (p !== -1 && p <= idx) {
      if (idx + len <= p + e.length) return true;
      p = t.indexOf(e, p + 1);
    }
  }
  return false;
}

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
          if (!isPrefixOfPreferred && !insideException(t, idx, b.length, row.except)) {
            issues.push({
              line: l.no,
              kind: "glossary",
              message: `表記ゆれ「${b}」→「${row.preferred}」（${row.source || "用語集"}）。この語を認めるなら、その表の「例外」の列に足す（列が無ければ足す）`,
            });
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
  const table = config.requiredHeadings || DEFAULT_REQUIRED_HEADINGS;
  if (!Object.hasOwn(table, docType) && !FREE_DOC_TYPES.includes(docType)) {
    const known = [...Object.keys(table), ...FREE_DOC_TYPES];
    return [
      {
        line: null,
        kind: "heading",
        message: `知らない文書の種類「${docType}」: ${known.join("・")} のどれかを書いてください（新しい種類は config の requiredHeadings に足す）`,
      },
    ];
  }
  const required = table[docType];
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
  return withTarget({ line: lineNo, kind: "link", message: `リンク切れ: ${target}` }, resolved);
}

/** リンクの指摘に行き先のファイル（絶対パス）を持たせる。列挙されないプロパティにして、指摘の比べ方とテストを変えない */
function withTarget(issue, resolved) {
  Object.defineProperty(issue, "target", { value: resolved, enumerable: false });
  return issue;
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
  let resolvedFile = null;
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
    resolvedFile = resolved;
    const isHtml = isHtmlPath(resolved);
    if (!isHtml && !/\.md$/i.test(resolved)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null; // ファイルの有無はリンク切れの検査が見る
    if (!anchorCache.has(resolved)) anchorCache.set(resolved, anchorsOf(fs.readFileSync(resolved, "utf-8"), isHtml));
    anchors = anchorCache.get(resolved);
  }
  if (anchors.has(frag) || anchors.has(frag.toLowerCase())) return null;
  return withTarget(
    {
      line: lineNo,
      kind: "link",
      message: `アンカー切れ: ${target}（行き先に「#${frag}」に当たる見出しや id が無い。見出しの文言を変えていないか確かめる。描画の作り方が GitHub と違うなら config の rules.anchors を false に）`,
    },
    resolvedFile
  );
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function isHtmlPath(p) {
  return /\.html?$/i.test(String(p));
}

/** 試作のファイル（<元の名前>.proto-N.<拡張子>。plan-doc の L・テイスト変更が作り、承認の後に消す） */
export function isProto(p) {
  return /\.proto-\d+\.[^./\\]+$/i.test(String(p));
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
  if (isProto(absPath)) return null; // 試作のファイル（plan-doc の L・テイスト変更）。承認の後に消すので検査しない
  const rel = toPosix(path.relative(dir, absPath));
  if (rel.startsWith("../") || path.isAbsolute(rel)) return null;
  const styleRel = toPosix(config.styleDir || "docs-style") + "/";
  if (rel.startsWith(styleRel)) return null;
  // 内部の改訂記録と改訂設計書は、styleDir の外に置いても読者向けの文書ではない
  for (const d of [config.historyDir, config.plansDir]) if (d && rel.startsWith(toPosix(d).replace(/\/$/, "") + "/")) return null;
  if (rel.startsWith(".claude/")) return null; // ブリーフ（.claude/rules/doc-brief-*.md）や設定は文書ではない
  if (!matchesAny(rel, config.include)) return null;
  if (matchesAny(rel, config.exclude)) return null;
  if (!fs.existsSync(absPath)) return null;
  const text = fs.readFileSync(absPath, "utf-8");
  const issues = checkDocument(text, { filePath: absPath, config, style });
  if (!html) issues.push(...runLinters(dir, absPath, config)); // markdownlint / textlint は Markdown だけ
  return { rel, issues };
}

// ---------------------------------------------------------------------------
// 前からある指摘（直前のコミットの中身と比べる。DocumentTemplete background/08 の決定）
// ---------------------------------------------------------------------------

/** 比べずに毎回止める指摘。リンク切れは前の版でも今の配置で判定されるので「前からある」になってしまう。lint は前の中身を渡せない */
const ALWAYS_REPORT = new Set(["link", "markdownlint", "textlint"]);

/**
 * 直前のコミット（HEAD）の中身。読めなければ null（git でない・コミットが無い・新しいファイル・リネームの後）。
 * ファイルのフォルダーを起点にし、`./` を付ける（プロジェクトがリポジトリのサブフォルダーにあっても、入れ子のリポジトリでも読める）
 */
export function headText(absPath) {
  const r = spawnSync("git", ["-C", path.dirname(absPath), "show", `HEAD:./${path.basename(absPath)}`], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

/** 指摘を kind と message の組で数える（行番号を含まない） */
export function issueKeys(issues) {
  const m = new Map();
  for (const i of issues) {
    const k = `${i.kind}\u0000${i.message}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/**
 * 今の指摘を、前の版の指摘と比べる。
 * 戻り値: { added: [増えた組の今の指摘（組の行を全部）], groups: [{ message, total, extra }], kept: 前からある件数 }
 * 件数で数えるので、増えた組のどの行が新しいかは決められない。組の行を全部返す
 */
export function diffIssues(now, prevIssues, { always = ALWAYS_REPORT } = {}) {
  const old = issueKeys(prevIssues);
  const nowKeys = issueKeys(now);
  const addedKeys = new Map();
  let kept = 0;
  for (const [k, n] of nowKeys) {
    const kind = k.split("\u0000")[0];
    const extra = always.has(kind) ? n : Math.max(0, n - (old.get(k) || 0));
    if (extra > 0) addedKeys.set(k, { total: n, extra, before: old.get(k) || 0 });
    kept += n - extra;
  }
  const added = now.filter((i) => addedKeys.has(`${i.kind}\u0000${i.message}`));
  const groups = [...addedKeys].map(([k, v]) => ({ kind: k.split("\u0000")[0], message: k.split("\u0000")[1], ...v }));
  return { added, groups, kept };
}

/**
 * フックと `--changed` の判定。result は checkFile の戻り値。
 * 戻り値: { issues: 止める指摘, note: 末尾に添える行, kept: 前からある件数 }
 */
export function changedIssues(absPath, result, config, style) {
  const prev = headText(absPath);
  if (prev === null) return { issues: result.issues, note: "前の版（直前のコミット）を読めなかったので、全部の指摘を出した", kept: 0 };
  const prevIssues = checkDocument(prev, { filePath: absPath, config, style });
  const { added, groups, kept } = diffIssues(result.issues, prevIssues);
  // 比べずに止める指摘（リンク切れ）が前の版にもあったなら、そう添える（範囲の外を直しに行くかを Claude が決められるように）
  const preexisting = new Set(groups.filter((g) => ALWAYS_REPORT.has(g.kind) && g.before > 0).map((g) => `${g.kind}\u0000${g.message}`));
  const issues = added.map((i) =>
    preexisting.has(`${i.kind}\u0000${i.message}`) ? withTarget({ ...i, message: `${i.message}（直前のコミットにもある。リンク切れは前からあっても止める）` }, i.target) : i
  );
  const notes = groups.filter((g) => !ALWAYS_REPORT.has(g.kind) && g.total > g.extra).map((g) => `「${g.message}」は ${g.total} 件のうち ${g.extra} 件が増えた（どれが新しいかは決められないので全部出した）`);
  if (kept) notes.push(`前からある指摘 ${kept} 件は止めていない（直前のコミットにもある。直す依頼のときに直す）`);
  return { issues, note: notes.join("\n  "), kept };
}

/**
 * 作業中の基準点（scripts/complete-doc.mjs --mark が .git/harness-doc/baseline.json に残す）に登録された文書の集合
 * （プロジェクトからの相対パス）。基準点が無い・通過済み・その後にコミットがあれば null（古い基準点で本物のリンク切れを逃さない）
 */
export function plannedDocs(dir) {
  const run = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const gdir = run(["rev-parse", "--git-dir"]);
  const head = run(["rev-parse", "HEAD"]);
  if (!gdir || !head) return null;
  try {
    const b = JSON.parse(fs.readFileSync(path.join(path.resolve(dir, gdir), "harness-doc", "baseline.json"), "utf-8"));
    if (b.passed || !b.files) return null;
    if (b.head !== head) {
      // 基準点の後のコミットが、基準点のファイルに触れていなければ（別の作業のコミット）、基準点は有効のまま（0.14.0 の G7 と同じ判定）
      const count = b.head ? run(["rev-list", "--count", `${b.head}..HEAD`]) : null;
      if (!count || Number(count) === 0) return null;
      const touching = run(["--literal-pathspecs", "log", "--format=%h", `${b.head}..HEAD`, "--", ...Object.keys(b.files)]);
      if (touching === null || touching !== "") return null;
    }
    return new Set(Object.keys(b.files).map((k) => path.posix.normalize(toPosix(k))));
  } catch {
    return null;
  }
}

/**
 * 書きかけの文書へのリンク切れ・アンカー切れを止めない（B1 の評価 #7）。並列で書いている最中は、行き先のページがまだ無いか、
 * 見出しの id がまだ無い。行き先が作業中の基準点に登録された文書（自分自身は除く）なら外し、件数を返す。最終の確認は完了処理の検査
 */
export function deferPlanned(issues, dir, self = null) {
  const planned = issues.some((i) => i.kind === "link" && i.target) ? plannedDocs(dir) : null;
  if (!planned) return { issues, deferred: 0 };
  const own = self ? path.resolve(self) : null;
  const keep = issues.filter(
    (i) => !(i.kind === "link" && i.target && path.resolve(i.target) !== own && planned.has(toPosix(path.relative(dir, i.target))))
  );
  return { issues: keep, deferred: issues.length - keep.length };
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function mainHook() {
  const payload = readPayload();
  if (!payload) process.exit(0);
  const filePath = payload?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(payload.cwd || projectDir(), filePath);
  const dir = findProjectDir(abs);
  const { status, config } = loadConfig(dir);
  if (status !== "ok") process.exit(0);

  const style = loadStyle(dir, config);
  const result = checkFile(abs, dir, config, style);
  if (!result || result.issues.length === 0) process.exit(0);

  const changed = changedIssues(abs, result, config, style);
  const { issues, deferred } = deferPlanned(changed.issues, dir, abs);
  const deferNote = deferred ? `作業中の文書（作業前の基準点に登録された、書きかけの文書）へのリンク切れ・アンカー切れ ${deferred} 件は止めていない（完了処理の検査で見る）` : "";
  if (!issues.length) {
    // 前からある指摘・書きかけの文書へのリンクだけ: 止めずに Claude に伝える（PostToolUse の additionalContext）
    const parts = [];
    if (changed.kept) parts.push(`前からある指摘 ${changed.kept} 件（直前のコミットにもある。直す依頼のときに直す。今は直さなくてよい）`);
    if (deferNote) parts.push(deferNote);
    const msg = `[check-docs] ${result.rel}: ${parts.join("。")}`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } }) + "\n");
    process.exit(0);
  }
  const note = [changed.note, deferNote].filter(Boolean).join("\n  ");
  process.stderr.write(formatIssues(result.rel, issues) + (note ? `\n  ${note}` : "") + "\n");
  process.exit(2);
}

function mainCli(files, { changed = false } = {}) {
  const projects = new Map(); // プロジェクトのルートごとに config と style を1回だけ読む
  const projectOf = (abs) => {
    const dir = findProjectDir(abs);
    if (!projects.has(dir)) {
      const { status, config } = loadConfig(dir);
      const effective = status === "ok" ? config : { ...DEFAULT_CONFIG, include: ["**/*.md", "**/*.html", "**/*.htm"], exclude: [] };
      projects.set(dir, { dir, effective, style: loadStyle(dir, effective) });
    }
    return projects.get(dir);
  };
  let failed = false;
  for (const f of files) {
    const abs = path.resolve(f);
    const { dir, effective, style } = projectOf(abs);
    const result = checkFile(abs, dir, effective, style);
    if (!result) {
      process.stdout.write(`[check-docs] 対象外: ${toPosix(path.relative(dir, abs))}\n`);
      continue;
    }
    let issues = result.issues;
    let note = "";
    if (changed && issues.length) ({ issues, note } = changedIssues(abs, result, effective, style));
    if (issues.length) {
      failed = true;
      process.stderr.write(formatIssues(result.rel, issues) + (note ? `\n  ${note}` : "") + "\n");
    } else {
      process.stdout.write(`[check-docs] OK: ${result.rel}${note ? `（${note}）` : ""}\n`);
    }
  }
  process.exit(failed ? 2 : 0);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const args = process.argv.slice(2);
  const changed = args.includes("--changed");
  const files = args.filter((a) => a !== "--changed");
  if (files.length) mainCli(files, { changed });
  else if (changed) {
    process.stderr.write("usage: node check-docs.mjs [--changed] <file.md|file.html> [...]\n");
    process.exit(2);
  } else mainHook();
}
