# AGENTS.md — xrp-cosy

本文件为 AI Agent 划定项目边界。任何 Agent 在本仓库工作时，必须遵守以下约束。

## 概述
- 本项目是什么：一个 **qwenwork / qoder 双通道的 xrl-router 插件**，将两个同协议族（Cosy 签名）的 AI 网关包装为 OpenAI Chat Completions 兼容的本地服务
- **唯一登录方式：自包含网页 OAuth**（设备授权 + PKCE S256 + `deviceToken/poll` 轮询），不依赖任何官方 App
- 项目由 `xrl-router-plugin-qwenwork` 更名而来（2026-10-25，见 `docs/DECISIONS.md` D-17）

| 通道 | 上游网关 | 登录入口 | 后端模型 |
|------|---------|---------|---------|
| qwenwork | `gateway.qwenwork.cn` | `pnpm log-in` | Standard / Pro / Qwen3.8-Max |
| qoder | `api3.qoder.sh` | `pnpm log-in:qoder` | Qwen3.8-Flash / DeepSeek-Flash |

协议边界：**只桥接 OpenAI Chat Completions（`/v1/chat/completions`）**，不做任何协议扩展。

## 边界与范围
- 范围内：OpenAI Chat Completions 协议桥接（流式 + 非流式）、Cosy 签名、qwenwork token 自动刷新、qwenwork 网页 device-flow 登录、qwenwork 扣费身份派生（个人 / 企业积分池）、qoder 网页 device-flow 登录与 token 轮换、qoder 只读模型目录、WebSocket 插件注册/心跳/重连（V24 契约）
- 非目标（明确排除）：
  - **不实现 Anthropic Messages API** — 旧架构，已在 commit `63eb217` 中整体删除，不要加回来
  - **不做密钥轮转 / 重试逻辑** — 这是 xrl-router 的职责，插件只管转发
  - **不做本地模型推理** — 所有请求都走远端网关，插件是纯翻译层
  - **不实现 `/v1/models` 端点** — 模型列表通过 WebSocket 注册推送，不通过 HTTP 暴露
  - **不复用抓到的 JWT / cosy-key** — 网关有 anti-replay 检测，复用会被封
  - **不做 tools / tool_use 翻译** — xrl-router 自己处理
  - **不实现非 Chat Completions 端点** — `/v1/embeddings`、`/v1/completions` 等一律不加
  - **不读取、不解密、不写回任何官方 App 登录态文件** — `auth.v1.dat` / `auth-v2.dat` 一律不碰；凭据只来自网页 device-flow（见 D-16 / D-17）
  - **不支持千问办公 App 链路** — 不解密也不写回 `auth-v2.dat`，不要加回文件监听/解密
  - **个人版积分是合法选择** — `QWEN_IDENTITY=personal` 一律如实放行，不得拦截；只有企业模式（`biz`）铸造失败才报错，**绝不静默降级**（见 D-15）

## Agent 操作指南
- 如何理解本项目：纯翻译层插件——把 qwenwork / qoder 网关的 Cosy 签名字段桥接为 OpenAI Chat Completions 兼容 API，不引入业务逻辑
- 全局规则 / 约定：
  - **包管理器：pnpm**（不是 npm — npm 会触发 arborist `Link.matches` 崩溃 bug，详见 MEMORY）
  - **dev 模式：tsx**（已去掉 watch — 文件变更需手动重启）
  - **HTTP 框架：Hono**（不是 Express — V24 契约要求）
  - `.env` 永不进 git — `git check-ignore .env` 必须通过
  - 只从自己登录的实例抓密钥，不要抓别人的
  - 两个通道是**独立进程、独立插件**（`plugin-qwenwork`@19067 / `plugin-qoder`@19070），共享 `forward.ts` / `server.ts` / `signer.ts` / `envStore.ts` / `openBrowser.ts`，不要合并成单进程
  - V24 契约：register 不带 `keys`（带了 Router 直接拒绝断开）、不发 `keys_update`（发了直接断开）、`provider.kind` 为 `chat_completions`、心跳 `{"type": "heartbeat"}` 不带 timestamp、register 带 `workdir`、Router 发占位凭证 `Authorization: Bearer xrl-router`（插件用自身凭证访问上游）
  - 凭据持久化只允许写 `.env`（`envStore.ts` 单点、git-ignore 守卫、mode 600）；除 `.env` 外的任何凭据文件格式都需要先改本文件

### 构建与运行

```bash
pnpm install              # 安装依赖（再次强调：不要用 npm）
pnpm typecheck            # src + scripts 类型检查
pnpm serve                # 启动 qwenwork 网关（19067）
pnpm log-in               # qwenwork 网页设备授权登录（唯一凭据来源，无需 App）
pnpm log-in --list-orgs   # 列企业组织及席位/套餐可用性（取 --team-id）
pnpm log-in --identity biz [--team-id <id>]   # 登录并派生+校验企业扣费身份
pnpm log-in --status      # 只读诊断：当前扣费身份与个人/企业双池余额
pnpm log-in:qoder         # qoder 网页设备授权登录（写入 .env QODER_KEYS）
pnpm log-in:qoder --status  # qoder 只读诊断：凭据可刷新性 + 账号 + 有效期
pnpm serve:qoder          # 启动 qoder 网关（19070）
```

