/**
 * Host half of dsh-composer-lists.
 *
 * Serves POST /composer-lists/optimize for the browser half's prompt-polish
 * button: body { text } → { ok, text } with the draft rewritten by the
 * current default model as a structured list. The route is loopback-only by
 * deployment and rejects cross-origin callers by Origin header.
 */
export const inject = ['llm']

const SYSTEM_PROMPT = '把指令草稿改写为结构清晰的提示词：一句话任务目标；有序列表分步骤（缩进子列表表层级）；无序列表列约束与验收标准。保留原意与语言，不臆造，无解释无代码围栏，直接输出 Markdown 列表。'

const MAX_INPUT_CHARS = 65536
const MAX_BODY_BYTES = 262144

/** Mirrors the browser half's filter: fragments too meaningless to optimize. */
function meaninglessText (text) {
  const t = text.replace(/\s/g, '')
  if (t.length < 6) return true
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return true
  if (new Set(t).size <= 2) return true
  if (/^(.)\1+$/.test(t)) return true
  if (/^(.{1,4}?)\1{1,}$/.test(t)) return true
  return false
}

/** Await `promise`, rejecting with `message` after `ms`. */
async function withTimeout (promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Current default model selection, or a first-provider fallback. */
function modelSelection (ctx) {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults !== undefined) {
    try {
      const selection = defaults.currentSelection()
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') return selection
    } catch { /* fall through to the provider fallback */ }
  }
  try {
    const providers = ctx.llm.listProviders()
    const first = providers[0]
    if (first === undefined) return null
    const model = Array.isArray(first.models) ? (first.models[0]?.id ?? first.models[0]) : undefined
    if (typeof model !== 'string') return null
    return { provider: first.provider ?? first.id, model }
  } catch {
    return null
  }
}

// Resolved per route; the rewrite is one-shot, so cache the answer.
const effortCache = new Map()

/**
 * The lightest reasoning effort the exact route declares. Effort ids are
 * adapter-owned opaque strings (no global "off" value), so the only
 * portable way to minimize thinking is to pick the first entry of the
 * route's own least-to-greatest `efforts` list. A route without declared
 * efforts gets no parameter (the provider default applies). This keeps the
 * rewrite fast on reasoning models and is a no-op elsewhere.
 */
async function lightestEffort (ctx, provider, model) {
  const key = `${provider}\u0000${model}`
  if (effortCache.has(key)) return effortCache.get(key)
  let effort
  let resolved = false
  try {
    if (typeof ctx.llm?.resolveModelInfo === 'function') {
      let timer
      const info = await Promise.race([
        ctx.llm.resolveModelInfo(provider, model),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resolve timeout')), 3000) }),
      ])
      clearTimeout(timer)
      const efforts = info?.reasoning?.efforts
      effort = Array.isArray(efforts) && efforts.length > 0 ? efforts[0].id : undefined
      resolved = true
    }
  } catch { /* unknown route or slow adapter: omit and let the provider default apply */ }
  // Cache only successful resolutions — a transient resolve failure must not
  // permanently pin this route to "no effort parameter".
  if (resolved) effortCache.set(key, effort)
  return effort
}

export function apply (ctx) {
  // Optional wiring: headless compositions have no web server to serve. The
  // inject callback receives a child scope Context; the service rides it.
  ctx.effect(() => ctx.inject(['webServer'], (scope) =>
    scope.webServer.register({
      kind: 'exact',
      path: '/composer-lists/optimize',
      handler: async (req, res) => {
        const reply = (status, payload) => {
          if (res.writableEnded) return
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' })
          const origin = req.headers.origin
          const host = String(req.headers.host ?? '')
          if (typeof origin === 'string' && origin !== '') {
            // Exact host match. A suffix check (`origin.endsWith(host)`) would
            // admit origins like http://a.127.0.0.1:<port> whose hostname
            // merely ends with ours.
            let sameHost = false
            try { sameHost = new URL(origin).host === host } catch { sameHost = false }
            if (!sameHost) return reply(403, { ok: false, error: 'cross-origin refused' })
          }
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > MAX_BODY_BYTES) return reply(413, { ok: false, error: 'body too large' })
            chunks.push(chunk)
          }
          let body
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          catch { return reply(400, { ok: false, error: 'invalid JSON body' }) }
          const text = typeof body?.text === 'string' ? body.text : ''
          if (text.trim() === '' || text.length > MAX_INPUT_CHARS) {
            return reply(400, { ok: false, error: 'invalid text' })
          }
          // Reject fragments too meaningless to optimize (too short, no
          // letters/CJK, a repeated character, a repeated 1-4 char pattern):
          // treated as a failure the client surfaces.
          if (meaninglessText(text)) {
            return reply(400, { ok: false, error: '文本过短或无意义，无优化价值 (text too short or meaningless to optimize)' })
          }
          const selection = modelSelection(ctx)
          if (selection === null) {
            return reply(503, { ok: false, error: 'no model provider configured' })
          }
          // Stop early when the browser side disconnects (its own timeout or
          // Escape abort), and never hang on a provider that stalls between
          // chunks: each next() is raced against a hard deadline.
          let clientGone = false
          res.on('close', () => { clientGone = true })
          // The rewrite needs no thinking: use the route's lightest declared
          // effort instead of the user's global (possibly heavy) selection.
          const lightEffort = await lightestEffort(ctx, selection.provider, selection.model)
          const runStream = async (maxTokens) => {
            let out = ''
            let failure = ''
            const iterator = ctx.llm.stream({
              provider: selection.provider,
              model: selection.model,
              ...(lightEffort === undefined ? {} : { reasoningEffort: lightEffort }),
              system: SYSTEM_PROMPT,
              messages: [{ role: 'user', content: [{ type: 'text', text }] }],
              maxTokens,
            })[Symbol.asyncIterator]()
            try {
              while (true) {
                const step = await withTimeout(iterator.next(), 120_000, 'model stream timed out')
                if (clientGone) return { aborted: true, out: '', failure: '' }
                if (step.done) break
                const chunk = step.value
                if (chunk.type === 'text-delta') out += chunk.text
                else if (chunk.type === 'finish' && chunk.reason !== 'stop' && out === '') {
                  // The finish reason is not always a string; extract something readable.
                  const reason = chunk.reason
                  failure = typeof reason === 'string' ? reason
                    : reason !== null && typeof reason === 'object'
                      ? String(reason.message ?? reason.kind ?? reason.type ?? JSON.stringify(reason))
                      : 'unknown'
                }
              }
            } finally {
              void iterator.return?.()
            }
            return { aborted: false, out, failure }
          }
          let result = await runStream(4096)
          // Never retry after the browser side is gone (its own timeout or
          // Escape abort already freed the client).
          if (!result.aborted && !clientGone && result.out.trim() === '' && result.failure.includes('max-tokens')) {
            // A force-thinking model burned the whole budget on reasoning
            // before any text: retry once with a doubled ceiling instead of
            // failing the rewrite (self-healing in place of a config knob).
            result = await runStream(8192)
          }
          if (result.aborted) return
          const trimmed = result.out.trim()
          if (trimmed === '') {
            return reply(502, { ok: false, error: result.failure === '' ? 'empty model response' : `generation stopped: ${result.failure}` })
          }
          return reply(200, { ok: true, text: trimmed })
        } catch (error) {
          return reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })))
}
