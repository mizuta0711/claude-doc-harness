#!/usr/bin/env node
/**
 * コミット時の検査（PreToolUse・Bash / PowerShell）。文書を含むコミットで、改訂の記録が無ければ止める。
 *
 * 完了処理の検査（scripts/complete-doc.mjs）は、スキルが完了報告の前に呼ぶ。スキルを通らなかった作業
 * （実地検証 P3a の F1: 続けての依頼で plan-doc が起動しなかった）では呼ばれないので、コミットの時点で止める。
 * 決めたこと（D1〜D4）は DocumentTemplete の background/05。
 *
 * 判定:
 *   1. コマンドの中の `git commit` を、引用符・ヒアドキュメント・コメントの中を除いて探す（git-scope.cjs。
 *      正本は claude-dev-harness の hooks/scripts/git-scope.js。写しなので片方だけ直さない）
 *   2. 対象のリポジトリを、コマンドの中の cd / Set-Location / pushd と `git -C`、フックの入力の cwd から決める
 *   3. git が作るコミットの中身を、一時の index で再現する。同じコマンドの中で commit より前にある
 *      `git add` / `git rm` を当て、`commit -- <paths>` なら HEAD に paths を足した中身、`-a` なら追跡済みの変更を足す。
 *      フックはコマンドの実行前に走るので、そのままの index には今回の add がまだ入っていない
 *   4. その中身で complete-doc の --staged と同じ検査をする（--amend は HEAD~1 と比べる）
 *
 * 結果:
 *   - NG → deny（理由に NG の行）。コミットの文言に `doc-record: skip（理由）` があれば、deny ではなく ask
 *     （依頼者の承認を求める。止められた AI が自分で印を書いて外せないように。D1）。理由が空なら deny
 *   - ブリーフが1つも無いプロジェクト → 警告だけ（D3）
 *   - config の completeCheck: "off" → 何もしない。"warn" → 警告だけ（D4 はハーネス自身のリポジトリを off）
 *   - 改訂設計書（docs-style/plans/*.md）が同じコミットに入っていて、状態が「作業中」で、対象の文書に入っている文書 → 警告だけ
 *   - 再現できない形（commit より前に git mv・作業ツリーを変えるコマンド・コマンド置換のパス）→ deny し、分けるよう返す
 *
 * フックの時間切れは止めずに続行されるので、全体の予算（BUDGET_MS）を超えたら deny する（素通りさせない）。
 * Node 標準ライブラリのみ。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, DEFAULT_CONFIG, isProto, loadStyle } from "./check-docs.mjs";
import { changedDocs, checkDoc, setGitContext, planStates, CHECK_DOCS_NG } from "../../scripts/complete-doc.mjs";
import { loadBriefs } from "../../scripts/brief.mjs";

const require = createRequire(import.meta.url);
const scope = require("./git-scope.cjs");

const BUDGET_MS = 20000;
const TAG = "[harness-doc commit-check]";

// ---------------------------------------------------------------------------
// コマンドの読み取り
// ---------------------------------------------------------------------------

const DIR_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);
/**
 * commit より前にあっても、作業ツリーとコミットの中身を変えないコマンド（git 以外）。
 * git-scope の TREE_SAFE_COMMANDS（書き出されていない）と同じ並びに、シェルの構文（if・export）を足したもの
 */
const SAFE_COMMANDS = new Set([
  "cd", "pushd", "popd", "chdir", "pwd", "ls", "dir", "echo", "printf", "cat", "true", "test", "[", ":",
  "set-location", "sl", "get-location", "get-childitem", "gci", "write-host", "write-output", "start-sleep", "sleep",
  "wc", "head", "tail", "grep", "sort", "uniq", "type", "findstr", "get-content", "gc",
  "out-null", "out-string", "select-object", "select", "where-object", "where", "measure-object",
  "select-string", "sls", "format-table", "ft",
  "push-location", "pop-location", "fi", "done", "export", "set", "local", "false",
]);
/** commit より前にあっても index も作業ツリーも変えない git のサブコマンド（add・rm は一時の index に当てる） */
const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch", "remote", "config", "fetch", "tag"]);

