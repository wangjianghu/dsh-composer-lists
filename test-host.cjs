// Host-half integration tests: load the ESM index.js, capture the registered
// optimize route, and drive its handler with fake req/res transports —
// covering the happy path, retries, guards, disconnects, and resource discipline.
const path = require('path')
const { pathToFileURL } = require('url')
const { mock } = require('node:test')

let failures = 0
let passes = 0
const ok = (cond, label) => {
  if (cond !== true) {
    failures += 1
    console.error(`FAIL ${label}`)
  } else {
    passes += 1
    console.log(`ok   ${label}`)
  }
}
const eq = (actual, expected, label) => ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)

/** Async-iterable chunk list shaped like an IncomingMessage body. */
function fakeReq ({ method = 'POST', headers = {}, body = '' } = {}) {
  const chunks = typeof body === 'string' ? [Buffer.from(body)] : body
  return {
    method,
    headers,
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      }
    },
  }
}

/** Capturing ServerResponse with an optional manual 'close' trigger. */
function fakeRes () {
  const state = { status: undefined, body: undefined, ended: false, closeListeners: [] }
  return {
    state,
    get writableEnded () { return state.ended },
    get statusCode () { return state.status },
    set statusCode (v) { state.status = v },
    on (event, cb) { if (event === 'close') state.closeListeners.push(cb) },
    writeHead (status, headers) { state.status = status; state.headers = headers; return this },
    end (body) { state.ended = true; state.body = body; return this },
    close () { for (const cb of state.closeListeners) cb() },
  }
}

