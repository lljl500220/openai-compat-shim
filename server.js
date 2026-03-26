import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || "";
const TARGET_API_KEY = process.env.TARGET_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gpt-5.4";
const SHIM_API_KEY = process.env.SHIM_API_KEY || "";
const STRIP_FIELDS = String(process.env.STRIP_FIELDS || "audio")
  .split(",")
  .map((field) => field.trim())
  .filter(Boolean);
const DEBUG_CAPTURE_DIR = process.env.DEBUG_CAPTURE_DIR || "";

// Send a small JSON response with a consistent content type.
function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// Extract the bearer token used for shim-side auth checks.
function readBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

// Emit structured logs so production traffic is easy to inspect.
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

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Generate a unique file name for per-request debug captures.
function makeCaptureId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

// Persist a full request/response record when debug capture is enabled.
async function writeDebugCapture(record) {
  if (!DEBUG_CAPTURE_DIR) return;
  const filePath = path.join(DEBUG_CAPTURE_DIR, `${makeCaptureId()}.json`);
  await fs.mkdir(DEBUG_CAPTURE_DIR, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

// Ensure tool-call arguments are serialized as strings for chat.completions compatibility.
function normalizeToolCall(toolCall) {
  const normalized = toolCall && typeof toolCall === "object" ? cloneJson(toolCall) : {};
  if (normalized.function && typeof normalized.function === "object") {
    const args = normalized.function.arguments;
    if (args != null && typeof args !== "string") {
      normalized.function.arguments = JSON.stringify(args);
    }
  }
  return normalized;
}

function normalizeToolParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false
    };
  }
  const normalized = cloneJson(parameters);
  if (!normalized.type) {
    normalized.type = "object";
  }
  if (normalized.type === "object") {
    if (!normalized.properties || typeof normalized.properties !== "object") {
      normalized.properties = {};
    }
    if (normalized.additionalProperties == null) {
      normalized.additionalProperties = false;
    }
  }
  return normalized;
}

// Convert incoming tool definitions into the function-tool shape upstreams expect.
function normalizeChatTool(tool) {
  if (!tool || typeof tool !== "object") return null;

  if (tool.type === "function" && tool.function && typeof tool.function === "object") {
    const normalized = cloneJson(tool);
    normalized.function.parameters = normalizeToolParameters(normalized.function.parameters);
    return normalized;
  }

  if (tool.type === "function" && typeof tool.name === "string") {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: normalizeToolParameters(tool.parameters),
        strict: tool.strict
      }
    };
  }

  if (tool.type === "custom" && typeof tool.name === "string") {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "The raw string input for this custom tool."
            }
          },
          required: ["input"],
          additionalProperties: false
        }
      }
    };
  }

  return null;
}

// Normalize an entire tools array while dropping unsupported entries.
function normalizeChatTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(normalizeChatTool).filter(Boolean);
}

function extractCustomToolNames(tools) {
  const names = new Set();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (tool?.type === "custom" && typeof tool.name === "string" && tool.name) {
      names.add(tool.name);
    }
  }
  return names;
}

// Translate content parts from mixed client formats into chat-completions parts.
function normalizeChatContentPart(part) {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }
  if (!part || typeof part !== "object") {
    return { type: "text", text: String(part ?? "") };
  }

  const normalized = cloneJson(part);
  if (normalized.type === "input_text") {
    normalized.type = "text";
  }
  if (normalized.type === "output_text") {
    normalized.type = "text";
  }
  if (normalized.type === "input_image") {
    normalized.type = "image_url";
    if (normalized.image_url == null && typeof normalized.image === "string") {
      normalized.image_url = { url: normalized.image };
      delete normalized.image;
    }
  }
  return normalized;
}

// Best-effort fallback that flattens structured content into plain text.
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

// Normalize a single chat message while preserving tool-call context.
function normalizeChatMessage(message) {
  const normalized = message && typeof message === "object" ? cloneJson(message) : {};
  normalized.role = normalized.role || "user";

  if ("content" in normalized) {
    if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content.map(normalizeChatContentPart);
    } else if (
      normalized.content &&
      typeof normalized.content === "object" &&
      typeof normalized.content.text === "string"
    ) {
      normalized.content = normalized.content.text;
    } else if (
      normalized.content != null &&
      typeof normalized.content !== "string" &&
      typeof normalized.content !== "object"
    ) {
      normalized.content = String(normalized.content);
    }
  } else if (normalized.role === "assistant" && Array.isArray(normalized.tool_calls) && normalized.tool_calls.length > 0) {
    normalized.content = null;
  } else {
    normalized.content = "";
  }

  if (Array.isArray(normalized.tool_calls)) {
    normalized.tool_calls = normalized.tool_calls.map(normalizeToolCall);
  }

  return normalized;
}

