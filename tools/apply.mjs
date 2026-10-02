#!/usr/bin/env node
/**
 * テンプレート層（templates/base/）を既存プロジェクトへ適用する。
 *
 *   node tools/apply.mjs --dest <project-dir> [--dry-run]
 *
 * 動作:
 *   - templates/base/ 配下のファイルを dest へコピーする。**既存ファイルは上書きしない**
 *   - CLAUDE.section.md は dest/CLAUDE.md の末尾へ**追記**する（既に「文書ルール（harness-doc）」の
 *     見出しがあれば何もしない）。CLAUDE.md が無ければ新規に作る
 *   - --dry-run なら、何をするかを表示するだけで書き込まない
 *
 * プラグイン本体（skills / agents / hooks）は `claude plugin install harness-doc@doc-harness` で入れる。
 * このスクリプトは、プラグインでは配れないもの（CLAUDE.md の節・docs-style・config）だけを扱う。
 *
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTION_HEADING = "## 文書ルール（harness-doc）";

export function parseArgs(argv) {
  const out = { dest: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i];
    else if (a.startsWith("--dest=")) out.dest = a.slice("--dest=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out;
}

/**
 * 適用計画を作る（純関数に近い。dest の存在確認だけ行う）。
 * 戻り値: [{ action: "copy" | "skip" | "append" | "create", rel, reason? }]
 */
export function plan(templateDir, dest) {
  const items = [];
  for (const rel of walk(templateDir)) {
    const posix = rel.split(path.sep).join("/");
    if (posix === "CLAUDE.section.md") {
      const target = path.join(dest, "CLAUDE.md");
      if (!fs.existsSync(target)) items.push({ action: "create", rel: "CLAUDE.md" });
      else if (fs.readFileSync(target, "utf-8").includes(SECTION_HEADING))
        items.push({ action: "skip", rel: "CLAUDE.md", reason: "文書ルールの節が既にある" });
      else items.push({ action: "append", rel: "CLAUDE.md" });
      continue;
    }
    const target = path.join(dest, rel);
    if (fs.existsSync(target)) items.push({ action: "skip", rel: posix, reason: "既にある（上書きしない）" });
    else items.push({ action: "copy", rel: posix });
  }
  return items;
}

export function apply(templateDir, dest, items) {
  const section = fs.readFileSync(path.join(templateDir, "CLAUDE.section.md"), "utf-8");
  for (const it of items) {
    const target = path.join(dest, it.rel);
    if (it.action === "copy") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(templateDir, it.rel), target);
    } else if (it.action === "create") {
      fs.writeFileSync(target, `# CLAUDE.md\n\n対話は日本語で行うこと。\n\n${section}`);
    } else if (it.action === "append") {
      const cur = fs.readFileSync(target, "utf-8");
      const sep = cur.endsWith("\n") ? "\n" : "\n\n";
      fs.writeFileSync(target, `${cur}${sep}${section}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dest) {
    process.stdout.write("usage: node tools/apply.mjs --dest <project-dir> [--dry-run]\n");
    process.exit(args.help ? 0 : 1);
  }
  const dest = path.resolve(args.dest);
  if (!fs.existsSync(dest)) {
    process.stderr.write(`dest が存在しません: ${dest}\n`);
    process.exit(1);
  }
  const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "base");
  const items = plan(templateDir, dest);
  for (const it of items) {
    const label = { copy: "コピー", skip: "スキップ", append: "追記", create: "新規" }[it.action];
    process.stdout.write(`  ${label.padEnd(5)} ${it.rel}${it.reason ? `  （${it.reason}）` : ""}\n`);
  }
  if (args.dryRun) {
    process.stdout.write("--dry-run のため書き込んでいません\n");
    return;
  }
  apply(templateDir, dest, items);
  process.stdout.write(
    "\n次の手順:\n" +
      "  1. claude plugin marketplace add mizuta0711/claude-doc-harness   （初回だけ）\n" +
      "  2. claude plugin install harness-doc@doc-harness --scope user\n" +
      "  3. Claude Code を再起動する\n" +
      "  4. docs-style/README.md を読む\n"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
