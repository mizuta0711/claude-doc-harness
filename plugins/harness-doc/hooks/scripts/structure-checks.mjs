/**
 * 構造とアクセシビリティの検査（check-docs から呼ぶ）。
 *
 * - 画像の代替テキスト（WCAG 2.2 1.1.1）
 * - 見出しレベルの飛び（h2 の次に h4）。WCAG の達成基準では不適合ではなく、W3C G141 とデジタル庁ガイドブックの推奨
 * - 行き先の分からないリンク文言（WCAG 2.2 2.4.4。「こちら」「ここ」だけのリンク）
 * - html 要素の lang（WCAG 2.2 3.1.1）
 *
 * config.rules の imageAlt / headingSkip / linkText / htmlLang を false にすると個別に止められる。
 * 依存パッケージは使わない。
 */

/** 行き先を表さないリンク文言。前後の空白を除いた完全一致で判定する（「こちらの手順」は止めない） */
export const VAGUE_LINK_TEXTS = [
  "こちら", "ここ", "これ", "ここをクリック", "こちらをクリック", "詳しくはこちら", "詳細はこちら", "リンク",
  "click here", "here", "link", "more", "read more",
];

export function isVagueLinkText(t) {
  const x = String(t).replace(/\s+/g, " ").trim().toLowerCase();
  return VAGUE_LINK_TEXTS.includes(x);
}

/** 見出しレベルの飛び。最初の見出しはどのレベルでもよい。レベルを上げる（h4 の次に h2）のは問題ない */
export function headingSkipIssues(levels) {
  const issues = [];
  let prev = null;
  for (const h of levels) {
    if (prev !== null && h.level > prev + 1) {
      issues.push({
        line: h.line,
        kind: "heading-skip",
        message: `見出しのレベルが飛んでいる（h${prev} の次が h${h.level}）: 間のレベルを入れるか、レベルを上げる（W3C G141 の推奨。止めたくなければ config の rules.headingSkip を false に）`,
      });
    }
    prev = h.level;
  }
  return issues;
}

const ruleOn = (config, name) => config?.rules?.[name] !== false;
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const vagueMessage = (txt) =>
  `リンクの文言「${txt}」だけでは行き先が分からない: 行き先を表す語にする（例: 「設定の手順」）`;

/**
 * HTML の構造検査。
 * @param {string} body  コメント・script・style・template を同じ長さの空白に置き換えた本文（行番号を保つ）
 * @param {string[]} rawLines  元の行（ignore マーカーの判定に使う）
 * @param {(s:string)=>string} decodeEntities
 * @param {(line:string)=>boolean} lineIgnored
 */
export function checkHtmlStructure(body, rawLines, config, decodeEntities, lineIgnored) {
  const issues = [];
  const ignored = (ln) => lineIgnored(rawLines[ln - 1] || "");

  if (ruleOn(config, "imageAlt")) {
    const imgRe = /<img\b([^>]*)>/gi;
    let m;
    while ((m = imgRe.exec(body)) !== null) {
      if (/\balt\s*=/i.test(m[1])) continue; // alt="" は飾りの画像として認める
      const ln = lineOf(body, m.index);
      if (!ignored(ln)) {
        issues.push({ line: ln, kind: "alt", message: '画像に alt が無い: 内容を説明する文を書く（飾りの画像なら alt=""）' });
      }
    }
  }

  if (ruleOn(config, "headingSkip")) {
    const levels = [];
    const hRe = /<h([1-6])\b/gi;
    let m;
    while ((m = hRe.exec(body)) !== null) levels.push({ level: Number(m[1]), line: lineOf(body, m.index) });
    issues.push(...headingSkipIssues(levels).filter((i) => !ignored(i.line)));
  }

  if (ruleOn(config, "linkText")) {
    const aRe = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
    let m;
    while ((m = aRe.exec(body)) !== null) {
      const txt = decodeEntities(m[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      const ln = lineOf(body, m.index);
      if (isVagueLinkText(txt) && !ignored(ln)) issues.push({ line: ln, kind: "link-text", message: vagueMessage(txt) });
    }
  }

  if (ruleOn(config, "htmlLang")) {
    const m = /<html\b([^>]*)>/i.exec(body);
    if (m && !/\blang\s*=/i.test(m[1])) {
      issues.push({ line: lineOf(body, m.index), kind: "lang", message: 'html 要素に lang が無い: lang="ja" を付ける（読み上げの言語が決まらない）' });
    }
  }

  return issues;
}

/**
 * Markdown の構造検査。
 * @param {Array<{no:number,text:string}>} prose  コードブロックの外の行
 * @param {(s:string)=>string} stripInlineCode
 * @param {(line:string)=>boolean} lineIgnored
 */
export function checkMarkdownStructure(prose, config, stripInlineCode, lineIgnored) {
  const issues = [];

  if (ruleOn(config, "headingSkip")) {
    const levels = [];
    for (const l of prose) {
      const m = /^\s{0,3}(#{1,6})\s+\S/.exec(l.text);
      if (m && !lineIgnored(l.text)) levels.push({ level: m[1].length, line: l.no });
    }
    issues.push(...headingSkipIssues(levels));
  }

  for (const l of prose) {
    if (lineIgnored(l.text)) continue;
    const t = stripInlineCode(l.text);

    if (ruleOn(config, "imageAlt")) {
      const imgRe = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
      let m;
      while ((m = imgRe.exec(t)) !== null) {
        if (!m[1].trim()) {
          issues.push({ line: l.no, kind: "alt", message: `画像に代替テキストが無い（${m[2]}）: ![内容を説明する文](...) と書く` });
        }
      }
    }

    if (ruleOn(config, "linkText")) {
      const linkRe = /(^|[^!])\[([^\]]+)\]\([^)]+\)/g;
      let m;
      while ((m = linkRe.exec(t)) !== null) {
        if (isVagueLinkText(m[2])) issues.push({ line: l.no, kind: "link-text", message: vagueMessage(m[2].trim()) });
      }
    }
  }

  return issues;
}
