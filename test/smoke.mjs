/**
 * Smoke test for the OpenCode Zen connector's pure logic and its shim.
 *
 * Run with: node test/smoke.mjs
 *
 * The shim cases drive a real loopback server against a stubbed upstream, so a
 * change in how a failure is attributed shows up here rather than in the UI:
 * "requested a free model, was told to top up" was a real, repeated report.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FALLBACK_MODELS,
  UPSTREAM,
  createZenShim,
  describeFreePoolExhaustion,
  isPaidModel,
  shapePayload,
} from '../lib/index.js'

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    const result = fn()
    // An async body returns a promise this harness would otherwise drop: the
    // rejection escapes as an unhandled one and the check prints "ok" having
    // asserted nothing. Refuse the shape outright rather than pass silently.
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      throw new Error('check() got an async body — use checkAsync() so its rejection is awaited')
    }
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}

//#region the built-in roster
console.log('manifest')
check('the client bundle registers under the package name', () => {
  // The browser module system keys factories by `stripClientSuffix(registration.id)`
  // while the host composes one graph row per loader entry whose name is the
  // package specifier. An `id` that disagrees with package.json registers the
  // bundle under a key no row ever asks for, so the plugin never appears and
  // nothing reports an error.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const m = /__ModuleLoader__\.load\(\{\s*id:\s*["'`]([^"'`]+)/.exec(client)
  assert.ok(m !== null, 'client.js does not call window.__ModuleLoader__.load with an id')
  assert.equal(m[1], manifest.name, `client id "${m[1]}" must equal package name "${manifest.name}"`)
})
check('the bundle patch quotes a scoped package name', () => {
  // A scoped name starts with `@`, which YAML reserves: an unquoted
  // `name: @scope/pkg` is a parse error, and DSH rejects the whole install with
  // "failed to parse overlay ... bad indentation of a mapping entry".
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    if (m[1].startsWith('@')) throw new Error(`unquoted scoped name in cordis.patch.yml: ${line.trim()}`)
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!text.includes(`'${manifest.name}'`)) throw new Error(`cordis.patch.yml does not name ${manifest.name} in quotes`)
})
await checkAsync('the version is valid semver', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `not semver: ${manifest.version}`)
})
await checkAsync('the client declares the primitives it renders with', async () => {
  // `Button` comes from the shared package; requiring it without declaring it
  // resolves or not depending on the host's module map.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const injected = manifest.dsh?.client?.inject ?? []
  assert.ok(injected.includes('@deepseek-ai/dsh-client-ui-primitives'), 'dsh.client.inject is missing the primitives package')
})

console.log('built-in roster')
check('every row is a free model the upstream still lists', () => {
  // Captured from Zen's own /models on 2026-11-08. A roster row that no longer
  // exists costs a failed attempt on the first request after a cold start, and
  // a row that is actually paid would spend money the free tier never charges.
  const LIVE_FREE = new Set([
    'big-pickle',
    'beam-free',
    'crouton-alpha-free',
    'deepseek-v4.1-flash-free',
    'flint-40b-free',
    'glm-5.3-flash-free',
    'iceman-free',
    'inkling-2-small-free',
    'mimo-v2.6-flash-free',
    'nemotron-3.5-lightning-free',
    'nemotron-3.5-super-vl-free',
  ])
  for (const model of FALLBACK_MODELS) {
    assert.ok(LIVE_FREE.has(model.id), `${model.id} is not in the free pool the upstream lists`)
  }
})
check('the roster covers the whole free pool, not a subset', () => {
  // A missing row is invisible: the picker simply has fewer models, and the
  // free tier looks smaller than it is.
  const LIVE_FREE = [
    'big-pickle', 'beam-free', 'crouton-alpha-free', 'deepseek-v4.1-flash-free',
    'flint-40b-free', 'glm-5.3-flash-free', 'iceman-free', 'inkling-2-small-free',
    'mimo-v2.6-flash-free', 'nemotron-3.5-lightning-free', 'nemotron-3.5-super-vl-free',
  ]
  const ids = new Set(FALLBACK_MODELS.map((m) => m.id))
  for (const id of LIVE_FREE) assert.ok(ids.has(id), `${id} is offered upstream but missing from the roster`)
})
check('every row carries a positive window and budget', () => {
  // DSH rejects a provider whose model metadata is not a positive integer, and
  // it rejects the WHOLE provider when one row is bad — an empty picker over a
  // working connection.
  for (const model of FALLBACK_MODELS) {
    assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0, `${model.id} has no context window`)
    assert.ok(Number.isInteger(model.maxTokens) && model.maxTokens > 0, `${model.id} has no output budget`)
  }
})
check('the roster is ordered as a fallback chain, roomiest first', () => {
  // candidatesFor() walks the list in order, so a small-context row ahead of a
  // large one sends a long conversation to the model that must refuse it.
  const windows = FALLBACK_MODELS.map((m) => m.contextWindow)
  const sorted = [...windows].sort((a, b) => b - a)
  assert.deepEqual(windows, sorted, 'the roster is not sorted by descending context window')
})
check('deterministic order for equal windows', () => {
  // Ties must not depend on the order someone happened to paste rows in:
  // within one window group, ids ascend.
  const groups = new Map()
  for (const model of FALLBACK_MODELS) {
    const group = groups.get(model.contextWindow) ?? []
    group.push(model.id)
    groups.set(model.contextWindow, group)
  }
  for (const [window, ids] of groups) {
    assert.deepEqual(ids, [...ids].sort(), `equal-window rows at ${window} are not in id order: ${ids.join(', ')}`)
  }
})
//#endregion

//#region paid vs free
console.log('paid vs free')
check('a row priced above zero is paid', () => {
  assert.equal(isPaidModel({ id: 'muse-wonder-1.0', price: 4 }), true)
})
check('a row priced at zero is free', () => {
  assert.equal(isPaidModel({ id: 'big-pickle', price: 0 }), false)
})
check('a row with no declared price is treated as free', () => {
  // Unknown must not silently become "needs a key": the anonymous tier is the
  // whole point, and the upstream answers for a genuinely paid model anyway.
  assert.equal(isPaidModel({ id: 'mystery' }), false)
})
//#endregion

//#region free-pool exhaustion
console.log('free-pool exhaustion')
check('a documented refusal names the reset time', () => {
  const text = describeFreePoolExhaustion(4 * 60 * 60)
  assert.match(text, /免费池/)
  assert.match(text, /重置/)
})
check('an unknown reset time still explains itself', () => {
  const text = describeFreePoolExhaustion(0)
  assert.match(text, /免费池/)
  assert.doesNotMatch(text, /undefined|NaN/)
})
//#endregion

//#region gate shaping
console.log('gate shaping')
check('an agent turn with a read tool is passed through untouched', () => {
  const body = { model: 'x', messages: [], tools: [{ type: 'function', function: { name: 'read' } }] }
  const { payload, bridged } = shapePayload(body, 'big-pickle')
  assert.equal(bridged, false)
  assert.deepEqual(payload.tools, body.tools)
})
check('a tool-less request gets the minimal read bridge', () => {
  const { payload, bridged } = shapePayload({ model: 'x', messages: [] }, 'big-pickle')
  assert.equal(bridged, true)
  assert.equal(payload.tools.length, 1)
  assert.equal(payload.tool_choice, 'none')
})
check('the model is always the candidate, never the request', () => {
  const { payload } = shapePayload({ model: 'requested', messages: [] }, 'fallback')
  assert.equal(payload.model, 'fallback')
})
check('streaming is forced on', () => {
  const { payload } = shapePayload({ model: 'x', messages: [], stream: false }, 'big-pickle')
  assert.equal(payload.stream, true)
})
//#endregion

//#region shim attribution
console.log('shim attribution')

const FREE = 'deepseek-v4.1-flash-free'
const PAID = 'muse-wonder-1.0'

/** A shim over a stubbed upstream; `answer(model)` returns a Response. */
async function withShim({ models, answer, key = 'public', keySource = 'anonymous' }, run) {
  const realFetch = globalThis.fetch
  const tried = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    tried.push(body.model)
    return answer(body.model, init)
  }
  const catalog = { current: () => models }
  const gate = {
    headers: () => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    userAgent: 'opencode/1.19.5',
    sessionId: () => 'ses_test',
  }
  const credentials = {
    current: () => ({ key, source: keySource }),
    tail: () => ({ source: keySource }),
  }
  const shim = createZenShim({ gate, catalog, credentials })
  try {
    await (shim.ready ?? Promise.resolve())
    await run({ shim, tried, realFetch })
  } finally {
    await shim.close()
    globalThis.fetch = realFetch
  }
}

