# PRD — xrp-cosy

> **产品需求文档** — qwenwork / qoder 双通道的 Cosy 协议桥接插件：仅支持自包含网页 OAuth 登录

| 字段 | 内容 |
|------|------|
| 产品名称 | xrp-cosy |
| 版本 | 0.6.0 |
| 状态 | V24 契约稳定运行；双通道均已完成自包含登录改造 |
| 最后更新 | 2026-10-25 |

---

## 1. 背景与目标

### 1.1 背景

国内 AI 网关对外暴露的能力很强，但协议壁垒也很高，普通 OpenAI 客户端无法直接调用。

**QwenWorkCN 网关**（gateway.qwenwork.cn）与 **Qoder 网关**（api3.qoder.sh）使用同一套 Cosy 签名体系（RSA+AES+MD5）：每个请求需要 `Cosy-Key`（RSA 加密的随机 AES key）、`Authorization`（MD5 签名绑定 body/path/时间戳）、`Cosy-User` 等头。签名算法逆向自官方客户端，普通客户端无法自行签名。

**xrl-router** 是统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑，通过 WebSocket 插件协议（V24 契约）扩展对不同后端的支持。

**历史包袱**：两条通道曾分别依赖千问办公 App（`auth-v2.dat`）与 Qoder App（`auth.v1.dat`）的登录态文件。App 链路带来 Electron safeStorage 解密、文件监听、写回互踩等复杂度，且把「能否部署」绑定在「本机是否装着官方 App」上。

### 1.2 目标

1. 让任何能调 OpenAI API 的客户端（Claude Code、Cursor、各类 IDE 插件）通过 xrl-router 无缝访问 qwenwork / qoder 网关，无需感知 Cosy 签名协议细节
2. **登录方式收敛为唯一形态：自包含网页 OAuth**（设备授权 + PKCE S256 + 轮询换票 + refresh 轮换），不读取、不解密、不写回任何官方 App 文件

### 1.3 非目标

- 不实现 Anthropic Messages API 协议（旧版架构，已删除）
- 不管理密钥轮转逻辑（由 xrl-router 负责）
- 不运行任何本地模型
- 不发送 `keys` / `keys_update` 给 Router（V24 契约严格禁止）
- 不读取/解密/写回 `auth-v2.dat`、`auth.v1.dat` 等 App 登录态文件
- 不实现除 OpenAI Chat Completions 之外的端点

---

## 2. 用户画像

| 角色 | 描述 | 核心诉求 |
|------|------|----------|
| 开发者 | 使用 Claude Code / Cursor 等工具 | 无缝调用模型，无需改客户端代码 |
| 运维 | 负责凭据管理和部署 | 一键验证 token、自动刷新、长期稳定运行 |
| 终端用户 | 通过上层应用使用 AI 能力 | 稳定、低延迟 |
| 逆向工程师 | 分析 Cosy 协议族 | 离线独立调用验证（不依赖任何官方 App） |

---

## 3. 用户故事

### US-1：开发者通过两个通道调用模型

**作为** 使用 Cursor 的开发者，
**我希望** 通过 qwenwork / qoder 插件访问上游模型，
**以便** 我可以使用国产大模型而无需担心密钥过期。

**验收标准：**
- 客户端发送标准 OpenAI Chat Completions 请求
- 插件自动完成 Cosy 签名（RSA 加密 AES key → `Cosy-Key`，MD5 签名 → `Authorization`）
- 流式响应：解包外层 SSE（`data:{"body":"<内层chunk>"}`）为标准 OpenAI SSE 透传
- 非流式响应：聚合所有 delta chunk 为完整 `chat.completion` JSON

### US-2：Token 自动刷新

**作为** 运维人员，
**我希望** 两个通道的 OAuth token 都能自动刷新，
**以便** 服务可以长期运行而无需人工干预。

