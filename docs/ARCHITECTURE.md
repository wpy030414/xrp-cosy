# ARCHITECTURE.md — xrp-cosy 架构地图

> Version: 0.7.0 | Last updated: 2026-10-25
>
> 本文档描述稳定的结构关系，半年至一年不变。代码改动若偏离此处描述，需同步更新。

---

## 1. 架构概览

```
┌────────────┐     OpenAI API      ┌──────────────┐    WS register    ┌──────────────────────────┐
│  Client    │ ──────────────────> │  xrl-router  │ ────────────────> │ plugin-qwenwork (Hono)   │
│ (Claude    │  /v1/chat/          │  (路由/密钥/  │  (V24 契约，      │  :19067                  │
│  Code etc) │  completions        │   重试)       │   占位凭证)       ├──────────────────────────┤
│            │                     │              │                   │ plugin-qoder (Hono)      │
│            │                     │              │                   │  :19070                  │
└────────────┘                     └──────────────┘                   └───────────┬──────────────┘
                                                                                  │
                                                                   Cosy 签名 + SSE 外层解包
                                                                                  │
                                      ┌───────────────────────────────────────────┴─────────────┐
                                      ▼                                                         ▼
                        ┌────────────────────────────┐                            ┌────────────────────────────┐
                        │ gateway.qwenwork.cn        │                            │ api3.qoder.sh              │
                        │ → Standard / Pro           │                            │ → Qwen3.8-Flash            │
                        │   Qwen3.8-Max              │                            │   DeepSeek-Flash           │
                        └────────────────────────────┘                            └────────────────────────────┘
```

两个通道是**独立进程、独立插件注册**，共享同一套签名/转发/服务骨架；上游协议同族，仅 host、`business.product`、`agent_id` 与账号体系不同。

### 设计原则

| 原则 | 说明 |
|------|------|
| **纯翻译层** | 只做 OpenAI ↔ 上游协议转换，不引入业务逻辑、不做 prompt engineering |
| **凭证自持** | V24 起 Router 不再管理密钥，插件用自身 OAuth token 访问上游；Router 发占位凭证 `Bearer xrl-router`，插件必须忽略 |
| **无状态** | 每个请求独立签名（Cosy），无 session 存储（token 缓存是性能优化，非业务状态） |
| **字节透传** | 仅解包外层 SSE wrapper（`{"body":"..."}`），内层 chunk 原样转发 |
| **自动恢复** | WS 断线指数退避重连（max 60s）；两条通道的 token 均按需刷新，轮换值分别落 `.env QWEN_KEYS` / `QODER_KEYS`；端口占用自动 kill |
| **凭据所有权** | 两条通道的凭据均由插件自持并自行轮换（只写本仓库的 `.env`，不碰任何 App 文件）；来源唯一：网页设备授权 |
| **无 App 依赖** | 不读取/解密/写回 `auth.v1.dat` / `auth-v2.dat`；登录页由官方托管，插件只负责发起授权与轮询换票 |

---

## 2. 源码结构

```
src/
├── index.ts              # qwenwork 入口：初始化 token 管理 + 启动共享服务
├── qoderIndex.ts         # qoder 入口：初始化 token 管理 + 启动共享服务
├── server.ts             # 共享 Hono 骨架：路由 + 端口释放 + 优雅退出 + PluginClient
├── forward.ts            # 共享转发核心：签名 + SSE 解包 + tool_calls 标准化 + 非流式聚合
├── config.ts             # qwenwork 配置单例：env 读取
├── qoderConfig.ts        # qoder 配置单例：端口/模型/登录端点
├── pluginClient.ts       # WebSocket 客户端：V24 注册（无 keys）/ 心跳 / 重连（参数化）
├── client.ts             # qwenwork 通道差异：静态头 / business / 展示名 / 灾备 refresh
├── qoderClient.ts        # qoder 通道差异：静态头 / business / agent_id / 展示名
├── auth.ts               # qwenwork token：refresh 轮换 / 两源 fallback（缓存 + .env QWEN_KEYS）/ adoptCredential
├── qoderAuth.ts          # qoder token：refresh 轮换 / 两源 fallback（缓存 + .env QODER_KEYS）/ adoptCredential
├── deviceLogin.ts        # qwenwork 网页 device-flow：PKCE + selectAccounts URL + deviceToken/poll 轮询
├── qoderDeviceLogin.ts   # qoder 网页设备授权：PKCE + selectAccounts URL + poll + userinfo
├── openBrowser.ts        # 跨平台打开系统浏览器（两通道共用）
├── envStore.ts           # .env 安全读写单点：git-ignore 守卫 + 单行 upsert + mode 600
└── signer.ts             # 请求签名：AES-128-CBC + RSA_PKCS1 + MD5
```

