# openai-compat-shim

[中文说明](./README.zh-CN.md)

A lightweight Node.js compatibility shim that sits between editor clients and an OpenAI-compatible upstream.

Its main job is not "proxying" in the narrow sense, but request-shape adaptation:

- accept editor/client payloads that are OpenAI-like but not fully standard
- normalize them into a shape the upstream can reliably understand
- preserve streaming
- preserve agent/tool-calling context
- provide request/response captures for debugging real production traffic

This project uses built-in Node modules only.

## Why this exists

Many editors can point to a custom `base_url` and `api_key`, but the upstream gateway is often only partially compatible with the exact JSON they send.

Typical mismatches:

- client sends `input`, upstream expects `messages`
- client sends tool definitions in a `responses`-style shape, upstream expects `chat.completions` function tools
- client mixes `chat/completions` path with `input` payloads
- client sends structured multi-turn content arrays, upstream expects normalized message objects
- client expects agent/tool-call continuation, but an intermediate shim accidentally flattens the conversation into plain text

This shim is the translation layer that absorbs those mismatches.

## What it serves

- `GET /`
- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

## Design

### Request flow

```text
Editor / Cursor / custom client
        |
        v
openai-compat-shim
  - auth guard
  - request parsing
  - payload adaptation
  - optional field stripping
  - optional debug capture
  - stream passthrough
        |
        v
OpenAI-compatible upstream
```

### Design goals

- preserve as much semantic information as possible
- normalize only the parts that are known to break compatibility
- do not eagerly flatten structured content unless there is no better fallback
- keep the implementation dependency-light and easy to deploy on a small server
- make production debugging cheap by capturing full request/response records when needed

### Non-goals

- this is not a full OpenAI API clone
- this is not a session store
- this shim does not execute tools itself
- this shim does not repair every upstream incompatibility automatically

## Implementation overview

### 1. Authentication and health endpoints

The shim can protect `/v1/*` endpoints with `SHIM_API_KEY`.

- client sends `Authorization: Bearer <shim-key>`
- shim validates it
- shim forwards to upstream with `TARGET_API_KEY`

`/healthz` and `/v1/models` exist so clients can probe the service before sending real traffic.

### 2. Payload adaptation

Core adaptation happens in `adaptPayload()` inside `server.js`.

For `/v1/chat/completions`:

- keep native `messages` if the client already sent them
- if the client sends `input`, convert it into structured `messages`
- preserve multi-turn role ordering instead of collapsing everything into one string
- convert tool definitions into `chat.completions`-friendly function tools

For `/v1/responses`:

- preserve structured `input`
- normalize string/object/array inputs into response items without destroying tool-call context

### 3. Tool-call preservation

The shim preserves:

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- assistant `tool_calls`
- tool result messages
- structured `input` items such as `function_call_output`

This is the key requirement for agent-style clients.

### 4. Streaming passthrough

The shim treats a request as streaming when one of these is true:

- `body.stream === true`
- `body.stream_options != null`
- request `Accept` header includes `text/event-stream`

When streaming is enabled, the upstream stream is piped directly back to the client.

For production reverse proxies such as Nginx, disable proxy buffering for `/v1/` routes; otherwise SSE clients such as Cursor may time out before they receive the first event.

### 5. Debug capture

When `DEBUG_CAPTURE_DIR` is set, the shim writes one JSON file per request containing:

- incoming request body
- adapted payload sent upstream
- upstream status and headers
- upstream response body

This is much more useful than packet capture for this service, because shim-to-upstream traffic is HTTPS.

## The key agent bug we hit

### Symptom

Cursor could talk to the service, but an agent task stopped after one round:

- first model response came back
- no real multi-turn tool loop followed
- it looked like the upstream "had no agent ability"

### What we first suspected

- upstream `gmncode.cn` might not support tool-calling
- upstream might not support `responses`
- upstream might reject forced `tool_choice`

Those were partly true in edge cases, but they were not the main blocker.

### Real root causes

There were two main compatibility bugs in the shim.

#### Root cause 1: tool-related fields were being stripped

An early version deleted fields such as:

