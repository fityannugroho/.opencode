import { type Plugin, tool } from "@opencode-ai/plugin"

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
const DDG_REFERER = "https://html.duckduckgo.com/"
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

interface DdgResult {
  title: string
  url: string
  snippet: string
  date?: string
}

function clampCount(count: unknown): number {
  const n = typeof count === "number" ? Math.floor(count) : DEFAULT_COUNT
  if (!Number.isFinite(n)) return DEFAULT_COUNT
  return Math.min(Math.max(n, 1), MAX_COUNT)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
}

// Decode common HTML entities (does not execute HTML).
function decodeHtmlText(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return _
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10))
      } catch {
        return _
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
}

function stripTags(input: string): string {
  return decodeHtmlText(input.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

// Unwrap Duckduckgo redirect links (//duckduckgo.com/l/?uddg=<encoded>&...).
// Bounded decode loop (max 3 iterations): after each decode, stop when the
// value starts with http(s) AND contains no `%25` (double-encoded percent),
// stop early when decoding throws or changes nothing, and validate the
// final value as an http(s) URL afterward. This handles both conventional
// double-encoded values (`https%253A%252F%252Fexample.com` decodes twice to
// `https://example.com`) and singly-encoded targets with their own escapes
// (`.../a%2Fb` stops after one decode and is never corrupted to `.../a/b`).
// Returns the http(s) target or null when the href is not a usable result.
function unwrapDdgUrl(rawHref: string): string | null {
  const href = rawHref.replace(/&amp;/g, "&").trim()
  // A raw newline in an href is never legitimate; reject it so a quoted
  // href containing one can never be emitted verbatim into results.
  if (/[\r\n]/.test(href)) return null
  const uddg = href.match(/[?&]uddg=([^&]*)/)
  if (uddg) {
    let target = uddg[1]
    for (let i = 0; i < 3; i++) {
      if (/^https?:\/\//i.test(target) && !target.includes("%25")) break
      let next: string
      try {
        next = decodeURIComponent(target)
      } catch {
        break
      }
      if (next === target) break
      target = next
      // Revalidate after every decode step: escapes like %0A become
      // literal newlines only here, so the raw-href check above cannot
      // see them. A target with a newline is never emitted.
      if (/[\r\n]/.test(target)) return null
    }
    if (/^https?:\/\//i.test(target)) return target
    return null
  }
  if (/^\/\//.test(href)) return `https:${href}`
  if (/^https?:\/\//i.test(href)) return href
  return null
}

// Attribute-order-independent anchor scan: captures the raw attribute string
// and inner HTML separately so `class`/`href` may appear in any order with
// single or double quotes.
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi

function hasResultLinkClass(attrs: string): boolean {
  const m = attrs.match(/(?:^|\s)class\s*=\s*(["'])([^"']*)\1/i)
  return m ? m[2].split(/\s+/).includes("result__a") : false
}

function extractHref(attrs: string): string {
  const m = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : ""
}

// Snippet matcher tolerant of tag changes: any tag name (backreferenced
// close tag), attributes in any order, single/double-quoted class.
// Snippets may be absent or use an unknown variant; an empty snippet is
// kept silent (no placeholder) to keep output compact.
function extractSnippet(scope: string): string {
  const m = scope.match(
    /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bresult__snippet\b[^"']*\2[^>]*>([\s\S]*?)<\/\1>/i,
  )
  return m ? stripTags(m[3]) : ""
}

// Published-date extractor: looks only inside the result's
// `result__extras__url` container for a bare `<span>` holding a
// date-shaped value (e.g. `2026-07-30...`), so date-shaped text elsewhere
// (snippets, or a span after the container's closing tag) is never
// mistaken for publication metadata. Only attribute-free `<span>`
// elements qualify (snippet spans carry classes), and the text must start
// with YYYY-MM-DD. Returns "" when absent, in which case the caller omits
// the date line.
function extractDate(scope: string): string {
  const container = scope.match(
    /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bresult__extras__url\b[^"']*\2[^>]*>([\s\S]*?)<\/\1>/i,
  )
  if (!container) return ""
  // Bound the scan to content strictly inside the container: a date span
  // after its closing tag (e.g. an empty container followed by
  // `<span>2026-07-30</span>`) is not publication metadata.
  const span = container[3].match(/<span>([^<>]{1,64})<\/span>/i)
  if (!span) return ""
  const text = stripTags(span[1])
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : ""
}

// Collect lowercased input names from a form's inner HTML (attribute
// order varies, so each tag is parsed independently).
function formInputNames(formInner: string): Set<string> {
  const names = new Set<string>()
  for (const input of formInner.matchAll(/<input\b[^>]*>/gi)) {
    const name = input[0].match(/(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!name) continue
    const key = decodeHtmlText(name[1] ?? name[2] ?? name[3] ?? "")
    if (key) names.add(key.toLowerCase())
  }
  return names
}

// Decoded value of the named input inside a form's inner HTML (attribute
// order varies, so each tag is parsed independently), or null when absent.
function formInputValue(formInner: string, wanted: string): string | null {
  for (const input of formInner.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0]
    const name = tag.match(/(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!name) continue
    if (decodeHtmlText(name[1] ?? name[2] ?? name[3] ?? "").toLowerCase() !== wanted) continue
    const value = tag.match(/(?:^|\s)value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    return decodeHtmlText(value ? (value[1] ?? value[2] ?? value[3] ?? "") : "")
  }
  return null
}

// Extract DDG's continuation form as an encoded POST body for the next
// page request. All `<form>…</form>` blocks are scored (forms never nest,
// so page-wide matching stays robust when wrapper divs would truncate a
// container match): `nextParams` presence stays the first-priority
// criterion, but among `nextParams` forms the one with the largest numeric
// `s` wins (ties → last in document order) — DDG emits a Previous form
// (`s=0`) before the Next form, which must never win. Without
// `nextParams`, the same largest-`s` rule applies to `s`+`vqd` forms,
// since the next page always carries the furthest offset — never blindly
// the first form, since a prev form would walk pagination backwards into
// all-duplicate pages. Only
// when no such form exists is the legacy container shape (the form inside
// `div.nav-link`) used as a fallback. Each `<input>` tag's name/value is
// parsed independently since attribute order varies, and HTML entities are
// decoded first so values like `fish &amp; chips` survive into the next
// request uncorrupted. First-page keys the form omits (`q`, `kl`, `b`) are
// carried over from the first request body instead of being dropped (form
// values win when present). Returns null when no continuation form with
// named inputs exists.
function extractContinuation(html: string, firstBody: string): string | null {
  const scored = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].map((f) => ({
    inner: f[1],
    names: formInputNames(f[1]),
  }))
  let inner: string | null = null
  {
    // First priority: forms carrying nextParams — but select the largest
    // numeric s among them (ties → last), else the s+vqd fallback below.
    const withNext = scored.filter((f) => f.names.has("nextparams"))
    const candidates =
      withNext.length > 0
        ? withNext
        : scored.filter((f) => f.names.has("s") && f.names.has("vqd"))
    // The next page carries the furthest offset; a prev form (smaller s)
    // must never win.
    let furthestS = -Infinity
    for (const f of candidates) {
      const s = Number(formInputValue(f.inner, "s"))
      if (!Number.isFinite(s)) continue
      if (s >= furthestS) {
        furthestS = s
        inner = f.inner
      }
    }
  }
  if (inner === null) {
    // Fallback: legacy container shape. Matching the whole container
    // would stop at the first inner `</div>`, cutting forms that wrap
    // inputs in divs — so instead locate the container's opening tag and
    // match the first complete form at or after it (forms never nest,
    // like the primary path above).
    const containerOpen = html.match(
      /<div\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bnav-link\b[^"']*\1[^>]*>/i,
    )
    const legacy =
      containerOpen && containerOpen.index !== undefined
        ? html
            .slice(containerOpen.index + containerOpen[0].length)
            .match(/<form\b[^>]*>([\s\S]*?)<\/form>/i)
        : null
    if (!legacy) return null
    inner = legacy[1]
  }
  const params = new URLSearchParams()
  for (const input of inner.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0]
    const name = tag.match(/(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (!name) continue
    const key = decodeHtmlText(name[1] ?? name[2] ?? name[3] ?? "")
    if (!key) continue
    const value = tag.match(/(?:^|\s)value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    params.append(key, decodeHtmlText(value ? (value[1] ?? value[2] ?? value[3] ?? "") : ""))
  }
  const first = new URLSearchParams(firstBody)
  for (const key of ["q", "kl", "b"]) {
    if (!params.has(key)) {
      const carried = first.get(key)
      if (carried !== null) params.set(key, carried)
    }
  }
  const body = params.toString()
  return body ? body : null
}

// Parse static Duckduckgo html result blocks via regex (no DOM, no script execution).
// Primary path is one block per result wrapper div (quote-tolerant); the
// fallback path scans title anchors page-wide whenever the primary path
// produced zero results, so renamed wrappers or renamed title classes
// still fall back instead of a false "No results found". Only when both
// paths find nothing is it a true zero-result page.
function parseDdgHtml(html: string, count: unknown = DEFAULT_COUNT): DdgResult[] {
  const limit = clampCount(count)
  const results: DdgResult[] = []
  const seen = new Set<string>()
  const pushCandidate = (attrs: string, inner: string, scope: string): void => {
    if (results.length >= limit) return
    if (!hasResultLinkClass(attrs)) return
    const url = unwrapDdgUrl(extractHref(attrs))
    if (!url || seen.has(url)) return
    const titleText = stripTags(inner)
    if (!titleText) return
    seen.add(url)
    const snippet = extractSnippet(scope)
    const date = extractDate(scope)
    results.push(date ? { title: titleText, url, snippet, date } : { title: titleText, url, snippet })
  }
  const blockRe =
    /<div\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bresult\b[^"']*\1[^>]*>([\s\S]*?)(?=<div\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bresult\b[^"']*\3|<div\b[^>]*?(?:^|\s)class\s*=\s*(["'])[^"']*\bnav-link\b[^"']*\4|$)/gi
  const blocks = [...html.matchAll(blockRe)]
  for (const block of blocks) {
    if (results.length >= limit) break
    const scope = block[2]
    const anchors = [...scope.matchAll(ANCHOR_RE)]
    // Each title anchor gets its own region (up to the next title anchor
    // in the block, capped), so multiple titles in one block each pick up
    // their own nearest snippet instead of sharing the block's first one.
    const titleStarts = anchors.filter((a) => hasResultLinkClass(a[1])).map((a) => a.index ?? 0)
    for (const anchor of anchors) {
      if (results.length >= limit) break
      const anchorStart = anchor.index ?? 0
      const anchorEnd = anchorStart + anchor[0].length
      const nextTitle = titleStarts.find((s) => s > anchorStart) ?? scope.length
      const region = scope.slice(anchorEnd, Math.min(nextTitle, anchorEnd + 3000))
      pushCandidate(anchor[1], anchor[2], region)
    }
  }
  if (results.length === 0) {
    const anchors = [...html.matchAll(ANCHOR_RE)]
    // Title-anchor starts delimit result regions. Snippets are commonly
    // `<a class="result__snippet">` anchors, so regions end at the next
    // TITLE anchor (not the next anchor of any type) to keep each
    // snippet inside its own result's scope.
    const titleStarts = anchors.filter((a) => hasResultLinkClass(a[1])).map((a) => a.index ?? 0)
    for (let i = 0; i < anchors.length; i++) {
      if (results.length >= limit) break
      const anchor = anchors[i]
      const anchorStart = anchor.index ?? 0
      const anchorEnd = anchorStart + anchor[0].length
      const nextTitle = titleStarts.find((s) => s > anchorStart) ?? html.length
      const scope = html.slice(anchorEnd, Math.min(nextTitle, anchorEnd + 3000))
      pushCandidate(anchor[1], anchor[2], scope)
    }
  }
  return results
}

function isChallengeHtml(html: string): boolean {
  // Challenge tokens match only inside tag markup (attributes), never in
  // prose: a page <title>, header input value, or result title/snippet
  // mentioning e.g. "anomaly.js" must not falsely throw a throttle error
  // on HTTP 200 with valid results. Real challenge pages carry these
  // tokens as element id/class attributes or script asset URLs.
  if (
    /<\w+\b[^>]*(?:id|name|class)\s*=\s*["'][^"']*(?:anomaly-modal|challenge-form)[^"']*["']/i.test(
      html,
    ) ||
    /<script\b[^>]*\bsrc\s*=\s*["'][^"']*anomaly\.js[^"']*["']/i.test(html)
  ) {
    return true
  }
  // Bare "captcha" appears in genuine result text (e.g. a "captcha solver"
  // query on HTTP 200 with valid results), so it only counts as a
  // challenge when tied to challenge markup: a form tag mentioning
  // captcha, an input/div/iframe whose id/name/class mentions captcha, an
  // iframe whose src/title points at a captcha/recaptcha challenge asset
  // (e.g. google.com/recaptcha), or a script src pointing at a captcha
  // asset. Prose mentions never match.
  return /<form\b[^>]*captcha[^>]*>|<(?:input|div|iframe)\b[^>]*(?:id|name|class)\s*=\s*["'][^"']*captcha[^"']*["'][^>]*>|<iframe\b[^>]*(?:src|title)\s*=\s*["'][^"']*captcha[^"']*["'][^>]*>|<script\b[^>]*\bsrc\s*=\s*["'][^"']*captcha[^"']*["']/i.test(
    html,
  )
}

function mapRequestError(
  err: unknown,
  q: string,
  timeoutMs: number,
  opts: {
    callerAborted: boolean
    timeoutFired: boolean
    phase: "request" | "body"
    redirectNote: string
  },
): Error {
  if (opts.callerAborted) {
    return new Error(`Aborted: DuckDuckGo search was cancelled${opts.redirectNote} for query "${q}".`)
  }
  const name = (err as { name?: string } | null)?.name
  if (opts.timeoutFired || name === "TimeoutError" || name === "AbortError") {
    return new Error(
      `DuckDuckGo search timed out after ${timeoutMs}ms${opts.redirectNote} for query "${q}"`,
    )
  }
  const detail = err instanceof Error ? err.message : String(err)
  if (opts.phase === "body") {
    return new Error(
      `DuckDuckGo request failed while reading response body${opts.redirectNote}: ${detail}`,
    )
  }
  return new Error(`DuckDuckGo request failed${opts.redirectNote}: ${detail}`)
}

interface SearchOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

async function performDdgSearch(
  query: string,
  count: unknown = DEFAULT_COUNT,
  opts: SearchOptions = {},
): Promise<{ results: DdgResult[]; stoppedEarly: boolean }> {
  if (typeof query !== "string") {
    throw new Error("Bad Request: query must be a non-empty string")
  }
  const q = query.trim()
  if (!q) throw new Error("Bad Request: query must be a non-empty string")
  if (opts.signal?.aborted) {
    throw new Error("Aborted: DuckDuckGo search was cancelled before it started.")
  }
  const limit = clampCount(count)
  let timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Bad Request: timeoutMs must be a positive finite number of milliseconds")
  }
  // Clamp huge values: setTimeout overflows past 2^31-1ms and fires almost
  // immediately, which would contradict the timeout reported in errors.
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS
  const fetchFn = opts.fetchFn ?? fetch
  const firstBody = new URLSearchParams({ q, kl: "us-en", b: "" }).toString()

  // Combine the caller's cancellation signal with the hard timeout so an
  // active request stops on either. Timer and listener are always cleaned
  // up to avoid leaks.
  const callerSignal = opts.signal
  const combined = new AbortController()
  let timeoutFired = false
  const onCallerAbort = () => combined.abort()
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timeoutFired = true
    combined.abort()
  }, timeoutMs)
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    ;(timer as unknown as { unref: () => void }).unref()
  }
  // Re-check: the caller may have aborted between the pre-start check and
  // the listener wiring above (cleanup runs in finally).
  // Redirect metadata is page-local: constructed fresh after each fetch and
  // returned per request — before every response error path (body-read,
  // empty body, challenge, status) — so no error path can omit it or leak
  // a previous page's redirect URL into a later page's failure.
  const requestPage = async (
    params: string,
  ): Promise<{ res: Response; html: string; redirectNote: string }> => {
    let res: Response
    let phase: "request" | "body" = "request"
    let redirectNote = ""
    try {
      if (callerSignal?.aborted) {
        throw new Error("Aborted: DuckDuckGo search was cancelled before it started.")
      }
      res = await fetchFn(DDG_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: DDG_REFERER,
          // Browser-like headers reduce the Duckduckgo bot-challenge rate.
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
        body: params,
        signal: combined.signal,
      })
      redirectNote = res.redirected ? ` [redirected to ${res.url}]` : ""
      phase = "body"
      const html = await res.text()
      return { res, html, redirectNote }
    } catch (err) {
      throw mapRequestError(err, q, timeoutMs, {
        callerAborted: callerSignal?.aborted ?? false,
        timeoutFired,
        phase,
        redirectNote,
      })
    }
  }
  // Per-page response validation: empty body, challenge markup, and
  // status are checked for every page. A page-1 failure throws; a page ≥2
  // failure (including challenge) returns the collected results with the
  // early-stop note instead — only caller abort rethrows on later pages.
  const checkPage = (res: Response, html: string, redirectNote: string): void => {
    // An empty body is a failed fetch, never "No results found".
    if (!html.trim()) {
      throw new Error(
        `DuckDuckGo request failed: empty response body${redirectNote} for query "${q}".`,
      )
    }
    // Bot-challenge markup can accompany any status (including 403/429/503
    // challenge pages), so inspect the body before the status. A challenge
    // page is always an error — never "No results found".
    if (isChallengeHtml(html)) {
      throw new Error(
        `DuckDuckGo request was throttled (HTTP ${res.status} / bot-challenge response)${redirectNote} for query "${q}". Try again later.`,
      )
    }
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new Error(
        `DuckDuckGo request was throttled or temporarily blocked (HTTP ${res.status} / bot challenge)${redirectNote} for query "${q}". Try again later.`,
      )
    }
    if (!res.ok) {
      throw new Error(
        `DuckDuckGo request failed with HTTP ${res.status}${redirectNote} for query "${q}".`,
      )
    }
  }

  // Paginate through DDG's continuation form, following only the result
  // cap (max 20, default 10): keep fetching while collected results are
  // below the limit. Stops when enough results are collected, no
  // continuation form exists, or a page yields no new results (breaks to
  // avoid infinite loops; an all-duplicate later page simply returns the
  // results collected so far). URLs are deduped across pages. A page-1
  // failure throws as before, but any later-page failure (network, empty
  // body, challenge, bad status, total timeout) keeps the collected
  // results and flags them instead of discarding them; caller abort
  // always propagates. The single timeout/abort wiring above spans the
  // whole loop.
  const all: DdgResult[] = []
  const seen = new Set<string>()
  let stoppedEarly = false
  try {
    let params = firstBody
    for (let page = 1; ; page++) {
      let res: Response
      let html: string
      let redirectNote: string
      try {
        ;({ res, html, redirectNote } = await requestPage(params))
        checkPage(res, html, redirectNote)
      } catch (err) {
        // Page-1 failures and caller aborts always throw. A total-timeout
        // or any other failure on page ≥2 keeps the collected results with
        // the early-stop note, like every other late-page failure.
        if (page === 1 || callerSignal?.aborted) throw err
        stoppedEarly = true
        break
      }
      let newOnPage = 0
      for (const r of parseDdgHtml(html, MAX_COUNT)) {
        if (all.length >= limit) break
        if (seen.has(r.url)) continue
        seen.add(r.url)
        all.push(r)
        newOnPage++
      }
      if (all.length >= limit) break
      const next = extractContinuation(html, firstBody)
      if (!next) break
      if (newOnPage === 0) break
      params = next
    }
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener("abort", onCallerAbort)
  }
  return { results: all, stoppedEarly }
}

const PAGINATION_NOTE = "\n\nNote: pagination stopped early, showing partial results."
const MAX_SNIPPET_CHARS = 300
const MAX_QUERY_ECHO_CHARS = 500

// Bound an echoed query to whole code points (surrogate-safe), used only
// for the no-results message so a very long query can't bloat it. The
// all-results path echoes the full query uncapped, as intended.
function capQueryEcho(query: string): string {
  const points = [...query]
  if (points.length <= MAX_QUERY_ECHO_CHARS) return query
  return points.slice(0, MAX_QUERY_ECHO_CHARS).join("")
}

// Cap a snippet preview to whole code points (surrogate-safe) within
// MAX_SNIPPET_CHARS total: the ellipsis is appended only when truncation
// actually occurred, so a truncated snippet is 299 content points + `…`
// (300 total) while snippets ≤300 points stay untouched with no marker.
// Titles, URLs, and dates are never truncated.
function capSnippet(snippet: string): string {
  const points = [...snippet]
  if (points.length <= MAX_SNIPPET_CHARS) return snippet
  return `${points.slice(0, MAX_SNIPPET_CHARS - 1).join("")}…`
}

function formatResults(query: string, results: DdgResult[], stoppedEarly = false): string {
  // A stopped-early pagination appends a short fixed informative note.
  const note = stoppedEarly ? PAGINATION_NOTE : ""
  // Collapse newlines in the echoed query on both output paths so a
  // multi-line query can never forge result lines.
  const safeQuery = query.replace(/[\r\n]+/g, " ")
  if (results.length === 0) return `No results found for "${capQueryEcho(safeQuery)}".`
  // Cap every snippet preview; all found results are always shown with a
  // plain header. Numbering stays sequential.
  const formatBlock = (r: DdgResult, i: number): string => {
    const head = `${i + 1}. ${r.title}\n   ${r.url}`
    const dated = r.date ? `${head}\n   ${r.date}` : head
    const snippet = capSnippet(r.snippet)
    return snippet ? `${dated}\n   ${snippet}` : dated
  }
  return `${results.length} result(s) for "${safeQuery}":\n\n${results.map(formatBlock).join("\n\n")}${note}`
}

export const DuckDuckGoPlugin: Plugin = async () => {
  return {
    tool: {
      "duck-websearch": tool({
        description:
          "Search DuckDuckGo (static HTML endpoint) and return compact title/url/snippet results.",
        args: {
          query: tool.schema.string().describe("Search query (required, non-empty)"),
          count: tool.schema
            .number()
            .optional()
            .describe("Max results to return (default 10, capped at 20; fetches more pages as needed)"),
        },
        async execute(args, context) {
          if (context.abort.aborted) {
            throw new Error("Aborted: Tool execution has been aborted.")
          }
          const { results, stoppedEarly } = await performDdgSearch(args.query, args.count, {
            signal: context.abort,
          })
          return formatResults(args.query.trim(), results, stoppedEarly)
        },
      }),
    },
  }
}