### 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| 密钥过期（~1h qwenwork access token） | 网关设计，自动刷新即可 |
| qwenwork refresh token 有服务端绝对过期时间 | 服务端策略；<24h 告警提示重登即可 |
| qoder 凭据 30 天 / refresh 1 年 | 官方设备授权策略；自动轮换即可 |
| 网页登录需要人工在浏览器完成授权 | 官方登录页托管口令，插件不经手、也不应模拟 |
| 无测试 | 当前阶段不需要，插件是纯翻译层 |
| `.env` 是唯一持久化凭据载体 | 与「无 App 依赖」边界一致；`.env` 丢失只能重新登录 |

### 必须拒绝的任务

遇到以下需求，直接引用本 AGENTS.md 拒绝：

1. **「实现 Anthropic Messages API」** → Non Goal，已删除的旧架构
2. **「添加密钥轮转逻辑」** → xrl-router 的职责
3. **「实现本地模型推理」** → 纯桥接插件
4. **「复用抓到的 JWT / cosy-key」** → anti-replay 会封号
5. **「加回千问办公 App 链路（解密/写回 auth-v2.dat）」** → 已取消支持（D-16），凭据只走网页 device-flow
6. **「读取/解密/写回 Qoder App 的 auth.v1.dat」** → 已随 D-17 移除；qoder 凭据只走网页设备授权
7. **「拦截个人版积分 / biz 失败时静默回退个人凭据」** → 个人版是合法选择；企业模式必须显式失败（D-15）

### 允许的任务方向

- 新增 DEAP / Cosy 业务 header
- 优化 WebSocket 重连策略
- 新增模型展示名（`DISPLAY_NAMES`）
- 维护 qwenwork 网页 device-flow 登录（PKCE / `deviceToken/poll`，见 `docs/specs/qwenwork-device-login.md`）
- 维护 qoder 网页 device-flow 登录与刷新（见 `docs/specs/qoder-device-login.md`）
- 维护扣费身份切换（`QWEN_IDENTITY=personal|biz`，见 `docs/DECISIONS.md` D-15）
- 维护 qoder 通道的模型目录 / 展示名 / 请求差异
- 维护 `.env` 凭据读写单点（`src/envStore.ts`）

## 目录速查
- `src/index.ts` — qwenwork 入口：配置 + 启动
- `src/qoderIndex.ts` — qoder 入口：配置 + 启动
- `src/server.ts` — 共享 Hono 服务骨架：路由、端口释放、优雅退出
- `src/forward.ts` — 共享转发核心：签名、SSE 解包、tool_calls 标准化、非流式聚合
- `src/config.ts` — qwenwork Settings 单例
- `src/qoderConfig.ts` — qoder Settings（端口/模型/登录端点/凭据）
- `src/pluginClient.ts` — WebSocket 客户端：注册（V24 无 keys）、心跳、重连
- `src/client.ts` — qwenwork 通道差异：静态头、business、展示名、灾备 refresh
- `src/qoderClient.ts` — qoder 通道差异：静态头、business、`agent_id`、展示名
- `src/auth.ts` — qwenwork token 管理（刷新轮换 + 两源 fallback（缓存 / `.env QWEN_KEYS`）+ adoptCredential）
- `src/bizIdentity.ts` — 企业身份派生（switch-team 铸 biz JWT + 缓存续期 + 双池余额判据）
- `src/qoderAuth.ts` — qoder token 管理（刷新轮换 + 两源 fallback（缓存 / `.env QODER_KEYS`）+ adoptCredential）
- `src/deviceLogin.ts` — qwenwork 网页 device-flow 登录（PKCE + deviceToken/poll）
- `src/qoderDeviceLogin.ts` — qoder 网页设备授权登录（PKCE + deviceToken/poll + userinfo）
- `src/openBrowser.ts` — 跨平台打开系统浏览器
- `src/envStore.ts` — .env 安全读写单点（git-ignore 守卫 + 单行 upsert）
- `src/signer.ts` — RSA_PKCS1 + AES 签名（逆向自 asar）
- `scripts/log-in.ts` — pnpm log-in：qwenwork 渠道凭据入口（网页登录 + 扣费身份管理；`--list-orgs` / `--status` 为只读模式）
- `scripts/log-in-qoder.ts` — pnpm log-in:qoder：qoder 渠道凭据入口（网页设备授权登录 + `--status` 只读诊断）
- `docs/PRD.md` — 产品需求文档
- `docs/ARCHITECTURE.md` — 架构地图
- `docs/DECISIONS.md` — 设计决策记录
- `docs/researches/` — 逆向分析原始记录
- `docs/specs/` — 核心功能规格文档
