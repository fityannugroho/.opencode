import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

// Structural session shape (V2 Session.Info subset used by these tools).
// Local interface — no SDK dependency.
interface SessionDetail {
  id: string
  title?: string
  slug?: string
  version?: string
  agent?: string
  directory?: string
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  time?: { created?: number; updated?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  summary?: { additions?: number; deletions?: number; files?: number }
  permission?: Array<{ permission: string; action: string; pattern: string }>
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

// Helper: read the running service endpoint + password (discovery file the CLI uses)
function readServiceState(): { url: string; password: string } {
  const file = join(homedir(), ".local", "state", "opencode", "service.json")
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Unexpected service state in ${file}`)
  }
  const url = Reflect.get(parsed, "url")
  const password = Reflect.get(parsed, "password")
  if (typeof url !== "string" || typeof password !== "string") {
    throw new Error(`Missing url/password in ${file}`)
  }
  return { url, password }
}

function isSessionList(value: unknown): value is SessionDetail[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null && typeof Reflect.get(item, "id") === "string")
  )
}

// Helper: list child sessions. The plugin session domain has no list method
// (ctx.session offers create/get/remove/update/move/context/compact/prompt/
// generate/command/synthetic/interrupt/wait/switchAgent/switchModel only), so
// the tool calls the session API the CLI itself uses: GET /api/session?parentID=…
async function fetchChildSessions(parentID: string, limit = 50): Promise<SessionDetail[]> {
  const state = readServiceState()
  const endpoint = new URL("/api/session", state.url)
  endpoint.searchParams.set("parentID", parentID)
  endpoint.searchParams.set("limit", String(limit))

  const response = await fetch(endpoint, {
    headers: { Authorization: `Basic ${btoa(`opencode:${state.password}`)}` },
  })
  if (!response.ok) {
    throw new Error(`Session API error ${response.status}: ${await response.text()}`)
  }

  const payload: unknown = await response.json()
  const data = typeof payload === "object" && payload !== null ? Reflect.get(payload, "data") : undefined
  if (!isSessionList(data)) {
    throw new Error("Session API returned an unexpected payload")
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

  const summary = s.summary ?? {}
  const chg =
    (summary.additions || 0) + (summary.deletions || 0) > 0 ? ` +${summary.additions}-${summary.deletions}` : ""

  const lifetime = s.time?.updated && s.time?.created ? s.time.updated - s.time.created : Number.NaN

  return `${s.id} [${agent}] ${title} | ${cost} ${model} | ${tokStr}${chg} | ${formatDuration(lifetime)}`
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
            const children = await fetchChildSessions(sessionID)
            if (children.length === 0) {
              return { content: `No subagent sessions found for current session (${sessionID}).` }
            }

            const lines = children.map(formatSessionLine)
            return { content: `${children.length}:\n${lines.join("\n")}` }
          } catch (err) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
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
          const sessionID = (args as any).session_id ?? (context as any).sessionID

          if ((context as any).signal?.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!sessionID || !sessionID.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${sessionID}" — must start with "ses_"`)
          }