// Normalize a messages array and drop invalid top-level shapes.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeChatMessage);
}

// Collapse arbitrary input into text only when we cannot preserve richer structure.
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

// Map one responses-style input item into one or more chat messages.
function normalizeInputItemToChatMessages(item) {
  if (item == null) return [];
  if (typeof item === "string") {
    return [
      {
        role: "user",
        content: item
      }
    ];
  }
  if (typeof item !== "object") {
    return [
      {
        role: "user",
        content: String(item)
      }
    ];
  }

  if (item.role || item.type === "message") {
    return [normalizeChatMessage(item)];
  }

  if (item.type === "function_call") {
    return [
      normalizeChatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || "",
            type: "function",
            function: {
              name: item.name || item.function?.name || "",
              arguments: item.arguments || item.function?.arguments || "{}"
            }
          }
        ]
      })
    ];
  }

  if (item.type === "custom_tool_call") {
    return [
      normalizeChatMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || "",
            type: "function",
            function: {
              name: item.name || "",
              arguments:
                typeof item.input === "string"
                  ? item.input
                  : JSON.stringify(item.input ?? {})
            }
          }
        ]
      })
    ];
  }

  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return [
      normalizeChatMessage({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: normalizeContent(item.output)
      })
    ];
  }

  return [
    {
      role: "user",
      content: normalizeContent(item.content ?? item)
    }
  ];
}

// Convert mixed input payloads into role-preserving chat messages.
function normalizeInputToChatMessages(input) {
  if (Array.isArray(input)) {
    return input.flatMap(normalizeInputItemToChatMessages);
  }
  return normalizeInputItemToChatMessages(input);
}

// Normalize a single responses content part into a stable item shape.
function normalizeResponseContentItem(item) {
  if (typeof item === "string") {
    return { type: "input_text", text: item };
  }
  if (!item || typeof item !== "object") {
    return { type: "input_text", text: String(item ?? "") };
  }
  return cloneJson(item);
}

// Normalize one responses input item without losing tool-call continuity.
function normalizeResponseInputItem(item) {
  if (typeof item === "string") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: item }]
    };
  }
  if (!item || typeof item !== "object") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: String(item ?? "") }]
    };
  }

  const normalized = cloneJson(item);

  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map(normalizeResponseContentItem);
  } else if (typeof normalized.content === "string") {
    normalized.content = [{ type: "input_text", text: normalized.content }];
  } else if (
    normalized.content &&
    typeof normalized.content === "object" &&
    !Array.isArray(normalized.content)
  ) {
    normalized.content = [normalizeResponseContentItem(normalized.content)];
  }

  if (Array.isArray(normalized.tool_calls)) {
    normalized.tool_calls = normalized.tool_calls.map(normalizeToolCall);
  }

  return normalized;
}

// Normalize /responses input while preserving structured items whenever possible.
function normalizeResponseInput(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map(normalizeResponseInputItem);
  }
  if (input && typeof input === "object") {
    return normalizeResponseInputItem(input);
  }
  return input;
}

function unwrapCustomToolArguments(name, argumentsText, customToolNames) {
  if (!customToolNames.has(name) || typeof argumentsText !== "string") {
    return argumentsText;
  }
  const parsed = tryParseJson(argumentsText);
  if (parsed && typeof parsed.input === "string") {
    return parsed.input;
  }
  return argumentsText;
}

function transformChatCompletionJson(text, customToolNames) {
  const payload = tryParseJson(text);
  if (!payload || payload.object !== "chat.completion") {
    return text;
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const toolCalls = choice?.message?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name;
      const args = toolCall?.function?.arguments;
      if (typeof name === "string" && typeof args === "string") {
        toolCall.function.arguments = unwrapCustomToolArguments(name, args, customToolNames);
      }
    }
  }

  return JSON.stringify(payload);
}

function makeChunkFromTemplate(template, choice) {
  return {
    id: template?.id || "",
    object: template?.object || "chat.completion.chunk",
    created: template?.created || Math.floor(Date.now() / 1000),
    model: template?.model || DEFAULT_MODEL,
    choices: [choice]
  };
}

