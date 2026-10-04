#!/usr/bin/env node
/**
 * 読者役（doc-reviewer）が、内部の改訂記録（docs-style/history/）と改訂設計書（docs-style/plans/）を読むのを止める
 * （PreToolUse・Read / Grep / Glob）。
 *
 * どちらにも書き手の改訂意図と改訂方針が書いてあり、読者役が読むと意図を知って追認になる。
 * doc-reviewer.md の禁止事項だけでは、実地検証で読者役が範囲を超えて読んだ（P3a の F15）ので、機械で止める。
 *
 * フックの入力の agent_type で、doc-reviewer からの呼び出しだけを見る（メインのエージェント・ほかのエージェントは素通り）。
 * - Read: 対象のファイルが記録か設計書の中なら止める
 * - Grep: 探す範囲（path。無ければ作業フォルダー）が記録か設計書の中、またはそれを含むフォルダー（プロジェクトのルートなど）なら止める
 *   （検索結果に記録の中身が出るため。path にソースのフォルダーを指定させる）
 * - Glob: 探す範囲が記録か設計書の中なら止める（ファイル名の一覧は中身を出さないので、ルートからは通す）
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULT_CONFIG } from "./check-docs.mjs";

const TAG = "[harness-doc reviewer-guard]";

const isReviewer = (agentType) => /(^|:)doc-reviewer$/.test(String(agentType || ""));

/** .claude/doc-harness.config.json のある最も近いフォルダー（無ければ start） */
function projectRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, ".claude", "doc-harness.config.json"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** 戻り値: null（通す）か、止める理由 */
export function judge(payload) {
  if (!isReviewer(payload.agent_type)) return null;
  const tool = payload.tool_name;
  if (!["Read", "Grep", "Glob"].includes(tool)) return null;
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = projectRoot(cwd);
  const config = loadConfig(root).config || DEFAULT_CONFIG;
  // 完了処理の基準点（.git/harness-doc/）にも、内部の改訂記録の全文が入っている
  const guarded = [config.historyDir || "docs-style/history", config.plansDir || "docs-style/plans", ".git/harness-doc"].map((d) => path.resolve(root, d));
  const input = payload.tool_input || {};
  if (tool === "Read") {
    const file = path.resolve(cwd, input.file_path || "");
    return guarded.some((g) => inside(file, g)) ? "内部の改訂記録・改訂設計書は読まない（書き手の意図が書いてあり、読むと追認になる）" : null;
  }
  const target = path.resolve(cwd, input.path || ".");
  if (guarded.some((g) => inside(target, g))) return "内部の改訂記録・改訂設計書の中は探さない";
  if (tool === "Grep" && guarded.some((g) => inside(g, target)))
    return `探す範囲（${input.path || "作業フォルダー"}）に内部の改訂記録・改訂設計書が含まれる。path にソースのフォルダー（UI の文字列の定義など）か、文書のフォルダーを指定する`;
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    let reason = null;
    try {
      reason = judge(JSON.parse(data || "{}"));
    } catch {
      reason = null;
    }
    if (reason)
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${TAG} ${reason}` } })
      );
    process.exit(0);
  });
}
