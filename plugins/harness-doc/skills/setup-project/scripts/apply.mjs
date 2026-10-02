#!/usr/bin/env node
/**
 * プロジェクト側に置くファイル（プラグイン内の scaffold/）を導入先へ適用する。
 * setup-project スキルから呼ばれる。人が直接打つことは想定していない。
 *
 *   node apply.mjs [--dest <project-dir>] [--dry-run] [--json]
 *
 * 動作:
 *   - --dest を省略すると CLAUDE_PROJECT_DIR（無ければカレントディレクトリ）を導入先にする
 *   - scaffold/ 配下のファイルを dest へコピーする。**既存ファイルは上書きしない**
 *   - CLAUDE.section.md は dest/CLAUDE.md の末尾へ**追記**する（既に「文書ルール（harness-doc）」の
 *     見出しがあれば何もしない）。CLAUDE.md が無ければ新規に作る
 *   - claude-dev-harness 導入済み（.claude/harness.config.json がある）なら、
 *     harness-core が管理するフォルダを検査対象から外した config を置く
 *   - --dry-run なら、何をするかを表示するだけで書き込まない
 *
 * プラグインはプロジェクトのファイルを自動では置けないため、CLAUDE.md の節・docs-style・config は
 * このスクリプトで置く。原本はプラグインに同梱されている（scaffold/）ので、ネットワークは要らない。
 *
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NL = "\n";
const SECTION_HEADING = "## 文書ルール（harness-doc）";
const CONFIG_REL = ".claude/doc-harness.config.json";

export const SCAFFOLD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scaffold");

/**
 * claude-dev-harness（harness-core）を導入済みのプロジェクトで、検査対象から外すフォルダ。
 * これらは harness-core のスキル（new-feature / update-docs / receive-handoff 等）が書く
 * 開発者向けの記録で、読み手向けの文書ではない。検査すると update-docs のたびに止まる。
 */
export const DEV_HARNESS_EXCLUDE = ["docs/設計書/**", "docs/features/**", "docs/reviews/**", "docs/handoff/**"];

/** harness-core を導入済みか（`.claude/harness.config.json` の有無で判定する） */
export function isDevHarnessProject(dest) {
  return fs.existsSync(path.join(dest, ".claude", "harness.config.json"));
}

/** config の雛形に、dev-harness 併用時の除外を足した文字列を返す */
export function configFor(templateText, devHarness) {
  if (!devHarness) return templateText;
  const json = JSON.parse(templateText);
  json.exclude = [...new Set([...(json.exclude || []), ...DEV_HARNESS_EXCLUDE])];
  json.$comment =
    (json.$comment || "") +
    "。claude-dev-harness 併用のため、harness-core が管理する設計書・機能設計書・レビュー記録・引き継ぎを exclude している";
  return JSON.stringify(json, null, 2) + NL;
}

export function parseArgs(argv) {
  const out = { dest: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i];
    else if (a.startsWith("--dest=")) out.dest = a.slice("--dest=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
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
 * 適用計画を作る（dest の存在確認だけ行う）。
 * 戻り値: [{ action: "copy" | "skip" | "append" | "create", rel, reason? }]
 */
export function plan(templateDir, dest) {
  const items = [];
  const devHarness = isDevHarnessProject(dest);
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
    else if (posix === CONFIG_REL && devHarness)
      items.push({ action: "copy", rel: posix, reason: "dev-harness 併用: 設計書・features・reviews・handoff を検査対象から外す" });
    else items.push({ action: "copy", rel: posix });
  }
  return items;
}

export function apply(templateDir, dest, items) {
  const section = fs.readFileSync(path.join(templateDir, "CLAUDE.section.md"), "utf-8");
  const devHarness = isDevHarnessProject(dest);
  for (const it of items) {
    const target = path.join(dest, it.rel);
    if (it.action === "copy") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (it.rel === CONFIG_REL) {
        const text = fs.readFileSync(path.join(templateDir, it.rel), "utf-8");
        fs.writeFileSync(target, configFor(text, devHarness));
      } else {
        fs.copyFileSync(path.join(templateDir, it.rel), target);
      }
    } else if (it.action === "create") {
      fs.writeFileSync(target, ["# CLAUDE.md", "", "対話は日本語で行うこと。", "", ""].join(NL) + section);
    } else if (it.action === "append") {
      const cur = fs.readFileSync(target, "utf-8");
      const sep = cur.endsWith(NL) ? NL : NL + NL;
      fs.writeFileSync(target, cur + sep + section);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const say = (line) => process.stdout.write(line + NL);
  if (args.help) {
    say("usage: node apply.mjs [--dest <project-dir>] [--dry-run] [--json]");
    process.exit(0);
  }
  const dest = path.resolve(args.dest || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!fs.existsSync(dest)) {
    process.stderr.write(`dest が存在しません: ${dest}` + NL);
    process.exit(1);
  }
  const devHarness = isDevHarnessProject(dest);
  const items = plan(SCAFFOLD_DIR, dest);
  if (!args.dryRun) apply(SCAFFOLD_DIR, dest, items);
  if (args.json) {
    say(JSON.stringify({ dest, dryRun: args.dryRun, devHarness, items }, null, 2));
    return;
  }
  say(`導入先: ${dest}${devHarness ? "（claude-dev-harness 導入済み）" : ""}`);
  for (const it of items) {
    const label = { copy: "コピー", skip: "スキップ", append: "追記", create: "新規" }[it.action];
    say(`  ${label.padEnd(5)} ${it.rel}${it.reason ? `  （${it.reason}）` : ""}`);
  }
  if (args.dryRun) say("--dry-run のため書き込んでいません");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
