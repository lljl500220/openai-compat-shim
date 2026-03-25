# openai-compat-shim

A minimal Node.js proxy that sits between editor clients and an OpenAI-compatible upstream.

It is useful when a client can override `base_url` / `api_key`, but the upstream gateway is only
partially compatible with the exact request shape the client sends.

This shim currently focuses on:

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- normalizing `input` / `messages` payloads
- preserving streaming responses (`stream: true`)
- stripping some fields that frequently break third-party gateways

## Requirements

- Node.js 18+

## Configuration

Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

Environment variables:

- `PORT`: local listen port
- `TARGET_BASE_URL`: upstream OpenAI-compatible base URL
- `TARGET_API_KEY`: upstream provider API key
- `SHIM_API_KEY`: the key your editor/client will use against this shim
- `DEFAULT_MODEL`: fallback model id exposed by `/v1/models`

## Run locally

```bash
export $(grep -v '^#' .env | xargs)
npm start
```

## PM2

```bash
export $(grep -v '^#' .env | xargs)
pm2 start ecosystem.config.cjs
pm2 save
```

## Test

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

List models:

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer replace-with-your-own-secret"
```

Chat completion:

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

Streaming chat completion:

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

## Nginx reverse proxy example

See [nginx.example.conf](./nginx.example.conf).

Typical production topology:

- public HTTPS domain in Nginx
- Nginx reverse proxy to `127.0.0.1:$PORT`
- editor/client points to `https://your-domain.example/v1`

## Notes

- This project is intentionally dependency-light and uses built-in Node modules only.
- It is a compatibility shim, not a full OpenAI clone.
- If your client still fails, log the incoming payload and adjust the adapter rules in `server.js`.