const freeModel = (id) => ({ id, name: id, contextWindow: 200000, maxTokens: 32000, efforts: [], input: ['text'], price: 0 })
const paidModel = (id) => ({ id, name: id, contextWindow: 1000000, maxTokens: 128000, efforts: [], input: ['text'], price: 4 })

await checkAsync('a free 429 never surfaces a paid model’s 402', async () => {
  // The reported bug: asking for a free model, being told "Insufficient account
  // funds" — a billing message for a model the user never asked for, from a
  // call that was never billable.
  await withShim({
    models: [freeModel(FREE), paidModel(PAID)],
    answer: (model) => model === FREE
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }), { status: 429, headers: { 'retry-after': '3600' } })
      : new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Insufficient account funds' } }), { status: 402 }),
  }, async ({ shim, tried, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: FREE, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    assert.ok(!tried.includes(PAID), `the anonymous chain reached a paid model: ${tried.join(' -> ')}`)
    assert.doesNotMatch(text, /Insufficient account funds/i, 'the paid model’s billing error reached the user')
    assert.match(text, /免费池/, 'the free-pool explanation is missing')
  })
})

await checkAsync('with an api key, the paid model is a legitimate fallback', async () => {
  // A user who pasted a Zen key expects the chain to use what that key can buy.
  await withShim({
    models: [freeModel(FREE), paidModel(PAID)],
    key: 'zen_live_key',
    keySource: 'card',
    answer: (model) => model === FREE
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }), { status: 429 })
      : new Response('data: {"id":"1","model":"muse-wonder-1.0","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, async ({ shim, tried, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: FREE, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.ok(tried.includes(PAID), `the paid fallback was never tried: ${tried.join(' -> ')}`)
    assert.equal(res.status, 200)
  })
})

