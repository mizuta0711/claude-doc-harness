#!/usr/bin/env node
/**
 * プラグインに同梱した資料を標準出力に出す。
 *
 *   node show.mjs voices              文体の見本集
 *   node show.mjs visuals             見た目の方向性
 *   node show.mjs profile <名前>      読者プロファイル（beginner / engineer / operator / developer）
 *   node show.mjs reference <名前>    知見のまとめ（structure / writing / japanese / web / accessibility）
 *   node show.mjs claude-section     プロジェクトの CLAUDE.md に置く「文書ルール（harness-doc）」の節の最新版
 *   node show.mjs path <名前>         plan-doc の経路の手順（S / M / L / tone / finish / docset）
 *   node show.mjs plan-template      改訂設計書の雛形
 *   node show.mjs style-readme       docs-style/README.md の最新版（導入済みのプロジェクトと比べるとき）
 *   node show.mjs writer-handoff     本文を別のエージェントに書かせるときに渡す全文（manual-writer の規則を抜き出して足す）
 *   node show.mjs path questions     依頼者への問いの出し方（推奨を付けない問い・完了前の確認を4問に収める）
 *
 * なぜスクリプトか: プラグインはプロジェクトの外（~/.claude/plugins/ のキャッシュ）に置かれる。
 * Read ツールでそこを読むと、権限の確認が出たり拒否されたりする（非対話の試験で実際に拒否された）。
 * スキルが許可している `node` で出力すれば、利用者に余計な確認を出さずに済む。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

export function resolveDoc(kind, name) {
  if (kind === "claude-section") return path.join(pluginRoot, "scaffold", "CLAUDE.section.md");
  if (kind === "voices") return path.join(here, "voices.md");
  if (kind === "visuals") return path.join(here, "visuals.md");
  if (kind === "plan-template") return path.join(pluginRoot, "skills", "plan-doc", "TEMPLATE.md");
  if (kind === "style-readme") return path.join(pluginRoot, "scaffold", "docs-style", "README.md");
  if (kind === "path") {
    if (!/^[a-z0-9_-]+$/i.test(name || "")) return null;
    return path.join(pluginRoot, "skills", "plan-doc", "paths", `${name}.md`);
  }
  if (kind === "profile" || kind === "reference") {
    if (!/^[a-z0-9_-]+$/i.test(name || "")) return null;
    const dir = kind === "profile" ? "profiles" : "references";
    return path.join(pluginRoot, "skills", "manual-writer", dir, `${name}.md`);
  }
  return null;
}

/**
 * Markdown の見出しの節を抜き出す（見出しの行から、同じか上のレベルの次の見出しの前まで）。無ければ null
 */
export function extractSection(text, heading) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  const level = (heading.match(/^#+/) || [""])[0].length;
  let j = i + 1;
  let fence = false;
  for (; j < lines.length; j++) {
    if (/^(```|~~~)/.test(lines[j])) fence = !fence;
    const m = !fence && lines[j].match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
  }
  return lines.slice(i, j).join("\n").trim();
}

/**
 * 書き手への引き渡し（manual-writer の handoff.md）に、manual-writer の SKILL.md から事実の確認・書き方の規則・
 * 書かないこと・自己点検の節を抜き出して足す。正は SKILL.md の1か所のまま、1回の出力で完結させる
 * （書き手のサブエージェントは、プロジェクトの外にあるプラグインのファイルを Read できないことがある）
 */
export function writerHandoff() {
  const mw = path.join(pluginRoot, "skills", "manual-writer");
  const skill = fs.readFileSync(path.join(mw, "SKILL.md"), "utf-8");
  const parts = [fs.readFileSync(path.join(mw, "handoff.md"), "utf-8").replace(/<プラグイン>/g, toPosix(pluginRoot)).trim()];
  const show = `node "${toPosix(path.join(here, "show.mjs"))}"`;
  parts.push(`## 参照の読み方\n\n\`\`\`bash\n${["structure", "writing", "japanese", "accessibility", "web"].map((n) => `${show} reference ${n}`).join("\n")}\n\`\`\``);
  for (const [h, title] of [
    ["## Step 2: 事実を確認する", "## 事実の確認（manual-writer の Step 2）"],
    ["### 書き方の規則", "## 書き方の規則（manual-writer の Step 4）"],
    ["### 図と画面", "## 図と画面（manual-writer の Step 4）"],
    ["### 書かないこと", "## 書かないこと（manual-writer の Step 4）"],
    ["## Step 5: 自己点検する", "## 自己点検（manual-writer の Step 5）"],
  ]) {
    const sec = extractSection(skill, h);
    if (!sec) throw new Error(`manual-writer の SKILL.md に「${h}」の節が無い`);
    parts.push(`${title}\n\n${sec.split("\n").slice(1).join("\n").trim()}`);
  }
  return parts.join("\n\n") + "\n";
}

const toPosix = (p) => String(p).replace(/\\/g, "/");

function main() {
  const [kind, name] = process.argv.slice(2);
  if (kind === "writer-handoff") {
    process.stdout.write(writerHandoff());
    return;
  }
  const file = resolveDoc(kind, name);
  if (!file || !fs.existsSync(file)) {
    const list = (d) =>
      fs
        .readdirSync(path.join(pluginRoot, "skills", "manual-writer", d))
        .map((f) => f.replace(/\.md$/, ""))
        .join("|");
    process.stderr.write(
      `usage: node show.mjs voices | visuals | claude-section | plan-template | style-readme | writer-handoff | path <S|M|L|tone|finish|docset|questions> | profile <${list("profiles")}> | reference <${list("references")}>\n`
    );
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, "utf-8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