function transformChatCompletionSse(text, customToolNames) {
  const rawText = String(text || "");
  if (!rawText.includes("tool_calls")) return rawText;

  const events = rawText.split("\n\n").filter(Boolean);
  const parsedEvents = [];

  for (const event of events) {
    if (!event.startsWith("data: ")) {
      parsedEvents.push({ kind: "raw", value: event });
      continue;
    }

    const data = event.slice("data: ".length);
    if (data === "[DONE]") {
      parsedEvents.push({ kind: "done" });
      continue;
    }

    const parsed = tryParseJson(data);
    if (!parsed) {
      parsedEvents.push({ kind: "raw", value: event });
      continue;
    }

    parsedEvents.push({ kind: "json", value: parsed });
  }

  const toolStates = new Map();
  const toolOrder = [];
  const finishReasons = new Map();
  const passthroughEvents = [];
  const trailingEvents = [];
  let templateChunk = null;

  for (const event of parsedEvents) {
    if (event.kind !== "json") {
      if (event.kind !== "done") {
        passthroughEvents.push(event);
      }
      continue;
    }

    const payload = event.value;
    if (payload?.object !== "chat.completion.chunk" || !Array.isArray(payload.choices)) {
      passthroughEvents.push(event);
      continue;
    }

    if (!templateChunk) {
      templateChunk = payload;
    }

    if (payload.choices.length === 0) {
      trailingEvents.push(event);
      continue;
    }

    const cloned = cloneJson(payload);
    const keptChoices = [];

    for (const choice of cloned.choices) {
      const choiceIndex = choice?.index ?? 0;
      const delta = choice?.delta;

      if (Array.isArray(delta?.tool_calls)) {
        for (const toolDelta of delta.tool_calls) {
          const toolIndex = toolDelta?.index ?? 0;
          const key = `${choiceIndex}:${toolIndex}`;
          let state = toolStates.get(key);
          if (!state) {
            state = {
              choiceIndex,
              toolIndex,
              id: "",
              type: "function",
              name: "",
              arguments: ""
            };
            toolStates.set(key, state);
            toolOrder.push(key);
          }

          if (typeof toolDelta?.id === "string" && toolDelta.id) {
            state.id = toolDelta.id;
          }
          if (typeof toolDelta?.type === "string" && toolDelta.type) {
            state.type = toolDelta.type;
          }
          if (typeof toolDelta?.function?.name === "string" && toolDelta.function.name) {
            state.name += toolDelta.function.name;
          }
          if (typeof toolDelta?.function?.arguments === "string") {
            state.arguments += toolDelta.function.arguments;
          }
        }
      }

      if (choice?.finish_reason != null) {
        finishReasons.set(choiceIndex, choice.finish_reason);
      }

      if (delta && typeof delta === "object") {
        delete delta.tool_calls;
      }

      const hasDelta =
        delta &&
        typeof delta === "object" &&
        Object.keys(delta).length > 0 &&
        !(Object.keys(delta).length === 1 && delta.content === "");

      if (hasDelta && choice?.finish_reason == null) {
        keptChoices.push(choice);
      }
    }

    if (keptChoices.length > 0) {
      cloned.choices = keptChoices;
      passthroughEvents.push({ kind: "json", value: cloned });
    }
  }

  const hasCustomToolCall = toolOrder.some((key) => customToolNames.has(toolStates.get(key)?.name));
  if (!hasCustomToolCall) {
    return rawText;
  }

  const output = [];
  for (const event of passthroughEvents) {
    if (event.kind === "json") {
      output.push(`data: ${JSON.stringify(event.value)}`);
    } else if (event.kind === "raw") {
      output.push(event.value);
    }
  }

  for (const key of toolOrder) {
    const state = toolStates.get(key);
    if (!state) continue;
    const args = unwrapCustomToolArguments(state.name, state.arguments, customToolNames);
    output.push(
      `data: ${JSON.stringify(
        makeChunkFromTemplate(templateChunk, {
          index: state.choiceIndex,
          delta: {
            tool_calls: [
              {
                index: state.toolIndex,
                id: state.id,
                type: state.type,
                function: {
                  name: state.name,
                  arguments: ""
                }
              }
            ]
          },
          finish_reason: null
        })
      )}`
    );

    if (args) {
      output.push(
        `data: ${JSON.stringify(
          makeChunkFromTemplate(templateChunk, {
            index: state.choiceIndex,
            delta: {
              tool_calls: [
                {
                  index: state.toolIndex,
                  function: {
                    name: "",
                    arguments: args
                  }
                }
              ]
            },
            finish_reason: null
          })
        )}`
      );
    }
  }

  for (const [choiceIndex, finishReason] of finishReasons.entries()) {
    output.push(
      `data: ${JSON.stringify(
        makeChunkFromTemplate(templateChunk, {
          index: choiceIndex,
          delta: { content: "" },
          finish_reason: finishReason
        })
      )}`
    );
  }

  for (const event of trailingEvents) {
    output.push(`data: ${JSON.stringify(event.value)}`);
  }

  output.push("data: [DONE]");
  return `${output.join("\n\n")}\n\n`;
}

