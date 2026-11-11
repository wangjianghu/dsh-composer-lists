// Host-half integration tests: load the ESM index.js, capture the registered
// optimize route, and drive its handler with fake req/res transports —
// covering the happy path, the max-tokens retry, guards, and disconnects.
const path = require('path')
const { pathToFileURL } = require('url')

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
    on (event, cb) { if (event === 'close') state.closeListeners.push(cb) },
    writeHead (status, headers) { state.status = status; state.headers = headers; return this },
    end (body) { state.ended = true; state.body = body; return this },
    close () { for (const cb of state.closeListeners) cb() },
  }
}

/** Async iterable of stream chunks. */
function streamOf (chunks) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }
    },
  }
}

async function main () {
  const mod = await import(pathToFileURL(path.join(__dirname, 'index.js')).href)

  let route = null
  const fakeCtx = {
    llm: null,
    get: () => undefined,
    inject: (names, cb) => {
      cb({ webServer: { register (r) { route = r } } })
      return () => {}
    },
    effect: (fn) => fn(),
  }
  mod.apply(fakeCtx)
  ok(route !== null && route.path === '/composer-lists/optimize', 'route registered at exact path')

  const calls = []
  const lastOptions = () => calls[calls.length - 1]

  /** Install a fresh llm fake and reset the call log. */
  let providerSeq = 0
  const useLlm = ({ chunksByCall, resolveInfo, providers, delayMs = 0 } = {}) => {
    calls.length = 0
    providerSeq += 1
    // A distinct provider per test keeps the module-level effort cache from
    // leaking one test's resolution into the next.
    fakeCtx.llm = {
      listProviders: () => providers ?? [{ provider: `p${providerSeq}`, models: [{ id: 'm' }] }],
      resolveModelInfo: async () => {
        if (resolveInfo instanceof Error) throw resolveInfo
        return resolveInfo
      },
      stream (options) {
        calls.push(options)
        const chunks = chunksByCall === undefined ? [] : (typeof chunksByCall === 'function' ? chunksByCall(calls.length) : chunksByCall)
        if (delayMs <= 0) return streamOf(chunks)
        return {
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              next: () => new Promise((resolve) => {
                setTimeout(() => resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), delayMs)
              }),
            }
          },
        }
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

  // 1. Happy path: lightest effort applied, 4096 ceiling, JSON reply.
  useLlm({
    chunksByCall: () => [
      { type: 'text-delta', text: '1. 目标' },
      { type: 'text-delta', text: '\n2. 步骤' },
      { type: 'finish', reason: 'stop' },
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
    chunksByCall: () => [{ type: 'text-delta', text: '缓存 内容' }, { type: 'finish', reason: 'stop' }],
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
    chunksByCall: () => [{ type: 'text-delta', text: 'ok 内容' }, { type: 'finish', reason: 'stop' }],
    resolveInfo: { reasoning: { efforts: [] } },
  })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 200, 'empty efforts status 200')
    ok(!('reasoningEffort' in lastOptions()), 'no reasoningEffort when route declares none')
  }

  // 4. resolveModelInfo throws → omit effort, still succeed; not cached.
  useLlm({
    chunksByCall: () => [{ type: 'text-delta', text: '好 内容' }, { type: 'finish', reason: 'stop' }],
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
      : [{ type: 'text-delta', text: '重试 成功' }, { type: 'finish', reason: 'stop' }],
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

  // 7. Zero output for a non-max-tokens reason → no retry.
  useLlm({ chunksByCall: () => [{ type: 'finish', reason: 'content-filter' }] })
  {
    const { res } = await run({ body: bodyOf(TEXT) })
    eq(res.status, 502, 'content-filter 502')
    eq(calls.length, 1, 'no retry for non-max-tokens')
  }

  // 8. Method guard.
  useLlm({ chunksByCall: () => [] })
  eq((await run({ method: 'GET', body: '' })).res.status, 405, 'GET 405')

  // 9. Cross-origin refused (suffix collision must NOT pass).
  useLlm({ chunksByCall: () => [{ type: 'text-delta', text: '同源 内容' }, { type: 'finish', reason: 'stop' }] })
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
    chunksByCall: () => [{ type: 'text-delta', text: 'partial' }, { type: 'finish', reason: 'stop' }],
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
    chunksByCall: () => [{ type: 'text-delta', text: '回退 模型' }, { type: 'finish', reason: 'stop' }],
    providers: [{ provider: 'gamma', models: [{ id: 'glm-5' }] }],
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