### 依赖图

```
index.ts / qoderIndex.ts
├── config.ts / qoderConfig.ts
├── auth.ts / qoderAuth.ts（各自 ← 对应 config + envStore）
├── client.ts / qoderClient.ts ← forward.ts
│   └── forward.ts ← signer.ts（Token 形状）
├── signer.ts
└── server.ts
    ├── pluginClient.ts ← 入口传入的配置
    └── 入口传入的 forwardChatCompletions / displayName

qwenwork:
  auth.ts ← config.ts + envStore.ts
  client.ts ← config.ts + auth.ts + bizIdentity.ts + forward.ts
  deviceLogin.ts ← config.ts + envStore.ts + openBrowser.ts
qoder:
  qoderAuth.ts ← qoderConfig.ts + envStore.ts
  qoderClient.ts ← qoderConfig.ts + qoderAuth.ts + forward.ts
  qoderDeviceLogin.ts ← qoderConfig.ts + qoderAuth.ts + envStore.ts + openBrowser.ts

log-in.ts（qwenwork）额外引 auth/client/deviceLogin/bizIdentity/envStore
log-in-qoder.ts（qoder）额外引 qoderConfig/qoderAuth/qoderDeviceLogin/envStore
```

---

## 3. 模块设计

### 3.1 config.ts / qoderConfig.ts — 配置单例

两个入口各自导出配置单例，进程启动时一次性读取 `process.env`，此后不再重新加载。

**Settings（qwenwork）**：

| 分组 | 字段 | 说明 |
|------|------|------|
| 通用 | `port`, `availableModels` | 监听端口（默认 19067）、可用模型列表 |
| qwenwork | `qwenBaseUrl`, `qwenDeviceRefreshPath`, `qwenDevicePollPath`, `qwenAuthBase`, `qwenClientId`, `qwenLoginTimeoutMs`, `qwenMachineId`, `qwenRsaPublicKeyPath`, `qwenRefreshIntervalMs`, `qwenTarget` | 推理网关地址 + OAuth/签名/网页登录参数 |
| xrl-router | `xrlRouterUrl` | WS 连接地址 |

**QoderSettings（qoder）**：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `19070` | 监听端口（19069 已被 xrp-workbuddy 占用） |
| `availableModels` | `qfmodel,dfmodel` | 当前账号已启用的目录 key |
| `baseUrl` | `https://api3.qoder.sh` | Qoder 推理/目录网关（国际区） |
| `oauthBaseUrl` | `https://openapi.qoder.sh` | 设备授权轮询/刷新/userinfo API |
| `authBaseUrl` | `https://qoder.com` | 网页授权页 origin（`/device/selectAccounts`） |
| `clientId` | `e883ade2-…-f92ceff5fdcb` | 设备授权 OAuth client_id（官方客户端常量） |
| `devicePollPath` / `deviceRefreshPath` | `/api/v1/deviceToken/poll` / `refresh` | 换票与轮换接口 |
| `userInfoPath` | `/api/v1/userinfo` | 登录后展示账号（best-effort） |
| `loginTimeoutMs` | `300000` | 设备授权轮询总超时 |
| `machineId` | *(空，自动生成持久化到 .env)* | 设备标识显式覆盖（`QODER_MACHINE_ID`） |
| `userAgent` | `QoderWork/1.1.75` | 登录/刷新请求 UA（对齐官方客户端） |
| `xrlRouterUrl` | `http://localhost:19068` | WS 连接地址 |

### 3.2 pluginClient.ts — WS 客户端（V24 契约）

`PluginClient` 类由入口参数化构造（`routerUrl` / `pluginId` / `port` / `models` / `displayName`），构造时立即连接 `ws://{host}/ws/plugin`。两个通道各起一个实例：

| 入口 | plugin_id | 端口 | 默认模型 |
|------|-----------|------|---------|
| `index.ts` | `plugin-qwenwork` | 19067 | `flash`, `pro`, `qwen3.8-max-preview` |
| `qoderIndex.ts` | `plugin-qoder` | 19070 | `qfmodel`, `dfmodel` |

#### 注册消息格式（V24）

