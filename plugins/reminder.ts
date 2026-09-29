import { Plugin } from "@opencode/plugin"
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

async function deliver(ctx: any, r: Reminder): Promise<boolean> {
  try {
    await ctx.session.prompt({
      sessionID: r.sessionId,
      text: formatReminder(r),
    })
    return true
  } catch (e: any) {
    console.error(`[reminder] Failed to deliver reminder ${r.id}: ${e?.message ?? e}`)
    return false
  }
}

async function assertPrimaryAgent(ctx: any, sessionId: string): Promise<void> {
  const session = (await ctx.session.get({ sessionID: sessionId })) as Record<string, unknown> | undefined
  if (session?.parentID) {
    throw new Error("Forbidden: This tool is only available to the primary agent")
  }
}

export default Plugin.define({
  id: "reminder",
  async setup(ctx) {
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
            const ok = await deliver(ctx, r)
            if (ok) delOne(r.id)
            timers.delete(r.id)
            recoveredIds.delete(r.id)
          }, delay)
          timers.set(r.id, t)
        }
      }

      if (overdue.length > 0) {
        Promise.all(overdue.map((r) => deliver(ctx, r))).then(
          (results) => {
            for (let i = 0; i < results.length; i++) {
              if (results[i]) delOne(overdue[i].id)
            }
          },
        )
      }

      await ctx.tool.transform((editor) => {
        editor.add({
          name: "set-reminder",
          description:
            "Schedule a reminder. When time arrives it is sent as a user message to this session. " +
            "Format examples: +5m, +2h, +30s, +1d or ISO 8601 like 2026-07-16T15:00.",
          input: {
            type: "object",
            properties: {
              message: { type: "string", description: "Reminder message to be delivered" },
              time: {
                type: "string",
                description:
                  "Time format: +5m (5 minutes), +2h (2 hours), +30s (30 seconds), +1d (1 day), " +
                  "or absolute ISO 8601 like 2026-07-16T15:00",
              },
            },
            required: ["message", "time"],
            additionalProperties: false,
          },
          async execute(input, context) {
            if ((context as any).signal?.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            const sessionID = (context as any).sessionID as string
            await assertPrimaryAgent(ctx, sessionID)
            const { message, time } = input as { message?: string; time?: string }
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
              sessionId: sessionID,
              createdAt: Date.now(),
              scheduledAt,
            }
            addOne(reminder)

            const delay = scheduledAt - Date.now()
            const timer = setSafeTimeout(async () => {
              await deliver(ctx, reminder)
              delOne(reminder.id)
              timers.delete(reminder.id)
            }, delay)
            timers.set(reminder.id, timer)

            return {
              content: `Reminder set: ${reminder.id}
Message: ${reminder.message}
Time:    ${relTime(scheduledAt)} (${new Date(scheduledAt).toLocaleString()})`,
            }
          },
        })
        editor.add({
          name: "reminders",
          description: "List all pending reminders for this session.",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async execute(_input, context) {
            if ((context as any).signal?.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            const sessionID = (context as any).sessionID as string
            await assertPrimaryAgent(ctx, sessionID)
            const list = loadBySession(sessionID)
            if (list.length === 0) return { content: "No pending reminders." }
            const lines = list.map((r) => `  ${r.id} | ${r.message} | ${relTime(r.scheduledAt)}`)
            return { content: `Pending reminders (${list.length}):\n${lines.join("\n")}` }
          },
        })
        editor.add({
          name: "cancel-reminder",
          description: "Cancel a pending reminder by its ID so it won't be delivered.",
          input: {
            type: "object",
            properties: {
              id: { type: "string", description: "The reminder ID to cancel (e.g. rem_xxx)" },
            },
            required: ["id"],
            additionalProperties: false,
          },
          async execute(input, context) {
            if ((context as any).signal?.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            const sessionID = (context as any).sessionID as string
            await assertPrimaryAgent(ctx, sessionID)
            const { id } = input as { id?: string }
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

            return { content: `Reminder cancelled: ${id}` }
          },
        })
        editor.add({
          name: "time-now",
          description: "Get the current date and time accurately. Use this when you need to know what time it is right now.",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async execute(_input, context) {
            if ((context as any).signal?.aborted) {
              throw new Error("Aborted: Tool execution has been aborted.")
            }
            return { content: new Date().toISOString() }
          },
        })
      })

      return () => {
        for (const t of timers.values()) clearTimeout(t)
        timers.clear()
      }
    } catch (err: any) {
      console.error("[reminder] factory error:", err?.message ?? err)
      throw err
    }
  },
})