- `tools`
- `tool_choice`
- `parallel_tool_calls`

That alone is enough to kill agent behavior.

#### Root cause 2: multi-turn structured input was flattened into a single user message

This was the deeper issue.

Cursor was sending requests to `/v1/chat/completions`, but the body used `input` with a multi-turn structured conversation:

- system instruction
- earlier user turns
- earlier assistant turns
- current user turn
- tool definitions

The old shim converted that entire `input` array into one giant text blob and wrapped it as:

```json
[
  {
    "role": "user",
    "content": "huge flattened text..."
  }
]
```

That destroyed the conversation shape:

- role boundaries were lost
- prior assistant turns were lost as assistant turns
- tool call continuity was lost
- the model no longer saw a real agent conversation

### A third compatibility issue

Cursor tool definitions were also not in the exact shape preferred by `chat.completions`.

Real client traffic included tools like:

```json
{
  "type": "function",
  "name": "Shell",
  "description": "...",
  "parameters": { ... }
}
```

and even:

```json
{
  "type": "custom",
  "name": "ApplyPatch",
  "description": "..."
}
```

For `chat/completions`, the upstream behaved more reliably when tools were transformed into:

```json
{
  "type": "function",
  "function": {
    "name": "Shell",
    "description": "...",
    "parameters": { ... }
  }
}
```

## How we fixed it

### Fix 1: preserve agent fields by default

The shim no longer deletes tool-related fields by default.

Instead it now supports configurable top-level stripping through:

- `STRIP_FIELDS`

Default:

```bash
STRIP_FIELDS=audio
```

### Fix 2: convert `input` to real multi-turn `messages`

For `/v1/chat/completions`, the shim now converts `input` arrays into role-preserving chat messages.

Examples:

- `role: system/user/assistant` items stay as their own messages
- `function_call` items become assistant `tool_calls`
- `function_call_output` items become `role: tool` messages
- `input_text` and `output_text` content parts are normalized to chat text parts

This was the change that brought agent behavior back.

### Fix 3: normalize tool definitions for chat completions

The shim now transforms:

- top-level `function` tools
- `custom` tools

into `chat.completions`-style function tool definitions.

That lets the upstream recognize real callable tools instead of treating them as opaque metadata.

### Fix 4: add request/response capture

We added `DEBUG_CAPTURE_DIR` so production traffic can be inspected without guessing.

That allowed us to compare:

- what Cursor actually sent
- what the shim adapted
- what the upstream returned

This turned the debugging process from speculation into direct evidence.

## What we verified

We verified the upstream behavior directly against `https://gmncode.cn/v1`.

Observed behavior:

- plain `/v1/chat/completions` works
- `/v1/chat/completions` with tools works
- `/v1/chat/completions` can return `tool_calls`
- `/v1/chat/completions` can accept tool-result follow-up messages
- `/v1/responses` can return function calls in the first round
- `/v1/responses` follow-up with `previous_response_id` was not reliable in our testing
- forced tool selection in some shapes was less stable than normal `tool_choice: "auto"`

Because of that, the most reliable path for this deployment is:

- keep Cursor traffic on `/v1/chat/completions`
- adapt mixed `input` payloads into structured `messages`
- normalize tools into `chat.completions` function-tool format

## Configuration

Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

Environment variables:

- `PORT`: listen port
- `TARGET_BASE_URL`: upstream base URL, for example `https://your-provider.example/v1`
- `TARGET_API_KEY`: upstream provider key
- `SHIM_API_KEY`: key used by editor/client against this shim
- `DEFAULT_MODEL`: fallback model exposed by `/v1/models`
- `STRIP_FIELDS`: comma-separated top-level request fields to remove before proxying
- `DEBUG_CAPTURE_DIR`: directory for full request/response capture files
- `ENABLE_STREAM_TOOL_TRANSFORM`: set to `1` only if you explicitly need streamed custom-tool argument rewriting; default off because it buffers the full SSE before replying
- `UPSTREAM_REQUEST_TIMEOUT_MS`: upstream POST timeout in milliseconds, default `300000`
- `NODE_USE_ENV_PROXY`: set to `1` so built-in Node.js `http` / `https` requests honor proxy environment variables
- `HTTP_PROXY`: outbound HTTP proxy, for example `http://127.0.0.1:7892`
- `HTTPS_PROXY`: outbound HTTPS proxy, for example `http://127.0.0.1:7892`
- `NO_PROXY`: addresses that should bypass the proxy, for example `127.0.0.1,localhost`

