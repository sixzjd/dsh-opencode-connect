/**
 * dsh-opencode-connect — host half.
 *
 * Registers an `opencode` LLM provider whose models are served by OpenCode Zen
 * (https://opencode.ai/inference/v1), including the anonymous free tier. Zen
 * gates its free models to genuine OpenCode clients, so every upstream request
 * is shaped like one: an `opencode/<version>` User-Agent, the paired
 * `x-opencode-session` / `x-opencode-session-id` headers carrying an id in
 * opencode's own timestamped format, and (for requests that carry no tools at
 * all) a minimal `read` tool with `tool_choice: "none"` — the exact shape
 * measured to pass the gate while keeping the reply tool-free.
 *
 * The shaping cannot live in the profile config: dsh's own adapter strips a
 * configured `user-agent` as a reserved attribution header, so the plugin owns
 * the wire format through a loopback shim, the same architecture
 * dsh-qoder-connect uses for its private transport. pi-ai speaks plain
 * OpenAI-completions to the shim; the shim speaks opencode to Zen.
 *
 * @module dsh-opencode-connect
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

export const name = 'llm-opencode'
export const inject = ['llm']

const PROVIDER_ID = 'opencode-zen'
const DISPLAY_NAME = 'OpenCode Zen'
const PLUGIN_VERSION = '0.1.0'

/** Zen's inference endpoint. The legacy /zen/v1 base is retired and gate-refuses everything. */
const UPSTREAM = 'https://opencode.ai/inference/v1'
/** The session header pair the gate requires; both must carry the same value. */
const SESSION_HEADERS = ['x-opencode-session', 'x-opencode-session-id']
/** A session id stays plausible for ~30 minutes; re-mint on a schedule. */
const SESSION_MAX_AGE_MS = 30 * 60_000
/** How often to re-check the npm registry for a newer opencode release. */
const UA_REFRESH_MS = 6 * 60 * 60_000
/** How often to re-fetch the live model catalog. */
const CATALOG_REFRESH_MS = 30 * 60_000
/** Upstream wall-clock ceiling per attempt. */
const UPSTREAM_TIMEOUT_MS = 120_000
/** Extra same-model attempts on transient failures before the chain moves on. */
const RETRIES_PER_MODEL = 2
const RETRY_BACKOFF_MS = 500
/** Cap the fallback walk so one request cannot fan out over the whole catalog. */
const MAX_FALLBACK_CANDIDATES = 8
/** Chat-completion bodies in a long session are large; 32 MiB mirrors Anthropic's guidance. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** The shim's preferred fixed loopback port (env-overridable; falls back to ephemeral on collision). */
const SHIM_PORT = Number(process.env.DSH_OPENCODE_CONNECT_PORT ?? 39317)
/** Models whose ids are not chat-servable on Zen (systemone classification endpoint). */
const NOT_CHAT_SERVABLE = /^jev-/

/**
 * The gate's measured minimum: a tool named `read` (schema content is not
 * checked), streaming, the session pair and the opencode UA. A request that
 * already carries a `read` tool — every real dsh agent turn does — is sent
 * untouched; a tool-less auxiliary request (titles, compaction) gets this
 * injected with `tool_choice: "none"`, and any tool call the model returns
 * anyway is stripped from the reply.
 */
const GATE_READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file or directory from the local filesystem.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The absolute path to the file or directory to read.' },
        offset: { type: 'integer', minimum: 0, description: '1-based start line.' },
        limit: { type: 'integer', minimum: 0, description: 'Maximum lines to read.' },
      },
      required: ['filePath'],
    },
  },
}

//#region paths and small IO
/**
 * Plugin data directory: `<profile>/.dsh-opencode-connect` when the module is
 * installed inside a profile's node_modules, falling back to `$DSH_HOME`
 * otherwise (a checkout running its own tests). One folder is the whole
 * footprint (credential + saved catalog + settings).
 */
function pluginDataDir() {
  const override = process.env.DSH_OPENCODE_CONNECT_DATA_DIR
  if (override !== undefined && override.trim() !== '') return override
  const here = dirname(fileURLToPath(import.meta.url))
  // .../profiles/<profile>/node_modules/.../lib → profile dir = the path
  // component right before the LAST node_modules segment.
  const marker = '/node_modules/'
  const idx = here.lastIndexOf(marker)
  if (idx !== -1) {
    const profileDir = here.slice(0, idx)
    if (profileDir.includes('/profiles/')) return join(profileDir, '.dsh-opencode-connect')
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(process.env.HOME ?? '.', '.dsh')
  return join(home, '.dsh-opencode-connect')
}

function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  return undefined
}

function writeJsonFileAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, path)
  } catch {
    // Persistence is best-effort: a failed write must never stop the plugin from serving.
  }
}
//#endregion

//#region gate identity (session ids, UA)
const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/**
 * Mint an id in opencode's own format: `ses_` + 12 hex chars that decode to a
 * plausible creation timestamp + 14 random base62 chars. The gate decodes the
 * leading 12 hex and refuses ids that do not carry a real timestamp, so a
 * naive random suffix pair is rejected exactly like a missing header.
 */