// Adapt client payloads into the most compatible upstream shape for each endpoint.
function adaptPayload(pathname, body) {
  const payload = body && typeof body === "object" ? cloneJson(body) : {};

  for (const field of STRIP_FIELDS) {
    delete payload[field];
  }

  if (pathname.endsWith("/responses")) {
    if (payload.input != null) {
      payload.input = normalizeResponseInput(payload.input);
    }
  }

  if (pathname.endsWith("/chat/completions")) {
    if (Array.isArray(payload.tools)) {
      payload.tools = normalizeChatTools(payload.tools);
    }

    const normalizedMessages = normalizeMessages(payload.messages);
    if (normalizedMessages.length > 0) {
      payload.messages = normalizedMessages;
      delete payload.input;
    } else if (payload.input != null) {
      const inputMessages = normalizeInputToChatMessages(payload.input);
      payload.messages =
        inputMessages.length > 0
          ? inputMessages
          : [
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

// Read and parse a JSON request body from the incoming client stream.
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

// Forward the adapted request upstream and preserve either JSON or SSE streaming behavior.
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

  const customToolNames = extractCustomToolNames(body?.tools);
  const payload = adaptPayload(pathname, body);
  const upstreamUrl = new URL(pathname, TARGET_BASE_URL.endsWith("/") ? TARGET_BASE_URL : `${TARGET_BASE_URL}/`);
  const captureBase = {
    ts: new Date().toISOString(),
    method: req.method,
    path: pathname,
    userAgent: req.headers["user-agent"] || "",
    originalBody: body,
    adaptedPayload: payload
  };

  const acceptHeader = String(req.headers.accept || "");
  const wantsStream =
    body?.stream === true ||
    body?.stream_options != null ||
    acceptHeader.includes("text/event-stream");

  logEvent({
    phase: "proxy_request",
    method: req.method,
    path: pathname,
    model: payload.model,
    requestedStream: wantsStream,
    accept: acceptHeader,
    keys: Object.keys(payload),
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : undefined,
    hasInput: payload.input != null,
    bodyPreview: JSON.stringify(body).slice(0, 800)
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
    const shouldTransformStream =
      pathname.endsWith("/chat/completions") && customToolNames.size > 0;

    if (shouldTransformStream) {
      const streamedChunks = [];
      upstreamResponse.stream.on("data", (chunk) => {
        streamedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      upstreamResponse.stream.on("error", (error) => {
        logEvent({
          phase: "stream_error",
          method: req.method,
          path: pathname,
          message: error.message
        });
        res.destroy(error);
      });
      upstreamResponse.stream.on("end", () => {
        const upstreamBody = Buffer.concat(streamedChunks).toString("utf8");
        const transformedBody = transformChatCompletionSse(upstreamBody, customToolNames);
        writeDebugCapture({
          ...captureBase,
          streamed: true,
          upstreamStatus: upstreamResponse.status,
          upstreamHeaders: upstreamResponse.headers,
          upstreamBody,
          transformedBody
        }).catch((error) => {
          logEvent({
            phase: "debug_capture_error",
            method: req.method,
            path: pathname,
            message: error.message
          });
        });
        res.writeHead(upstreamResponse.status, {
          "Content-Type": upstreamResponse.headers["content-type"] || "text/event-stream; charset=utf-8",
          "Cache-Control": upstreamResponse.headers["cache-control"] || "no-cache",
          Connection: upstreamResponse.headers.connection || "keep-alive"
        });
        res.end(transformedBody);
      });
      return;
    }

    res.writeHead(upstreamResponse.status, {
      "Content-Type": upstreamResponse.headers["content-type"] || "text/event-stream; charset=utf-8",
      "Cache-Control": upstreamResponse.headers["cache-control"] || "no-cache",
      Connection: upstreamResponse.headers.connection || "keep-alive"
    });
    const streamedChunks = [];
    upstreamResponse.stream.on("data", (chunk) => {
      streamedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    upstreamResponse.stream.on("end", () => {
      writeDebugCapture({
        ...captureBase,
        streamed: true,
        upstreamStatus: upstreamResponse.status,
        upstreamHeaders: upstreamResponse.headers,
        upstreamBody: Buffer.concat(streamedChunks).toString("utf8")
      }).catch((error) => {
        logEvent({
          phase: "debug_capture_error",
          method: req.method,
          path: pathname,
          message: error.message
        });
      });
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

  let text = upstreamResponse.text;
  if (pathname.endsWith("/chat/completions") && customToolNames.size > 0) {
    text = transformChatCompletionJson(text, customToolNames);
  }
  logEvent({
    phase: "proxy_response",
    method: req.method,
    path: pathname,
    status: upstreamResponse.status,
    streamed: false
  });
  writeDebugCapture({
    ...captureBase,
    streamed: false,
    upstreamStatus: upstreamResponse.status,
    upstreamHeaders: upstreamResponse.headers,
    upstreamBody: text
  }).catch((error) => {
    logEvent({
      phase: "debug_capture_error",
      method: req.method,
      path: pathname,
      message: error.message
    });
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