Example:

```bash
PORT=8787
TARGET_BASE_URL=https://your-openai-compatible-provider.example/v1
TARGET_API_KEY=sk-xxxx
SHIM_API_KEY=replace-with-your-own-secret
DEFAULT_MODEL=gpt-5.4
STRIP_FIELDS=audio
DEBUG_CAPTURE_DIR=
ENABLE_STREAM_TOOL_TRANSFORM=0
UPSTREAM_REQUEST_TIMEOUT_MS=300000
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:7892
HTTPS_PROXY=http://127.0.0.1:7892
NO_PROXY=127.0.0.1,localhost
```

## Local run

```bash
export $(grep -v '^#' .env | xargs)
npm start
```

## PM2 run

```bash
export $(grep -v '^#' .env | xargs)
pm2 start ecosystem.config.cjs
pm2 save
```

The PM2 config also passes through:

- `STRIP_FIELDS`
- `DEBUG_CAPTURE_DIR`
- `NODE_USE_ENV_PROXY`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`

## Route upstream traffic through a local proxy on the server

If the server reaches `gmncode.cn` much more slowly than your local machine, the most reliable fix is to route outbound traffic through a local proxy instead of changing the application protocol.

Recommended setup:

- run `mihomo` core on the server, not the `Clash Verge Rev` desktop GUI
- let `mihomo` fetch nodes from your subscription
- expose a local proxy port such as `127.0.0.1:7892`
- let this shim reach the upstream via `NODE_USE_ENV_PROXY=1` plus `HTTP_PROXY` / `HTTPS_PROXY`

Why this works:

- `Clash Verge Rev` is a desktop GUI client, not a good fit for a headless server
- this project uses built-in Node.js `http` / `https`
- starting from Node.js `v22.21.0`, built-in requests can honor proxy environment variables when `NODE_USE_ENV_PROXY=1` is enabled

References:

- Node.js enterprise network configuration: <https://nodejs.org/en/learn/http/enterprise-network-configuration>
- Mihomo service docs: <https://wiki.metacubex.one/en/startup/service/>
- Mihomo proxy-providers docs: <https://wiki.metacubex.one/en/config/proxy-providers/>

### 1. Prepare Mihomo config

The repo includes a sample file:

- [deploy/mihomo/config.yaml.example](./deploy/mihomo/config.yaml.example)

Replace the subscription URL with your own link.

### 2. Verify the proxy really improves upstream access

On the server, first verify that Mihomo can reach the upstream from its local proxy:

```bash
curl -x http://127.0.0.1:7892 -I https://gmncode.cn/
```

Only after this is clearly faster or more stable than direct access should the shim be pointed at the proxy.

### 3. Make the shim use the local proxy

Configure `.env` like this:

```bash
PORT=8787
TARGET_BASE_URL=https://gmncode.cn/v1
TARGET_API_KEY=sk-xxxx
SHIM_API_KEY=replace-with-your-own-secret
DEFAULT_MODEL=gpt-5.4
STRIP_FIELDS=audio
DEBUG_CAPTURE_DIR=
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:7892
HTTPS_PROXY=http://127.0.0.1:7892
NO_PROXY=127.0.0.1,localhost
```

### 4. Deploy with systemd

The repo includes a sample unit:

- [systemd/openai-compat-shim.service.example](./systemd/openai-compat-shim.service.example)

Key points:

- `After=mihomo.service` so the proxy core starts first
- `EnvironmentFile=/etc/openai-compat-shim.env`
- `NODE_USE_ENV_PROXY=1`
- `HTTP_PROXY` / `HTTPS_PROXY` point at the local Mihomo port

## Example requests

### Health check

```bash
curl http://127.0.0.1:8787/healthz
```

### Models

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer replace-with-your-own-secret"
```

