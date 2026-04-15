# openai-compat-shim

[English](./README.md)

一个轻量级的 Node.js 兼容垫片，位于编辑器客户端与 OpenAI 兼容上游之间。

它的主要职责并不是狭义上的“代理”，而是请求形态适配：

- 接收编辑器或客户端发来的、类似 OpenAI 但并不完全标准的请求
- 将其规范化为上游能够稳定理解的格式
- 保留流式传输
- 保留 agent / tool calling 上下文
- 提供请求与响应抓包，便于排查真实生产流量问题

这个项目只使用 Node 内置模块。

## 为什么会有这个项目

许多编辑器都支持自定义 `base_url` 和 `api_key`，但上游网关往往只“部分兼容”它们实际发出的 JSON。

常见不匹配包括：

- 客户端发送的是 `input`，但上游要求 `messages`
- 客户端发送的是 `responses` 风格的工具定义，而上游要求 `chat.completions` 的 function tools
- 客户端把 `chat/completions` 路径和 `input` 结构的请求体混用
- 客户端发送结构化的多轮内容数组，而上游期望的是标准化后的 message 对象
- 客户端希望 agent / tool-call 能继续多轮执行，但中间层垫片却错误地把整个对话压平成纯文本

这个 shim 就是用来吸收这些不匹配的翻译层。

## 提供的接口

- `GET /`
- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

## 设计

### 请求流程

```text
编辑器 / Cursor / 自定义客户端
        |
        v
openai-compat-shim
  - 鉴权保护
  - 请求解析
  - 请求体适配
  - 可选字段剥离
  - 可选调试抓取
  - 流式透传
        |
        v
OpenAI 兼容上游
```

### 设计目标

- 尽可能保留原始语义信息
- 只规范化那些已知会导致兼容性问题的部分
- 除非没有更好的退路，否则不主动把结构化内容压平成纯文本
- 保持实现轻量、依赖少，方便部署到小型服务器
- 在需要时抓取完整请求/响应记录，降低生产排障成本

### 非目标

- 这不是完整的 OpenAI API 克隆
- 这不是会话存储系统
- 这个 shim 不会自己执行工具
- 它也不会自动修复所有上游兼容性问题

## 实现概览

### 1. 鉴权与健康检查接口

这个 shim 可以用 `SHIM_API_KEY` 保护 `/v1/*` 路径。

- 客户端发送 `Authorization: Bearer <shim-key>`
- shim 进行校验
- shim 使用 `TARGET_API_KEY` 转发到上游

之所以提供 `/healthz` 和 `/v1/models`，是为了让客户端在发送真实流量前先探活。

### 2. 请求体适配

核心适配逻辑位于 `server.js` 里的 `adaptPayload()`。

对于 `/v1/chat/completions`：

- 如果客户端本来就发送了原生 `messages`，则尽量保持不变
- 如果客户端发送的是 `input`，则转换为结构化 `messages`
- 保留多轮对话中的角色顺序，而不是把一切折叠成一个字符串
- 将工具定义转换为 `chat.completions` 兼容的 function tools

对于 `/v1/responses`：

- 保留结构化 `input`
- 将字符串 / 对象 / 数组形式的输入标准化为 response items，同时不破坏 tool-call 上下文

### 3. 保留 tool-call 上下文

这个 shim 会保留：

- `tools`
- `tool_choice`
- `parallel_tool_calls`
- assistant 的 `tool_calls`
- tool 结果消息
- 类似 `function_call_output` 这样的结构化 `input` 项

这对 agent 风格客户端来说是关键能力。

### 4. 流式透传

只要满足以下任意一个条件，shim 就会把请求视为流式请求：

- `body.stream === true`
- `body.stream_options != null`
- 请求头中的 `Accept` 包含 `text/event-stream`

启用流式后，上游流会被直接透传回客户端。

如果前面还有 Nginx 之类的反向代理，请为 `/v1/` 路由关闭代理缓冲；否则 Cursor 这类 SSE 客户端可能会在收到首个事件前就先超时断开。

### 5. 调试抓取

当设置了 `DEBUG_CAPTURE_DIR` 时，shim 会为每个请求写入一个 JSON 文件，其中包含：

- 原始请求体
- 发往上游的适配后请求体
- 上游状态码和响应头
- 上游响应体

