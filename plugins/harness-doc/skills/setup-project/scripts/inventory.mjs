#!/usr/bin/env node
/**
 * プロジェクトの文書の棚卸し。setup-project が「新規か既存か」を判断し、
 * 検査対象（include）・既存の用語表（glossaryFiles）・従う CSS の案を作るために使う。
 * 読み取りだけで、何も書き込まない。
 *
 *   node inventory.mjs [--dest <project-dir>]      JSON を標準出力へ
 *
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 文書の場所として数えないディレクトリ（生成物・依存・VCS・ビルド成果物） */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".vs", ".idea", ".gradle", ".next", ".nuxt",
  "bin", "obj", "build", "dist", "out", "publish", "target", "coverage", "vendor", "Library", "Temp",
]);

/** claude-dev-harness（harness-core）が管理する開発者向けのフォルダ */
const DEV_HARNESS_DIRS = ["docs/設計書", "docs/features", "docs/reviews", "docs/handoff"];

/** 開発者向け・記録用と思われるファイル名（利用者向け文書の候補から外す目安） */
const DEV_DOC_NAME = /^(CHANGELOG|CLAUDE|constitution|CONTRIBUTING|LICENSE|ROADMAP|REQUIREMENTS|DESIGN|BASIC_DESIGN|API_DESIGN|TODO)(\.|_|$)|(設計|要件|仕様書|調査|レビュー|議事|マネタイズ|競合)/i;

const toPosix = (p) => p.split(path.sep).join("/");

function walk(root, rel = "", out = []) {
  let ents;
  try {
    ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
        if (e.name === ".claude") walk(root, r, out); // 用語表を探すため .claude だけは見る
        continue;
      }
      walk(root, r, out);
    } else out.push(toPosix(r));
  }
  return out;
}

export function inventory(dest) {
  const files = walk(dest);
  const devHarness = fs.existsSync(path.join(dest, ".claude", "harness.config.json"));
  const isDoc = (f) => /\.(md|html?)$/i.test(f) && !f.startsWith(".claude/") && !f.startsWith("docs-style/");

  // 文書のあるディレクトリごとに数える
  const byDir = new Map();
  for (const f of files.filter(isDoc)) {
    const dir = path.posix.dirname(f);
    const key = dir === "." ? "(ルート)" : dir;
    const cur = byDir.get(key) || { dir: key, md: 0, html: 0, devLike: 0, samples: [] };
    if (/\.md$/i.test(f)) cur.md++;
    else cur.html++;
    if (DEV_DOC_NAME.test(path.posix.basename(f))) cur.devLike++;
    if (cur.samples.length < 3) cur.samples.push(f);
    byDir.set(key, cur);
  }
  const managedByDevHarness = (d) => DEV_HARNESS_DIRS.some((m) => d === m || d.startsWith(m + "/"));
  const docDirs = [...byDir.values()]
    .map((d) => ({ ...d, managedByDevHarness: devHarness && managedByDevHarness(d.dir) }))
    .sort((a, b) => b.md + b.html - (a.md + a.html));

  // 利用者向けの候補: dev-harness 管理外で、開発文書らしい名前が半分未満のディレクトリ
  const candidates = docDirs.filter(
    (d) => d.dir !== "(ルート)" && !d.managedByDevHarness && d.devLike * 2 < d.md + d.html
  );

  // 既存の用語表
  const termFiles = files.filter(
    (f) => /\.md$/i.test(f) && /(^|\/)(.*(用語|terms?|glossary|表記).*)\.md$/i.test(f) && !f.startsWith("docs-style/")
  );

  // 既存の CSS（サイトの見た目の正）
  const cssFiles = files.filter((f) => /\.css$/i.test(f));

  return {
    dest,
    devHarness,
    hasHarnessDoc: fs.existsSync(path.join(dest, ".claude", "doc-harness.config.json")),
    hasVoice: fs.existsSync(path.join(dest, "docs-style", "voice.md")),
    totalDocs: files.filter(isDoc).length,
    existing: candidates.length > 0,
    docDirs,
    candidates: candidates.map((d) => d.dir),
    termFiles,
    cssFiles,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dest");
  const dest = path.resolve(i >= 0 ? argv[i + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!fs.existsSync(dest)) {
    process.stderr.write(`dest が存在しません: ${dest}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(inventory(dest), null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