// if・while・until も剥がし、条件の中のコマンド（`if sed -i … ; then git commit`）を判定する（確かめ直し N4）
const stripKeyword = (text) => text.replace(/^(?:(?:then|do|else|elif|if|while|until|time|!)\s+)+/, "");

/** `bash -c "..."` / `pwsh -Command "..."` / `cmd /c "..."` の中身 */
function wrapped(text) {
  const m =
    /^(?:(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-c|-command)|cmd(?:\.exe)?\s+\/c|eval)\s+(["'])([\s\S]*)\1\s*$/i.exec(text);
  return m ? m[2] : null;
}

/**
 * ヒアドキュメント（bash）とヒアストリング（PowerShell）を、印・本文・終わりの行ごと消す（同じ行の残りは残す）。
 * `-m "$(cat <<'EOF' … EOF)"` の本文に `"` が奇数個あると、引用符の走査（git-scope）が反転し、
 * 後ろの `-- <paths>` を見失って記録の無い文書を通していた（0.10.0 の実装の査読 C1。正本の git-scope.js にもある欠陥）。
 * 印だけ残すと、git-scope が終わりの行を探してコマンドの残りを全部読み飛ばすので、印も消す（確かめ直し N1）。
 * 終わりの行は、`<<-` のときだけ行頭のタブを許す（N8）
 */
export function stripHeredocs(text, shell = "bash") {
  let s = String(text);
  if (shell === "powershell") return s.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''");
  let out = "";
  const re = /<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const lineEnd = s.indexOf("\n", re.lastIndex);
    if (lineEnd < 0) break;
    const tag = m[3];
    const lines = s.slice(lineEnd + 1).split("\n");
    let k = 0;
    let found = -1;
    let consumed = lineEnd + 1;
    for (; k < lines.length; k++) {
      const line = m[1] ? lines[k].replace(/^\t+/, "") : lines[k];
      // 終わりの行は TAG だけ（`$(…)` の中なら直後に `)` が続くことがある）
      const t = /^([A-Za-z_][A-Za-z0-9_]*)(\)?.*)$/.exec(line.replace(/\r$/, ""));
      if (t && t[1] === tag) {
        found = k;
        break;
      }
      consumed += lines[k].length + 1;
    }
    if (found < 0) break; // 終わりの行が無い（書きかけ）。そのまま読む
    const termLine = lines[found];
    const after = termLine.replace(/^\t*/, "").slice(tag.length); // `)` などの残り
    // 印を消し、同じ行の残り（`-- docs/a.md`）はそのまま、本文と終わりの行を消す
    out += s.slice(0, m.index) + s.slice(re.lastIndex, lineEnd) + after;
    s = s.slice(consumed + termLine.length);
    re.lastIndex = 0;
  }
  return out + s;
}

/**
 * フォルダーの指定を解決する。Git Bash のパス（`/c/Users/...`）はドライブのパスに読み替える。
 * 変数・`~`・コマンド置換を含むものと、実在しないフォルダーは null（検査の対象を決められない）
 */