**验收标准：**
- access token 临近过期（提前 5 分钟）时自动刷新
- qwenwork：`POST /api/v1/deviceToken/refresh`，body `{refresh_token, target}`
- qoder：`POST /api/v1/deviceToken/refresh`，body `{refresh_token}`（国际区 `openapi.qoder.sh`）
- refresh token 轮换后自动同步到 `.env`（`QWEN_KEYS` / `QODER_KEYS`）
- 两源回退：内存缓存 → `.env` 备份（自举）；均为网页登录产出
- 单飞防并发（同一时刻只有一个刷新请求）

### US-3：凭据自举（自包含网页登录）

**作为** 普通用户 / 运维，
**我希望** 不安装任何官方 App 也能获取首份凭据并验证刷新链路，
**以便** 在任意机器上「拷项目 → 浏览器登录 → serve」完成部署。

**验收标准：**
- qwenwork：`pnpm log-in` 打开 `gateway.qwenwork.cn/device/selectAccounts`，扫码后在本地轮询 `deviceToken/poll`
- qoder：`pnpm log-in:qoder` 打开 `qoder.com/device/selectAccounts`，登录后在本地轮询 `openapi.qoder.sh/api/v1/deviceToken/poll`
- 全程无本地回调监听、无 App 文件读写；轮询成功前校验 nonce + challenge 绑定（服务端返回时）
- 凭据备份到 `.env`（`QWEN_KEYS` / `QODER_KEYS`，mode 600，git-ignore 守卫）
- 登录后立即验证一次刷新链，确认 refresh token 可轮换
- 跟踪 refresh token 绝对过期时间，距过期 <24h 告警提示重登

### US-4：故障自动恢复（WebSocket 重连）

**作为** 运维人员，
**我希望** 插件与 xrl-router 断线后能自动重连，
**以便** 我不需要手动重启服务。

**验收标准：**
- WebSocket 断线后自动重连（指数退避：1s → 2s → 4s → … → 最大 60s）
- 心跳保活（每 30s 发送 `heartbeat` 消息）
- 容忍 Router 未就绪：连接失败时退避重试
- 重连成功后自动重新注册

### US-5：企业积分扣费身份（qwenwork）

**作为** 企业用户，
**我希望** 可以显式选择从企业积分池扣费，
**以便** 不误烧个人额度。

**验收标准：**
- `QWEN_IDENTITY=personal`（默认）如实使用个人池
- `QWEN_IDENTITY=biz` 用 switch-team 派生企业 JWT；派生失败必须显式报错，**绝不静默降级**
- `pnpm log-in --status` 用双池余额变化作为扣费身份的硬判据

---

## 功能及其意义

| 功能 | 解决什么 | 为什么需要 |
|------|----------|------------|
| Cosy 签名桥接 | 两个网关的 RSA+AES+MD5 签名协议壁垒 | 普通 OpenAI 客户端无法自行签名 |
| SSE 双层解包 | 上游返回外层包裹的 SSE 格式 | 客户端需要标准 OpenAI SSE |
| Token 自动刷新 | access token 会过期（qwenwork ~1h / qoder ~30d） | 避免服务频繁中断 |
| WebSocket 注册/心跳/重连 | 插件发现与保活 | xrl-router 需要感知插件存活 |
| 自包含网页 device-flow 登录 | 首份凭据曾需官方 App | 实现「拷项目→登录→serve」零 App 部署 |
| 端口释放 | 重启时 EADDRINUSE | 开发体验 |

## 功能之间的关系

- Cosy 签名桥接依赖 Token 自动刷新（每个请求需有效 OAuth token 参与签名）
- 网页 device-flow 登录为 Token 自动刷新提供首份 refresh token（自举源）
- WebSocket 注册/心跳/重连保障插件在 xrl-router 中可见，是所有转发流量的前置条件
- SSE 双层解包与非流式聚合共同覆盖 OpenAI Chat Completions 的全部响应模式

