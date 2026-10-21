import { Plugin } from "@opencode/plugin"

// Structural session shape (V2 Session.Info subset used by these tools).
// Local interface — no SDK dependency.
interface SessionDetail {
  id: string
  title?: string
  agent?: string
  location?: { directory?: string }
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  time?: { created?: number; updated?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

// Structural view of a V2 message (flat shape, no `info`/`parts` nesting).
interface V2Message {
  type?: string
  time?: { created?: number }
  text?: string
  command?: string
  content?: Array<{ type?: string; text?: string }>
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

// Helper: safely format date
function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return "N/A"
  const date = new Date(timestamp)
  return isNaN(date.getTime()) ? "N/A" : date.toLocaleString()
}

// Helper: format elapsed duration from milliseconds
function formatDuration(ms: number): string {
  if (typeof ms !== "number" || isNaN(ms) || ms < 0) return "N/A"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `~${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return `~${m}m ${remS}s`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return `~${h}h ${remM}m`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return `~${d}d ${remH}h`
}

// Helper: restore V1's error prefixes.
// V2 API failures are Effect tagged errors (SessionNotFoundError, InvalidRequestError,
// UnknownError) carrying `_tag`; a plain Error has name === "Error" and is rethrown
// untouched so our own throws keep their message.
function apiError(err: unknown): Error {
  const tag = typeof err === "object" && err !== null ? Reflect.get(err, "_tag") : undefined
  const name = typeof err === "object" && err !== null ? Reflect.get(err, "name") : undefined
  const message = err instanceof Error ? err.message : String(err)
  const kind =
    typeof tag === "string" ? tag : typeof name === "string" && name !== "Error" ? name : undefined
  if (kind === undefined) return err instanceof Error ? err : new Error(message)
  const detail = message.trim().length > 0 ? message : kind.includes("NotFound") ? "resource does not exist" : kind
  if (kind.includes("NotFound")) return new Error(`Not Found: ${detail}`)
  if (kind.includes("InvalidRequest") || kind.includes("BadRequest")) return new Error(`Bad Request: ${detail}`)
  return new Error(`Unexpected Error: ${detail}`)
}

function isSessionList(value: unknown): value is SessionDetail[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null && typeof Reflect.get(item, "id") === "string")
  )
}

type SessionListFn = (input: { parentID: string; limit?: number }) => Promise<unknown>

// Structural view of the plugin context: only session.list is used, and it is
// absent on runtimes older than opencode 2.1.1.
interface SessionListContext {
  readonly session?: { readonly list?: SessionListFn }
}

// Helper: list child sessions of the given parent session.
// ctx.session.list is the in-process session API (opencode >= 2.1.1). It returns
// the same rows the CLI's GET /api/session?parentID=… returned, so the tool needs
// neither the host service registration file nor any network access.
async function listChildSessions(ctx: SessionListContext, parentID: string, limit = 50): Promise<SessionDetail[]> {
  const list = ctx.session?.list
  if (typeof list !== "function") {
    throw new Error("subagent-sessions requires opencode >= 2.1.1 (this runtime has no ctx.session.list)")
  }
  const result = await list({ parentID, limit })
  const data = Array.isArray(result)
    ? result
    : typeof result === "object" && result !== null
      ? Reflect.get(result, "data")
      : undefined
  if (!isSessionList(data)) {
    throw new Error("Session list returned an unexpected payload")
  }
  return data
}

function stringField(source: unknown, name: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined
  const value = Reflect.get(source, name)
  return typeof value === "string" ? value : undefined
}

function aborted(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false
  const signal = Reflect.get(context, "signal")
  return typeof signal === "object" && signal !== null && Reflect.get(signal, "aborted") === true
}

// Helper: format session info (compact, single line)
function formatSessionLine(s: SessionDetail): string {
  const agent = s.agent || "?"
  const title = s.title || "untitled"
  const cost = s.cost !== undefined && s.cost !== null ? `$${Number(s.cost).toFixed(4)}` : "free"
  const model = s.model?.id || "?"

  const tokens = s.tokens ?? {}
  const tokStr = `${tokens.input || 0}i/${tokens.output || 0}o (cumulative)`

  const lifetime = s.time?.updated && s.time?.created ? s.time.updated - s.time.created : Number.NaN

  return `${s.id} [${agent}] ${title} | ${cost} ${model} | ${tokStr} | ${formatDuration(lifetime)}`
}

export default Plugin.define({
  id: "task-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      // ============================================
      // subagent-sessions: List child sessions
      // ============================================
      editor.add({
        name: "subagent-sessions",
        description: "List all subagent sessions spawned by the current session (IDs, titles, costs, etc.)",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute(args: unknown, context: unknown) {
          if (aborted(context)) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          const sessionID = stringField(context, "sessionID")
          if (!sessionID || !sessionID.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${sessionID}" — must start with "ses_"`)
          }