```json
{
  "type": "register",
  "plugin_id": "plugin-qwenwork",
  "provider": {
    "kind": "chat_completions",
    "base_url": "http://localhost:19067",
    "api_path": "/v1/chat/completions"
  },
  "models": [
    { "model_id": "flash", "display_name": "Standard", "tier": "custom" },
    { "model_id": "pro", "display_name": "Pro", "tier": "custom" },
    { "model_id": "qwen3.8-max-preview", "display_name": "Qwen3.8-Max", "tier": "custom" }
  ],
  "workdir": "C:/Users/me/plugins/qwenwork"
}
```

**注意**：
- **不带 `keys` 字段** — Router V24 起严格拒绝带 keys 的 register，回 `{"type":"error","reason":"keys_not_supported"}` 并断开
- `kind` 为 `chat_completions`（不是 `openai`）
- `plugin_id` / 端口 / 模型由入口传入，不在客户端内硬编码
- `workdir` 为伴生启动 cwd（COALESCE 语义）

#### 定时任务

| 任务 | 间隔 | 说明 |
|------|------|------|
| 心跳 | 30s | `{"type": "heartbeat"}`（不带 timestamp） |

#### 重连策略

指数退避：`delay = min(1000ms * 2^attempts, 60000ms)`。每次 `open` 事件重置 `reconnectAttempts = 0`。

### 3.3 forward.ts — 共享转发核心

`forwardChatCompletionsGeneric(body, res, authHeader, opts)` 承载两个通道的全部共同逻辑。通道文件只声明差异：

| opts | qwenwork | qoder |
|------|----------|-------|
| `provider` | `qwenwork` | `qoder` |
| `baseUrl` | `gateway.qwenwork.cn` | `api3.qoder.sh` |
| `staticHeaders` | 12 个 `Cosy-*` / Login / model-source | 同左 + `X-Qoder-Remote-Api-Version` + `User-Agent` |
| `product`（缺省 business） | `qoder_work` | `qoder` |
| `bodyDefaults` | — | `agent_id: 'agent_common'` |
| `defaultModel` | `flash` | `qfmodel` |
| `modelHeaderName` | `x-model-key` | `x-model-key` |
| `getToken` | `getToken`（可刷新） | `getQoderToken`（可刷新） |
| `fallbackAuth` | 占位凭证中若带 `ory_rt_` 则灾备 refresh | — |
| `ensureUid` / `authErrorMessage` | 从 JWT 解 uid / 中文提示 | — / 中文提示 |

处理流程：

```
  opts.getToken()         ← 通道各自的缓存/刷新策略
        │
        │ （qwenwork）缓存全失效？灾备 ↓
  opts.fallbackAuth(authHeader) ← 占位凭证 Bearer xrl-router 仅作灾备触发
        │
        ▼
  opts.ensureUid(token)   ← 必要时从 JWT payload.sub / .uid / .user_id 解 uid
        │
        ▼
  buildSignMaterial(token)  ← 随机 16B AES key → Cosy-Key + info
        │
        ▼
  buildAuthHeaders(m, url, body) ← MD5 签名 → Authorization: Bearer COSY.xxx.sig
        │
        ▼
  fetch(opts.baseUrl + opts.path + opts.query)
        │
        ▼
  ┌─ stream=true:  外层 SSE 解包 → 内层 OpenAI chunk 透传
  └─ stream=false: delta 聚合 → 完整 chat.completion JSON
```

**请求体构造**：`{ ...bodyDefaults, ...body }` 后强制补齐 `model` / `request_id` / `session_id` / `business`，再删除 `encode` / `extra_body`。明文 JSON，**不**使用 `Encode=1`（WASM 签名链不是必需品）。

**流式 tool_calls 标准化**（适配 xrl-router 的转换逻辑）：
- xrl-router 把「某 index 的首个 chunk」解析为 `content_block_start`（input 字段），其余分片作为 `input_json_delta` 处理
- 因此首 chunk 必须发空 `arguments`（避免 `"{"` 被提前消耗），所有 arguments 片段（含首 chunk 的 `"{"`）原样发出
- 用 `seenToolCallIndex` 集合跟踪每个 index 的首 chunk

**非流式聚合**：读取所有 SSE chunk，拼接 `choices[0].delta` 的 `content` / `reasoning_content`（空值时字段不存在），`tool_calls` 按 `index` 分组拼接 `arguments`。

**上游错误**：外层 `statusCodeValue !== 200` 或内层出现 `code/message` 时记录并终止，避免把错误当正文透传。