## 范围与非目标

- 范围内：OpenAI Chat Completions 协议桥接、Cosy 签名、OAuth token 管理与刷新、WebSocket 插件协议（V24）、两条通道的自包含网页登录、qwenwork 扣费身份派生、qoder 模型目录、端口释放
- 范围外：Anthropic Messages API、密钥轮转/重试逻辑、本地模型推理、`/v1/models` 端点、非 Chat Completions 端点、tools/tool_use 翻译、任何 App 登录态文件的读取/解密/写回

### 4.1 核心功能（P0）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-1 | Cosy 签名桥接 | 每请求生成随机 16B AES key → RSA 加密为 `Cosy-Key` → AES 加密 userInfo → MD5 签名 `Authorization` |
| F-2 | 流式支持 | 解包外层 SSE `{"body":"..."}` 为标准 OpenAI SSE |
| F-3 | 非流式支持 | 聚合所有 delta chunk 为完整 `chat.completion` JSON |
| F-4 | WebSocket 注册/心跳/重连（V24） | 启动时 `register`（plugin_id + 模型列表 + workdir，**无 keys**），心跳 30s（**无 timestamp**），断线指数退避重连 |
| F-5 | 自包含网页登录 | `pnpm log-in` / `pnpm log-in:qoder`：设备授权 + PKCE + `deviceToken/poll` + 刷新链验证 + `.env` 备份 |
| F-6 | Token 自动刷新 | 两通道各自缓存 + 单飞刷新；轮换值同步 `.env` |

### 4.2 重要功能（P1）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-7 | qwenwork 扣费身份 | `QWEN_IDENTITY=personal / biz`；`log-in --status` / `--list-orgs` 只读诊断 |
| F-8 | qoder 模型目录 | 启动时注册 `QODER_MODELS`；展示名映射在 `qoderClient.ts` |
| F-9 | qoder `--status` | 只读诊断凭据可刷新性、账号、有效期 |

### 4.3 辅助功能（P2）

| 编号 | 功能 | 描述 |
|------|------|------|
| F-10 | 健康检查 | `GET /health` 返回 `{status, backend, base_url}` |
| F-11 | 服务信息 | `GET /` 返回 `{version, service, backend, endpoints}` |
| F-12 | 端口释放 | 启动前自动检测并 kill 占用目标端口的进程（macOS lsof / Windows netstat+taskkill） |

---

## 5. 非功能需求

### 5.1 性能

- 请求延迟：插件层增加延迟 < 10ms（不含网络传输和签名计算）
- 内存占用：单实例 < 100MB
- 并发能力：单实例支持 100+ 并发请求

### 5.2 可用性

- 断线自动重连（指数退避，最大间隔 60s）
- 心跳保活（每 30s 一次）
- 优雅退出（SIGTERM/SIGINT 时关闭 WebSocket 连接、停止心跳）

### 5.3 安全性

- `.env` 与密钥永不进 git（`.gitignore` 强制，`envStore.ts` 写入前 `git check-ignore` 守卫）
- `.env` 文件权限 600（仅属主可读写）
- 仅使用本机、本人完成网页授权获得的凭据；不读取任何官方 App 的登录态文件
- 登录轮询必须校验 nonce / PKCE challenge 绑定（服务端返回时），防串号采纳他人凭据

### 5.4 兼容性

- Node.js >= 20
- 跨平台：Windows / macOS / Linux（无 Keychain / DPAPI 依赖）
- HTTP 框架：Hono（V24 契约要求）
- 协议兼容：OpenAI Chat Completions API（流式 + 非流式）

---

## 6. 约束与依赖

### 6.1 约束

- 本插件不管理密钥轮转逻辑（由 xrl-router 负责）
- 本插件不运行任何本地模型（全部能力来自远端网关）
- 本插件凭证自持（V24 契约），Router 发占位凭证 `Bearer xrl-router`
- 凭据持久化只允许写 `.env`；不引入任何 App 文件格式