对于这个服务来说，这比抓网络包更有价值，因为 shim 到上游之间是 HTTPS。

## 我们遇到的关键 agent 问题

### 现象

Cursor 可以连上服务，但 agent 任务在一轮之后就停住了：

- 第一轮模型响应能返回
- 后续并没有真正进入多轮工具调用循环
- 看起来像是上游“没有 agent 能力”

### 一开始怀疑的方向

- 上游 `gmncode.cn` 可能不支持 tool-calling
- 上游可能不支持 `responses`
- 上游可能会拒绝强制 `tool_choice`

这些猜测在某些边缘情况下部分成立，但它们并不是主要阻塞点。

### 真正的根因

shim 里有两个主要兼容性问题。

#### 根因 1：与工具相关的字段被错误剥离了

早期版本会删除这些字段：

- `tools`
- `tool_choice`
- `parallel_tool_calls`

光这一点就足以让 agent 行为失效。

#### 根因 2：多轮结构化 `input` 被压平成了单条用户消息

这是更深层的问题。

Cursor 当时把请求发到了 `/v1/chat/completions`，但请求体使用的是带有多轮结构化对话的 `input`：

- system 指令
- 之前的 user 轮次
- 之前的 assistant 轮次
- 当前 user 轮次
- 工具定义

旧版 shim 会把整个 `input` 数组拼成一大段文本，再包装成：

```json
[
  {
    "role": "user",
    "content": "huge flattened text..."
  }
]
```

这会直接破坏对话结构：

- 角色边界丢失
- 之前 assistant 轮次不再是 assistant 轮次
- tool call 连续性丢失
- 模型看到的已不再是真正的 agent 对话

### 第三个兼容性问题

Cursor 的工具定义当时也不是 `chat.completions` 最偏好的格式。

真实客户端流量里出现过这样的 tools：

```json
{
  "type": "function",
  "name": "Shell",
  "description": "...",
  "parameters": { ... }
}
```

甚至还有：

```json
{
  "type": "custom",
  "name": "ApplyPatch",
  "description": "..."
}
```

对于 `chat/completions`，当工具被转换成下面这种形式时，上游表现会更稳定：

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

## 我们是怎么修复的

### 修复 1：默认保留 agent 相关字段

shim 现在默认不再删除与工具相关的字段。

取而代之的是，它支持通过下面的环境变量配置需要剥离的顶层字段：

- `STRIP_FIELDS`

默认值：

```bash
STRIP_FIELDS=audio
```

### 修复 2：把 `input` 转换为真正的多轮 `messages`

对于 `/v1/chat/completions`，shim 现在会把 `input` 数组转换为保留角色语义的 chat messages。

例如：

- `role: system/user/assistant` 的项会保留为各自独立的消息
- `function_call` 项会变成 assistant 的 `tool_calls`
- `function_call_output` 项会变成 `role: tool` 消息
- `input_text` 和 `output_text` 内容片段会被标准化为 chat 文本片段

这正是让 agent 行为恢复正常的关键改动。

### 修复 3：把工具定义标准化为 chat completions 格式

shim 现在会将下面这些工具：

- 顶层 `function` 工具
- `custom` 工具

转换成 `chat.completions` 风格的 function tool 定义。

这样上游就能识别出真正可调用的工具，而不是把它们当成不透明元数据。

### 修复 4：增加请求/响应抓取

我们加入了 `DEBUG_CAPTURE_DIR`，这样就能在生产环境直接查看真实流量，而不是靠猜。

这让我们可以对比：

- Cursor 实际发送了什么
- shim 实际适配成了什么
- 上游实际返回了什么

整个排查过程也因此从猜测变成了基于证据的分析。

## 我们验证过什么

我们直接对 `https://gmncode.cn/v1` 验证了上游行为。

观测结果如下：

- 普通 `/v1/chat/completions` 可以工作
- 带 tools 的 `/v1/chat/completions` 可以工作
- `/v1/chat/completions` 可以返回 `tool_calls`
- `/v1/chat/completions` 可以接受工具结果后的后续消息
- `/v1/responses` 可以在第一轮返回 function calls
- 在我们的测试中，`/v1/responses` 配合 `previous_response_id` 的后续调用不够稳定
- 某些形态下的强制工具选择，比正常的 `tool_choice: "auto"` 更不稳定

