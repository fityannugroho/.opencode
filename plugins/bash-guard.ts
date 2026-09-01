// ── Known limitations (Level 1 scope) ────────────────────────────────────────
// This plugin inspects the first token of each shell segment. The following are
// intentionally NOT detected (out of scope for Level 1):
//   • bash -c "…" / sh -c "…" / eval "…" wrappers — the inner string is not
//     re-parsed, so a blocked command hidden inside is allowed through.
//   • timeout / nohup / nice / xargs / stdbuf / script / setsid wrappers — only
//     rtk, sudo, command, env, time are stripped as wrapper prefixes.
//   • Command substitution ($(cat x), `cat x`) and process substitution
//     (<(cat x)) embed blocked commands as arguments rather than as the first
//     token, so they pass through.
//   • Leading redirect / exec prefixes — e.g. `> file cmd`,
//     `2>/dev/null cmd`, `>&`, `< cmd`, and `exec` prefixes — are
//     not stripped, so the real command after them is not detected.
//   • Heredoc edge cases: a delimiter word that is itself a blocked command, or
//     a delimiter line that carries a trailing command, are not handled — the
//     delimiter line is treated as a normal line when it does not exactly match
//     the delimiter.
// These gaps are inherent to the first-token analysis design.

// ── Shell tokenizer ──────────────────────────────────────────────────────────
// Produces a flat list of tokens including operators as individual tokens.
// Handles single quotes, double quotes (with backslash escaping), and
// backslash escaping outside quotes.

import type { Plugin } from "@opencode-ai/plugin"

type Token = string

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ""
  let inSingle = false
  let inDouble = false

  const flush = () => {
    if (current) {
      tokens.push(current)
      current = ""
    }
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!

    if (inSingle) {
      if (ch === "'") {
        inSingle = false
      } else {
        current += ch
      }
      continue
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false
      } else if (ch === '\\' && i + 1 < input.length) {
        current += input[++i]!
      } else {
        current += ch
      }
      continue
    }

    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i]!
      continue
    }

    // Two-char operators first
    if ((ch === '&' && input[i + 1] === '&') || (ch === '|' && input[i + 1] === '|')) {
      flush()
      tokens.push(ch + input[i + 1]!)
      i++
      continue
    }

    // Single-char operators
    if (ch === '|' || ch === ';') {
      flush()
      tokens.push(ch)
      continue
    }

    if (/\s/.test(ch)) {
      flush()
      continue
    }

    current += ch
  }

  flush()
  return tokens
}

// ── Heredoc detection ────────────────────────────────────────────────────────
// Scans lines for heredoc openers (<<[-]?['"]?WORD, allowing optional
// whitespace) and returns a Set of line indices that are heredoc body lines
// (to be skipped during analysis). The opener line itself is analysed normally.
//
// The opener is only recognised when the `<<` appears OUTSIDE quotes, so a
// string such as `"msg << EOF"` does not open a phantom heredoc. The delimiter
// may contain characters beyond \w (e.g. `X-Y`, `EOF.txt`).

function findHeredocDelimiter(line: string): string | null {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === "\\" && i + 1 < line.length) i++ // escaped char (e.g. \")
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }

    // Outside quotes: look for a heredoc opener `<<`.
    if (ch === "<" && line[i + 1] === "<") {
      if (line[i + 2] === "<") { i += 2; continue } // herestring <<<, not a heredoc
      let j = i + 2
      if (line[j] === "-") j++ // optional <<- (strip leading tabs)
      while (j < line.length && /\s/.test(line[j]!)) j++ // optional whitespace
      const quoted = line[j] === "'" || line[j] === '"'
      if (quoted) j++ // optional opening quote
      // Delimiter: anything except whitespace and quotes; for an unquoted
      // delimiter also stop at shell operator/redirect characters.
      let delim = ""
      while (j < line.length) {
        const c = line[j]!
        if (/[\s'"]/.test(c)) break
        if (!quoted && "><|;&".includes(c)) break
        delim += c
        j++
      }
      if (delim.length === 0) continue
      // An unquoted delimiter immediately followed by a shell operator /
      // redirect is not a valid heredoc opener (e.g. `<<EOF>out`).
      if (!quoted && j < line.length && "><|;&".includes(line[j]!)) continue
      return delim
    }
  }
  return null
}

function buildHeredocSkipSet(lines: string[]): Set<number> {
  const skip = new Set<number>()
  let heredocDelimiter: string | null = null

  for (let i = 0; i < lines.length; i++) {
    if (heredocDelimiter !== null) {
      const trimmed = lines[i]!.trim()
      if (trimmed === heredocDelimiter) {
        heredocDelimiter = null
      } else {
        skip.add(i)
      }
      continue
    }

    const delim = findHeredocDelimiter(lines[i]!)
    if (delim) {
      heredocDelimiter = delim
    }
  }

  return skip
}