### 6.2 依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| xrl-router | 上游路由层 | 必须运行在 `http://localhost:19068` |
| gateway.qwenwork.cn / qwenwork.cn | qwenwork 推理 + 授权 | 设备授权入口在 gateway 域 |
| api3.qoder.sh / openapi.qoder.sh / qoder.com | qoder 推理 + 授权 | 国际区：推理 api3，令牌 openapi，授权页 qoder.com |
| 千问办公 App / Qoder App | **无依赖** | 登录与刷新全部由网页设备授权完成 |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| xrl-router 断线 | 插件无法注册 | 自动重连（指数退避 1s~60s）+ 心跳保活 30s |
| OAuth token 刷新失败 | 通道不可用 | 两源回退：内存缓存 → `.env` 备份；均失效则提示重跑对应 log-in |
| 官方设备授权端点变更 | 登录不可用 | 登录参数全部走配置（`QODER_*` / `QWEN_*` env），可快速改道 |
| 企业凭据不可用（`QWEN_IDENTITY=biz`） | 请求 401 | 刻意拒绝降级到个人积分，需修复席位/套餐或重登 |
| `.env` 丢失 | 需重新登录 | 无 App 兜底；这是自包含登录的已知代价 |

---

## 8. 验收标准

- [ ] `pnpm log-in` 网页授权成功并备份 `QWEN_KEYS`（无需 App）
- [ ] `pnpm log-in:qoder` 网页授权成功并备份 `QODER_KEYS`（无需 App）
- [ ] `pnpm serve` / `pnpm serve:qoder` 启动后 `/health` 分别返回 `backend: "qwenwork"` / `"qoder"`
- [ ] 插件成功连接 xrl-router 并注册（`plugin-qwenwork` / `plugin-qoder`，V24 契约无 keys）
- [ ] 客户端通过 xrl-router 能正常调用两条通道的模型（流式 + 非流式）
- [ ] Cosy 签名正确（`Cosy-Key`、`Authorization`、`Cosy-Date`、`Cosy-User`）
- [ ] Token 临近过期时自动刷新，refresh token 轮换后同步 `.env`
- [ ] 仓库内不存在对 `auth.v1.dat` / `auth-v2.dat` 的读取/解密/写回代码
- [ ] 优雅退出：SIGTERM/SIGINT 关闭 WebSocket + 停止心跳

---

## 9. 附录

### 9.1 术语表

| 术语 | 含义 |
|------|------|
| xrl-router | 统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑 |
| Cosy | qwenwork / qoder 网关共用的签名体系：RSA 加密随机 AES key + AES 加密 userInfo + MD5 请求签名 |
| 设备授权（device flow） | OAuth 2.0 设备授权：浏览器完成登录，客户端用 nonce/verifier 轮询换票 |
| PKCE | Proof Key for Code Exchange；`challenge = base64url(sha256(verifier))` |
| refresh token | qwenwork 为 `ory_rt_` 前缀，qoder 为 `drt-` 前缀；轮换式，用于 `deviceToken/refresh` |
| V24 契约 | xrl-router 插件系统 V24 版本，废除 keys 字段、要求 Hono 框架 |
| plugin_id | 插件在 xrl-router 中的注册标识：`plugin-qwenwork` / `plugin-qoder` |
| 占位凭证 | Router 恒发的 `Bearer xrl-router`，插件必须忽略并用自身 OAuth token |

### 9.2 快速启动

```bash
pnpm install              # 安装依赖

pnpm log-in               # qwenwork 网页设备授权（无需 App）
pnpm serve                # qwenwork 网关 :19067

pnpm log-in:qoder         # qoder 网页设备授权（无需 App）
pnpm serve:qoder          # qoder 网关 :19070
```

---

*版本 0.6.0 · 最后更新 2026-10-25*
