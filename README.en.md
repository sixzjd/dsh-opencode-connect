# DSH OpenCode Connect

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![npm version](https://img.shields.io/npm/v/@sixzjd/dsh-opencode-connect)](https://www.npmjs.com/package/@sixzjd/dsh-opencode-connect) [![npm downloads](https://img.shields.io/npm/dm/@sixzjd/dsh-opencode-connect)](https://www.npmjs.com/package/@sixzjd/dsh-opencode-connect) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[简体中文](./README.md) | **English**

Bring **OpenCode Zen** models into [DSH](https://github.com/deepseek-ai/deepseek-harness) (DSH), including Zen's **limited-time free model pool** (`*-free`, `big-pickle`, etc. — no balance required).

## How it works

Zen's free tier only admits a "genuine opencode client": requests must carry

- `User-Agent: opencode/<version>` (auto-refreshed to follow the latest opencode npm release);
- a matched pair of `x-opencode-session` / `x-opencode-session-id`, where the id is in opencode's own format (the first 12 hex digits decode to a timestamp);
- a tool named `read` in the tool list, on a streaming request.

DSH's normal configuration layer cannot forge these (`user-agent` is a DSH reserved attribution header and gets stripped), so the plugin runs an in-process **loopback shim**: pi-ai speaks standard OpenAI Chat Completions to the shim, and the shim speaks "opencode" to Zen. A real DSH agent turn already carries the `read` tool and passes the gate naturally; tool-less requests such as title generation get a minimal `read` + `tool_choice:"none"` injected by the shim, which also strips the occasional tool call the model returns. When the free pool hits 429/5xx or a model is delisted, the shim automatically falls back to the next model in the enabled catalog.

The architecture is shared with [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) (loopback shim + in-process provider registration + card management), and the impersonation logic is shared with [zen-proxy](https://github.com/12errh/zen-proxy) — but as a DSH plugin it runs **without an external process and without touching config files**.

## Installation

```sh
# From npm (recommended, scoped package)
dsh plugin --profile web add @sixzjd/dsh-opencode-connect

# Or from GitHub (pin a commit for reproducibility)
dsh plugin --profile web add github:sixzjd/dsh-opencode-connect#<commit>

# Or a local directory (development, link: is a live symlink)
dsh plugin --profile web add "link:/absolute/path/to/dsh-opencode-connect"
```

After installing, start a new DSH session and an **OpenCode Zen** group appears in the model picker. Settings → Plugin settings → the "OpenCode Connect" card lets you:

- paste your own Zen API Key (leave empty = anonymous free pool);
- see the model catalog source (live / last saved / built-in) and refresh it manually;
- toggle individual models (disabled models are hidden from the picker).

## Notes

- **Package-name collision**: the unscoped `dsh-opencode-connect` on npm is a different, independent project (`sanser9`) — not this repository — and **must not be published to** (it would collide). This repository is published as the scoped package **`@sixzjd/dsh-opencode-connect`**; use the commands above. When installing from GitHub, pin a commit for reproducibility.
- **The free pool has a daily quota**: measured 2026-11-08, when the pool is exhausted every free model returns `429 / FreeUsageLimitError`, `retry-after` points to the next UTC midnight (08:00 Beijing time), while `/models` still returns 200. The plugin translates this into "free pool quota used up for today, resets around X" instead of relaying the upstream "please subscribe to OpenCode Go".
- **Paid models are not in the anonymous fallback chain**: models with `cost.input.price > 0` only participate in fallback when the user has supplied their own API Key. Otherwise, if one were reached, its `402 Insufficient account funds` would mask the real free-pool failure — hence the "I wanted a free model, why does it say insufficient balance?" confusion.
- **Explicit requests are respected**: a model the user names explicitly is still tried once without a key; the plugin does not make account decisions on the user's behalf.
- The free pool is IP-rate-limited with shared slots, so it can return 429 at peak times (the plugin retries with the next model automatically);
- This bypasses an explicitly documented upstream restriction and is unsupported (anomalyco/opencode#42500 was closed as not planned). The gate may tighten at any time and break it;
- Plugin data (key, catalog cache) all lives under `<profile>/.dsh-opencode-connect/`.
- The built-in fallback list was **captured from real measurements** (11 free models on 2026-11-08), sorted by descending context window — fallback walks the list in order, and putting small-window models first would make long conversations hit a run of small windows first. `node test/smoke.mjs` verifies the list still contains only free models, covers the whole free pool, and is correctly ordered.

MIT
