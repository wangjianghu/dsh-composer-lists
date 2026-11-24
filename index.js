/**
 * Host half of dsh-composer-lists.
 *
 * Serves POST /composer-lists/optimize for the browser half's prompt-polish
 * button: body { text } → { ok, text } with the draft rewritten by the
 * current default model as a structured list.
 *
 * Tool use stays out of the rewrite because no tools are ever declared on
 * these calls. On top of that, every stream call passes `toolChoice: 'none'`
 * as a forward-compatible hint, and a model that still ends with tool calls
 * gets one retry with an explicit no-tools system nudge. (The LLM adapters
 * shipped with DSH 0.2.2 do not declare a `toolChoice` option, so the hint
 * is ignored there — the retry is the layer that actually bites.)
 *
 * Every request passes the composition's `connection` trust fence first
 * (`requestRejection`: the Host/Origin fence defeats DNS rebinding and
 * cross-site calls, and the browser authentication cookie gates every
 * caller) before any body is read; a same-origin check backs it up as
 * defense in depth.
 *
 * Resource discipline: the browser disconnecting, a stalled provider stream
 * and handler errors all ABORT the provider request through
 * `GenerateOptions.signal` (closing the loop alone would leave the upstream
 * request running as a zombie), and the stream iterator is closed on every
 * exit path with its rejection handled (an unhandled one takes the Host
 * process down).
 *
 * Stream protocol (dsh-llm 0.2.2): a call yields `text-delta` chunks for the
 * visible answer (reasoning and tool-call deltas are ignored), then `usage`
 * and one terminal `finish` chunk whose `reason` is an OBJECT keyed by
 * `kind`. See decodeFinish for the shapes; test-host.cjs replays them.
 */
export const inject = ['llm']

const SYSTEM_PROMPT = '把指令草稿改写为结构清晰的提示词：一句话任务目标；有序列表分步骤（缩进子列表表层级）；无序列表列约束与验收标准。保留原意与语言，不臆造，无解释无代码围栏，直接输出 Markdown 列表。'

/**
 * Appended to the system prompt ONLY on the no-tools retry: some models
 * sit behind server-forced tools and end their turn with tool calls instead
 * of text; the nudge makes the retry's instruction explicit.
 */
const NO_TOOL_NUDGE = ' 本次调用不需要也不能调用任何工具（无工具可用）；必须直接输出 Markdown 文本。'

const MAX_INPUT_CHARS = 65536
const MAX_BODY_BYTES = 262144
/** No chunk for this long → the provider stalled: cancel it and fail the request. */
const STREAM_STEP_TIMEOUT_MS = 120_000
/** Model-info lookups slower than this are skipped (the provider default effort applies). */
const RESOLVE_TIMEOUT_MS = 3000

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

/**
 * Finish kinds that mean "the model completed the answer": only then may the
 * rewrite replace the draft.
 */
const COMPLETE_KINDS = new Set(['stop', 'end-turn', 'stop-sequence'])

/**
 * Decode the reason of one `finish` chunk into `{ kind, detail }`.
 *
 * DSH adapters ALWAYS end a stream with `usage` then `finish`, and the reason
 * is an OBJECT (dsh-llm 0.2.2 `FinishReasonMap`; the pi-ai adapter's
 * `mapStopReason` yields exactly these):
 *
 *   { kind: 'stop' }                   normal completion
 *   { kind: 'max-tokens' }             output limit reached: the text is cut off
 *   { kind: 'tool-calls' }             the model asked for tools instead of text
 *   { kind: 'aborted', failure }       cancelled
 *   { kind: 'error', failure }         provider / transport / empty response
 *
 * `failure` is an LlmFailure ({ message, code, status? }): the details live
 * THERE, not in `reason.message`. Comparing the reason with the STRING 'stop'
 * (1.3.x and 1.4.0) took every normal completion for a failure, and 1.4.0
 * then rejected each rewrite with "generation stopped: stop (partial output
 * discarded)". A string reason is still accepted defensively; a kind this
 * plugin does not know is never a success. Retry branches key on `kind` —
 * never on the message text, where a sentence like "upstream said
 * max-tokens-not-supported" would trigger the wrong retry.
 *
 * @returns {{kind: string, detail: string}} `kind` is '' when the reason
 *   could not be read at all
 */