function genSessionId(now = Date.now(), counter = 1) {
  const stamp = BigInt(now) * 0x1000n + BigInt(counter)
  const masked = ~stamp
  const hex = Array.from({ length: 6 }, (_, i) => Number((masked >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('')
  const tail = Array.from(randomBytes(14), (b) => SESSION_ALPHABET[b % 62]).join('')
  return `ses_${hex}${tail}`
}

/** The opencode client identity the shim presents upstream. */
class ZenGate {
  #session
  #userAgent = 'opencode/1.18.30'
  #uaCheckedAt = 0
  #logger
  constructor(logger) {
    this.#logger = logger
  }
  /** The session pair value, re-minted when older than the plausibility window. */
  sessionId() {
    const now = Date.now()
    if (this.#session === undefined || now - this.#session.at > SESSION_MAX_AGE_MS) {
      this.#session = { value: genSessionId(now), at: now }
    }
    return this.#session.value
  }
  get userAgent() {
    return this.#userAgent
  }
  /** Ask the npm registry for the latest opencode release; keep the old UA on any failure. */
  async refreshUserAgent(force = false) {
    const now = Date.now()
    if (!force && this.#uaCheckedAt !== 0 && now - this.#uaCheckedAt < UA_REFRESH_MS) return
    this.#uaCheckedAt = now
    try {
      const res = await fetch('https://registry.npmjs.org/opencode-ai/latest', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return
      const data = await res.json()
      const version = String(data?.version ?? '')
      if (!/^\d+\.\d+\.\d+/.test(version)) return
      const next = `opencode/${version}`
      if (next !== this.#userAgent) {
        this.#userAgent = next
        this.#logger?.info?.(`dsh-opencode-connect: presenting opencode/${version} to the Zen gate`)
      }
    } catch {
      // Registry unreachable: the pinned UA keeps working until the next check.
    }
  }
  headers(apiKey) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${apiKey}`,
      'user-agent': this.#userAgent,
    }
    const session = this.sessionId()
    for (const name of SESSION_HEADERS) headers[name] = session
    return headers
  }
}
//#endregion

//#region credential store
/**
 * The Zen API key. Resolution order: the plugin-owned file (saved from the
 * card), then `OPENCODE_API_KEY` in the environment, then the anonymous public
 * token — the free tier answers `Bearer public` when the request is shaped
 * like opencode's, so a missing key is a working state, not an error.
 */
class CredentialStore {
  #path
  constructor(path) {
    this.#path = path
  }
  #file() {
    const doc = readJsonFile(this.#path)
    const key = doc?.apiKey
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined
  }
  current() {
    const file = this.#file()
    if (file !== undefined) return { key: file, source: 'card' }
    const env = process.env.OPENCODE_API_KEY?.trim()
    if (env !== undefined && env !== '') return { key: env, source: 'env' }
    return { key: 'public', source: 'anonymous' }
  }
  save(apiKey) {
    const trimmed = String(apiKey ?? '').trim()
    if (trimmed === '') throw new Error('empty key')
    writeJsonFileAtomic(this.#path, { version: 1, apiKey: trimmed, savedAtMs: Date.now() })
  }
  clear() {
    writeJsonFileAtomic(this.#path, { version: 1, apiKey: '', clearedAtMs: Date.now() })
  }
  /** Redacted display tail; never the key itself. */
  tail() {
    const { key, source } = this.current()
    if (source !== 'card') return { source, tail: undefined }
    return { source, tail: key.length <= 8 ? '••••' : key.slice(-4) }
  }
}
//#endregion

//#region catalog
/**
 * The built-in roster: the free pool as captured from Zen's own /models plus
 * models.dev metadata (context/output budgets, reasoning efforts, modalities),
 * transcribed 2026-10-18. It exists so the provider serves a usable list
 * before the first live fetch and when both the network and models.dev are
 * unreachable; the live answer replaces it at startup.
 */
const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', contextWindow: 200000, maxTokens: 32000, efforts: ['low', 'high', 'max'], input: ['text', 'image'] },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', contextWindow: 200000, maxTokens: 128000, efforts: ['low', 'high', 'max'], input: ['text'] },
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, efforts: [], input: ['text'] },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', contextWindow: 200000, maxTokens: 32000, efforts: [], input: ['text', 'image'] },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash Free', contextWindow: 262144, maxTokens: 32768, efforts: [], input: ['text'] },
  { id: 'hy3-free', name: 'Hy3 Free', contextWindow: 190000, maxTokens: 64000, efforts: ['low', 'medium', 'high'], input: ['text'] },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3 Flash Free', contextWindow: 204800, maxTokens: 131072, efforts: [], input: ['text'] },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', contextWindow: 1000000, maxTokens: 128000, efforts: [], input: ['text'] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 262144, maxTokens: 262144, efforts: [], input: ['text'] },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', contextWindow: 262144, maxTokens: 65536, efforts: [], input: ['text', 'image'] },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', contextWindow: 1000000, maxTokens: 131072, efforts: [], input: ['text', 'image'] },
  { id: 'space-bunny-free', name: 'Space Bunny Free', contextWindow: 262144, maxTokens: 65536, efforts: [], input: ['text'] },
  { id: 'beam-free', name: 'Beam Free', contextWindow: 262144, maxTokens: 65536, efforts: [], input: ['text'] },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free', contextWindow: 256000, maxTokens: 32000, efforts: ['low', 'medium', 'high'], input: ['text'] },
  { id: 'cat-jam-free', name: 'Cat Jam Free', contextWindow: 1048576, maxTokens: 131072, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], input: ['text'] },
  { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free', contextWindow: 262144, maxTokens: 262144, efforts: [], input: ['text', 'image'] },
]

/**
 * Mutable model list shared by the shim's /v1/models, the adapter and the
 * card. Entries are `{ id, name, contextWindow, maxTokens, efforts, input }`.
 * `source` records where the current list came from (live → saved → fallback),
 * mirroring dsh-qoder-connect's three-level degradation so the card can say
 * whether the list is fresh, remembered, or compiled in.
 */
class Catalog {
  #models = FALLBACK_MODELS.map((m) => ({ ...m }))
  #disabled = new Set()
  source = 'fallback'
  fetchedAtMs
  lastError
  /** ids the live endpoint listed, for the card's "upstream offers N models". */
  listed = new Set(FALLBACK_MODELS.map((m) => m.id))
  current() {
    return this.#models.filter((m) => !this.#disabled.has(m.id))
  }
  all() {
    return [...this.#models]
  }
  set(models, source, fetchedAtMs) {
    this.#models = models.map((m) => ({ ...m }))
    this.source = source
    if (fetchedAtMs !== undefined) this.fetchedAtMs = fetchedAtMs
  }
  setDisabled(ids) {
    const next = new Set(ids)
    const changed = next.size !== this.#disabled.size || [...next].some((id) => !this.#disabled.has(id))
    this.#disabled = next
    return changed
  }
  getDisabled() {
    return [...this.#disabled]
  }
  has(id) {
    return this.#models.some((m) => m.id === id)
  }
}
//#endregion

//#region catalog fetching
const VALID_MODEL_ID = /^[A-Za-z0-9._:@+/%-]+$/

function toModelInfo(row) {
  const contextWindow = Number.isFinite(row.contextWindow) && row.contextWindow > 0 ? Math.floor(row.contextWindow) : 200000
  const maxTokens = Number.isFinite(row.maxTokens) && row.maxTokens > 0 ? Math.floor(row.maxTokens) : Math.min(32768, contextWindow)
  return {
    id: String(row.id),
    name: typeof row.name === 'string' && row.name !== '' ? row.name : String(row.id),
    contextWindow,
    maxTokens,
    efforts: Array.isArray(row.efforts) ? row.efforts.filter((e) => typeof e === 'string') : [],
    input: Array.isArray(row.input) && row.input.includes('image') ? ['text', 'image'] : ['text'],
  }
}

/**
 * Read models.dev's opencode section for the budgets/efforts the Zen /models
 * endpoint does not carry. Prefers opencode's own local cache (free, offline,
 * refreshed by that CLI); a fetch of the full catalog is the fallback and is
 * bounded by a timeout because the document is multi-megabyte.
 *
 * `needed` is the set of ids that must be described. The local cache is only
 * as fresh as the last `opencode` run, so when it does not cover every needed
 * id the live document is fetched as well and merged over it (live wins per
 * id). Without this a stale cache silently pins whatever the built-in roster
 * guessed for a model the cache has never heard of.
 */
async function modelsDevMeta(logger, needed = []) {
  const cachePath = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? '.', '.cache'), 'opencode', 'models.json')
  const tryDoc = (doc) => {
    const section = doc?.opencode?.models
    if (section === null || typeof section !== 'object') return undefined
    const out = {}
    for (const [id, m] of Object.entries(section)) {
      out[id] = {
        name: m?.name,
        contextWindow: m?.limit?.context,
        maxTokens: m?.limit?.output,
        efforts: Array.isArray(m?.reasoning_options) ? m.reasoning_options.flatMap((o) => (o?.type === 'effort' && Array.isArray(o.values) ? o.values : [])) : [],
        input: Array.isArray(m?.modalities?.input) ? m.modalities.input : undefined,
      }
    }
    return out
  }
  let cached
  try {
    cached = tryDoc(readJsonFile(cachePath))
  } catch {}
  const uncovered = cached === undefined || needed.some((id) => cached[id] === undefined)
  if (!uncovered) return cached
  try {
    const res = await fetch('https://models.dev/api.json', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (res.ok) {
      const live = tryDoc(await res.json())
      if (live !== undefined) return cached === undefined ? live : { ...cached, ...live }
    }
  } catch (error) {
    logger?.warn?.('dsh-opencode-connect: models.dev metadata unavailable', error)
  }
  return cached
}

async function fetchLiveCatalog(logger) {
  const res = await fetch(`${UPSTREAM}/models`, {
    headers: { accept: 'application/json', 'user-agent': 'opencode/1.18.30' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`zen /models answered ${res.status}`)
  const doc = await res.json()
  const rows = Array.isArray(doc?.data) ? doc.data : []
  return rows
    .map((row) => (typeof row?.id === 'string' && VALID_MODEL_ID.test(row.id) ? row.id : null))
    .filter((id) => id !== null && !NOT_CHAT_SERVABLE.test(id))
}
//#endregion

//#region upstream error classification
/**
 * A failure the fallback chain should walk past: capacity/availability
 * conditions (429, 5xx, retired ids, free-tier refusals, provider overload)
 * that say something about the model or the pool, not about the request.
 * Deterministic request errors (400 bad body, 401 auth) break out instead.
 */
function retryableUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  if (status === 410) return true
  if (status < 400 || status > 499) return false
  const type = String(body?.error?.type ?? body?.type ?? '')
  const message = String(body?.error?.message ?? body?.message ?? '')
  if (['server_error', 'api_error', 'upstream_error', 'ProviderError', 'ModelError', 'FreeTierError', 'model_not_found'].includes(type)) return true
  return /model is unavailable|not supported|only be used in opencode|free tier can only|no such model|does not exist|has been deprecated|no longer available|overloaded|temporarily.*limit|upstream request failed/i.test(message)
}

function transientUpstream(status, body) {
  if (status === 429 || status >= 500) return true
  const type = String(body?.error?.type ?? body?.type ?? '')
  return ['server_error', 'api_error', 'upstream_error', 'ProviderError'].includes(type)
}

function parseRetryAfter(value) {
  if (value == null) return 0
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const t = Date.parse(value)
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : 0
}
//#endregion

//#region request shaping
/**
 * Shape one chat-completion body for the gate. Three cases:
 * - tools present and one is named `read` (every real dsh agent turn): pass through untouched;
 * - tools present without `read`: append the gate tool (the gate only checks a
 *   `read` exists; the model still prefers the caller's own tools);
 * - no tools at all (auxiliary title/summary requests): append the gate tool
 *   with `tool_choice: "none"` and strip any tool call the model returns anyway.
 * Streaming is forced: the gate refuses non-stream free-tier traffic, and the
 * relay reassembles plain JSON when the client asked for none.
 */
function shapePayload(body, modelId) {
  const payload = { ...body, model: modelId, stream: true }
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const hasRead = tools.some((t) => t?.function?.name === 'read')
  let bridged = false
  if (tools.length === 0) {
    payload.tools = [GATE_READ_TOOL]
    payload.tool_choice = 'none'
    bridged = true
  } else if (!hasRead) {
    payload.tools = [...tools, GATE_READ_TOOL]
  }
  return { payload, bridged }
}

/** Strip injected-bridge tool calls from a reassembled non-stream reply. */
function stripToolCalls(content) {
  if (content !== null && typeof content === 'object' && Array.isArray(content.choices)) {
    for (const choice of content.choices) {
      if (choice?.message && Array.isArray(choice.message.tool_calls)) {
        delete choice.message.tool_calls
        if (choice.message.content == null || choice.message.content === '') choice.message.content = ''
      }
      if (choice?.finish_reason === 'tool_calls') choice.finish_reason = 'stop'
    }
  }
  return content
}
//#endregion

//#region loopback shim
/**
 * The loopback OpenAI-completions endpoint pi-ai points at. Inbound hardening
 * follows dsh-qoder-connect: loopback bind, Host/Origin checks, a per-process
 * bearer secret, and a JSON content-type requirement — the shim is reachable
 * by any local process otherwise.
 */
function createZenShim({ gate, catalog, credentials, logger }) {
  const SHARED_SECRET = randomBytes(32).toString('base64url')
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

  function hostnameOfHost(host) {
    const value = String(host ?? '').trim().toLowerCase()
    if (value.startsWith('[')) {
      const end = value.indexOf(']')
      return end === -1 ? value : value.slice(0, end + 1)
    }
    const colon = value.lastIndexOf(':')
    return colon !== -1 && !value.slice(0, colon).includes(':') && /^\d+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value
  }
  function trusted(req) {
    if (!LOOPBACK_HOSTS.has(hostnameOfHost(req.headers.host))) return false
    const origin = req.headers.origin
    return origin === undefined || /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
  }
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const a = Buffer.from(match[1])
    const b = Buffer.from(SHARED_SECRET)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  function openaiError(res, status, type, message) {
    const payload = JSON.stringify({ error: { message, type, code: type } })
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  async function readBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > MAX_BODY_BYTES) {
        const err = new Error('request body too large')
        err.statusCode = 413
        throw err
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** Candidate walk: the requested model first, then the rest of the enabled catalog. */
  function candidatesFor(requested) {
    const rest = catalog.current().map((m) => m.id).filter((id) => id !== requested)
    if (requested !== undefined && catalog.current().some((m) => m.id === requested)) return [requested, ...rest].slice(0, MAX_FALLBACK_CANDIDATES)
    return rest.slice(0, MAX_FALLBACK_CANDIDATES)
  }

  async function relayStream(res, upstreamRes, signal, bridged) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let reader
    try {
      reader = upstreamRes.body.getReader()
    } catch {
      res.end()
      return
    }
    // Cancelling the reader resolves any in-flight read() as done, so a stall
    // mid-stream (the free-tier backend holding the connection open without
    // data) is broken by the abort/timeout rather than blocking the pump.
    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buf += decoder.decode(chunk.value, { stream: true })
        if (!bridged) {
          // Plain passthrough: hand over everything up to the last complete
          // event boundary so a split block never gets rewritten wrongly.
          const cut = buf.lastIndexOf('\n\n')
          if (cut !== -1) {
            res.write(buf.slice(0, cut + 2))
            buf = buf.slice(cut + 2)
          }
          continue
        }
        // Bridged: only forward complete events, dropping tool-call data lines.
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx + 2)
          buf = buf.slice(idx + 2)
          const out = sanitizeBlock(block)
          if (out !== '') res.write(out)
        }
      }
      if (buf !== '') res.write(bridged ? sanitizeBlock(buf.endsWith('\n\n') ? buf : `${buf}\n\n`) : buf)
    } catch (error) {
      logger?.warn?.('dsh-opencode-connect: upstream stream failed mid-flight', error)
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (res.writable && !res.writableEnded) res.end()
    }
  }

  /** Drop tool-call data lines from one complete SSE event; keep the rest verbatim. */
  function sanitizeBlock(block) {
    const lines = block.split('\n')
    const out = []
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        out.push(line)
        continue
      }
      const raw = line.slice(5).trim()
      if (raw === '' || raw === '[DONE]') {
        out.push(line)
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        out.push(line)
        continue
      }
      const choices = Array.isArray(parsed?.choices) ? parsed.choices : []
      if (choices.some((c) => c?.delta?.tool_calls !== undefined)) continue
      let touched = false
      for (const c of choices) {
        if (c?.finish_reason === 'tool_calls') {
          c.finish_reason = 'stop'
          touched = true
        }
      }
      out.push(`data: ${touched ? JSON.stringify(parsed) : raw}`)
    }
    const text = out.join('\n')
    return text.replace(/\n+$/, '') === '' ? '' : `${text.replace(/\n+$/, '')}\n\n`
  }

  /** Reassemble an SSE stream into the plain chat.completion JSON the client asked for. */
  async function collectCompletion(upstreamRes, signal) {
    if (!/text\/event-stream/i.test(upstreamRes.headers.get('content-type') ?? '')) return await upstreamRes.json()
    const message = { role: 'assistant', content: '' }
    const out = {
      id: `chatcmpl-${randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
    }
    const toolCalls = []
    let reader
    try {
      reader = upstreamRes.body.getReader()
    } catch {
      return out
    }
    const decoder = new TextDecoder()
    let buf = ''
    // Same stall-break as relayStream: an abort resolves the in-flight read.
    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        let chunk
        try {
          chunk = await reader.read()
        } catch {
          break
        }
        if (chunk.done) break
        buf += decoder.decode(chunk.value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx + 2)
          buf = buf.slice(idx + 2)
          let raw = ''
          for (const line of block.split('\n')) if (line.startsWith('data:')) raw = line.slice(5).trim()
          if (raw === '' || raw === '[DONE]') continue
          let d
          try {
            d = JSON.parse(raw)
          } catch {
            continue
          }
          if (typeof d?.model === 'string' && d.model !== '') out.model = d.model
          if (d?.usage !== undefined && d.usage !== null) out.usage = d.usage
          for (const choice of Array.isArray(d?.choices) ? d.choices : []) {
            if (typeof choice?.delta?.content === 'string') message.content += choice.delta.content
            if (typeof choice?.delta?.reasoning_content === 'string') message.reasoning_content = (message.reasoning_content ?? '') + choice.delta.reasoning_content
            if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls)
            if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') out.choices[0].finish_reason = choice.finish_reason
          }
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (toolCalls.length > 0) message.tool_calls = mergeToolCallDeltas(toolCalls)
    if (out.model === '') out.model = upstreamRes.headers.get('x-opencode-model') ?? ''
    return out
  }

  function mergeToolCallDeltas(deltas) {
    const merged = []
    for (const d of deltas) {
      const idx = Number.isInteger(d?.index) ? d.index : merged.length
      let slot = merged.find((m) => m.index === idx)
      if (slot === undefined) {
        slot = { id: d?.id ?? `call_${idx}`, type: 'function', index: idx, function: { name: d?.function?.name ?? '', arguments: '' } }
        merged.push(slot)
      }
      if (typeof d?.function?.name === 'string' && d.function.name !== '') slot.function.name = d.function.name
      if (typeof d?.function?.arguments === 'string') slot.function.arguments += d.function.arguments
    }
    return merged
  }

  async function chatCompletions(req, res) {
    if (!trusted(req)) return openaiError(res, 403, 'unauthorized', 'loopback only')
    if (!bearerOk(req)) return openaiError(res, 401, 'invalid_request_error', 'invalid shim token')
    if (req.method !== 'POST') return openaiError(res, 405, 'not_found', `no such route: ${req.method}`)
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
      return openaiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object')
    } catch (error) {
      const status = error?.statusCode === 413 ? 413 : 400
      return openaiError(res, status, 'invalid_request_error', String(error?.message ?? error))
    }
    const requested = typeof body.model === 'string' && body.model !== '' ? body.model : undefined
    const candidates = candidatesFor(requested)
    if (candidates.length === 0) return openaiError(res, 503, 'api_error', 'opencode zen: no enabled models in catalog')
    const clientWantsStream = body.stream === true
    const { key } = credentials.current()
    // One abort signal drives every upstream attempt for this request: it
    // fires on a wall-clock ceiling (so a saturated free-tier backend that
    // opens the stream and then stalls cannot hang the relay forever) or the
    // moment the client hangs up. Node's IncomingMessage carries no `.signal`,
    // so it is built here rather than assumed.
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS)
    deadline.unref?.()
    const onClientClose = () => controller.abort(new Error('client closed'))
    res.on('close', onClientClose)
    let firstErr = null
    let firstStatus = 0
    let lastErr = null
    let lastStatus = 502
    try {
      for (const model of candidates) {
        const { payload, bridged } = shapePayload(body, model)
        const headers = gate.headers(key)
        const retries = RETRIES_PER_MODEL
        let delayMs = 0
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          delayMs = 0
          let upstreamRes
          try {
            upstreamRes = await fetch(`${UPSTREAM}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
          } catch (error) {
            lastErr = { error: { type: 'upstream_error', message: String(error?.message ?? error) } }
            lastStatus = 502
            // Once the request budget is spent, every remaining candidate's
            // fetch rejects on the same aborted signal — walk out fast rather
            // than stacking another timeout per model.
            if (controller.signal.aborted) break
            if (attempt < retries) {
              delayMs = RETRY_BACKOFF_MS * (attempt + 1)
              continue
            }
            break
          }
          if (upstreamRes.ok) {
            if (model !== requested) {
              res.setHeader?.('x-opencode-served-by', model)
              res.setHeader?.('x-opencode-fallback', 'true')
            }
            // Awaited (not `return`ed): the enclosing finally must not clear
            // the deadline until the stream has actually been pumped.
            if (clientWantsStream) {
              await relayStream(res, upstreamRes, controller.signal, bridged)
              return
            }
            try {
              const content = await collectCompletion(upstreamRes, controller.signal)
              if (content && typeof content === 'object') {
                content.model = requested ?? model
                if (model !== requested) content.opencode_served_by = model
              }
              return sendJson(res, 200, stripToolCalls(content))
            } catch (error) {
              logger?.warn?.('dsh-opencode-connect: bad upstream stream', error)
              return openaiError(res, 502, 'upstream_error', 'bad upstream response')
            }
          }
          try {
            lastErr = await upstreamRes.json()
          } catch {
            lastErr = { error: { type: 'upstream_error', message: `upstream returned ${upstreamRes.status}` } }
          }
          lastStatus = upstreamRes.status
          const retryAfterMs = Math.min(parseRetryAfter(upstreamRes.headers.get('retry-after')) * 1000, 3000)
          if (transientUpstream(upstreamRes.status, lastErr) && attempt < retries) {
            delayMs = Math.max(RETRY_BACKOFF_MS * (attempt + 1), retryAfterMs)
            continue
          }
          if (retryableUpstream(upstreamRes.status, lastErr)) {
            if (retryAfterMs > 0) await new Promise((r) => setTimeout(r, retryAfterMs))
            break
          }
          // Deterministic request-level error: surface it as-is rather than masking it behind the chain.
          return sendJson(res, upstreamRes.status, lastErr)
        }
        if (model === requested && firstErr === null) {
          firstErr = lastErr
          firstStatus = lastStatus
        }
      }
      const finalStatus = firstErr !== null ? firstStatus : lastStatus
      const finalErr = firstErr ?? lastErr
      sendJson(res, finalStatus === 0 ? 502 : finalStatus, finalErr ?? { error: { type: 'rate_limit_error', message: 'all opencode zen models are unavailable' } })
    } finally {
      clearTimeout(deadline)
      res.removeListener('close', onClientClose)
    }
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      if (!trusted(req) || !bearerOk(req)) return openaiError(res, 401, 'invalid_request_error', 'invalid shim token')
      return sendJson(res, 200, {
        object: 'list',
        data: catalog.current().map((m) => ({ id: m.id, object: 'model', created: Math.floor((catalog.fetchedAtMs ?? Date.now()) / 1000), owned_by: 'opencode' })),
      })
    }
    chatCompletions(req, res).catch((error) => {
      logger?.warn?.('dsh-opencode-connect: loopback request failed', error)
      try {
        if (!res.headersSent) openaiError(res, 500, 'internal', String(error))
        else res.end()
      } catch {}
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  // The shim must never hold a finished CLI run open: an unref'd listener lets
  // the process exit while the server is up.
  server.unref()

  // A fixed loopback port keeps baseUrl() usable synchronously: the adapter's
  // model descriptors embed the shim origin at construction, and the headless
  // host starts its first turn before an awaited setup continuation resolves.
  // A collision falls back to an ephemeral port and the caller refreshes its
  // descriptors when `ready` lands. The promise never rejects: an unawaited
  // rejection would tear down the host process.
  const ready = new Promise((resolve) => {
    server.once('listening', () => resolve(true))
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        logger?.warn?.(`dsh-opencode-connect: port ${SHIM_PORT} is busy, falling back to an ephemeral loopback port`)
        server.once('error', (retryError) => {
          logger?.error?.('dsh-opencode-connect: loopback endpoint failed to start', retryError)
          resolve(false)
        })
        server.listen(0, '127.0.0.1')
        return
      }
      logger?.error?.('dsh-opencode-connect: loopback endpoint failed to start', error)
      resolve(false)
    })
  })
  server.listen(SHIM_PORT, '127.0.0.1')

  return {
    ready,
    baseUrl: () => `http://127.0.0.1:${server.address()?.port ?? SHIM_PORT}`,
    token: () => SHARED_SECRET,
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
//#endregion

//#region pi-ai adapter
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}
/** pi-ai's auth plane stays inert: the shim's shared secret is the only credential on this route. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-opencode-connect: the opencode route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function reasoningFields(info) {
  if (!Array.isArray(info.efforts) || info.efforts.length === 0) return { reasoning: false }
  const efforts = info.efforts
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: efforts.includes('minimal') ? 'minimal' : null,
      low: efforts.includes('low') ? 'low' : null,
      medium: efforts.includes('medium') ? 'medium' : null,
      high: efforts.includes('high') ? 'high' : null,
      xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
      max: efforts.includes('max') ? 'max' : null,
    },
  }
}

function toPiModel(info, baseUrl) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl,
    input: info.input === undefined ? ['text'] : info.input.filter((m) => m === 'text' || m === 'image').length > 1 ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  }
}

function createOpenCodeAdapter({ shim, catalog, resolveAttachments }) {
  const buildModels = () => catalog.current().map((info) => toPiModel(info, `${shim.baseUrl()}/v1`))
  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'OpenCode Zen shim shared secret',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: DISPLAY_NAME }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }
  const profile = {
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-opencode-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  let profiles = new Map([[PROVIDER_ID, profile]])
  return {
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      // Image inputs reach the wire through the host's durable attachment
      // service: dsh-llm-pi-ai refuses any request carrying an image without
      // it (UNSUPPORTED_CONTENT: "pi-ai image input requires the durable
      // attachment service"), so the adapter must be handed the service the
      // same way dsh-qoder-connect hands it.
      ...resolveAttachments === void 0 ? {} : { resolveAttachments },
    }),
    invalidate: () => {
      profiles = new Map([[PROVIDER_ID, profile]])
    },
  }
}
//#endregion

//#region host routes (card surface)
/** Per-process control keys, minted once so a fiber hot-reload does not 403 the open card. */
let processKeys
function controlKeys() {
  processKeys ??= { auth: randomBytes(24).toString('hex'), models: randomBytes(24).toString('hex') }
  return processKeys
}

function routeGuard(req, key) {
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))) return false
  const presented = req.headers['x-dsh-opencode-connect-key']
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readRouteBody(req, limit = 4096) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limit) return undefined
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}
//#endregion

//#region plugin entry
/**
 * Start the provider: shim first (the models read its ephemeral port), then
 * the adapter registration, then the catalog lifecycle. An empty catalog hides
 * the model group in dsh's picker, which is how a provider with nothing to
 * serve disappears without touching registration.
 */
export async function apply(ctx, config = {}) {
  const dataDir = pluginDataDir()
  const credentials = new CredentialStore(join(dataDir, '.opencode-auth.json'))
  const savedCatalogPath = join(dataDir, '.opencode-catalog.json')
  const gate = new ZenGate(ctx.logger)
  const catalog = new Catalog()
  const { auth: authKey, models: modelsKey } = controlKeys()

  // Seed: the account's last successful live list, else the built-in roster.
  const saved = readJsonFile(savedCatalogPath)
  if (Array.isArray(saved?.models) && saved.models.length > 0) {
    const seeded = saved.models.map((m) => {
      try {
        return toModelInfo(m)
      } catch {
        return undefined
      }
    }).filter((m) => m !== undefined)
    if (seeded.length > 0) catalog.set(seeded, 'saved', saved.fetchedAtMs)
  }
  if (Array.isArray(config?.disabledModels)) catalog.setDisabled(config.disabledModels)

  const disabledFromSettings = () => {
    const doc = readJsonFile(join(dataDir, '.opencode-settings.json'))
    return Array.isArray(doc?.disabledModels) ? doc.disabledModels : undefined
  }
  const ownDisabled = disabledFromSettings()
  if (ownDisabled !== undefined) catalog.setDisabled(ownDisabled)

  let invalidateAdapter
  const refresh = () => {
    invalidateAdapter?.()
    ctx.emit('llm/adapters-updated')
  }

  async function refreshCatalog() {
    try {
      const ids = await fetchLiveCatalog(ctx.logger)
      if (ids.length === 0) throw new Error('zen listed no models')
      const meta = await modelsDevMeta(ctx.logger, ids)
      const byId = new Map(catalog.all().map((m) => [m.id, m]))
      const models = ids.map((id) => {
        const prior = byId.get(id)
        const m = meta?.[id]
        return toModelInfo({
          id,
          name: m?.name ?? prior?.name ?? id,
          contextWindow: m?.contextWindow ?? prior?.contextWindow,
          maxTokens: m?.maxTokens ?? prior?.maxTokens,
          efforts: m?.efforts ?? prior?.efforts,
          input: m?.input ?? prior?.input,
        })
      })
      catalog.set(models, 'live', Date.now())
      catalog.lastError = undefined
      writeJsonFileAtomic(savedCatalogPath, { version: 1, fetchedAtMs: catalog.fetchedAtMs, models })
      refresh()
    } catch (error) {
      catalog.lastError = String(error?.message ?? error)
      ctx.logger?.warn?.('dsh-opencode-connect: catalog refresh failed', error)
    }
  }

  const shim = createZenShim({ gate, catalog, credentials, logger: ctx.logger })

  // Register synchronously, before any await: the headless host starts its
  // first turn the moment the fiber is ready and does not await an async
  // setup continuation, so an adapter registered after an `await` loses the
  // race (the first turn sees NO_ADAPTER). baseUrl() is known synchronously
  // because the shim binds a fixed loopback port, so the model descriptors
  // can be built without waiting for the listen event.
  const built = createOpenCodeAdapter({
    shim,
    catalog,
    // Lazy service lookup (same as dsh-qoder-connect): the adapter asks for
    // the host's attachment service only when a request actually carries an
    // image, so a host without one never fails plugin startup.
    resolveAttachments: () => ctx.get('attachments'),
  })
  invalidateAdapter = () => built.invalidate()
  let releaseAdapter
  let releaseDirectory
  try {
    releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], built.adapter)
  } catch (error) {
    ctx.logger?.error?.('dsh-opencode-connect: registerAdapter failed', error)
    return
  }
  try {
    releaseDirectory = ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      settingsNs: ctx.fiber?.entry?.options?.id ?? PROVIDER_ID,
      settingsPath: [],
      declared: false,
    }])
  } catch (error) {
    ctx.logger?.error?.('dsh-opencode-connect: registerConfigurableProviders failed', error)
    releaseAdapter()
    return
  }
  ctx.effect(() => () => {
    releaseAdapter()
    releaseDirectory()
  })
  // The first catalog fetch runs in the background: serving starts on the
  // saved/built-in roster and upgrades to the live list when it lands.
  void refreshCatalog()
  void gate.refreshUserAgent()
  // When the listen event lands (including the ephemeral-port fallback), the
  // descriptors' embedded baseUrl may have changed — re-snapshot them.
  void shim.ready.then((up) => {
    if (up) refresh()
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      void refreshCatalog()
      void gate.refreshUserAgent()
    }, CATALOG_REFRESH_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // Card routes on the host web server (same-origin for the browser half).
  const statusHandler = (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    const host = req.headers.host
    if (typeof host !== 'string' || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) {
      res.statusCode = 403
      res.end()
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))) {
      res.statusCode = 403
      res.end()
      return
    }
    const { source, tail } = credentials.tail()
    const payload = JSON.stringify({
      status: 'ok',
      credential: { source, tail },
      userAgent: gate.userAgent,
      catalog: {
        source: catalog.source,
        fetchedAt: catalog.fetchedAtMs,
        error: catalog.lastError,
        models: catalog.all().map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          free: m.id.endsWith('-free') || m.id === 'big-pickle',
          enabled: !catalog.getDisabled().includes(m.id),
        })),
      },
      authKey,
      modelsKey,
      version: PLUGIN_VERSION,
    })
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(payload)
  }

  const authHandler = async (req, res) => {
    if (req.method !== 'POST' || !routeGuard(req, authKey)) {
      res.statusCode = req.method === 'POST' ? 403 : 405
      res.end()
      return
    }
    const text = await readRouteBody(req)
    let action
    try {
      action = JSON.parse(text ?? '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    if (action?.action === 'save') {
      try {
        credentials.save(action.apiKey)
      } catch {
        res.statusCode = 400
        res.end()
        return
      }
    } else if (action?.action === 'clear') {
      credentials.clear()
    } else {
      res.statusCode = 400
      res.end()
      return
    }
    res.statusCode = 204
    res.end()
  }

  const modelsHandler = async (req, res) => {
    if (req.method !== 'POST' || !routeGuard(req, modelsKey)) {
      res.statusCode = req.method === 'POST' ? 403 : 405
      res.end()
      return
    }
    const text = await readRouteBody(req, 65536)
    let action
    try {
      action = JSON.parse(text ?? '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    if (action?.action === 'set-disabled' && Array.isArray(action.models)) {
      const known = new Set(catalog.all().map((m) => m.id))
      const next = action.models.filter((id) => typeof id === 'string' && known.has(id))
      writeJsonFileAtomic(join(dataDir, '.opencode-settings.json'), { version: 1, disabledModels: next })
      if (catalog.setDisabled(next)) refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'refresh') {
      await refreshCatalog()
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 400
    res.end()
  }

  // Card routes on the host web server (same-origin for the browser half).
  // Deferred injection: a headless host without the webServer service simply
  // never runs this callback, and the model channel keeps working.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const a = webCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-opencode-connect/status', handler: statusHandler })
      const b = webCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-opencode-connect/auth', handler: authHandler })
      const c = webCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-opencode-connect/models', handler: modelsHandler })
      return () => {
        a()
        b()
        c()
      }
    }, 'dsh-opencode-connect: web routes')
  })

  ctx.effect(() => async () => {
    try {
      await shim.close()
    } catch {}
  })
}

export default { name, inject, apply }
//#endregion

// Internal surfaces exported for tests and CLI use, mirroring the pattern
// dsh-qoder-connect establishes for its own bundle.
export { Catalog, CredentialStore, FALLBACK_MODELS, GATE_READ_TOOL, UPSTREAM, ZenGate, createOpenCodeAdapter, createZenShim, pluginDataDir, shapePayload }