export function resolveDir(base, p) {
  const s = String(p || "");
  if (!s || /[$`~%]/.test(s)) return null;
  let t = s;
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(t);
    if (m) t = `${m[1].toUpperCase()}:${m[2] || "/"}`;
  }
  const r = path.resolve(base, t);
  return fs.existsSync(r) ? r : null;
}

/** git の呼び出しの、サブコマンドより前の -C を順に当てたディレクトリ（解決できなければ null） */
function gitDirOf(seg, base, opts) {
  const text = seg.text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const tokens = scope.tokenize(text, opts).map((t) => t.value);
  let dir = base;
  for (let i = 1; i < tokens.length && tokens[i].startsWith("-"); i++) {
    if (tokens[i] === "-C" && tokens[i + 1]) {
      dir = resolveDir(dir, tokens[++i]);
      if (!dir) return null;
    } else if (["-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(tokens[i])) i++;
  }
  return dir;
}

/** 起点を指定しない新しいブランチの作成と切り替え（git switch -c <名前> / git checkout -b <名前>） */
function isNewBranch(g, opts) {
  const t = scope.tokenize(g.args, opts).map((x) => x.value);
  const flag = g.sub === "switch" ? /^(-[cC]|--create|--force-create)$/ : g.sub === "checkout" ? /^-[bB]$/ : null;
  if (!flag) return false;
  // 許す形だけを列挙する（除外を列挙すると、起点の「-」（直前のブランチ）や -f（作業ツリーの変更を捨てる）を見落とした。0.11.1 の査読）
  const harmless = /^(-q|--quiet|--no-track|--no-guess)$/;
  let created = 0;
  const names = [];
  for (const x of t) {
    if (flag.test(x)) created++;
    else if (harmless.test(x)) continue;
    else if (x.startsWith("-")) return false; // -f・--orphan・-t・--・- ほか、許していない引数
    else names.push(x);
  }
  return created === 1 && names.length === 1; // 名前1つだけ（起点があれば中身が変わりうる）
}

/** 断片がファイルへ書き出すリダイレクトを持つか（`/dev/null`・`$null`・`NUL` だけなら持たない） */
function writesFile(text) {
  const unquoted = text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
  const targets = [...unquoted.matchAll(/>>?\s*([^\s&|;<>]+)/g)].map((m) => m[1]);
  return targets.some((t) => !/^(\/dev\/null|\$null|nul)$/i.test(t));
}

/**
 * コマンドを読み、コミットごとに { dir, args, ops: [{sub, args, dir}] } を返す。
 * 再現できない形なら { unsupported: "理由" } を返す
 */
/**
 * 覚えた変数を置き換える。`"$P"` は引用符ごと1語に、引用符なしの `$P` は bash と同じく空白で語に分かれるように、値をそのまま入れる。
 * 単引用符の中（`'$P'`）は bash では展開しないので、単引用符を含む文は置き換えない
 */
export function substituteVars(text, vars) {
  // 単引用符で囲まれた区間はそのまま残し、外側だけを置き換える（`-m 'docs: x' -- $P` の $P は置き換える）
  return text
    .split(/('[^']*')/)
    .map((part) => {
      if (part.startsWith("'") && part.endsWith("'") && part.length >= 2) return part;
      let out = part;
      for (const [name, value] of vars) out = out.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "g"), value);
      return out;
    })
    .join("");
}

export function readCommand(command, { shell = "bash", cwd }) {
  const opts = { shell };
  const text = stripHeredocs(String(command || ""), shell).replace(/\d*>&(?:\d+|-)/g, " ").replace(/&>/g, ">");
  const raw = scope.scanCommands(text, opts);
  // if・for・while・case の中の代入は、どの値が使われるかを順に読んでも決められない。変数を覚えない（置き換えずに、今までどおり読む）
  const controlFlow = raw.some((s) => /^\s*(if|then|else|elif|fi|for|while|until|do|done|case|esac)\b/.test(s.text));
  const segs = raw.map((s) => ({ ...s, text: stripKeyword(s.text) }));
  let dir = cwd;
  // 再現できない形を止めるかは、ここまでに出てきたフォルダーのどれかが文書ハーネスのプロジェクトかで決める（確かめ直し N2）
  const dirs = [cwd];
  const ops = [];
  const commits = [];
  const unsupported = (reason) => ({ unsupported: reason, dirs: [...new Set(dirs.filter(Boolean))] });
  // 文だけの変数の代入（`P="a.md b.md"`）を覚え、後ろの `$P`・`"$P"`・`${P}` を置き換えてから読む（B1 の評価 #12）。
  // 値に引用符・バックスラッシュ・$・`・(・;・& を含むものは覚えない（置き換えると区切りが崩れる）。bash だけ
  const vars = new Map();
  for (const seg0 of segs) {
    const seg = shell === "powershell" || !vars.size ? seg0 : { ...seg0, text: substituteVars(seg0.text, vars) };
    const inner = wrapped(seg.text);
    if (inner !== null) {
      const r = readCommand(inner, { shell: /^(pwsh|powershell)/i.test(seg.text) ? "powershell" : "bash", cwd: dir });
      dirs.push(...(r.dirs || []), ...(r.commits || []).map((c) => c.dir));
      if (r.unsupported) return unsupported(r.unsupported);
      if (r.commits.length) {
        if (ops.length || commits.length) return unsupported("コミットが bash -c / pwsh -Command / cmd /c の中にあり、その前で git add しているか、コミットが2つある");
        commits.push(...r.commits);
      }
      continue;
    }
    const g = scope.parseGit(seg, opts);
    if (g && g.sub === "commit") {
      // コミットの出力のリダイレクト（`git commit … > out.txt`）は、コミットの中身を変えない（確かめ直し N3）
      const gdir = gitDirOf(seg, dir, opts);
      if (!gdir) return unsupported("git -C の行き先を決められない（変数・~ を含むか、実在しない）");
      dirs.push(gdir);
      // 2つ目のコミットの前の git add を当てられないので、分けさせる（査読 M3）
      if (commits.length) return unsupported("1つのコマンドにコミットが2つある");
      commits.push({ dir: gdir, args: g.args, ops: ops.slice() });
      continue;
    }
    // ファイルへのリダイレクトは、git の出力でも作業ツリーを変える（`git show X > doc.md && git commit`。査読 M2）
    if (writesFile(seg.text)) {
      if (!commits.length) ops.push({ sub: "__tree__", text: seg.text });
      continue;
    }
    if (!g) {
      const tokens = scope.tokenize(seg.text, opts).map((t) => t.value);
      const asg = shell !== "powershell" && tokens.length === 1 ? tokens[0].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s) : null;
      if (asg) {
        // 作業ツリーを変えない。置き換えられる値だけを覚え、覚えられない値なら前の値を消す（古い値で置き換えない）
        if (!controlFlow && /^[^"'\\$`();&|<>]*$/.test(asg[2])) vars.set(asg[1], asg[2]);
        else vars.delete(asg[1]);
        continue;
      }
      const name = (tokens[0] || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
      if (DIR_COMMANDS.has(name)) {
        if (tokens[1] === "-") return unsupported("cd - の行き先を決められない"); // 確かめ直し N7
        const pi = tokens.findIndex((t) => /^-(Literal)?Path$/i.test(t));
        // `cmd /c "cd /d X"` の /d はオプション（確かめ直し N6）
        const target = pi > 0 ? tokens[pi + 1] : tokens.slice(1).find((t) => !t.startsWith("-") && !/^\/d$/i.test(t));
        if (target === undefined) {
          dir = os.homedir(); // `cd` だけはホームへ
          dirs.push(dir);
          continue;
        }
        const next = resolveDir(dir, target);
        if (!next) return unsupported(`移動先のフォルダー（${target}）を決められない（変数・~ を含むか、実在しない）`);
        dir = next;
        dirs.push(dir);
      } else if (!SAFE_COMMANDS.has(name) && !/^\$[\w:]+\s*=/.test(seg.text) && !/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(seg.text)) {
        if (!commits.length) ops.push({ sub: "__tree__", text: seg.text });
      }
      continue;
    }
    const gdir = gitDirOf(seg, dir, opts);
    // 新しいブランチを作って切り替えるだけ（起点を指定しない `git switch -c x`・`git checkout -b x`）は、作業ツリーも index も変えない（P3b の G2）
    if (!commits.length && isNewBranch(g, opts)) continue;
    if (!commits.length && !SAFE_GIT.has(g.sub)) {
      if (!gdir) return unsupported("git -C の行き先を決められない（変数・~ を含むか、実在しない）");
      dirs.push(gdir);
      ops.push({ sub: g.sub, args: g.args, dir: gdir, text: seg.text });
    }
  }
  return { commits, dirs: [...new Set(dirs.filter(Boolean))] };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(dir, args, env) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: env || process.env });
}

function tryGit(dir, args, env) {
  try {
    return git(dir, args, env);
  } catch {
    return null;
  }
}

/** git のリポジトリの中で、.claude/doc-harness.config.json のある最も近いフォルダー（無ければ null） */
function projectRoot(dir) {
  const top = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const topAbs = path.resolve(top.trim());
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".claude", "doc-harness.config.json"))) return d;
    if (path.relative(topAbs, d) === "" || path.dirname(d) === d) return null;
    d = path.dirname(d);
  }
}