await checkAsync('a free-limit on a fallback does not hijack a paid request', async () => {
  // The mirror image: the caller asked for a PAID model with their own key,
  // that model is momentarily throttled, and a free fallback reports the daily
  // pool limit. The user must not be told "the free pool is empty" — their
  // request was never a free one.
  const PAID2 = 'gpt-6-sol'
  await withShim({
    models: [freeModel(FREE), paidModel(PAID2)],
    key: 'zen_live_key',
    keySource: 'card',
    answer: (model) => model === PAID2
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream busy' } }), { status: 429 })
      : new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }), { status: 429, headers: { 'retry-after': '3600' } }),
  }, async ({ shim, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: PAID2, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    assert.doesNotMatch(text, /免费池/, 'a free fallback’s pool limit was reported for a paid request')
  })
})

await checkAsync('a price-less paid row cannot hijack the answer either', async () => {
  // A saved catalog written before prices were recorded carries no price, so
  // isPaidModel() cannot recognise its paid rows. The request must still be
  // answered from the requested model's own refusal — the fallback's 402 is a
  // deterministic error and used to short-circuit the whole chain.
  const legacyPaid = { id: 'legacy-paid', name: 'Legacy paid', contextWindow: 1048576, maxTokens: 131072, efforts: [], input: ['text'] }
  await withShim({
    models: [freeModel(FREE), legacyPaid],
    answer: (model) => model === FREE
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }), { status: 429, headers: { 'retry-after': '3600' } })
      : new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Insufficient account funds' } }), { status: 402 }),
  }, async ({ shim, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: FREE, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    assert.doesNotMatch(text, /Insufficient account funds/i, 'a price-less fallback’s 402 short-circuited the chain')
    assert.match(text, /免费池/)
  })
})

await checkAsync('a requested paid model is attempted even without a key', async () => {
  // Naming a model explicitly is the caller's decision; refusing on their
  // behalf invents knowledge this shim does not have about their account.
  await withShim({
    models: [freeModel(FREE), paidModel(PAID)],
    answer: (model) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'no funds' } }), { status: 402 }),
  }, async ({ shim, tried, realFetch }) => {
    await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: PAID, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(tried[0], PAID, 'the explicitly requested paid model was skipped')
  })
})

await checkAsync('a deterministic 400 still surfaces as-is', async () => {
  // Bad request shapes are the user's (or this plugin's) bug and must not be
  // hidden behind a fallback message.
  await withShim({
    models: [freeModel(FREE), freeModel('big-pickle')],
    answer: () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large' } }), { status: 400 }),
  }, async ({ shim, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: FREE, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /max_tokens is too large/)
  })
})

await checkAsync('a working first candidate is returned without a fallback', async () => {
  await withShim({
    models: [freeModel(FREE), paidModel(PAID)],
    answer: () => new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }, async ({ shim, tried, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: FREE, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(tried, [FREE])
  })
})

await checkAsync('the shim only answers loopback callers', async () => {
  await withShim({
    models: [freeModel(FREE)],
    answer: () => new Response('{}', { status: 200 }),
  }, async ({ shim, realFetch }) => {
    const res = await realFetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: FREE, messages: [] }),
    })
    assert.equal(res.status, 401)
  })
})
//#endregion

//#region upstream constants
console.log('upstream')
check('the retired /zen/v1 base is not used', () => {
  assert.equal(UPSTREAM, 'https://opencode.ai/inference/v1')
})
//#endregion

console.log(`\n${passed} checks passed${failed === 0 ? '' : `, ${failed} failed`}`)