因此，对当前这套部署来说，最可靠的路径是：

- 让 Cursor 流量继续走 `/v1/chat/completions`
- 把混合 `input` 请求体适配成结构化 `messages`
- 把 tools 标准化成 `chat.completions` 的 function-tool 格式

## 配置

复制示例文件并填入你自己的值：

```bash
cp .env.example .env
```

环境变量：

- `PORT`: 监听端口
- `TARGET_BASE_URL`: 上游基础 URL，例如 `https://your-provider.example/v1`
- `TARGET_API_KEY`: 上游服务商的 key
- `SHIM_API_KEY`: 编辑器 / 客户端访问这个 shim 时使用的 key
- `DEFAULT_MODEL`: `/v1/models` 暴露的默认回退模型名
- `STRIP_FIELDS`: 代理前需要剥离的顶层请求字段，多个值用逗号分隔
- `DEBUG_CAPTURE_DIR`: 保存完整请求/响应抓取文件的目录
- `ENABLE_STREAM_TOOL_TRANSFORM`: 只有在你明确需要“流式 custom tool 参数重写”时才设为 `1`；默认关闭，因为这会在回复前先缓冲整段 SSE
- `UPSTREAM_REQUEST_TIMEOUT_MS`: 上游 POST 超时时间，单位毫秒，默认 `300000`
- `NODE_USE_ENV_PROXY`: 设为 `1` 后，Node.js 会让内置 `http` / `https` 请求遵循环境变量代理
- `HTTP_PROXY`: 上游出站 HTTP 代理，例如 `http://127.0.0.1:7892`
- `HTTPS_PROXY`: 上游出站 HTTPS 代理，例如 `http://127.0.0.1:7892`
- `NO_PROXY`: 不走代理的地址白名单，例如 `127.0.0.1,localhost`

示例：

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

## 本地运行

```bash
export $(grep -v '^#' .env | xargs)
npm start
```

## 使用 PM2 运行

```bash
export $(grep -v '^#' .env | xargs)
pm2 start ecosystem.config.cjs
pm2 save
```

PM2 配置同样会透传这些变量：

- `STRIP_FIELDS`
- `DEBUG_CAPTURE_DIR`
- `NODE_USE_ENV_PROXY`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`

## 服务器通过机场代理访问上游

如果你的服务器直连 `gmncode.cn` 很慢，但本机还好，最稳的办法不是改协议层，而是让服务器的出站请求先走本地代理。

推荐做法：

- 服务器运行 `mihomo` core，而不是运行 `Clash Verge Rev` 图形客户端
- `mihomo` 使用订阅拉取节点
- 本地暴露一个代理端口，例如 `127.0.0.1:7892`
- shim 通过 `NODE_USE_ENV_PROXY=1` + `HTTP_PROXY` / `HTTPS_PROXY` 访问上游

原因：

- `Clash Verge Rev` 是桌面 GUI 客户端，不适合无头服务器
- 当前这个项目使用的是 Node 内置 `http` / `https`
- 从 Node.js `v22.21.0` 开始，可以通过 `NODE_USE_ENV_PROXY=1` 让内置网络请求遵循环境变量代理

相关参考：

- Node.js 企业网络配置文档：<https://nodejs.org/en/learn/http/enterprise-network-configuration>
- Mihomo service 文档：<https://wiki.metacubex.one/en/startup/service/>
- Mihomo proxy-providers 文档：<https://wiki.metacubex.one/en/config/proxy-providers/>

### 1. 准备 Mihomo 配置

仓库内提供了一个样板文件：

- [deploy/mihomo/config.yaml.example](./deploy/mihomo/config.yaml.example)

把其中的订阅地址替换成你自己的订阅链接。

### 2. 验证代理是否真的加速

在服务器上先验证 `mihomo` 本地代理本身能正常访问上游：

```bash
curl -x http://127.0.0.1:7892 -I https://gmncode.cn/
```

如果这条请求比直连明显更稳或更快，再让 shim 挂上代理。

### 3. 让 shim 走本地代理

把 `.env` 配成类似这样：

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

### 4. systemd 方式部署

仓库内提供了一个 systemd 样板：

- [systemd/openai-compat-shim.service.example](./systemd/openai-compat-shim.service.example)

要点：

- `After=mihomo.service`，确保代理 core 先起来
- `EnvironmentFile=/etc/openai-compat-shim.env`
- `NODE_USE_ENV_PROXY=1`
- `HTTP_PROXY` / `HTTPS_PROXY` 指向本地 `mihomo` 端口

## 请求示例

### 健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

### 模型列表

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer replace-with-your-own-secret"
```