/** リダイレクトのトークン（`<<EOF`・`>`・`2>`）。ここから後ろはコマンドの引数ではない */
const REDIRECT = /^\d*[<>]/;
const tokens = (args, opts) => {
  const t = scope.tokenize(args, opts).map((x) => x.value);
  const end = t.findIndex((x) => REDIRECT.test(x));
  return end < 0 ? t : t.slice(0, end);
};

/** commit の引数を読む: { all, amend, include, paths } */
export function commitOptions(args, opts) {
  const t = tokens(args, opts);
  const VALUE = new Set(["-m", "-F", "-c", "-C", "-t", "--message", "--file", "--author", "--date", "--template", "--fixup", "--squash", "--cleanup", "--trailer", "--reuse-message", "--reedit-message", "--pathspec-from-file"]);
  const r = { all: false, amend: false, include: false, paths: [], pathspecFromFile: false };
  for (let i = 0; i < t.length; i++) {
    const a = t[i];
    if (REDIRECT.test(a)) break; // `<<'EOF'` のようなリダイレクトから後ろは引数ではない
    if (a === "--") {
      const rest = t.slice(i + 1);
      const end = rest.findIndex((x) => REDIRECT.test(x));
      r.paths.push(...(end < 0 ? rest : rest.slice(0, end)));
      break;
    }
    if (a === "--all") r.all = true;
    else if (a === "--amend") r.amend = true;
    else if (a === "-i" || a === "--include") r.include = true;
    else if (a.startsWith("--pathspec-from-file")) r.pathspecFromFile = true;
    else if (VALUE.has(a)) i++;
    else if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
      // 短いオプションの束（-am "msg"）。値を取る文字（m F c C t）から後ろはその値（-m"update" の update を -a と読まない）
      const body = a.slice(1);
      let k = 0;
      for (; k < body.length && !"mFcCt".includes(body[k]); k++) {
        if (body[k] === "a") r.all = true;
        if (body[k] === "i") r.include = true;
      }
      if (k === body.length - 1) i++; // 値を取る文字が束の最後なら、次のトークンが値（-am "msg"）
    } else if (!a.startsWith("-")) r.paths.push(a);
  }
  return r;
}