### 3.4 client.ts — qwenwork 通道

**Token 策略（方案 A）**：不再每请求都 refresh（refresh token 是轮换式的，每请求刷新会自踩）。`getToken()` 维护内存缓存，access token 剩余 > 5 分钟时直接返回，零网络开销。refresh 成功后把新 refresh token 落 `.env QWEN_KEYS`，进程重启可自举续命。凭据来源只有两条（缓存 + `.env`），均由 `pnpm log-in` 网页登录产出——2026-10-20 起已取消千问办公 App 支持，插件不读写任何 App 文件。

**静态头**：12 个固定值（`Cosy-Business-Product: qoder_work`, `Cosy-Scene: qwork`, `Cosy-Version: 1.1.59`, `Login-Version: v2` 等）。

**展示名映射**：`flash` → `Standard`、`pro` → `Pro`、`qwen3.8-max-preview` → `Qwen3.8-Max`（注册给 xrl-router 的 display_name）。请求方向无别名映射——客户端发送什么 `model` 就透传什么，缺省时默认 `flash`。

**业务字段**：`business: { product: 'qoder_work' }`（新版网关定位模型目录的必需字段，缺失会 503 `Model catalog unavailable`）。

### 3.5 qoderClient.ts — qoder 通道

Qoder 与 qwenwork 同协议族（相同推理路径、相同 Cosy 签名、相同双层 SSE），差异集中在：

| 差异 | 取值 |
|------|------|
| host | `https://api3.qoder.sh`（目录为 `GET /algo/api/v2/model/list?Encode=1`） |
| `business.product` | `qoder`（实测 `qoder_work` 也可，采用 `qoder`） |
| 必备 body 字段 | `agent_id: 'agent_common'`（缺失时内层 400 `None flow nodes found for router agent_router`） |
| 静态头 | `Cosy-Business-Product: qoder`、`X-Qoder-Remote-Api-Version: 2`、`User-Agent: Qoder/0.4.8` |
| 凭据 | 自包含网页设备授权（`openapi.qoder.sh`，插件自持轮换） |
| 默认模型 | `qfmodel`（Qwen3.8-Flash）；可选 `dfmodel`（DeepSeek-Flash） |

**模型目录**：`GET /algo/api/v2/model/list?Encode=1` 按场景分组，当前账号仅 `qfmodel` / `dfmodel` 的 `enable=true`。注册列表来自 `QODER_MODELS`，展示名映射见 `qoderClient.ts` 的 `DISPLAY_NAMES`。

**请求体**：除通用字段外自动补 `agent_id`；`version` 可选。

### 3.6 auth.ts — qwenwork token 管理

无 App 依赖：凭据由 `pnpm log-in`（网页 device-flow）产出，本模块只管轮换与拾取。

#### refreshDeviceToken

`POST {qwenBaseUrl}/api/v1/deviceToken/refresh`，body `{ refresh_token, target: "c" }`。响应包含 `device_token`（新 access token）+ `refresh_token`（轮换后的新 refresh token）。刷新成功后：
1. `syncEnvRefreshToken()` 写回 `.env QWEN_KEYS`（唯一持久化动作，不触碰任何 App 文件）
2. `refresh_token_expires_at` 距今 < 24h 时告警提示重跑 `pnpm log-in`

> 历史：曾把轮换结果**加密写回** `auth-v2.dat`（与千问办公 App 双向同步），已随 App 支持移除（见 `docs/DECISIONS.md` D-16）。

#### getToken — 两源 fallback

```
  缓存有效？（expiresAt > now + 5min）→ 直接返回，零网络请求
     │ 无效 ↓
  ① 内存缓存 refresh token → refreshDeviceToken()
     │ 失败 ↓
  ② .env QWEN_KEYS → refreshDeviceToken()
     │ 失败 ↓
  throw Error('无可用 token 源（…请运行 pnpm log-in 网页登录）')
```

`adoptCredential()` 供 log-in 把扫码结果写入缓存；`forceRefresh()` 供 log-in 验证刷新链。

### 3.7 qoderAuth.ts — qoder token 管理

与 `auth.ts` 同构：插件自持凭据、自行轮换，不依赖任何 App。

```
getQoderToken()
  · 缓存剩余 > 5min → 直接返回
  · 否则 ① 缓存 refresh token → deviceToken/refresh
        ② .env QODER_KEYS → deviceToken/refresh（自举）
  · 均失败 → throw「请运行 pnpm log-in:qoder 网页登录」
```