// ── Line joining ─────────────────────────────────────────────────────────────
// Joins physical lines that end with a continuation operator (&&, ||, |, ;)
// into single logical lines. Respects heredoc boundaries (skips body lines).

const LINE_CONTINUATION_RE = /(?:&&|\|\||[|;])\s*$/

function joinContinuationLines(lines: string[], heredocSkip: Set<number>): string[] {
  const result: string[] = []
  let buf = ""

  for (let i = 0; i < lines.length; i++) {
    if (heredocSkip.has(i)) continue

    const line = lines[i]!
    if (buf) {
      buf += " " + line
    } else {
      buf = line
    }

    if (LINE_CONTINUATION_RE.test(line)) {
      continue
    }

    result.push(buf)
    buf = ""
  }

  if (buf) result.push(buf)
  return result
}

// ── Segment splitter ─────────────────────────────────────────────────────────
// Splits token list into segments on &&  ||  |  ;  and newlines.
// Each segment records the operator that preceded it (if any).

export type Segment = {
  command: string
  args: string[]
  tokens: string[]
  precedingOp: string | null
}

const OPERATORS = new Set(["&&", "||", "|", ";"])

export function splitSegments(tokens: Token[]): Segment[] {
  const segments: Segment[] = []
  let current: string[] = []
  let precedingOp: string | null = null

  const flush = () => {
    if (current.length > 0) {
      segments.push({
        command: current[0]!,
        args: current.slice(1),
        tokens: [...current],
        precedingOp,
      })
      current = []
    }
  }

  for (const tok of tokens) {
    if (OPERATORS.has(tok)) {
      flush()
      precedingOp = tok
      continue
    }
    current.push(tok)
  }

  flush()
  return segments
}

// ── Blocklist ────────────────────────────────────────────────────────────────

const ALWAYS_BLOCKED = new Set([
  "cat", "read", "head", "tail", "less", "more", "bat",
  "tac", "glob", "find", "ls", "touch", "echo", "printf",
  "tee", "curl", "wget",
])

const PIPELINE_SAFE = new Set([
  "grep", "rg", "ag", "ack", "awk", "sed",
])

// No-op commands that always succeed/fail without doing anything.
// Used to detect bypass attempts like `true && cat file`.
const NOOP_COMMANDS = new Set(["true", "false", ":"])

const SUGGESTED_TOOL: Record<string, string> = {
  cat: "read",
  read: "read",
  head: "read",
  tail: "read",
  less: "read",
  more: "read",
  bat: "read",
  tac: "read",
  grep: "grep",
  rg: "grep",
  ag: "grep",
  ack: "grep",
  awk: "grep or edit",
  sed: "edit",
  glob: "glob",
  find: "glob or grep",
  ls: "read or glob",
  touch: "write",
  echo: "write",
  printf: "write",
  tee: "write",
  curl: "webfetch",
  wget: "webfetch",
}

const WRAPPER_PREFIXES = ["rtk", "sudo", "command", "env", "time", "builtin"]

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const CONFIRM_RE = /#\s*confirm\s*$/i

// ── Core analysis (exported for testing) ─────────────────────────────────────

export interface BlockedResult {
  name: string
  tool: string
}

/**
 * Extract the basename of a command token, handling paths like /bin/cat → cat.
 */
function basename(token: string): string {
  return token.split("/").pop()!.toLowerCase()
}

/**
 * Strip wrapper prefixes (rtk/sudo/command/env/time/builtin), wrapper
 * options, env assignments, and quotes. Returns the basename of the
 * first real command token, or null if nothing remains.
 */
