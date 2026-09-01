import { type Plugin, tool } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

interface Reminder {
  id: string
  message: string
  sessionId: string
  createdAt: number
  scheduledAt: number
}

const DB_DIR = join(homedir(), ".local", "share", "opencode", "reminder")
const DB_PATH = join(DB_DIR, "reminders.db")

const MAX_TIMEOUT_DELAY = 2_147_483_647 // ~24.85 days
let recoveredIds = new Set<string>()

function setSafeTimeout(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
  if (delay > MAX_TIMEOUT_DELAY) {
    return setTimeout(() => setSafeTimeout(fn, delay - MAX_TIMEOUT_DELAY), MAX_TIMEOUT_DELAY)
  }
  return setTimeout(fn, delay)
}

function genId(): string {
  return `rem_${Date.now().toString(36)}`
}

let _db: Database | null = null

function getDb(): Database {
  if (!_db) {
    mkdirSync(DB_DIR, { recursive: true })
    _db = new Database(DB_PATH)
    _db.exec("PRAGMA journal_mode=WAL")
    _db.run(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      scheduledAt INTEGER NOT NULL
    )`)
  }
  return _db
}

function loadAll(): Reminder[] {
  try {
    return getDb().query("SELECT * FROM reminders").all() as Reminder[]
  } catch {
    return []
  }
}

function addOne(r: Reminder): void {
  getDb().run(
    "INSERT INTO reminders (id, message, sessionId, createdAt, scheduledAt) VALUES (?, ?, ?, ?, ?)",
    [r.id, r.message, r.sessionId, r.createdAt, r.scheduledAt],
  )
}

function delOne(id: string): void {
  getDb().run("DELETE FROM reminders WHERE id = ?", [id])
}

function loadBySession(sessionId: string): Reminder[] {
  try {
    return getDb().query("SELECT * FROM reminders WHERE sessionId = ?").all(sessionId) as Reminder[]
  } catch {
    return []
  }
}

function exists(id: string): boolean {
  try {
    return getDb().query("SELECT 1 FROM reminders WHERE id = ?").get(id) !== null
  } catch {
    return false
  }
}

function parseTime(raw: string): number | null {
  const rel = raw.match(/^\+(\d+)([smhd])$/)
  if (rel) {
    const n = parseInt(rel[1])
    const u = rel[2]
    const mul: Record<string, number> = {
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
    }
    return Date.now() + n * (mul[u] ?? 0)
  }
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.getTime()
}

function relTime(ts: number): string {
  const d = ts - Date.now()
  if (d <= 0) return "now"
  if (d < 60000) return `~${Math.round(d / 1000)}s`
  if (d < 3600000) return `~${Math.floor(d / 60000)}m ${Math.round((d % 60000) / 1000)}s`
  if (d < 86400000) return `~${Math.floor(d / 3600000)}h ${Math.floor((d % 3600000) / 60000)}m`
  return new Date(ts).toLocaleString()
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function formatReminder(r: Reminder): string {
  return `<reminder>
  <id>${r.id}</id>
  <message>${escapeXml(r.message)}</message>
</reminder>`
}

async function deliver(client: any, r: Reminder): Promise<boolean> {
  try {
    await client.session.promptAsync({
      path: { id: r.sessionId },
      body: {
        parts: [{ type: "text", text: formatReminder(r) }],
      },
    })
    return true
  } catch (e: any) {
    await client.app
      .log({
        body: {
          service: "reminder",
          level: "error",
          message: `Failed to deliver reminder ${r.id}: ${e?.message ?? e}`,
          extra: { reminderId: r.id },
        },
      })
      .catch(() => {})
    return false
  }
}

async function assertPrimaryAgent(client: any, sessionId: string): Promise<void> {
  const res = await client.session.get({ path: { id: sessionId } })
  if ((res.data as Record<string, unknown> | undefined)?.parentID) {
    throw new Error("Forbidden: This tool is only available to the primary agent")
  }
}

export const ReminderPlugin: Plugin = async ({ client }) => {
  try {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const now = Date.now()
    const all = loadAll()
    const overdue: Reminder[] = []

    for (const r of all) {
      if (recoveredIds.has(r.id)) continue
      recoveredIds.add(r.id)
      const delay = r.scheduledAt - now
      if (delay <= 0) {
        overdue.push(r)
      } else {
        const t = setSafeTimeout(async () => {
          const ok = await deliver(client, r)
          if (ok) delOne(r.id)
          timers.delete(r.id)
          recoveredIds.delete(r.id)
        }, delay)
        timers.set(r.id, t)
      }
    }

    if (overdue.length > 0) {
      Promise.all(overdue.map((r) => deliver(client, r))).then(
        (results) => {
          for (let i = 0; i < results.length; i++) {
            if (results[i]) delOne(overdue[i].id)
          }
        },
      )
    }

    return {
      tool: {
        "set-reminder": tool({
          description:
            "Schedule a reminder. When time arrives it is sent as a user message to this session. " +
            "Format examples: +5m, +2h, +30s, +1d or ISO 8601 like 2026-07-16T15:00.",
          args: {
            message: tool.schema.string().describe("Reminder message to be delivered"),
            time: tool.schema.string().describe(
              "Time format: +5m (5 minutes), +2h (2 hours), +30s (30 seconds), +1d (1 day), " +
                "or absolute ISO 8601 like 2026-07-16T15:00",
            ),
          },
          async execute(args, context) {
            if (context.abort.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            await assertPrimaryAgent(client, context.sessionID)
            const { message, time } = args
            if (!message?.trim()) throw new Error("Bad Request: Message is required")
            if (!time?.trim()) throw new Error("Bad Request: Time is required")

            const scheduledAt = parseTime(time.trim())
            if (!scheduledAt) {
              throw new Error(
                `Bad Request: Invalid time format "${time}" — use +Nunit (e.g. +5m, +2h, +30s, +1d) or ISO 8601 (e.g. 2026-07-16T15:00)`,
              )
            }
            if (scheduledAt <= Date.now()) {
              throw new Error(`Bad Request: Time is in the past — ${new Date(scheduledAt).toISOString()}`)
            }

            const reminder: Reminder = {
              id: genId(),
              message: message.trim(),
              sessionId: context.sessionID,
              createdAt: Date.now(),
              scheduledAt,
            }
            addOne(reminder)

            const delay = scheduledAt - Date.now()
            const timer = setSafeTimeout(async () => {
              await deliver(client, reminder)
              delOne(reminder.id)
              timers.delete(reminder.id)
            }, delay)
            timers.set(reminder.id, timer)

            return `Reminder set: ${reminder.id}
Message: ${reminder.message}
Time:    ${relTime(scheduledAt)} (${new Date(scheduledAt).toLocaleString()})`
          },
        }),
        "reminders": tool({
          description: "List all pending reminders for this session.",
          args: {},
          async execute(_args, context) {
            if (context.abort.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            await assertPrimaryAgent(client, context.sessionID)
            const list = loadBySession(context.sessionID)
            if (list.length === 0) return "No pending reminders."
            const lines = list.map((r) => `  ${r.id} | ${r.message} | ${relTime(r.scheduledAt)}`)
            return `Pending reminders (${list.length}):\n${lines.join("\n")}`
          },
        }),
        "cancel-reminder": tool({
          description: "Cancel a pending reminder by its ID so it won't be delivered.",
          args: {
            id: tool.schema.string().describe("The reminder ID to cancel (e.g. rem_xxx)"),
          },
          async execute(args, context) {
            if (context.abort.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            await assertPrimaryAgent(client, context.sessionID)
            const { id } = args
            if (!id?.trim()) throw new Error("Bad Request: Reminder ID is required")

            if (!exists(id)) {
              throw new Error(`Not Found: Reminder "${id}" does not exist`)
            }

            // Clear in-memory timer if still running
            const timer = timers.get(id)
            if (timer !== undefined) {
              clearTimeout(timer)
              timers.delete(id)
            }

            // Remove from persistence
            delOne(id)
            recoveredIds.delete(id)

            return `Reminder cancelled: ${id}`
          },
        }),
        "time-now": tool({
          description: "Get the current date and time accurately. Use this when you need to know what time it is right now.",
          args: {},
          async execute(_args, context) {
            if (context.abort.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            return new Date().toISOString()
          },
        }),
      },
    }
  } catch (err: any) {
    console.error("[reminder] factory error:", err?.message ?? err)
    throw err
  }
}