### Basic chat completion

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer replace-with-your-own-secret" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "user", "content": "say hello" }
    ]
  }'
```

### Streaming chat completion

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer replace-with-your-own-secret" \
  -d '{
    "model": "gpt-5.4",
    "stream": true,
    "messages": [
      { "role": "user", "content": "reply with ok only" }
    ]
  }'
```

### Cursor-style mixed input on chat completions

This is the important compatibility case:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer replace-with-your-own-secret" \
  -d '{
    "model": "gpt-5.4",
    "input": [
      { "role": "system", "content": "You are a coding agent." },
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Use the calc tool to compute 2+2." }
        ]
      }
    ],
    "tools": [
      {
        "type": "function",
        "name": "calc",
        "description": "Evaluate arithmetic",
        "parameters": {
          "type": "object",
          "properties": {
            "expr": { "type": "string" }
          },
          "required": ["expr"]
        }
      }
    ]
  }'
```

## Debugging and troubleshooting

### 1. Turn on capture

```bash
DEBUG_CAPTURE_DIR=/path/to/captures
```

After restarting, each request will generate a JSON file with:

- `originalBody`
- `adaptedPayload`
- `upstreamStatus`
- `upstreamHeaders`
- `upstreamBody`

### 2. What to inspect first

If agent behavior is broken, compare:

- did the client send `tools`?
- did the client send `messages` or `input`?
- after adaptation, did the shim still preserve multiple roles?
- did assistant output contain `tool_calls`?
- did the upstream answer with `finish_reason: "tool_calls"` or `finish_reason: "stop"`?

### 3. Common failure patterns

#### Symptom: model answers directly instead of calling tools

Check:

- were tools stripped?
- were tools normalized into the correct shape?
- was a multi-turn `input` collapsed into one user string?

#### Symptom: first round works, second round fails

Check:

- whether follow-up tool-result messages were preserved as `role: tool`
- whether `function_call_output` was converted correctly
- whether the upstream path is `/chat/completions` or `/responses`

#### Symptom: request works locally but not in production

Check:

- PM2 environment values
- whether `--update-env` was used on restart
- whether `DEBUG_CAPTURE_DIR` is writable
- whether Nginx is buffering or timing out streaming responses

### 4. Recommended debug workflow

1. Enable `DEBUG_CAPTURE_DIR`
2. Reproduce the issue once
3. Open the newest capture file
4. Compare `originalBody` and `adaptedPayload`
5. Confirm whether the bug is in:
   - client request shape
   - shim adaptation
   - upstream compatibility
   - server outbound network quality

### 5. Network-first troubleshooting order

If the server is much worse than your local machine, check the network path first instead of blaming the agent protocol.

Order:

1. test direct access to `gmncode.cn` from the server
2. test access through the local `mihomo` proxy
3. compare `time_total`, TLS handshake, and TTFB
4. only if the network layer looks fine should you continue with shim captures

Example:

```bash
curl -o /dev/null -s -w 'direct dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://gmncode.cn/v1/models
curl -o /dev/null -s -x http://127.0.0.1:7892 -w 'proxy  dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://gmncode.cn/v1/models
```

## Deployment topology

Typical production setup:

- public HTTPS domain on Nginx
- Nginx reverse proxies to `127.0.0.1:$PORT`
- editor/client points at `https://your-domain.example/v1`
- PM2 keeps the shim alive

See [nginx.example.conf](./nginx.example.conf).

## Current known limitations

- this shim does not persist conversation state itself
- it depends on the client sending the right prior turns
- upstream `responses` continuation with `previous_response_id` may still be unreliable depending on provider behavior
- some providers are stricter than others about `tool_choice` shapes

## Maintenance notes

If a new client integration breaks, do not start by guessing.

Use captures to answer these questions in order:

1. What did the client actually send?
2. What did the shim actually forward?
3. What did the upstream actually return?

In practice, most bugs fall into one of these buckets:

- request shape mismatch
- tool schema mismatch
- multi-turn context flattening
- upstream-specific field intolerance

That is exactly what happened in the Cursor agent bug, and the fix came from preserving structure instead of simplifying it away.