**刷新**：`POST {oauthBaseUrl}/api/v1/deviceToken/refresh`，body `{ refresh_token }`。响应 `device_token`（或 `token`）+ 轮换后的 `refresh_token`；轮换值写回 `.env QODER_KEYS`。
`expires_in` 按**毫秒**解析（官方实测），`expires_at` 为 RFC3339；均缺失时默认 30 天。

`adoptQoderCredential()` 供登录脚本写入缓存；`forceRefreshQoder()` 供登录后验证刷新链。

### 3.8 qoderDeviceLogin.ts — qoder 网页设备授权登录

```
buildQoderDeviceLoginParams()  # PKCE(S256, 64 字符 verifier) + nonce(32-hex) + machineId(env > .env > 生成)
        ▼
buildQoderAuthUrl()            # https://qoder.com/device/selectAccounts
                               #   ?challenge&challenge_method=S256&nonce&client_id&machine_id
                               #   国际区不传 redirect_uri；302 → qoder.com 登录页
        ▼
openInBrowser()                # win: cmd /c start | mac: open | linux: xdg-open（best-effort）
        ▼
pollQoderDeviceFlow()          # GET {oauthBaseUrl}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
  · 404(NotFound) / 202 = 进行中，1.5s 间隔继续
  · 总超时 QODER_LOGIN_TIMEOUT_MS（300s）；连续网络错误 ≥5 次中止
  · 服务端返回 nonce / code_challenge / method 时逐字校验（防串号）
        ▼
QoderDeviceCredential { token, refreshToken, expiresAt, refreshTokenExpiresAt? }
```

登录后由 `qoderAuth.fetchQoderUserInfo()` 拉取 `/api/v1/userinfo`（best-effort，失败不影响凭据落盘；uid 未知时刷新链会自动补全，因为签名头的 `Cosy-User` 依赖它）。
协议来源：官方 CLI / 桌面端逆向与在线探活，详见 [specs/qoder-device-login.md](specs/qoder-device-login.md)。消费入口为 `scripts/log-in-qoder.ts`（`pnpm log-in:qoder`）。

### 3.9 signer.ts — 请求签名

#### buildSignMaterial — encryptUserInfo 等价物

```
e = randomUUID().replace(/-/g, '').substring(0, 16)   // 随机 16 字节 AES key

userInfo = { uid, aid: "", name, email, security_oauth_token: accessToken }

info    = base64(AES-128-CBC(key=e, iv=e, JSON.stringify(userInfo)))
cosyKey = base64(RSA_PKCS1_PADDING(publicKey, e))
```

RSA 公钥：asar 硬编码（modulus 头 `c0f223…`），可通过 `QWEN_RSA_PUBLIC_KEY_PATH` 环境变量覆盖。注意使用 **PKCS1** 而非 OAEP padding。

#### buildAuthHeaders — generateAuthToken 等价物

```
header = { version: "v1", requestId: UUID, info, cosyVersion: "1.0.0", ideVersion: "1.0.0" }
o      = base64(JSON.stringify(header))

path   = URL.pathname（去掉 query string；若以 /algo 开头则去掉该前缀）
signStr = `${o}\n${cosyKey}\n${timestamp}\n${body}\n${path}`
sig    = md5(signStr)

Authorization = "Bearer COSY." + o + "." + sig
```

签名绑定 body + path + 时间戳，天然防重放。

### 3.10 server.ts / index.ts / qoderIndex.ts — Hono 入口

`server.ts` 提供共享 `startPluginServer(opts)`：创建 Hono app、释放端口、启动 HTTP 服务、启动 `PluginClient`、注册优雅退出。两个入口只传差异：

| opts | `index.ts` | `qoderIndex.ts` |
|------|-----------|-----------------|
| `pluginId` | `plugin-qwenwork` | `plugin-qoder` |
| `backend` | `qwenwork` | `qoder` |
| `port` | 19067 | 19070 |
| `baseUrl` | `settings.qwenBaseUrl` | `qoderSettings.baseUrl` |
| `models` | `settings.availableModels` | `qoderSettings.availableModels` |
| `forward` | `client.forwardChatCompletions` | `qoderClient.forwardChatCompletions` |

#### 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 健康探针：返回 version / backend / endpoints |
| `GET` | `/health` | 健康检查：返回 status / backend / base_url |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions：调用入口传入的 `forward` |

#### killPortProcess — 跨平台端口释放

启动前自动释放目标端口，避免 `EADDRINUSE`：