async function main () {
  const mod = await import(pathToFileURL(path.join(__dirname, 'index.js')).href)

  let route = null
  // The connection trust fence, stubbed: `nextRejection` forces a rejection
  // status for the next request(s); undefined means trusted.
  let nextRejection
  const fakeCtx = {
    llm: null,
    get: () => undefined,
    inject: (names, cb) => {
      if (!names.includes('webServer') || !names.includes('connection')) {
        throw new Error('route wiring must inject webServer and connection')
      }
      cb({
        webServer: { register (r) { route = r } },
        connection: { requestRejection: () => nextRejection },
      })
      return () => {}
    },
    effect: (fn) => fn(),
  }
  mod.apply(fakeCtx)
  ok(route !== null && route.path === '/composer-lists/optimize', 'route registered at exact path')

  const calls = []
  const lastOptions = () => calls[calls.length - 1]

  /**
   * Install a fresh llm fake and reset the call log. `onIterator` wraps the
   * fake iterator (to stall it or make return() reject); `onClose` counts
   * return() calls.
   */
  let providerSeq = 0
  const useLlm = ({ chunksByCall, resolveInfo, providers, modelsOf, delayMs = 0, onIterator, onClose } = {}) => {
    calls.length = 0
    providerSeq += 1
    // A distinct provider per test keeps the module-level effort cache from
    // leaking one test's resolution into the next.
    fakeCtx.llm = {
      // Real shapes (dsh-llm 0.2.2): a route is { id, name } and carries NO
      // model list; its models come from the async listModels(provider).
      listProviders: () => providers ?? [{ id: `p${providerSeq}`, name: `Provider ${providerSeq}` }],
      listModels: async (provider) => (modelsOf === undefined ? [{ provider, id: 'm', name: 'Model M' }] : modelsOf(provider)),
      resolveModelInfo: async () => {
        if (resolveInfo instanceof Error) throw resolveInfo
        return resolveInfo
      },
      stream (options) {
        calls.push(options)
        const chunks = chunksByCall === undefined ? [] : (typeof chunksByCall === 'function' ? chunksByCall(calls.length) : chunksByCall)
        let i = 0
        const step = () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true })
        const base = {
          next: delayMs <= 0
            ? async () => step()
            : () => new Promise((resolve) => { setTimeout(() => resolve(step()), delayMs) }),
          return () {
            if (onClose !== undefined) onClose()
            return Promise.resolve({ done: true })
          },
        }
        const iterator = onIterator === undefined ? base : onIterator(base)
        return { [Symbol.asyncIterator]() { return iterator } }
      },
    }
  }

  const run = async (opts) => {
    const res = fakeRes()
    await route.handler(fakeReq(opts), res)
    let parsed = null
    try { parsed = JSON.parse(res.state.body ?? '') } catch { /* non-JSON or empty */ }
    return { res: res.state, parsed }
  }

  const TEXT = '帮我写一份周报，包含本周进展和下周计划'
  const bodyOf = (text) => JSON.stringify({ text })

  // 0. Trust fence: a connection rejection short-circuits with its status,
  //    empty body, and no model call.
  useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '不该出现' }, { type: 'finish', reason: { kind: 'stop' } }] })
  {
    nextRejection = 401
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    nextRejection = undefined
    eq(res.status, 401, 'rejected request answers the fence status')
    eq(res.body ?? '', '', 'rejected request sends no body')
    eq(parsed, null, 'rejected request sends no JSON')
    eq(calls.length, 0, 'rejected request never reaches the model')
  }

  // 1. Happy path: lightest effort applied, 4096 ceiling, JSON reply.
  useLlm({
    chunksByCall: () => [
      { type: 'text-delta', text: '1. 目标' },
      { type: 'text-delta', text: '\n2. 步骤' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    // efforts are declared least → greatest; efforts[0] is the lightest.
    resolveInfo: { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
  })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'happy path status 200')
    eq(parsed?.ok, true, 'happy path ok')
    eq(parsed?.text, '1. 目标\n2. 步骤', 'happy path joins deltas trimmed')
    eq(lastOptions().maxTokens, 4096, 'first call maxTokens 4096')
    eq(lastOptions().reasoningEffort, 'low', 'lightest declared effort chosen')
    ok((res.headers?.['content-type'] ?? '').includes('application/json'), 'content-type json')
  }

  // 2. Effort resolution cached across requests (fresh provider route).
  useLlm({
    chunksByCall: () => [{ type: 'text-delta', text: '缓存 内容' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  {
    let resolves = 0
    fakeCtx.llm.resolveModelInfo = async () => { resolves += 1; return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } } }
    await run({ body: bodyOf(TEXT) })
    await run({ body: bodyOf(TEXT) })
    eq(resolves, 1, 'resolveModelInfo cached per route')
    eq(lastOptions().reasoningEffort, 'low', 'cached effort still applied')
  }

  // 3. No declared efforts → no effort parameter (provider default).
  useLlm({
    chunksByCall: () => [{ type: 'text-delta', text: 'ok 内容' }, { type: 'finish', reason: { kind: 'stop' } }],
    resolveInfo: { reasoning: { efforts: [] } },
  })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'empty efforts status 200')
    ok(!('reasoningEffort' in lastOptions()), 'no reasoningEffort when route declares none')
  }

  // 4. resolveModelInfo throws → omit effort, still succeed; not cached.
  useLlm({
    chunksByCall: () => [{ type: 'text-delta', text: '好 内容' }, { type: 'finish', reason: { kind: 'stop' } }],
    resolveInfo: new Error('boom'),
  })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'resolve failure status 200')
    ok(!('reasoningEffort' in lastOptions()), 'resolve failure omits effort')
  }

  // 5. max-tokens zero output → exactly one retry at 8192, succeed.
  useLlm({
    chunksByCall: (n) => n === 1
      ? [{ type: 'finish', reason: { kind: 'max-tokens' } }]
      : [{ type: 'text-delta', text: '重试 成功' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'max-tokens retry succeeds')
    eq(parsed?.text, '重试 成功', 'retry text returned')
    eq(calls.length, 2, 'exactly two stream calls')
    eq(calls[1].maxTokens, 8192, 'retry doubles the ceiling')
  }

  // 6. Retry also max-tokens → 502 with readable reason.
  useLlm({ chunksByCall: () => [{ type: 'finish', reason: { kind: 'max-tokens' } }] })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'retry exhausted 502')
    eq(parsed?.error, 'generation stopped: max-tokens', 'readable max-tokens reason')
    eq(calls.length, 2, 'no third call')
  }

  // 7. Zero output for a non-max-tokens, non-tool-calls reason → no retry.
  useLlm({ chunksByCall: () => [{ type: 'finish', reason: 'content-filter' }] })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'content-filter 502')
    eq(calls.length, 1, 'no retry for non-max-tokens')
  }

  // 7a. Every stream call asks for protocol-level tool suppression.
  useLlm({ chunksByCall: () => [{ type: 'text-delta', text: 'ok 内容' }, { type: 'finish', reason: { kind: 'stop' } }] })
  {
    await run({ body: bodyOf(TEXT) })
    eq(lastOptions().toolChoice, 'none', 'first call passes toolChoice none')
  }

  // 7b. tool-calls ending → one nudge retry (same ceiling, appended system), succeeds.
  useLlm({
    chunksByCall: (n) => n === 1
      ? [{ type: 'finish', reason: { kind: 'tool-calls' } }]
      : [{ type: 'text-delta', text: '禁工具 重试成功' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'tool-calls nudge retry succeeds')
    eq(parsed?.text, '禁工具 重试成功', 'nudge retry text returned')
    eq(calls.length, 2, 'exactly two stream calls')
    eq(calls[1].maxTokens, 4096, 'nudge retry keeps the ceiling')
    ok(calls[1].system.length > calls[0].system.length, 'nudge retry appends to the system prompt')
    ok(calls[1].system.includes('不能调用任何工具'), 'nudge retry carries the no-tools instruction')
    eq(calls[1].toolChoice, 'none', 'nudge retry still passes toolChoice none')
  }

  // 7c. tool-calls twice → 502 with the descriptive message, no third call.
  useLlm({ chunksByCall: () => [{ type: 'finish', reason: { kind: 'tool-calls' } }] })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'tool-calls twice 502')
    ok((parsed?.error ?? '').includes('已重试一次仍失败'), 'descriptive tool-calls failure')
    eq(calls.length, 2, 'no third call after the nudge retry')
  }

  // 7d. Object finish reason carries kind and message.
  useLlm({ chunksByCall: () => [{ type: 'finish', reason: { kind: 'error', message: 'boom' } }] })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'object reason 502')
    eq(parsed?.error, 'generation stopped: error: boom', 'object reason renders kind + message')
  }

  // 8. Method guard.
  useLlm({ chunksByCall: () => [] })
  eq((await run({ method: 'GET', body: '' })).res.status, 405, 'GET 405')

  // 9. Cross-origin refused (suffix collision must NOT pass).
  useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '同源 内容' }, { type: 'finish', reason: { kind: 'stop' } }] })
  {
    const { res } = await run({ headers: { origin: 'http://a.127.0.0.1:9999', host: '127.0.0.1:9999' }, body: bodyOf(TEXT) })
    eq(res.status, 403, 'origin suffix collision refused')
  }
  {
    const { res } = await run({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' }, body: bodyOf(TEXT) })
    eq(res.status, 200, 'exact same-origin passes')
  }

  // 10. Body guards.
  eq((await run({ body: '{bad json' })).res.status, 400, 'invalid JSON 400')
  eq((await run({ body: JSON.stringify({}) })).res.status, 400, 'missing text 400')
  eq((await run({ body: bodyOf('x'.repeat(65537)) })).res.status, 400, 'over-length text 400')
  eq((await run({ body: bodyOf('哈哈哈哈哈哈哈') })).res.status, 400, 'meaningless text 400')
  eq((await run({ body: ['x'.repeat(200000), 'x'.repeat(200000)] })).res.status, 413, 'oversize body 413')

  // 11. Client disconnects mid-stream → no reply written. The chunks are
  // delayed so the close lands between registration and the first chunk.
  useLlm({
    delayMs: 25,
    chunksByCall: () => [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  {
    const res = fakeRes()
    const req = fakeReq({ body: bodyOf(TEXT) })
    const handling = route.handler(req, res)
    await new Promise((r) => setTimeout(r, 10))
    res.close()
    await handling
    eq(res.state.ended, false, 'client gone writes no reply')
  }

  // 12. No provider configured → 503.
  useLlm({ chunksByCall: () => [], providers: [] })
  fakeCtx.get = () => undefined
  eq((await run({ body: bodyOf(TEXT) })).res.status, 503, 'no provider 503')
  fakeCtx.get = () => undefined

  // 13. Provider fallback model selection when agentDefaultModel is absent.
  useLlm({
    chunksByCall: () => [{ type: 'text-delta', text: '回退 模型' }, { type: 'finish', reason: { kind: 'stop' } }],
    providers: [{ id: 'gamma', name: 'Gamma' }],
    modelsOf: (provider) => [{ provider, id: 'glm-5', name: 'GLM-5' }],
  })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'fallback provider used')
    eq(lastOptions().provider, 'gamma', 'fallback provider id')
    eq(lastOptions().model, 'glm-5', 'fallback model id')
  }

  // 14. Stream throws mid-iteration → 500 with message.
  useLlm({})
  fakeCtx.llm.stream = () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => { throw new Error('upstream blew up') } }
    },
  })
  {
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 500, 'stream error 500')
    eq(parsed?.error, 'upstream blew up', 'error message surfaced')
  }

  // ==================================================================
  // Resource discipline: cancellation, stream closing, truncated output.
  // ==================================================================
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(String((reason && reason.message) ?? reason)) }
  process.on('unhandledRejection', onUnhandled)
  const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
  try {
    // 15. Every stream call carries a caller cancellation signal, untouched
    //     on the normal path (the reply is written and the stream closed).
    let returned = 0
    useLlm({
      chunksByCall: () => [{ type: 'text-delta', text: '正常 内容' }, { type: 'finish', reason: { kind: 'stop' } }],
      onClose: () => { returned += 1 },
    })
    {
      const { res } = await run({ body: bodyOf(TEXT) })
      eq(res.status, 200, 'normal path status 200')
      ok(lastOptions().signal instanceof AbortSignal, 'every stream call passes a cancellation signal')
      eq(lastOptions().signal.aborted, false, 'normal path leaves the signal intact')
      eq(returned, 1, 'normal path closes the stream iterator')
    }

    // 16. The browser disconnects mid-stream → the PROVIDER request is
    //     cancelled too (not just abandoned), no reply is written.
    useLlm({
      delayMs: 25,
      chunksByCall: () => [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: { kind: 'stop' } }],
      onClose: () => { returned += 1 },
    })
    {
      returned = 0
      const res = fakeRes()
      const handling = route.handler(fakeReq({ body: bodyOf(TEXT) }), res)
      await new Promise((resolve) => setTimeout(resolve, 10))
      res.close()
      await handling
      eq(res.state.ended, false, 'disconnect writes no reply')
      eq(calls[0].signal.aborted, true, 'disconnect aborts the provider request')
      eq(returned, 1, 'disconnect closes the stream iterator')
    }

    // 17. A stalled provider stream: the step deadline cancels the provider
    //     request and fails the request instead of hanging the handler.
    {
      mock.timers.enable({ apis: ['setTimeout'] })
      useLlm({ chunksByCall: () => [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: { kind: 'stop' } }], onIterator: () => ({
        next: () => new Promise(() => {}), // never resolves: the provider stalled
        return () { returned += 1; return Promise.resolve({ done: true }) },
      }) })
      returned = 0
      const handling = run({ body: bodyOf(TEXT) })
      await new Promise((resolve) => setImmediate(resolve))
      mock.timers.tick(120_000)
      const { res, parsed } = await handling
      mock.timers.reset()
      eq(res.status, 500, 'stalled stream fails with 500')
      eq(parsed?.error, 'model stream timed out', 'stalled stream reports the timeout')
      eq(calls[0].signal.aborted, true, 'stalled stream aborts the zombie provider request')
      eq(returned, 1, 'stalled stream closes the iterator')
    }

    // 18. An adapter whose stream cancellation REJECTS must not produce an
    //     unhandled rejection (that takes the whole Host process down).
    {
      let returnedRejecting = 0
      useLlm({
        chunksByCall: () => [{ type: 'text-delta', text: '好 内容' }, { type: 'finish', reason: { kind: 'stop' } }],
        onIterator: (inner) => ({
          next: inner.next,
          return () { returnedRejecting += 1; return Promise.reject(new Error('iterator.return() failed (adapter cancel error)')) },
        }),
      })
      const { res } = await run({ body: bodyOf(TEXT) })
      await settle()
      eq(res.status, 200, 'a rejecting return() does not fail the request')
      eq(returnedRejecting, 1, 'return() was still attempted')
      eq(unhandled.length, 0, `no unhandledRejection (got ${JSON.stringify(unhandled)})`)
    }

    // 19. Partial output that did not finish cleanly is NEVER a success: a
    //     truncated rewrite must not replace the user's whole draft.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '1. 只写到一半的目标' }, { type: 'finish', reason: { kind: 'error', message: 'boom' } }] })
    {
      const { res, parsed } = await run({ body: bodyOf(TEXT) })
      eq(res.status, 502, 'partial output + error finish is 502 (was 200 with the truncated text)')
      ok((parsed?.error ?? '').startsWith('generation stopped: error: boom'), 'partial output: readable reason')
      eq(parsed?.ok, false, 'partial output: no ok payload')
      eq(calls.length, 1, 'partial output + error: no retry')
    }
    useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '1. 被截断' }, { type: 'finish', reason: { kind: 'max-tokens' } }] })
    {
      const { res, parsed } = await run({ body: bodyOf(TEXT) })
      eq(JSON.stringify([res.status, calls.length, calls[1]?.maxTokens]), JSON.stringify([502, 2, 8192]), 'partial output + max-tokens retries once at 8192, then 502')
      eq(parsed?.text, undefined, 'truncated text is never returned')
    }
    useLlm({
      chunksByCall: (n) => n === 1
        ? [{ type: 'text-delta', text: '1. 被截断' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
        : [{ type: 'text-delta', text: '完整的 重写' }, { type: 'finish', reason: { kind: 'stop' } }],
    })
    {
      const { res, parsed } = await run({ body: bodyOf(TEXT) })
      eq(JSON.stringify([res.status, parsed?.text]), JSON.stringify([200, '完整的 重写']), 'truncated first attempt, complete retry → the retry wins')
    }

    // 20. Retry branches key on the finish KIND, never on the message text.
    useLlm({ chunksByCall: () => [{ type: 'finish', reason: { kind: 'error', message: 'upstream said max-tokens-not-supported' } }] })
    {
      const { res, parsed } = await run({ body: bodyOf(TEXT) })
      eq(JSON.stringify([res.status, calls.length]), JSON.stringify([502, 1]), 'a message merely CONTAINING "max-tokens" does not trigger the 8192 retry')
      eq(parsed?.error, 'generation stopped: error: upstream said max-tokens-not-supported', 'kind + message still reported')
    }
    useLlm({ chunksByCall: () => [{ type: 'finish', reason: { kind: 'tool_calls' } }] })
    {
      const { res, parsed } = await run({ body: bodyOf(TEXT) })
      eq(JSON.stringify([res.status, calls.length]), JSON.stringify([502, 2]), 'an underscore "tool_calls" kind gets the no-tools retry too')
      ok((parsed?.error ?? '').includes('已重试一次仍失败'), 'underscore kind: descriptive failure after the retry')
    }

    // 21. A duplicated Origin header (array form) fails closed.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '同源 内容' }, { type: 'finish', reason: { kind: 'stop' } }] })
    eq((await run({ headers: { origin: ['http://127.0.0.1:9999', 'http://evil.example'], host: '127.0.0.1:9999' }, body: bodyOf(TEXT) })).res.status, 403, 'array Origin header refused')

    // 22. Model-info resolve: a fast rejection clears its 3 s race timer
    //     (a leaked timer kept the process alive), and concurrent first-time
    //     requests share one lookup.
    {
      const timers = new Set()
      const cleared = new Set()
      const realSet = global.setTimeout
      const realClear = global.clearTimeout
      global.setTimeout = (fn, ms, ...rest) => { const id = realSet(fn, ms, ...rest); if (ms === 3000) timers.add(id); return id }
      global.clearTimeout = (id, ...rest) => { cleared.add(id); return realClear(id, ...rest) }
      try {
        useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '好 内容' }, { type: 'finish', reason: { kind: 'stop' } }], resolveInfo: new Error('boom') })
        await run({ body: bodyOf(TEXT) })
        ok(timers.size === 1 && cleared.has([...timers][0]), 'fast resolve rejection clears its race timer')
        eq(lastOptions().signal.aborted, false, '(sanity) request completed normally')
        // Concurrent first miss: one shared lookup.
        let resolves = 0
        useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '并发 内容' }, { type: 'finish', reason: { kind: 'stop' } }] })
        fakeCtx.llm.resolveModelInfo = async () => { resolves += 1; await new Promise((resolve) => realSet(resolve, 20)); return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } } }
        await Promise.all([run({ body: bodyOf(TEXT) }), run({ body: bodyOf(TEXT) }), run({ body: bodyOf(TEXT) }), run({ body: bodyOf(TEXT) })])
        eq(resolves, 1, 'concurrent first-time requests share one resolveModelInfo')
        ok(calls.every(options => options.reasoningEffort === 'low'), 'every concurrent request still gets the resolved effort')
      } finally {
        global.setTimeout = realSet
        global.clearTimeout = realClear
      }
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }


  // ==================================================================
  // 23. The REAL DSH stream protocol (dsh-llm 0.2.2-rc.5). Every stream ends
  //     with `usage` then `finish`, and the finish reason is an OBJECT keyed
  //     by `kind` (FinishReasonMap; the pi-ai adapter's mapStopReason yields
  //     exactly these). 1.4.0 compared the reason with the STRING 'stop' and
  //     rejected every successful rewrite with "generation stopped: stop
  //     (partial output discarded)" — the fixtures below are that protocol.
  // ==================================================================
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const usage = { type: 'usage', usage: { inputTokens: 120, outputTokens: 40 } }
  {
    // A complete, successful call, chunk for chunk as the adapter emits it.
    useLlm({
      chunksByCall: () => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '1. 写一份周报' },
        { type: 'text-delta', index: 0, text: '\n- 包含本周进展' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '1. 写一份周报\n- 包含本周进展' } },
        usage,
        stop,
      ],
    })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'real protocol: a normal completion succeeds (1.4.0 answered 502 here)')
    eq(parsed?.text, '1. 写一份周报\n- 包含本周进展', 'real protocol: the rewrite is returned')
    eq(calls.length, 1, 'real protocol: no retry on a normal completion')
  }
  {
    // A reasoning model: thinking deltas are not part of the rewrite.
    useLlm({
      resolveInfo: { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      chunksByCall: () => [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: '先想一下结构……' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想一下结构……' } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: '1. 目标' },
        usage,
        stop,
      ],
    })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, parsed?.text, lastOptions().reasoningEffort].join(' | '), '200 | 1. 目标 | low', 'real protocol: reasoning deltas stay out, lightest effort still applied')
  }
  {
    // pi-ai mapStopReason: a terminal stop with NO content blocks.
    useLlm({ chunksByCall: () => [usage, { type: 'finish', reason: { kind: 'error', failure: { message: 'model "glm-5.4" returned a completed response with no content', code: 'EMPTY_RESPONSE' } } }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'real protocol: empty response is a failure')
    eq(parsed?.error, 'generation stopped: error: EMPTY_RESPONSE: model "glm-5.4" returned a completed response with no content', 'real protocol: kind + failure code + failure message are shown')
    eq(calls.length, 1, 'real protocol: an error finish gets no retry')
  }
  {
    // A transport truncation after partial text: the half rewrite is discarded.
    useLlm({
      chunksByCall: () => [
        { type: 'text-delta', index: 0, text: '1. 只写到一半' },
        usage,
        { type: 'finish', reason: { kind: 'error', failure: { message: 'Stream ended without finish_reason', code: 'TRANSPORT' } } },
      ],
    })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, calls.length].join(' | '), '502 | 1', 'real protocol: truncated output is a failure, no retry')
    eq(parsed?.error, 'generation stopped: error: TRANSPORT: Stream ended without finish_reason (partial output discarded)', 'real protocol: the transport failure reads clearly')
    eq(parsed?.text, undefined, 'real protocol: the partial rewrite is not returned')
  }
  {
    // Cancelled upstream (provider aborted, not this handler).
    useLlm({ chunksByCall: () => [usage, { type: 'finish', reason: { kind: 'aborted', failure: { message: 'pi-ai stream aborted', code: 'ABORTED' } } }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, parsed?.error].join(' | '), '502 | generation stopped: aborted: pi-ai stream aborted', 'real protocol: an aborted finish is reported, not retried')
  }
  {
    // Context overflow carries the provider's message.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '1. 被截' }, usage, { type: 'finish', reason: { kind: 'error', failure: { message: 'input length exceeds context window', code: 'CONTEXT_WINDOW_EXCEEDED' } } }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, calls.length].join(' | '), '502 | 1', 'real protocol: a context-overflow error is not retried')
    eq(parsed?.error, 'generation stopped: error: CONTEXT_WINDOW_EXCEEDED: input length exceeds context window (partial output discarded)', 'real protocol: overflow message surfaced')
  }
  {
    // max-tokens (object) → one retry at 8192 → success.
    useLlm({ chunksByCall: (n) => (n === 1 ? [{ type: 'reasoning-delta', index: 0, text: '思考' }, usage, { type: 'finish', reason: { kind: 'max-tokens' } }] : [{ type: 'text-delta', index: 0, text: '完整 重写' }, usage, stop]) })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, calls.length, calls[1].maxTokens, parsed?.text].join(' | '), '200 | 2 | 8192 | 完整 重写', 'real protocol: max-tokens retries once at the doubled ceiling')
  }
  {
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '1. 截断' }, usage, { type: 'finish', reason: { kind: 'max-tokens' } }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, calls.length].join(' | '), '502 | 2', 'real protocol: max-tokens twice is a failure')
    eq(parsed?.error, 'generation stopped: max-tokens (partial output discarded)', 'real protocol: truncated twice → reason shown, text withheld')
  }
  {
    // tool-calls (object) → the no-tools nudge retry → success.
    useLlm({ chunksByCall: (n) => (n === 1 ? [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'search', argumentsDelta: '{}' }, usage, { type: 'finish', reason: { kind: 'tool-calls' } }] : [{ type: 'text-delta', index: 0, text: '纯文本 重写' }, usage, stop]) })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, calls.length, calls[1].system.includes('不能调用任何工具'), parsed?.text].join(' | '), '200 | 2 | true | 纯文本 重写', 'real protocol: tool-calls gets the no-tools retry')
  }
  {
    // A kind this plugin does not know is never a success.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '1. 某种新结束' }, usage, { type: 'finish', reason: { kind: 'some-future-kind' } }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, parsed?.error].join(' | '), '502 | generation stopped: some-future-kind (partial output discarded)', 'real protocol: unknown finish kinds fail closed')
  }
  {
    // An unreadable reason fails closed as well.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '1. 文本' }, { type: 'finish', reason: null }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, parsed?.error].join(' | '), '502 | generation stopped: unknown finish reason (partial output discarded)', 'real protocol: a null reason is not a success')
  }
  {
    // A stream that ends without any finish chunk keeps the old contract:
    // text is accepted, nothing is invented.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '没有 finish 的文本' }] })
    const { res, parsed } = await run({ body: bodyOf(TEXT) })
    eq([res.status, parsed?.text].join(' | '), '200 | 没有 finish 的文本', 'real protocol: no finish chunk at all → text is used')
  }
  {
    // String reasons (older adapters) are still understood.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '字符串 原因' }, { type: 'finish', reason: 'stop' }] })
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'real protocol: a string "stop" reason still succeeds')
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '1. 截断' }, { type: 'finish', reason: 'MAX_TOKENS' }] })
    const { res: res2 } = await run({ body: bodyOf(TEXT) })
    eq([res2.status, calls.length].join(' | '), '502 | 2', 'real protocol: a string "MAX_TOKENS" reason is normalized and retried')
  }
  {
    // Fallback model selection uses the real directory API.
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '回退 内容' }, usage, stop], providers: [{ id: 'solo', name: 'Solo' }], modelsOf: () => [] })
    eq((await run({ body: bodyOf(TEXT) })).res.status, 503, 'real protocol: a route with no models answers 503')
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '回退 内容' }, usage, stop], providers: [{ id: 'broken', name: 'Broken' }], modelsOf: () => { throw new Error('directory offline') } })
    eq((await run({ body: bodyOf(TEXT) })).res.status, 503, 'real protocol: a failing model listing answers 503, not a crash')
    useLlm({ chunksByCall: () => [{ type: 'text-delta', index: 0, text: '回退 内容' }, usage, stop], providers: [{ id: 'gamma', name: 'Gamma' }], modelsOf: (provider) => [{ provider, id: 'glm-5', name: 'GLM-5' }] })
    const { res } = await run({ body: bodyOf(TEXT) })
    eq([res.status, lastOptions().provider, lastOptions().model].join(' | '), '200 | gamma | glm-5', 'real protocol: first model of the first route is the fallback')
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`)
    process.exit(1)
  }
  console.log(`\nall ${passes} host tests passed`)
  process.exit(0)
}

main().catch((error) => {
  console.error('host test harness crashed:', error)
  process.exit(1)
})