function getRealCommandBase(tokens: string[]): string | null {
  // Strip wrapper prefixes repeatedly: rtk sudo command env time builtin
  let tokensCopy = [...tokens]
  while (tokensCopy.length > 0) {
    const base = basename(tokensCopy[0]!)
    if (WRAPPER_PREFIXES.includes(base)) {
      tokensCopy = tokensCopy.slice(1)

      // R2: `command -v` / `command -V` is a query, not execution — skip it.
      if (base === "command" && tokensCopy.length > 0 && (tokensCopy[0] === "-v" || tokensCopy[0] === "-V")) {
        return null
      }

      // I2: skip option tokens after a wrapper prefix.
      // Short option (-X <arg>): skip the option and the following arg if
      //   the arg is NOT a blocked command itself (e.g. sudo -u root → root
      //   is not blocked → skip it; sudo -u cat → cat is blocked → don't skip).
      // Attached option (-X<arg> or --flag=value): skip unconditionally.
      while (tokensCopy.length > 0 && tokensCopy[0]!.startsWith("-")) {
        const opt = tokensCopy[0]!
        const isShortOpt = opt.length === 2 && opt !== "--"
        if (isShortOpt) {
          // Short option like -u: skip option + following token if not blocked
          tokensCopy = tokensCopy.slice(1)
          if (tokensCopy.length > 0) {
            const nextBase = basename(tokensCopy[0]!)
            if (!ALWAYS_BLOCKED.has(nextBase) && !PIPELINE_SAFE.has(nextBase)) {
              tokensCopy = tokensCopy.slice(1)
            }
          }
        } else {
          // Long option (--user=root) or attached short option (-uroot)
          tokensCopy = tokensCopy.slice(1)
        }
      }
    } else {
      break
    }
  }

  // Skip env-assignment tokens: FOO=bar …
  while (tokensCopy.length > 0 && ENV_ASSIGN_RE.test(tokensCopy[0]!)) {
    tokensCopy = tokensCopy.slice(1)
  }

  if (tokensCopy.length === 0) return null

  // Extract first real command token
  let first = tokensCopy[0]!
  // Strip surrounding quotes
  if (
    (first.startsWith("'") && first.endsWith("'")) ||
    (first.startsWith('"') && first.endsWith('"')) ||
    (first.startsWith("`") && first.endsWith("`"))
  ) {
    first = first.slice(1, -1)
  }
  // Take basename (handle /bin/cat → cat)
  return basename(first)
}

/**
 * Analyse a single segment for a blocked command.
 *
 * @param isPiped  true when the segment receives input from a pipe (|).
 *                 grep/awk/sed are only blocked when NOT piped.
 */
export function analyzeSegment(
  tokens: string[],
  isPiped: boolean,
): BlockedResult | null {
  const base = getRealCommandBase(tokens)
  if (base === null) return null

  // ── Check blocklist ───────────────────────────────────────────────────────
  if (ALWAYS_BLOCKED.has(base)) {
    return { name: base, tool: SUGGESTED_TOOL[base]! }
  }
  // grep/awk/sed are only blocked when NOT piped (i.e. not a pipeline filter)
  if (!isPiped && PIPELINE_SAFE.has(base)) {
    return { name: base, tool: SUGGESTED_TOOL[base]! }
  }

  return null
}

// ── guardCommand (exported for testing) ──────────────────────────────────────

/**
 * Analyse a full command string. Returns the formatted error message if the
 * command is blocked, or null if it is allowed.
 */
export function guardCommand(command: string): string | null {
  const result = findBlockedCommand(command)
  if (result) return formatError(result)
  return null
}

// ── findBlockedCommand ───────────────────────────────────────────────────────

export function findBlockedCommand(command: string): BlockedResult | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Escape hatch: # confirm at end
  if (CONFIRM_RE.test(trimmed)) return null

  // detect heredocs, then join continuation lines, then analyse
  const rawLines = trimmed.split("\n")
  const heredocSkip = buildHeredocSkipSet(rawLines)
  const logicalLines = joinContinuationLines(rawLines, heredocSkip)

  for (const line of logicalLines) {
    const tokens = tokenize(line)
    if (tokens.length === 0) continue
    const segments = splitSegments(tokens)
    // Skip leading no-op segments (true/false/:) — these are only used
    // to bypass the guard (e.g. `true && cat file`). Then check the
    // first real command. Chaining after that is allowed.
    let idx = 0
    let skippedNoop = false
    while (idx < segments.length) {
      // Strip wrapper prefixes first so `sudo true`, `command :`, etc.
      // are also recognized as no-op prefixes.
      const base = getRealCommandBase(segments[idx]!.tokens)
      if (base === null || !NOOP_COMMANDS.has(base)) break
      skippedNoop = true
      idx++
    }
    if (idx < segments.length) {
      const seg = segments[idx]!
      // After a no-op prefix, check strictly (ignore pipe status) to
      // prevent bypasses like `true | grep foo file`.
      const isPiped = !skippedNoop && seg.precedingOp === "|"
      const result = analyzeSegment(seg.tokens, isPiped)
      if (result) return result
    }
  }

  return null
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function formatError(result: BlockedResult): string {
  return (
    `Forbidden: Command "${result.name}" is blocked — use the "${result.tool}" tool instead.`
  )
}

export const BashGuardPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return

      const args = output?.args
      if (!args || typeof args !== "object") return

      const command = (args as Record<string, unknown>).command
      if (typeof command !== "string" || !command) return

      const result = findBlockedCommand(command)
      if (result) throw new Error(formatError(result))
    },
  }
}