- **macOS/Linux**：`lsof -ti :{port}` → `kill -9 {pids}`
- **Windows**：`netstat -ano` 过滤 `:{port}.*LISTENING` → `taskkill /F /PID {pids}`

#### 优雅退出

`SIGTERM` / `SIGINT` → `pluginClient.close()` → `process.exit(0)`。`close()` 清理心跳定时器、重连定时器、WS 连接。

### 3.11 deviceLogin.ts — 网页 device-flow 登录

```
buildDeviceLoginParams()   # PKCE(S256) + nonce(UUID) + machineId(env > .env > 生成持久化)
        ▼
buildAuthUrl()             # https://gateway.qwenwork.cn/device/selectAccounts?challenge&nonce&machine_id&client_id&redirect_uri
                           #   → 302 qwenwork.cn/oauth2/auth（Hydra 授权页，扫码）→ 回跳 gateway /oauth/callback
        ▼
openInBrowser()            # win: cmd /c start | mac: open | linux: xdg-open（best-effort，见 openBrowser.ts）
        ▼
pollDeviceFlow()           # GET {qwenBaseUrl}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
  · 404 / 400(INVALID_DEVICE_FLOW) = 进行中，1s 间隔继续
  · 总超时 QWEN_LOGIN_TIMEOUT_MS（300s）；连续网络错误 ≥5 次中止
  · 成功前校验 nonce + code_challenge + method 三连绑定（防串号）
        ▼
DeviceFlowCredential { token, refreshToken, expiresAt, refreshTokenExpiresAt? }
```

协议来源：QwenWorkCN 1.2.5 app.asar 逆向 + 2026-09-30 在线探活，详见 [specs/qwenwork-device-login.md](specs/qwenwork-device-login.md)。消费入口为 `scripts/log-in.ts`（`pnpm log-in`）。

### 3.12 envStore.ts — .env 安全读写单点

| 函数 | 说明 |
|------|------|
| `assertEnvGitIgnored(root?)` | `git check-ignore .env` 守卫，所有写入的前置条件 |
| `readEnvValue(key, root?)` | 读单键（缺失/空 → null），dotenv.parse |
| `writeEnvValue(key, value, root?)` | 单行 upsert（保留其他行）+ mode 600 + chmod |

消费方：`QWEN_KEYS` / `QODER_KEYS`（refresh token 备份/自举）、`QWEN_MACHINE_ID` / `QODER_MACHINE_ID`（设备标识）、`QWEN_IDENTITY` / `QWEN_BIZ_TEAM_ID`（扣费身份）。

---

## 4. 协议细节

### 4.1 OpenAI → qwenwork 映射

**请求头**：

```
Content-Type:  application/json
Accept:        text/event-stream
Authorization: Bearer COSY.{base64(header)}.{md5(sig)}
Cosy-Key:      {base64(RSA_PKCS1(pub, aesKey))}
Cosy-Date:     {unix_timestamp}
Cosy-User:     {uid}
x-model-key:   {model_id}
+ 12 个静态头（10 个 Cosy-* + Login-Version + x-model-source）
```

**请求体**：明文 JSON（**不**使用 `Encode=1`），自动补 `request_id` / `session_id`（UUID）与 `business: { product: 'qoder_work' }`（新版网关定位模型目录的必需字段，缺失会返回 503 `Model catalog unavailable`），删除 `encode` / `extra_body` 字段。

**响应**：

qwenwork 网关返回**双层 SSE**：
```
data: {"headers":{...},"body":"<内层 OpenAI chunk JSON>","statusCodeValue":200}
```

插件解包外层，取出 `body` 字段作为标准 OpenAI SSE chunk 透传：
```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"..."}}]}
```

非流式时聚合所有 delta 为完整 `chat.completion` 对象。

### 4.2 OpenAI → qoder 映射

请求形状与 4.1 完全一致（相同 path/query、相同签名、相同双层 SSE），差异：

```
Host:          https://api3.qoder.sh
x-model-key:   qfmodel | dfmodel
Cosy-Business-Product:  qoder
X-Qoder-Remote-Api-Version: 2
User-Agent:    Qoder/0.4.8
+ 12 个与 qwenwork 相同的静态头（`Cosy-Version: 1.1.59` 等）

body: { ..., business: { product: 'qoder' }, agent_id: 'agent_common', ... }
```