function decodeFinish (reason) {
  const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (typeof reason === 'string') {
    const kind = norm(reason)
    return { kind, detail: kind === '' ? 'unknown finish reason' : kind }
  }
  if (reason !== null && typeof reason === 'object') {
    const kind = norm(reason.kind ?? reason.type)
    const failure = reason.failure
    const message = typeof failure?.message === 'string' && failure.message.trim() !== ''
      ? failure.message.trim()
      : typeof reason.message === 'string' ? reason.message.trim() : ''
    const code = typeof failure?.code === 'string' ? failure.code.trim() : ''
    const parts = [kind === '' ? 'unknown' : kind]
    if (code !== '' && norm(code) !== kind) parts.push(code)
    if (message !== '') parts.push(message)
    return { kind, detail: parts.join(': ') }
  }
  return { kind: '', detail: 'unknown finish reason' }
}

/**
 * Current default model selection, or — when no default is configured — the
 * first model of the first registered provider.
 *
 * Shapes follow dsh-llm 0.2.2: `listProviders()` returns `[{ id, name }]`
 * (routes carry NO model list) and the models of one route come from the
 * async `listModels(provider)` as `[{ provider, id, name }]`. The 1.x
 * fallback read a `models` array off the provider entry, which never
 * existed: without a default selection every request answered 503.
 */
async function modelSelection (ctx) {
  const defaults = ctx.get('agentDefaultModel')
  if (defaults !== undefined) {
    try {
      const selection = defaults.currentSelection()
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') return selection
    } catch { /* fall through to the provider fallback */ }
  }
  try {
    const first = ctx.llm.listProviders()[0]
    const provider = typeof first?.id === 'string' ? first.id : undefined
    if (provider === undefined) return null
    const model = (await ctx.llm.listModels(provider))[0]?.id
    if (typeof model !== 'string') return null
    return { provider, model }
  } catch {
    return null
  }
}

// Resolved per route; the rewrite is one-shot, so cache the answer. Only
// successful resolutions are cached — a transient resolve failure must not
// permanently pin this route to "no effort parameter".
const effortCache = new Map()
// First-time lookups in flight, so concurrent requests share one resolve.
const effortPending = new Map()

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
  if (effortPending.has(key)) return effortPending.get(key)
  const pending = (async () => {
    let timer
    try {
      if (typeof ctx.llm?.resolveModelInfo === 'function') {
        const info = await Promise.race([
          ctx.llm.resolveModelInfo(provider, model),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resolve timeout')), RESOLVE_TIMEOUT_MS) }),
        ])
        const efforts = info?.reasoning?.efforts
        const effort = Array.isArray(efforts) && efforts.length > 0 ? efforts[0].id : undefined
        effortCache.set(key, effort)
        return effort
      }
    } catch { /* unknown route or slow adapter: omit and let the provider default apply */ } finally {
      // Also on the rejecting paths: a leaked timer kept the process alive.
      clearTimeout(timer)
    }
    return undefined
  })()
  effortPending.set(key, pending)
  try {
    return await pending
  } finally {
    effortPending.delete(key)
  }
}

