#!/usr/bin/env node
/**
 * 実地検証の実行役。写しのプロジェクトで Claude Code のセッションを開き、シナリオの依頼を順に入力し、
 * Claude が依頼者に出す問い（AskUserQuestion）にシナリオの規則で答える。
 *
 *   node run.mjs scenarios/p3b.mjs [--out <ログのフォルダー>] [--from <手順の id>] [--plugin <手元のプラグインのフォルダー>]
 *
 * - 許可を省くモード（依頼者のふだんの運用）で、インストール済みのプラグイン・フック・CLAUDE.md を読み込む
 * - 1つのセッションで続ける（2つ目からは resume）
 * - 問いと答え・フックの承認の求め（ask）と返事・各手順の結果を <out>/qa.jsonl と <out>/run.log に残す
 * - 判定はここではしない。Claude Code のセッションのログ（~/.claude/projects/）を読んで、人か別のセッションが判定する
 *
 * シナリオ（ES モジュール）が書き出すもの:
 *   cwd: 写しのパス
 *   steps: [{ id, prompt }]
 *   answer(question, ctx): 問い1つへの答え。選択肢のラベルか自由入力の文字列。null なら「推奨」を選ぶ
 *       question = { question, header, options: [{label, description}], multiSelect }
 *       ctx = { step, seen }（seen は手順ごとの、規則が数えるための入れ物）
 *   approve(toolName, input, ctx): フックが承認を求めたとき（ask）。true で承認、false で拒否
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const args = process.argv.slice(2);
const scenarioPath = args.find((a) => !a.startsWith("--"));
if (!scenarioPath) {
  process.stderr.write("usage: node run.mjs <シナリオ> [--out <フォルダー>] [--from <手順の id>]\n");
  process.exit(2);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const scenario = await import(pathToFileURL(path.resolve(scenarioPath)).href);
const out = path.resolve(opt("--out") || path.join("out", `${path.basename(scenarioPath, ".mjs")}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
fs.mkdirSync(out, { recursive: true });
const qaFile = path.join(out, "qa.jsonl");
const logFile = path.join(out, "run.log");
const say = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  process.stdout.write(line + "\n");
  fs.appendFileSync(logFile, line + "\n");
};
const record = (o) => fs.appendFileSync(qaFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");

/** 推奨の選択肢（ラベルに「推奨」）。無ければ最初の選択肢 */
const recommended = (q) => (q.options.find((o) => /推奨/.test(o.label)) || q.options[0]).label;

let current = null; // 今の手順
const seen = {};

const canUseTool = async (toolName, input) => {
  const ctx = { step: current, seen: (seen[current] ||= {}) };
  if (toolName === "AskUserQuestion") {
    const answers = {};
    for (const q of input.questions || []) {
      let a = scenario.answer ? scenario.answer(q, ctx) : null;
      if (a === null || a === undefined) a = recommended(q);
      answers[q.question] = a;
      record({ step: current, kind: "question", header: q.header, question: q.question, options: q.options.map((o) => o.label), multiSelect: !!q.multiSelect, answer: a });
      say(`問い（${current}）: ${q.header || ""} ${q.question.slice(0, 80)} → ${a}`);
    }
    return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
  }
  // 許可を省くモードでここに来るのは、フックが承認を求めた（ask）ときだけ
  const ok = scenario.approve ? !!scenario.approve(toolName, input, ctx) : false;
  record({ step: current, kind: "approval", tool: toolName, command: input.command || null, approved: ok });
  say(`承認の求め（${current}）: ${toolName} ${String(input.command || "").slice(0, 100)} → ${ok ? "承認" : "拒否"}`);
  return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "依頼者が拒否した" };
};

let sessionId = opt("--resume");
const from = opt("--from");
const localPlugin = opt("--plugin") ? path.resolve(opt("--plugin")) : null;
let started = !from;
for (const step of scenario.steps) {
  if (!started && step.id !== from) continue;
  started = true;
  current = step.id;
  say(`== ${step.id}: ${step.prompt}`);
  const t0 = Date.now();
  for await (const m of query({
    prompt: step.prompt,
    options: {
      cwd: scenario.cwd,
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project", "local"],
      // --plugin <フォルダー>: push の前の手元のプラグインで確かめる。インストール済みの harness-doc は切る（フックが二重に走らないように）
      ...(localPlugin
        ? { plugins: [{ type: "local", path: localPlugin }], settings: { enabledPlugins: { "harness-doc@doc-harness": false } } }
        : {}),
      canUseTool,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (m.type === "system" && m.subtype === "init" && !sessionId) {
      sessionId = m.session_id;
      say(`セッション: ${sessionId}`);
      // --plugin のときに、インストール済みの版が切れているかを確かめられるように
      say(`プラグイン: ${(m.plugins || []).map((p) => `${p.name}（${p.path}）`).join(" / ") || "なし"}`);
      fs.writeFileSync(path.join(out, "session.txt"), sessionId + "\n");
    }
    if (m.type === "result") {
      record({ step: current, kind: "result", subtype: m.subtype, turns: m.num_turns, costUsd: m.total_cost_usd, result: m.result });
      say(`結果（${current}・${Math.round((Date.now() - t0) / 1000)}秒）: ${String(m.result || m.subtype).slice(0, 300)}`);
    }
  }
}
say(`終わり。ログ: ${out}`);