          try {
            const session = (await ctx.session.get({ sessionID })) as SessionDetail
            if (!session) {
              throw new Error(`Not Found: Session not found.`)
            }

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
              // V2 context() takes no limit — fetch all, then keep the most
              // recent 1000 client-side so the <1000 freshness check below
              // keeps its V1 meaning (1000 → possibly truncated → skip).
              const allMessages = ((await ctx.session.context({ sessionID })) as any) || []
              const messages = allMessages.slice(-1000)
              // API returns messages oldest-first; the most recent is last.
              // If we hit the limit the window is truncated -> data may be stale,
              // so skip rather than report wrong numbers.
              if (messages.length > 0 && messages.length < 1000) {
                for (let i = messages.length - 1; i >= 0; i--) {
                  const m = messages[i]
                  const tk = m?.info?.tokens ?? (m as any)?.tokens
                  if (
                    m?.info?.role === "assistant" &&
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
              }
            } catch {
              // non-critical; fall back to N/A
            }

            // Fetch context window size from the model domain (Model.Info.limit.context).
            let contextLimit = 0
            if (providerID && modelID && modelID !== "unknown") {
              try {
                const models = ((await ctx.model.list()) as any[]) ?? []
                const match = models.find((m: any) => m?.providerID === providerID && m?.id === modelID)
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

            const additions = session.summary?.additions ?? 0
            const deletions = session.summary?.deletions ?? 0
            const files = session.summary?.files ?? 0

            const permissions = session.permission
              ? session.permission.map((p: any) => `  ${p.permission}: ${p.action} (${p.pattern})`).join("\n")
              : "  none"

            const elapsed = (session.time?.created && session.time?.updated)
              ? session.time.updated - session.time.created
              : NaN

            return {
              content: `ID: ${session.id}
Title: ${title}
Slug: ${session.slug || "N/A"}
Version: ${session.version || "N/A"}
Agent: ${agent}
Model: ${providerID}/${modelID} (${variant})
Directory: ${session.directory || "N/A"}
Created: ${created}
Updated: ${updated}
Elapsed: ${formatDuration(elapsed)}
Cost: ${cost}
Tokens (cumulative): ${(session.tokens?.input || 0)} input / ${(session.tokens?.output || 0)} output / ${(session.tokens?.reasoning || 0)} reasoning | Cache: ${(session.tokens?.cache?.read || 0)} read / ${(session.tokens?.cache?.write || 0)} write
Tokens (current): ${hasCurrentTokens ? `${input} input / ${output} output / ${reasoning} reasoning | Cache: ${cacheRead} read / ${cacheWrite} write` : "N/A"}
Context: ${hasCurrentTokens && contextLimit > 0 ? `${occupancy}/${contextLimit} (${contextPercent})` : "N/A"}
Code changes: +${additions} -${deletions} (${files} files)
Parent: ${session.parentID || "none (root session)"}
Permissions: ${permissions}`,
            }
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
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
          const { session_id } = args as any
          const limit = Math.min((args as any).limit || 10, 100)

          if ((context as any).signal?.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!session_id.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${session_id}" — must start with "ses_"`)
          }

          try {
            // V2 context() takes no limit — fetch all, then keep the most
            // recent `limit` client-side.
            const allMessages = ((await ctx.session.context({ sessionID: session_id })) as any) || []
            const messages = allMessages.slice(-limit)
            if (!Array.isArray(messages) || messages.length === 0) {
              return { content: `No messages found.` }
            }

            // Count by role
            let userCount = 0
            let assistantCount = 0
            for (const m of messages) {
              const role = m.info?.role || "unknown"
              if (role === "user") userCount++
              else assistantCount++
            }

            const lines = messages.map((m: any, idx: number) => {
              const info = m.info || m
              const parts = m.parts || []
              const role = info.role || "unknown"
              const created = info.time?.created
              const timestamp = formatDate(created)

              // Estimate duration from created time to next message
              let duration = ""
              if (created) {
                const nextCreated = idx < messages.length - 1
                  ? messages[idx + 1]?.info?.time?.created
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

              // Extract text content from parts
              const textParts = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text || "")
                .join("\n")

              const content = textParts || "[no text content]"
              const preview = content.length > 200
                ? content.substring(0, 200) + "..."
                : content

              return `[${role}] ${timestamp}${duration}
${preview}`
            })

            return { content: `Total: ${messages.length} messages | User: ${userCount} | Assistant: ${assistantCount}\n\n${lines.join("\n\n")}` }
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
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
            // Durable admission: compaction runs at the session's next step
            // boundary, not synchronously.
            const admitted: unknown = await ctx.session.compact({ sessionID })
            const inboxID = stringField(admitted, "id") ?? "unknown"
            const delivery = stringField(admitted, "delivery") ?? "default"

            return {
              content: `Compaction admitted: ${sessionID}
Inbox: ${inboxID} (${delivery})`,
            }
          } catch (err) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
          }
        },
      })
    })
  },
})