export function apply (ctx) {
  // Optional wiring: headless compositions have no web server to serve. The
  // inject callback receives a child scope Context; the services ride it.
  ctx.effect(() => ctx.inject(['webServer', 'connection'], (scope) =>
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
          // Trust fence first (the DSH-recommended pattern): Host/Origin
          // fence plus browser authentication, before anything is read.
          const rejection = scope.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' })
          const origin = req.headers.origin
          // A duplicated Origin header (Node joins duplicates into one
          // string for most headers; a raw carrier may hand an array) is
          // not something a browser sends: fail closed.
          if (Array.isArray(origin)) return reply(403, { ok: false, error: 'cross-origin refused' })
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
          // Stop early when the browser side disconnects (its own timeout or
          // Escape abort) — and cancel the provider request with it.
          let clientGone = false
          let activeAbort = null
          res.on('close', () => {
            clientGone = true
            if (activeAbort !== null) activeAbort.abort()
          })
          const selection = await modelSelection(ctx)
          if (selection === null) {
            return reply(503, { ok: false, error: 'no model provider configured' })
          }
          if (clientGone) return
          // The rewrite needs no thinking: use the route's lightest declared
          // effort instead of the user's global (possibly heavy) selection.
          const lightEffort = await lightestEffort(ctx, selection.provider, selection.model)
          if (clientGone) return
          const runStream = async (maxTokens, system = SYSTEM_PROMPT) => {
            const controller = new AbortController()
            activeAbort = controller
            let out = ''
            // 'none' = the stream ended without a finish chunk.
            let finish = { kind: 'none', detail: 'no finish reason' }
            const iterator = ctx.llm.stream({
              provider: selection.provider,
              model: selection.model,
              ...(lightEffort === undefined ? {} : { reasoningEffort: lightEffort }),
              toolChoice: 'none',
              // Caller cancellation (GenerateOptions.signal): the browser
              // disconnect and the stall deadline below abort the PROVIDER
              // request itself. Merely leaving the loop would leave that
              // request running as a zombie until the provider's own timeout.
              signal: controller.signal,
              system,
              messages: [{ role: 'user', content: [{ type: 'text', text }] }],
              maxTokens,
            })[Symbol.asyncIterator]()
            try {
              while (true) {
                let step
                try {
                  step = await withTimeout(iterator.next(), STREAM_STEP_TIMEOUT_MS, 'model stream timed out')
                } catch (error) {
                  controller.abort() // a stall or an adapter error: cancel upstream
                  throw error
                }
                if (clientGone) return { aborted: true, out: '', kind: 'none', detail: '' }
                if (step.done) break
                const chunk = step.value
                if (chunk.type === 'text-delta') {
                  // Only visible text: reasoning deltas and tool-call
                  // deltas are not the rewrite.
                  out += chunk.text
                } else if (chunk.type === 'finish') {
                  // Whatever the kind, keep streaming to the end so the
                  // iterator closes normally; the decision comes afterwards.
                  finish = decodeFinish(chunk.reason)
                }
              }
            } finally {
              activeAbort = null
              // Close the stream on every exit path (normal end, stall,
              // disconnect, retry). return() may reject (an adapter cancel
              // error); that rejection must be handled here — unhandled, it
              // takes the whole Host process down.
              const closed = iterator.return?.()
              if (closed !== undefined && typeof closed.catch === 'function') closed.catch(() => {})
            }
            return { aborted: false, out, kind: finish.kind, detail: finish.detail }
          }
          let result = await runStream(4096)
          // Never retry after the browser side is gone (its own timeout or
          // Escape abort already freed the client). One retry, branched by
          // the finish KIND:
          //  - max-tokens: a force-thinking model burned the whole budget on
          //    reasoning, or the rewrite was cut off; retry from scratch with
          //    a doubled ceiling.
          //  - tool-calls with no text at all: the model ignored the hint;
          //    retry once with an explicit no-tools nudge in the system prompt.
          const live = () => !result.aborted && !clientGone
          if (live() && result.kind === 'max-tokens') {
            result = await runStream(8192)
          } else if (live() && result.kind === 'tool-calls' && result.out.trim() === '') {
            result = await runStream(4096, SYSTEM_PROMPT + NO_TOOL_NUDGE)
            if (!result.aborted && !clientGone && result.out.trim() === '' && result.kind === 'tool-calls') {
              result = { ...result, detail: 'tool-calls（模型选择调用工具而非输出文本，已重试一次仍失败）' }
            }
          }
          if (result.aborted || clientGone) return
          const trimmed = result.out.trim()
          // Complete only on an explicit "stop" (or when no finish chunk came
          // at all and there is text). A truncated or errored rewrite must
          // never be handed to the client as if it were complete.
          const complete = result.kind === 'none' || COMPLETE_KINDS.has(result.kind)
          if (trimmed === '') {
            return reply(502, { ok: false, error: complete ? 'empty model response' : `generation stopped: ${result.detail}` })
          }
          if (!complete) {
            return reply(502, { ok: false, error: `generation stopped: ${result.detail} (partial output discarded)` })
          }
          return reply(200, { ok: true, text: trimmed })
        } catch (error) {
          return reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })))
}
