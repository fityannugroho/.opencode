import { type Plugin, tool } from "@opencode-ai/plugin"
import { type Session } from "@opencode-ai/sdk"

// Extra fields returned by API but missing from SDK Session type
type SessionDetail = Session & {
  slug?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
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

// Helper: extract message from API error
function getErrorMessage(error: any): string {
  return error.data?.message ?? error.message ?? JSON.stringify(error)
}

// Helper: handle API error result — throws Error for all error types
// so the AI SDK propagates it as a tool-error event and processor.ts
// renders state.status = "error" with the message in the UI.
function handleApiError(result: { error?: any }): void {
  if (!result.error) return

  const error = result.error

  // NotFoundError: has "name" property equal to "NotFoundError"
  if ("name" in error && error.name === "NotFoundError") {
    throw new Error(`Not Found: ${error.data?.message ?? "resource does not exist"}`)
  }

  // BadRequestError: has "errors" field
  if ("errors" in error) {
    const rawErrors = error.errors
    const detail = Array.isArray(rawErrors) && rawErrors.length
      ? rawErrors.map((e: any) => Object.values(e).join(": ")).join("; ")
      : JSON.stringify(error.data ?? rawErrors)
    throw new Error(`Bad Request: ${detail}`)
  }

  // Other errors (UnknownError etc): throw extracted message
  throw new Error(`Unexpected Error: ${getErrorMessage(error)}`)
}

// Helper: format session info (compact, single line)
function formatSession(s: any): string {
  const agent = s.agent || "?"
  const title = (s.title || "untitled")
  const cost = s.cost !== undefined && s.cost !== null ? `$${Number(s.cost).toFixed(4)}` : "free"
  const model = s.model?.id || "?"

  const tokens = s.tokens || {}
  const tokStr = `${tokens.input || 0}i/${tokens.output || 0}o (cumulative)`

  const summary = s.summary || {}
  const chg = (summary.additions || 0) + (summary.deletions || 0) > 0
    ? ` +${summary.additions}-${summary.deletions}`
    : ""

  return `${s.id} [${agent}] ${title} | ${cost} ${model} | ${tokStr}${chg} | ${formatDuration(s.time?.updated && s.time?.created ? s.time.updated - s.time.created : NaN)}`
}

export const TaskToolsPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      // ============================================
      // subagent-sessions: List child sessions
      // ============================================
      "subagent-sessions": tool({
        description: "List all subagent sessions spawned by the current session (IDs, titles, costs, etc.)",
        args: {},
        async execute(args, context) {
          const { sessionID } = context

          if (context.abort.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          try {
            const result = await client.session.children({
              path: { id: sessionID },
            })

            handleApiError(result)

            const children = result.data || []
            if (!Array.isArray(children) || children.length === 0) {
              return `No subagent sessions found for current session (${sessionID}).`
            }

            const lines = children.map(formatSession)
            return `${children.length}:\n${lines.join("\n")}`
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
          }
        },
      }),

      // ============================================
      // session-detail: Get session details
      // ============================================
      "session-detail": tool({
        description: "Get detailed info about a specific session (token usage, context limit, permissions, etc.)",
        args: {
          session_id: tool.schema.string().optional().describe("Session ID/Task ID to check (Defaults to current session)"),
        },
        async execute(args, context) {
          const sessionID = args.session_id ?? context.sessionID

          if (context.abort.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!sessionID || !sessionID.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${sessionID}" — must start with "ses_"`)
          }

          try {
            const result = await client.session.get({
              path: { id: sessionID },
            })

            handleApiError(result)

            const session = result.data as SessionDetail
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
              const msgResult = await client.session.messages({
                path: { id: sessionID },
                query: { limit: 1000 },
              })
              handleApiError(msgResult)

              const messages = (msgResult.data || []) as any[]
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

            // Fetch context window size from provider
            let contextLimit = 0
            if (providerID && modelID && modelID !== "unknown") {
              try {
                const providerResult = await client.provider.list()
                handleApiError(providerResult)

                const providers = providerResult.data?.all || []
                const providerData = providers.find((p: any) => p.id === providerID)

                if (providerData) {
                  const modelInfo = providerData.models[modelID]
                  if (modelInfo?.limit?.context) {
                    contextLimit = modelInfo.limit.context
                  }
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

            return `ID: ${session.id}
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
Permissions: ${permissions}`
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
          }
        },
      }),

      // ============================================
      // session-messages: Get session chat history
      // ============================================
      "session-messages": tool({
        description: "Get chat history of a session",
        args: {
          session_id: tool.schema.string().describe("Session ID/Task ID"),
          limit: tool.schema.number().optional().describe("Messages to show (default: 10; max: 100)"),
        },
        async execute(args, context) {
          const { session_id } = args
          const limit = Math.min(args.limit || 10, 100)

          if (context.abort.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!session_id.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${session_id}" — must start with "ses_"`)
          }

          try {
            const result = await client.session.messages({
              path: { id: session_id },
              query: { limit },
            })

            handleApiError(result)

            const messages = result.data || []
            if (!Array.isArray(messages) || messages.length === 0) {
              return `No messages found.`
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

            return `Total: ${messages.length} messages | User: ${userCount} | Assistant: ${assistantCount}\n\n${lines.join("\n\n")}`
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
          }
        },
      }),

      // ============================================
      // session-compact: Trigger session compaction
      // ============================================
      "session-compact": tool({
        description: "Compact a session by summarizing its conversation.",
        args: {
          session_id: tool.schema.string().describe("Session ID/Task ID to compact"),
        },
        async execute(args, context) {
          const { session_id } = args

          if (context.abort.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }

          if (!session_id.startsWith("ses_")) {
            throw new Error(`Bad Request: Invalid session ID "${session_id}" — must start with "ses_"`)
          }

          // Prevent self-compaction (would cause race condition)
          if (session_id === context.sessionID) {
            throw new Error(`Bad Request: Cannot compact the current session. Use session-compact on child sessions instead.`)
          }

          try {
            // Fetch session to get model info
            const sessionResult = await client.session.get({
              path: { id: session_id },
            })

            handleApiError(sessionResult)

            const session = sessionResult.data as SessionDetail
            if (!session) {
              throw new Error(`Not Found: Session not found.`)
            }

            const modelID = session.model?.id
            const providerID = session.model?.providerID

            if (!modelID || !providerID) {
              throw new Error(`Bad Request: Session has no model information. Cannot compact.`)
            }

            // Trigger compaction
            const summarizeResult = await client.session.summarize({
              path: { id: session_id },
              body: {
                providerID,
                modelID,
              },
            })

            handleApiError(summarizeResult)

            const success = summarizeResult.data
            if (success === false) {
              throw new Error(`Compaction failed for session ${session_id}.`)
            }

            return `Compacted: ${session_id}
Model: ${providerID}/${modelID}`
          } catch (err: any) {
            if (err instanceof Error) throw err
            throw new Error(String(err))
          }
        },
      }),
    },
  }
}