          try {
            const children = await listChildSessions(ctx, sessionID)
            if (children.length === 0) {
              return { content: `No subagent sessions found for current session (${sessionID}).` }
            }

            const lines = children.map(formatSessionLine)
            return { content: `${children.length}:\n${lines.join("\n")}` }
          } catch (err) {
            throw apiError(err)
          }
        },
      })

      // ============================================
      // session-detail: Get session details
      // ============================================
      editor.add({
        name: "session-detail",
        description: "Get detailed info about a specific session (token usage, context limit, permissions, etc.)",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID/Task ID to check (Defaults to current session)" },
          },
          additionalProperties: false,
        },
        async execute(args, context) {
          const contextRecord = context as unknown as { signal?: { aborted?: boolean } }
          const sessionID = stringField(args, "session_id") ?? stringField(context, "sessionID")

          if (contextRecord.signal?.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!sessionID || !sessionID.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${sessionID}" — must start with "ses_"`)
          }

          try {
            const session = (await ctx.session.get({ sessionID })) as SessionDetail

            const agent = session.agent || "unknown"
            const title = session.title || "untitled"
            const created = formatDate(session.time?.created)
            const updated = formatDate(session.time?.updated)
            const cost = session.cost !== undefined && session.cost !== null ? `$${Number(session.cost).toFixed(4)}` : "free"

            const modelID = session.model?.id || "unknown"
            const providerID = session.model?.providerID || ""
            const variant = session.model?.variant || "default"

            // session.tokens.* are CUMULATIVE counters (they grow every turn as the
            // full history is re-fed), so they do NOT reflect current context-window
            // occupancy. The UI reports current occupancy from the most recent
            // assistant message's token usage, so we match that here.
            let input = 0
            let output = 0
            let reasoning = 0
            let cacheRead = 0
            let cacheWrite = 0
            let hasCurrentTokens = false

            try {
              // V2 context() takes no limit — it returns the whole
              // post-compaction window, so the newest assistant message is
              // always present.
              const messages = ((await ctx.session.context({ sessionID })) as unknown as V2Message[]) ?? []
              // API returns messages oldest-first; the most recent is last.
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i]
                const tk = m?.tokens
                if (
                  m?.type === "assistant" &&
                  tk &&
                  (tk.input || tk.output || tk.reasoning || tk.cache?.read || tk.cache?.write)
                ) {
                  input = tk.input || 0
                  output = tk.output || 0
                  reasoning = tk.reasoning || 0
                  cacheRead = tk.cache?.read || 0
                  cacheWrite = tk.cache?.write || 0
                  hasCurrentTokens = true
                  break
                }
              }
            } catch {
              // non-critical; fall back to N/A
            }

            // Fetch context window size from the model domain (Model.Info.limit.context).
            let contextLimit = 0
            if (providerID && modelID && modelID !== "unknown") {
              try {
                // model.list resolves to { location, data } — the model rows are in data.
                const listed = await ctx.model.list()
                const models = listed.data ?? []
                const match = models.find((m) => m.providerID === providerID && m.id === modelID)
                if (match?.limit?.context) {
                  contextLimit = match.limit.context
                }
              } catch {
                // non-critical
              }
            }

            const occupancy = input + output + reasoning + cacheRead
            const contextPercent =
              hasCurrentTokens && contextLimit > 0
                ? `${((occupancy / contextLimit) * 100).toFixed(1)}%`
                : "N/A"

            const { permissions: sessionPermissions } = session
            const permissions = sessionPermissions?.length
              ? sessionPermissions.map((p) => `  ${p.action}: ${p.effect} (${p.resource})`).join("\n")
              : "  none"

            const elapsed = (session.time?.created && session.time?.updated)
              ? session.time.updated - session.time.created
              : NaN

            return {
              content: `ID: ${session.id}
Title: ${title}
Slug: N/A
Version: N/A
Agent: ${agent}
Model: ${providerID}/${modelID} (${variant})
Directory: ${session.location?.directory || "N/A"}
Created: ${created}
Updated: ${updated}
Elapsed: ${formatDuration(elapsed)}
Cost: ${cost}
Tokens (cumulative): ${(session.tokens?.input || 0)} input / ${(session.tokens?.output || 0)} output / ${(session.tokens?.reasoning || 0)} reasoning | Cache: ${(session.tokens?.cache?.read || 0)} read / ${(session.tokens?.cache?.write || 0)} write
Tokens (current): ${hasCurrentTokens ? `${input} input / ${output} output / ${reasoning} reasoning | Cache: ${cacheRead} read / ${cacheWrite} write` : "N/A"}
Context: ${hasCurrentTokens && contextLimit > 0 ? `${occupancy}/${contextLimit} (${contextPercent})` : "N/A"}
Code changes: N/A
Parent: ${session.parentID || "none (root session)"}
Permissions: ${permissions}`,
            }
          } catch (err) {
            throw apiError(err)
          }
        },
      })

      // ============================================
      // session-messages: Get session chat history
      // ============================================
      editor.add({
        name: "session-messages",
        description: "Get chat history of a session",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID/Task ID" },
            limit: { type: "number", description: "Messages to show (default: 10; max: 100)" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        async execute(args, context) {
          const argRecord = args as unknown as { session_id?: string; limit?: number }
          const contextRecord = context as unknown as { signal?: { aborted?: boolean } }
          const session_id = argRecord.session_id ?? ""
          const limit = Math.min(argRecord.limit || 10, 100)

          if (contextRecord.signal?.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!session_id.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${session_id}" — must start with "ses_"`)
          }

          try {
            // V2 context() takes no limit — fetch all, then keep the most
            // recent `limit` client-side.
            const allMessages =
              ((await ctx.session.context({ sessionID: session_id })) as unknown as V2Message[]) || []
            const messages = allMessages.slice(-limit)
            if (!Array.isArray(messages) || messages.length === 0) {
              return { content: `No messages found.` }
            }

            // Count by role (flat V2 message types)
            let userCount = 0
            let assistantCount = 0
            for (const m of messages) {
              if (m?.type === "user") userCount++
              else if (m?.type === "assistant") assistantCount++
            }
            const otherCount = messages.length - userCount - assistantCount

            const lines = messages.map((m: V2Message, idx: number) => {
              const role = m?.type ?? "unknown"
              const created = m?.time?.created
              const timestamp = formatDate(created)

              // Estimate duration from created time to next message
              let duration = ""
              if (created) {
                const nextCreated = idx < messages.length - 1
                  ? messages[idx + 1]?.time?.created
                  : Date.now()
                if (nextCreated) {
                  const seconds = Math.round((nextCreated - created) / 1000)
                  if (seconds < 60) {
                    duration = ` (~${seconds}s)`
                  } else {
                    const mins = Math.floor(seconds / 60)
                    const secs = seconds % 60
                    duration = ` (~${mins}m ${secs}s)`
                  }
                }
              }

              // Extract text content from the flat V2 message shape
              const content =
                (typeof m?.text === "string" && m.text.length > 0 ? m.text : "")
                || (Array.isArray(m?.content)
                      ? m.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
                      : "")
                || (typeof m?.command === "string" ? m.command : "")
                || "[no text content]"
              const preview = content.length > 200
                ? content.substring(0, 200) + "..."
                : content

              return `[${role}] ${timestamp}${duration}
${preview}`
            })

            return { content: `Total: ${messages.length} messages | User: ${userCount} | Assistant: ${assistantCount}${otherCount > 0 ? ` | Other: ${otherCount}` : ""}\n\n${lines.join("\n\n")}` }
          } catch (err) {
            throw apiError(err)
          }
        },
      })

      // ============================================
      // session-compact: Trigger session compaction
      // ============================================
      editor.add({
        name: "session-compact",
        description: "Compact a session by summarizing its conversation.",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "Session ID/Task ID to compact" },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        async execute(args: unknown, context: unknown) {
          if (aborted(context)) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          const sessionID = stringField(args, "session_id")
          if (!sessionID || !sessionID.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${sessionID}" — must start with "ses_"`)
          }

          // Compacting the running session would race its own agent loop.
          if (sessionID === stringField(context, "sessionID")) {
            throw new Error(
              "Bad Request: Cannot compact the current session. Use session-compact on child sessions instead.",
            )
          }

          try {
            // Fetch the session first so we can report the model it runs on and
            // surface a missing session before admitting the compaction.
            const session = (await ctx.session.get({ sessionID })) as SessionDetail
            const providerID = session.model?.providerID ?? "unknown"
            const modelID = session.model?.id ?? "unknown"

            // Durable admission: compaction runs at the session's next step
            // boundary, not synchronously.
            const admitted: unknown = await ctx.session.compact({ sessionID })
            const inboxID = stringField(admitted, "id") ?? "unknown"
            const delivery = stringField(admitted, "delivery") ?? "default"

            return {
              content: `Compaction admitted: ${sessionID}
Model: ${providerID}/${modelID}
Inbox: ${inboxID} (${delivery})`,
            }
          } catch (err) {
            throw apiError(err)
          }
        },
      })
    })
  },
})
