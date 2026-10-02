#!/usr/bin/env node
/**
 * プラグインに同梱した資料を標準出力に出す。
 *
 *   node show.mjs voices              文体の見本集
 *   node show.mjs visuals             見た目の方向性
 *   node show.mjs profile <名前>      読者プロファイル（beginner / operator / developer）
 *   node show.mjs reference <名前>    知見のまとめ（structure / writing / japanese / web / accessibility）
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
  if (kind === "voices") return path.join(here, "voices.md");
  if (kind === "visuals") return path.join(here, "visuals.md");
  if (kind === "profile" || kind === "reference") {
    if (!/^[a-z0-9_-]+$/i.test(name || "")) return null;
    const dir = kind === "profile" ? "profiles" : "references";
    return path.join(pluginRoot, "skills", "manual-writer", dir, `${name}.md`);
  }
  return null;
}

function main() {
  const [kind, name] = process.argv.slice(2);
  const file = resolveDoc(kind, name);
  if (!file || !fs.existsSync(file)) {
    const list = (d) =>
      fs
        .readdirSync(path.join(pluginRoot, "skills", "manual-writer", d))
        .map((f) => f.replace(/\.md$/, ""))
        .join("|");
    process.stderr.write(`usage: node show.mjs voices | visuals | profile <${list("profiles")}> | reference <${list("references")}>\n`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, "utf-8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
