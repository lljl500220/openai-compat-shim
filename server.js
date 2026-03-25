import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || "";
const TARGET_API_KEY = process.env.TARGET_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.4";
const SHIM_API_KEY = process.env.SHIM_API_KEY || "";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function logEvent(event) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      ...event
    })
  );
}

function cloneJson(value) {
  return value == null ? {} : JSON.parse(JSON.stringify(value));
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        if (item.type === "text") return item.text || "";
        if (item.type === "input_text") return item.text || "";
        if (item.type === "image_url") return "[image]";
        if (item.type === "input_image") return "[image]";
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    return JSON.stringify(content);
  }
  return String(content ?? "");
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => ({
    role: message?.role || "user",
    content: normalizeContent(message?.content)
  }));
}

function normalizeInputToText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (!item || typeof item !== "object") return normalizeContent(item);
        return normalizeContent(item.content ?? item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (input && typeof input === "object") {
    return normalizeContent(input.content ?? input);
  }
  return normalizeContent(input);
}

function adaptPayload(pathname, body) {
  const payload = body && typeof body === "object" ? cloneJson(body) : {};

  delete payload.parallel_tool_calls;
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.reasoning;
  delete payload.modalities;
  delete payload.audio;
  delete payload.metadata;

  if (pathname.endsWith("/responses")) {
    const input = payload.input;
    if (Array.isArray(input)) {
      payload.input = input
        .map((item) => normalizeContent(item?.content ?? item))
        .filter(Boolean)
        .join("\n");
    } else if (input && typeof input === "object") {
      payload.input = normalizeContent(input);
    }
  }

  if (pathname.endsWith("/chat/completions")) {
    const normalizedMessages = normalizeMessages(payload.messages);
    if (normalizedMessages.length > 0) {
      payload.messages = normalizedMessages;
      delete payload.input;
    } else if (payload.input != null) {
      payload.messages = [
        {
          role: "user",
          content: normalizeInputToText(payload.input)
        }
      ];
      delete payload.input;
    } else {
      payload.messages = [];
    }
  }

  if (!payload.model) {
    payload.model = DEFAULT_MODEL;
  }

  return payload;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

async function proxyJson(req, res, pathname) {
  if (!TARGET_BASE_URL || !TARGET_API_KEY) {
    return sendJson(res, 500, {
      error: {
        message: "Server missing TARGET_BASE_URL or TARGET_API_KEY",
        type: "server_configuration_error"
      }
    });
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: error.message, type: "invalid_request_error" }
    });
  }

  const payload = adaptPayload(pathname, body);
  const upstreamUrl = new URL(pathname, TARGET_BASE_URL.endsWith("/") ? TARGET_BASE_URL : `${TARGET_BASE_URL}/`);

  const wantsStream = body?.stream === true;

  logEvent({
    phase: "proxy_request",
    method: req.method,
    path: pathname,
    model: payload.model,
    requestedStream: wantsStream,
    keys: Object.keys(payload),
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : undefined,
    hasInput: payload.input != null
  });

  let upstreamResponse;
  try {
    upstreamResponse = await new Promise((resolve, reject) => {
      const requestBody = JSON.stringify(payload);
      const options = {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
          Authorization: `Bearer ${TARGET_API_KEY}`
        }
      };
      const transport = upstreamUrl.protocol === "https:" ? https : http;
      const upstreamReq = transport.request(options, (upstreamRes) => {
        if (wantsStream) {
          resolve({
            status: upstreamRes.statusCode || 502,
            headers: upstreamRes.headers,
            stream: upstreamRes
          });
          return;
        }

        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode || 502,
            headers: upstreamRes.headers,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      });
      upstreamReq.on("error", reject);
      upstreamReq.write(requestBody);
      upstreamReq.end();
    });
  } catch (error) {
    return sendJson(res, 502, {
      error: {
        message: `Upstream request failed: ${error.message}`,
        type: "upstream_connection_error"
      }
    });
  }

  if (wantsStream) {
    logEvent({
      phase: "proxy_response",
      method: req.method,
      path: pathname,
      status: upstreamResponse.status,
      streamed: true
    });
    res.writeHead(upstreamResponse.status, {
      "Content-Type": upstreamResponse.headers["content-type"] || "text/event-stream; charset=utf-8",
      "Cache-Control": upstreamResponse.headers["cache-control"] || "no-cache",
      Connection: upstreamResponse.headers.connection || "keep-alive"
    });
    upstreamResponse.stream.pipe(res);
    upstreamResponse.stream.on("error", (error) => {
      logEvent({
        phase: "stream_error",
        method: req.method,
        path: pathname,
        message: error.message
      });
      res.destroy(error);
    });
    return;
  }

  const text = upstreamResponse.text;
  logEvent({
    phase: "proxy_response",
    method: req.method,
    path: pathname,
    status: upstreamResponse.status,
    streamed: false
  });
  res.writeHead(upstreamResponse.status, {
    "Content-Type": upstreamResponse.headers["content-type"] || "application/json; charset=utf-8"
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  logEvent({
    phase: "incoming",
    method: req.method,
    path: pathname,
    hasAuth: Boolean(req.headers.authorization),
    userAgent: req.headers["user-agent"] || ""
  });

  if (req.method === "GET" && pathname === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      targetBaseUrl: TARGET_BASE_URL,
      defaultModel: DEFAULT_MODEL
    });
  }

  if (req.method === "GET" && pathname === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "openai-compat-shim",
      targetBaseUrl: TARGET_BASE_URL,
      defaultModel: DEFAULT_MODEL
    });
  }

  if (SHIM_API_KEY && pathname.startsWith("/v1/")) {
    const token = readBearerToken(req);
    if (token !== SHIM_API_KEY) {
      logEvent({
        phase: "auth_rejected",
        method: req.method,
        path: pathname
      });
      return sendJson(res, 401, {
        error: {
          message: "Invalid shim API key",
          type: "authentication_error"
        }
      });
    }
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: DEFAULT_MODEL,
          object: "model",
          owned_by: "shim"
        }
      ]
    });
  }

  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/responses")) {
    return proxyJson(req, res, pathname);
  }

  logEvent({
    phase: "not_found",
    method: req.method,
    path: pathname
  });
  return sendJson(res, 404, {
    error: { message: `Unsupported path: ${pathname}`, type: "not_found" }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `openai-compat-shim listening on :${PORT}, target=${TARGET_BASE_URL}, defaultModel=${DEFAULT_MODEL}`
  );
});