- `agent_id` 是 Qoder agent router 定位 flow 的必备字段，缺失时内层 400 `None flow nodes found for router agent_router`
- `business.product` 用 `qoder`（实测 `qoder_work` 也可）
- 模型目录：`GET /algo/api/v2/model/list?Encode=1`，当前账号仅 `qfmodel`（Qwen3.8-Flash）与 `dfmodel`（DeepSeek-Flash）启用
- 凭据 token 为 `dt-` 前缀 opaque token（非 JWT），uid 由 `GET {oauthBase}/api/v1/userinfo` 取得（best-effort）

### 4.3 WebSocket 协议（V24 契约）

插件与 xrl-router 之间通过 WebSocket (`/ws/plugin`) 通信。

#### 消息类型

| 方向 | 类型 | 说明 |
|------|------|------|
| plugin → router | `register` | 启动时注册插件身份、模型列表、workdir（**无 keys**） |
| plugin → router | `heartbeat` | 每 30s 保活（无 timestamp） |
| router → plugin | `registered` | 注册确认（静默） |
| router → plugin | `reconnected` | 重连确认（静默） |
| router → plugin | `error` | 协议拒绝（`keys_not_supported` / `expected_register` / `empty_plugin_id` / `invalid_register`） |
| router → plugin | `deleted` | 插件已被用户删除（`plugin_ignored`） |

**废除的消息**：
- ~~`keys_update`~~ — V24 起发送即断开
- ~~register 带 `keys` 字段~~ — V24 起严格拒绝

#### 占位凭证

Router 对插件上游请求恒发占位值：`Authorization: Bearer xrl-router`。插件必须忽略，用自身凭证（OAuth token）访问上游。

---

## 5. 部署与运维

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_PORT` | `19067` | qwenwork HTTP 监听端口 |
| `AVAILABLE_MODELS` | `flash,pro,qwen3.8-max-preview` | qwenwork 逗号分隔的可用模型列表 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router WS 连接地址（两个通道共用） |
| `QODER_PORT` | `19070` | qoder HTTP 监听端口 |
| `QODER_MODELS` | `qfmodel,dfmodel` | qoder 逗号分隔的可用模型列表 |
| `QODER_BASE_URL` | `https://api3.qoder.sh` | qoder 推理网关地址 |
| `QODER_OAUTH_BASE` | `https://openapi.qoder.sh` | qoder 设备授权/刷新/userinfo API base |
| `QODER_AUTH_BASE` | `https://qoder.com` | qoder 网页授权页 origin |
| `QODER_CLIENT_ID` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | qoder 设备授权 client_id |
| `QODER_DEVICE_POLL_PATH` | `/api/v1/deviceToken/poll` | qoder 登录轮询接口 |
| `QODER_DEVICE_REFRESH_PATH` | `/api/v1/deviceToken/refresh` | qoder token 刷新接口 |
| `QODER_USERINFO_PATH` | `/api/v1/userinfo` | qoder 账号信息接口 |
| `QODER_LOGIN_TIMEOUT_MS` | `300000` | qoder 登录轮询总超时 |
| `QODER_MACHINE_ID` | *(空，自动生成持久化到 .env)* | qoder 设备标识显式覆盖 |
| `QODER_LOGIN_UA` | `QoderWork/1.1.75` | qoder 登录/刷新请求 UA |
| `QODER_KEYS` | *(空)* | qoder refresh token 当前值（`pnpm log-in:qoder` 备份，自举源） |
| `QWEN_BASE_URL` | `https://gateway.qwenwork.cn` | 推理网关地址 |
| `QWEN_DEVICE_REFRESH_PATH` | `/api/v1/deviceToken/refresh` | token 刷新接口 |
| `QWEN_DEVICE_POLL_PATH` | `/api/v1/deviceToken/poll` | 网页登录轮询接口（host 同 `QWEN_BASE_URL`） |
| `QWEN_AUTH_BASE` | `https://gateway.qwenwork.cn` | device-flow 登录入口 origin（`/device/selectAccounts`） |
| `QWEN_CLIENT_ID` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` | device-flow OAuth client_id（asar 常量） |
| `QWEN_LOGIN_TIMEOUT_MS` | `300000` | 网页登录轮询总超时 |
| `QWEN_MACHINE_ID` | *(空，自动生成持久化到 .env)* | device-flow 设备标识显式覆盖 |
| `QWEN_RSA_PUBLIC_KEY_PATH` | *(空，用内嵌公钥)* | RSA 公钥 PEM 文件路径（可选覆盖） |
| `QWEN_REFRESH_INTERVAL_MS` | `600000` | token 自动刷新检查间隔（10min） |
| `QWEN_TARGET` | `c` | deviceToken/refresh 的 target 参数（实测仅 `c` 合法，与扣费身份无关） |
| `QWEN_IDENTITY` | `personal` | 扣费身份：`personal`=个人积分池（合法默认）/ `biz`=企业积分池（`log-in --status` 在 biz 下会调 switch-team 派生凭据，非纯只读） |
| `QWEN_BIZ_TEAM_ID` | *(空)* | 企业模式指定 team（空=自动挑 `active` + 有套餐的组织）；见 `pnpm log-in --list-orgs` |
| `QWEN_WEB_BASE` | `https://qwenwork.cn` | 网站域 origin（账户/组织/余额 API；这些端点在 gateway 域 404） |
| `QWEN_KEYS` | *(空)* | refresh token 当前值（`pnpm log-in` 备份，`getToken()` 自举源） |
| `QWEN_MACHINE_ID`（.env 行） | 自动生成 | device-flow 设备标识（`pnpm log-in` 首跑写入） |