/** 一時の index を作り、git が作るコミットの中身を再現する。戻り値: index のパス */
function buildIndex(root, commit, opts) {
  const real = path.resolve(root, git(root, ["rev-parse", "--git-path", "index"]).trim());
  const tmp = path.join(os.tmpdir(), `harness-doc-index-${process.pid}-${Date.now()}`);
  try {
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    return { index: tmp, amend: applyOps(root, commit, opts, { ...process.env, GIT_INDEX_FILE: tmp }) };
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // 失敗しても一時の index を残さない
    throw e;
  }
}

/** 一時の index に、コミットより前の操作とコミットの引数を当てる。戻り値: --amend か */
function applyOps(root, commit, opts, env) {
  for (const op of commit.ops) {
    if (op.sub === "__tree__") throw new Error(`コミットより前に、作業ツリーを変えうるコマンドがある（${op.text.slice(0, 60)}）`);
    if (op.sub === "add") {
      const a = tokens(op.args, opts);
      if (a.some((x) => /^(-p|--patch|-i|--interactive|-e|--edit)$/.test(x))) throw new Error("対話の git add は再現できない");
      if (a.some((x) => /[$`]/.test(x))) throw new Error("git add のパスに変数・コマンド置換がある");
      git(op.dir, ["add", ...a], env);
    } else if (op.sub === "rm") {
      const a = tokens(op.args, opts).filter((x) => x !== "--cached");
      if (a.some((x) => /[$`]/.test(x))) throw new Error("git rm のパスに変数・コマンド置換がある");
      git(op.dir, ["rm", "--cached", "-q", ...a], env);
    } else {
      // git mv は作業ツリーを動かすので、コマンドの実行前には中身を再現できない（新しいパスがまだ無い）。
      // 実装計画 §2-1 は「当てる」としていたが、再現できないので分けさせる（0.10.0 の実装の査読 M11）
      throw new Error(`コミットより前に git ${op.sub} がある`);
    }
  }
  const o = commitOptions(commit.args, opts);
  if (o.pathspecFromFile) throw new Error("--pathspec-from-file は再現できない");
  if (o.paths.some((x) => /[$`]/.test(x))) throw new Error("コミットのパスに変数・コマンド置換がある");
  if (o.all) git(commit.dir, ["add", "-u", ":/"], env);
  if (o.paths.length) {
    if (!o.include) {
      const hasHead = tryGit(root, ["rev-parse", "--verify", "HEAD"]) !== null;
      if (hasHead) git(root, ["read-tree", "HEAD"], env);
      else git(root, ["read-tree", "--empty"], env);
    }
    git(commit.dir, ["add", "-A", "--", ...o.paths], env);
  }
  return o.amend;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

const SKIP = /doc-record:\s*skip\s*[（(]\s*([^）)]*?)\s*[）)]/;
/** skip の理由の形。承認の画面に出る本文から、何を承認するのかが読めるように */
const SKIP_FORM = /^改訂の記録なしでコミットする\s*[:：]\s*\S/;

/** 1つのコミットを検査する。戻り値: { decision: "allow"|"warn"|"ask"|"deny", lines: [] } */
export function checkCommit(commit, { shell = "bash", command = "", deadline = Infinity } = {}) {
  const opts = { shell };
  const root = projectRoot(commit.dir);
  if (!root) return { decision: "allow", lines: [] };
  const loaded = loadConfig(root);
  const config = loaded.config || DEFAULT_CONFIG;
  const mode = config.completeCheck || "block";
  if (mode === "off") return { decision: "allow", lines: [] };
  let built;
  try {
    built = buildIndex(root, commit, opts);
  } catch (e) {
    return {
      decision: "deny",
      lines: [`コミットの中身を再現できない: ${e.message}。git add と git commit を別の呼び出しに分ける（文書の改訂の記録を確かめるため）`],
    };
  }
  try {
    let base = "HEAD";
    if (built.amend) {
      if (tryGit(root, ["rev-parse", "--verify", "HEAD~1"]) === null) {
        return { decision: "warn", lines: ["--amend で前の版が無いので、改訂の記録を確かめていない"] };
      }
      base = "HEAD~1";
    }
    setGitContext({ indexFile: built.index, base });
    // 試作のファイル（<名前>.proto-N.<拡張子>）は検査の対象外なので、そのままでは黙ってコミットされ公開物に混ざる（0.11.0 の査読 R1）
    const hasHead = tryGit(root, ["rev-parse", "--verify", "HEAD"]) !== null;
    const stagedNames = (
      tryGit(root, ["diff", "--cached", ...(hasHead ? [base] : []), "--name-only", "--diff-filter=ACMR", "-z"], { ...process.env, GIT_INDEX_FILE: built.index }) || ""
    )
      .split("\0")
      .filter(Boolean);
    const protos = stagedNames.filter((f) => isProto(f));
    if (protos.length)
      return {
        decision: mode === "warn" ? "warn" : "deny",
        lines: [`試作のファイルがコミットに入っている: ${protos.join(", ")}。試作は承認の後に消す（見本は改訂設計書の「試作」の節に写す）。コミットから外す`],
      };
    const targets = changedDocs(root, config, true);
    if (!targets.length) return { decision: "allow", lines: [] };
    const briefs = loadBriefs(root);
    if (!briefs.length)
      return {
        decision: "warn",
        lines: [
          `文書を含むコミットだが、ブリーフ（.claude/rules/doc-brief-*.md）が無いので改訂の記録を確かめていない（${targets.join(", ")}）。` +
            "/harness-doc:setup-project の「導入済みのプロジェクトに足す」でブリーフと内部の改訂記録を作ると、以後はここで確かめる",
        ],
      };
    // 同じコミットに入っている改訂設計書だけを見る（残った「作業中」で検査をずっと外さないように）
    const plans = planStates(root, config, { staged: true });
    const working = plans.filter((p) => p.state === "作業中" && p.inCommit);
    const ng = [];
    const docsNg = [];
    const warn = [];
    // check-docs の指摘が直前のコミットより増えていないかも見る（0.12.0）。書くたびのフックは増えた指摘だけを止めるが、
    // PostToolUse なので止めても書き込みは済んでいる。直さずにコミットが通ると、以後「前からある」になってしまう
    const style = loadStyle(root, config);
    for (const rel of targets) {
      // フックの時間切れは素通りになるので、予算を超えたら止める（文書の多いコミット。査読 P3）
      if (Date.now() > deadline) return { decision: mode === "warn" ? "warn" : "deny", lines: ["検査が時間内に終わらなかった。文書を分けてコミットする"] };
      // 問い合わせの印は警告にとどめる。印は改訂設計書の「問い合わせ」で管理していて、依頼者の回答を待つあいだ残るのが正しい状態。
      // 止めると、印を消して通すことになり、追跡が失われる（実地検証 P3b の G1）。
      // 0.13.0 から、改訂設計書に問い合わせ表があれば、完了処理の検査と同じく表で照らす: 回答の空の番号は警告、
      // 回答済みの番号・表に無い番号・番号の無い印は止める（allowQueries は表の無いとき＝規模 S の印だけに効く）
      const { problems, warnings } = checkDoc(root, rel, { staged: true, briefs, config, allowQueries: true, style });
      const plan = working.find((p) => p.docs.includes(rel));
      if (problems.length && plan) warn.push(`${rel}: 改訂設計書 ${plan.file} が作業中なので警告にとどめた — ${problems.join(" / ")}`);
      else if (problems.length) {
        // check-docs の指摘は記録の問題と分ける。記録の承認（doc-record: skip）で通してはいけない
        const docs = problems.filter((p) => p.startsWith(CHECK_DOCS_NG));
        const rest = problems.filter((p) => !p.startsWith(CHECK_DOCS_NG));
        if (docs.length) docsNg.push(`${rel}: ${docs.join(" / ")}`);
        if (rest.length) ng.push(`${rel}: ${rest.join(" / ")}`);
      }
      for (const w of warnings) warn.push(`${rel}: ${w}`);
    }
    for (const p of plans) if (p.state === "作業中" && p.ageDays > 7) warn.push(`改訂設計書 ${p.file} が「作業中」のまま ${p.ageDays} 日たっている。終えたか、やめたかを確かめる`);
    if (!ng.length && !docsNg.length) return { decision: warn.length ? "warn" : "allow", lines: warn };
    if (mode === "warn") return { decision: "warn", lines: [...docsNg, ...ng, ...warn] };
    if (docsNg.length)
      return {
        decision: "deny",
        lines: [
          ...docsNg,
          "書いた文書の check-docs の指摘が、直前のコミットより増えている。指摘を直してからコミットする（doc-record: skip では通らない。前からある指摘は直さなくてよい）",
          ...ng,
          ...warn,
        ],
      };
    const skip = SKIP.exec(command);
    // 承認の画面にはフックの理由が出ず、コマンドの本文だけが出る（実地検証 P3a-3 の G2。systemMessage も出しているが表示されなかった）。
    // 何を承認するのかが本文から読めるよう、理由の書き方をここで決める（スキルの指示だと AI が飛ばせる）
    if (skip && SKIP_FORM.test(skip[1].trim()))
      return { decision: "ask", lines: [`コミットの文言に doc-record: skip（${skip[1].trim()}）がある。改訂の記録の無い文書を、依頼者の承認でコミットする`, ...ng] };
    return {
      decision: "deny",
      lines: [
        ...ng,
        ...(skip ? [`doc-record: skip の理由は「改訂の記録なしでコミットする: <理由>」の形で書く（承認の画面にはコマンドの本文だけが出るので、何を承認するのかを本文に書く）`] : []),
        "改訂の記録を足してからコミットする（history.mjs add。読者向けの改訂履歴が「あり」なら文書にも1行）。" +
          "harness-doc の工程を通さない正当な変更なら、そう依頼者に説明する。コミットの文言に doc-record: skip（改訂の記録なしでコミットする: <理由>）を書くと、" +
          "ふつうのコマンドの実行確認と同じ画面で依頼者の承認を求める",
        ...warn,
      ],
    };
  } finally {
    setGitContext();
    try {
      fs.rmSync(built.index, { force: true });
    } catch {
      /* 一時ファイル */
    }
  }
}

function output(decision, lines) {
  const body = lines.map((l) => `- ${l}`).join("\n");
  if (decision === "allow") process.exit(0);
  if (decision === "warn") {
    const msg = `${TAG} ⚠️ 警告\n${body}`;
    process.stdout.write(JSON.stringify({ systemMessage: msg, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: msg } }));
    process.exit(0);
  }
  const reason = `${TAG} ${decision === "ask" ? "依頼者の承認が要る" : "❌ 改訂の記録が無い文書を含むコミット"}\n${body}`;
  process.stdout.write(
    JSON.stringify({ systemMessage: reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } })
  );
  process.exit(0);
}

export function run(payload) {
  const tool = payload.tool_name || "";
  if (tool !== "Bash" && tool !== "PowerShell") return { decision: "allow", lines: [] };
  const command = (payload.tool_input || {}).command || "";
  if (!/\bcommit\b/.test(command)) return { decision: "allow", lines: [] };
  const shell = tool === "PowerShell" ? "powershell" : "bash";
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const started = Date.now();
  const read = readCommand(command, { shell, cwd });
  if (read.unsupported) {
    // 再現できない形でも、コマンドに出てきたフォルダー（作業フォルダー・cd の先・git -C の先）のどれも
    // 文書ハーネスのプロジェクトでなければ止めない（無関係のリポジトリのコミットを妨げない）
    const modes = (read.dirs || [cwd])
      .map((d) => projectRoot(d))
      .filter(Boolean)
      .map((root) => (loadConfig(root).config || DEFAULT_CONFIG).completeCheck || "block")
      .filter((m) => m !== "off");
    if (!modes.length) return { decision: "allow", lines: [] };
    const d = modes.includes("block") ? "deny" : "warn";
    return { decision: d, lines: [`${read.unsupported}。文書の改訂の記録を確かめられないので、別の呼び出しに分ける`] };
  }
  const order = { allow: 0, warn: 1, ask: 2, deny: 3 };
  let decision = "allow";
  const lines = [];
  for (const c of read.commits) {
    const r = checkCommit(c, { shell, command, deadline: started + BUDGET_MS });
    if (order[r.decision] > order[decision]) decision = r.decision;
    lines.push(...r.lines);
    if (Date.now() - started > BUDGET_MS)
      return { decision: "deny", lines: ["検査が時間内に終わらなかった。文書を分けてコミットする", ...lines] };
  }
  return { decision, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(data || "{}");
    } catch {
      process.exit(0);
    }
    let r;
    try {
      r = run(payload);
    } catch (e) {
      // 検査そのものの不具合でコミットを止めない（理由は画面に出す）
      r = { decision: "warn", lines: [`検査を走らせられなかった: ${e.message}`] };
    }
    output(r.decision, r.lines);
  });
}