### 基础 chat completion

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

### 流式 chat completion

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

### Cursor 风格的混合 `input` + chat completions

这是最关键的兼容性场景：

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

## 调试与故障排查

### 1. 开启抓取

```bash
DEBUG_CAPTURE_DIR=/path/to/captures
```

重启之后，每个请求都会生成一个 JSON 文件，包含：

- `originalBody`
- `adaptedPayload`
- `upstreamStatus`
- `upstreamHeaders`
- `upstreamBody`

### 2. 先看什么

如果 agent 行为异常，优先对比这些点：

- 客户端有没有发送 `tools`？
- 客户端发送的是 `messages` 还是 `input`？
- 经过适配后，shim 是否还保留了多角色结构？
- assistant 输出里有没有 `tool_calls`？
- 上游返回的是 `finish_reason: "tool_calls"` 还是 `finish_reason: "stop"`？

### 3. 常见失败模式

#### 现象：模型直接回答，没有调用工具

检查：

- tools 是否被剥离了？
- tools 是否被标准化成了正确格式？
- 多轮 `input` 是否被压成了一条 user 字符串？

#### 现象：第一轮能跑，第二轮失败

检查：

- 后续工具结果消息是否被保留为 `role: tool`
- `function_call_output` 是否被正确转换
- 上游路径到底是 `/chat/completions` 还是 `/responses`

#### 现象：本地正常，生产环境异常

检查：

- PM2 环境变量是否正确
- 重启时是否使用了 `--update-env`
- `DEBUG_CAPTURE_DIR` 是否可写
- Nginx 是否对流式响应做了缓冲或超时截断

### 4. 推荐的调试流程

1. 开启 `DEBUG_CAPTURE_DIR`
2. 复现一次问题
3. 打开最新的抓取文件
4. 对比 `originalBody` 和 `adaptedPayload`
5. 确认问题属于哪一类：
   - 客户端请求格式
   - shim 适配逻辑
   - 上游兼容性
   - 服务器出站网络质量

### 5. 网络层排查顺序

如果服务器上表现明显比本机差，优先排查网络层，不要先怀疑 agent 协议。

顺序如下：

1. 服务器直连 `gmncode.cn` 测一次
2. 服务器通过 `mihomo` 本地代理再测一次
3. 对比 `time_total`、握手耗时和首包耗时
4. 只有在网络层差异不明显时，才继续看 shim 抓包

示例：

```bash
curl -o /dev/null -s -w 'direct dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://gmncode.cn/v1/models
curl -o /dev/null -s -x http://127.0.0.1:7892 -w 'proxy  dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://gmncode.cn/v1/models
```

## 部署拓扑

典型生产部署如下：

- 公网 HTTPS 域名由 Nginx 提供入口
- Nginx 反向代理到 `127.0.0.1:$PORT`
- 编辑器 / 客户端指向 `https://your-domain.example/v1`
- 由 PM2 保持 shim 常驻

参见 [nginx.example.conf](./nginx.example.conf)。

## 当前已知限制

- 这个 shim 本身不持久化对话状态
- 它依赖客户端主动发送正确的历史轮次
- 不同服务商下，`responses` 配合 `previous_response_id` 的续接可能仍然不稳定
- 一些服务商对 `tool_choice` 的格式比其他服务商更严格

## 维护说明

如果新的客户端集成出现问题，不要一开始就靠猜。

请按顺序用抓取结果回答这几个问题：

1. 客户端实际发了什么？
2. shim 实际转发了什么？
3. 上游实际返回了什么？

实际排查中，大多数问题都会落在这几类：

- 请求格式不匹配
- 工具 schema 不匹配
- 多轮上下文被压平
- 上游对特定字段更敏感

这正是 Cursor agent 问题里发生过的事，而真正的修复方式，是保留结构，而不是把结构“简化”掉。