### 日志格式

所有日志输出到 stdout/stderr，前缀标识模块：

```
[PluginClient] Connected to xrl-router
[PluginClient] Reconnecting in 2000ms (attempt 2)
[qwenwork] token 已刷新（有效期至 2026-08-02T15:30:00.000Z）
[qwenwork] 已用 QWEN_KEYS 自举刷新（有效期至 2026-08-02T15:30:00.000Z）
[qwenwork] QWEN_KEYS 同步失败（不影响运行）: EACCES
[qwenwork] 流读取失败: network timeout
[qoder] 已检测到 .env QODER_KEYS（网页登录凭据，运行时按需刷新）
[qoder] token 已刷新（有效期至 2026-11-19T02:58:20.000Z）
[qoder] 已用 QODER_KEYS 自举刷新（有效期至 2026-11-19T02:58:20.000Z）
[qoder] 流读取失败: network timeout
```

---

## 6. 故障排查

### 401 Unauthorized

- 原因：OAuth token 已失效或刷新失败
- qwenwork 排查：`pnpm log-in --status` 看双池与凭据有效期；确认 `.env QWEN_KEYS` 有值
- qoder 排查：`pnpm log-in:qoder --status` 看凭据可刷新性与有效期；确认 `.env QODER_KEYS` 有值
- 修复：重新运行对应的 `pnpm log-in` / `pnpm log-in:qoder`（网页设备授权，全程无需 App）
- `QWEN_IDENTITY=biz` 时的 401 另有一层含义：企业凭据不可用时**已拒绝降级**，不会改烧个人积分

### 550 / 上游错误

- 原因：gateway.qwenwork.cn 后端繁忙
- 修复：由 xrl-router 层自动重试；若持续出现检查上游网关状态

### WebSocket 连接失败

- 表现：`[PluginClient] WebSocket error` + 指数退避重连日志
- 排查：
  1. 确认 `XRL_ROUTER_URL` 指向运行中的 xrl-router 实例
  2. 检查 xrl-router 的 `/ws/plugin` 端点是否可达
  3. 重连间隔最大 60s，连续失败时检查网络/firewall

### token 所有源均失败

- 表现：`无可用 token 源（refresh token 均已失效，请运行 pnpm log-in 网页登录）`
- 排查顺序：
  1. `.env` 中 `QWEN_KEYS` 是否有值（唯一持久源）
  2. 该值是否已被服务端作废（refresh token 轮换式，旧值一次性的）
  3. 重跑 `pnpm log-in` 重新扫码（无需任何 App）

### qoder 凭据不存在 / 已过期

- 表现：`无可用 Qoder 凭据（refresh token 均失效或缺失），请运行 pnpm log-in:qoder 网页登录`
- 排查：`pnpm log-in:qoder --status` 看凭据能否刷新、账号与有效期
- 修复：重跑 `pnpm log-in:qoder`（浏览器完成设备授权，无需 Qoder App）

### qoder 内层 400 `None flow nodes found for router agent_router`

- 原因：请求体缺少 `agent_id`
- 修复：不要移除 `qoderClient.ts` 的 `bodyDefaults: { agent_id: 'agent_common' }`

### qoder 目录只显示两个模型

- 现象：`GET /algo/api/v2/model/list` 中多数模型 `enable=false`
- 原因：当前账号档位限制，非插件问题；可用 `QODER_MODELS` 覆盖注册列表，但未启用的模型无法推理
