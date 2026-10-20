# AGENTS.md — xrl-router-plugin-qwenwork

本文件为 AI Agent 划定项目边界。任何 Agent 在本仓库工作时，必须遵守以下约束。

## 概述
- 本项目是什么：一个 **qwenwork / qoder 双通道的 xrl-router 插件**，将两个同协议族的 AI 网关包装为 OpenAI Chat Completions 兼容的本地服务喵～

| 通道 | 上游网关 | 后端模型 |
|------|---------|---------|
| qwenwork | `gateway.qwenwork.cn` | Standard / Pro / Qwen3.8-Max |
| qoder | `api3.qoder.sh` | Qwen3.8-Flash / DeepSeek-Flash |

协议边界：**只桥接 OpenAI Chat Completions（`/v1/chat/completions`）**，不做任何协议扩展喵。

## 边界与范围
- 范围内：OpenAI Chat Completions 协议桥接（流式 + 非流式）、Cosy 签名、qwenwork token 自动刷新、qoder 只读凭据拾取、WebSocket 插件注册/心跳/重连（V24 契约）、网页 device-flow 登录（PKCE + deviceToken/poll）、扣费身份派生（个人 / 企业积分池）
- 非目标（明确排除）：
  - **不实现 Anthropic Messages API** — 旧架构，已在 commit `63eb217` 中整体删除，不要加回来
  - **不做密钥轮转 / 重试逻辑** — 这是 xrl-router 的职责，插件只管转发
  - **不做本地模型推理** — 所有请求都走远端网关，插件是纯翻译层
  - **不实现 `/v1/models` 端点** — 模型列表通过 WebSocket 注册推送，不通过 HTTP 暴露
  - **不复用抓到的 JWT / cosy-key** — 网关有 anti-replay 检测，复用会被封
  - **不做 tools / tool_use 翻译** — xrl-router 自己处理
  - **不实现非 Chat Completions 端点** — `/v1/embeddings`、`/v1/completions` 等一律不加
  - **qoder 凭据只读** — 不刷新、不写回 `auth.v1.dat`，不改 Qoder App 的任何文件；轮换权归 App
  - **不支持千问办公 App 链路**（2026-10-20 取消，见 D-16）— 不解密也不写回 `auth-v2.dat`，不要加回文件监听/解密；qwenwork 凭据只来自 `pnpm log-in` 网页 device-flow
  - **个人版积分是合法选择** — `QWEN_IDENTITY=personal` 一律如实放行，不得拦截；只有企业模式（`biz`）铸造失败才报错，**绝不静默降级**（见 D-15）

## Agent 操作指南
- 如何理解本项目：纯翻译层插件——把 qwenwork / qoder 网关的 Cosy 签名字段桥接为 OpenAI Chat Completions 兼容 API，不引入业务逻辑
- 全局规则 / 约定：
  - **包管理器：pnpm**（不是 npm — npm 会触发 arborist `Link.matches` 崩溃 bug，详见 MEMORY）
  - **dev 模式：tsx**（已去掉 watch — 文件变更需手动重启）
  - **HTTP 框架：Hono**（不是 Express — V24 契约要求）
  - `.env` 永不进 git — `git check-ignore .env` 必须通过喵！
  - 只从自己登录的实例抓密钥，不要抓别人的
  - 两个通道是**独立进程、独立插件**（`plugin-qwenwork`@19067 / `plugin-qoder`@19070），共享 `forward.ts` / `server.ts` / `signer.ts` / `safeStorage.ts`（解密），不要合并成单进程
  - V24 契约：register 不带 `keys`（带了 Router 直接拒绝断开）、不发 `keys_update`（发了直接断开）、`provider.kind` 为 `chat_completions`、心跳 `{"type": "heartbeat"}` 不带 timestamp、register 带 `workdir`、Router 发占位凭证 `Authorization: Bearer xrl-router`（插件用自身凭证访问上游）

### 构建与运行

```bash
pnpm install              # 安装依赖（再次强调：不要用 npm）
pnpm serve                # 启动 qwenwork 网关（19067）
pnpm serve:qoder          # 启动 qoder 网关（19070；需先登录 Qoder App）
pnpm log-in               # 网页扫码登录（device flow，唯一凭据来源，无需 App）
pnpm log-in --list-orgs   # 列企业组织及席位/套餐可用性（取 --team-id）
pnpm log-in --identity biz [--team-id <id>]   # 登录并派生+校验企业扣费身份
pnpm log-in --status      # 只读诊断：当前扣费身份与个人/企业双池余额
```

### 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| 密钥过期（~1h qwenwork access token） | 网关设计，自动刷新即可 |
| qoder 凭据只读（过期需打开 Qoder App 刷新） | 插件写回会与 App 的 refresh token 轮换互踩；App 拥有轮换权 |
| qwenwork 无 App 兜底（`.env QWEN_KEYS` 丢失只能重扫码） | App 链路支持已移除（D-16）：解密 + 写回 + 文件监听三套机制只服务一种部署形态，收益不抵风险 |
| 无测试 | 当前阶段不需要，插件是纯翻译层 |
| Windows 解密依赖 powershell.exe | Windows DPAPI 经 PowerShell `System.Security` 调用，Windows 自带无需安装；macOS 走 Keychain |

### 必须拒绝的任务

遇到以下需求，直接引用本 AGENTS.md 拒绝喵：

1. **「实现 Anthropic Messages API」** → Non Goal，已删除的旧架构
2. **「添加密钥轮转逻辑」** → xrl-router 的职责
3. **「实现本地模型推理」** → 纯桥接插件
4. **「复用抓到的 JWT / cosy-key」** → anti-replay 会封号
5. **「加回千问办公 App 链路（解密/写回 auth-v2.dat）」** → 已取消支持（D-16），凭据只走网页 device-flow
6. **「拦截个人版积分 / biz 失败时静默回退个人凭据」** → 个人版是合法选择；企业模式必须显式失败（D-15）

### 允许的任务方向

- 新增 DEAP / Cosy 业务 header
- 优化 WebSocket 重连策略
- 新增模型展示名（`DISPLAY_NAMES`）
- 维护网页 device-flow 登录（PKCE / `deviceToken/poll`，见 `docs/specs/qwenwork-device-login.md`）
- 维护扣费身份切换（`QWEN_IDENTITY=personal|biz`，见 `docs/DECISIONS.md` D-15）
- 维护 qoder 通道的模型目录 / 展示名 / 请求差异（保持凭据只读）

## 目录速查
- `src/index.ts` — qwenwork 入口：配置 + 启动
- `src/qoderIndex.ts` — qoder 入口：配置 + 启动
- `src/server.ts` — 共享 Hono 服务骨架：路由、端口释放、优雅退出
- `src/forward.ts` — 共享转发核心：签名、SSE 解包、tool_calls 标准化、非流式聚合
- `src/config.ts` — qwenwork Settings 单例
- `src/qoderConfig.ts` — qoder Settings（端口/模型/凭据路径）
- `src/pluginClient.ts` — WebSocket 客户端：注册（V24 无 keys）、心跳、重连
- `src/client.ts` — qwenwork 通道差异：静态头、business、展示名、灾备 refresh
- `src/qoderClient.ts` — qoder 通道差异：静态头、business、`agent_id`、展示名
- `src/auth.ts` — qwenwork token 管理（刷新轮换 + 两源 fallback（缓存 / `.env QWEN_KEYS`）+ adoptCredential）
- `src/bizIdentity.ts` — 企业身份派生（switch-team 铸 biz JWT + 缓存续期 + 双池余额判据）
- `src/qoderAuth.ts` — qoder token 管理（只读 + 文件监听，不刷新不写回）
- `src/safeStorage.ts` — Electron safeStorage 解密（仅 qoder 通道只读拾取；Keychain / DPAPI）
- `src/deviceLogin.ts` — 网页 device-flow 登录（PKCE + deviceToken/poll，无需 App）
- `src/envStore.ts` — .env 安全读写单点（git-ignore 守卫 + 单行 upsert）
- `src/signer.ts` — RSA_PKCS1 + AES 签名（逆向自 asar）
- `scripts/log-in.ts` — pnpm log-in：网页扫码登录 + 扣费身份管理（`--list-orgs` / `--status` 为只读模式）
- `docs/PRD.md` — 产品需求文档
- `docs/ARCHITECTURE.md` — 架构地图
- `docs/DECISIONS.md` — 设计决策记录
- `docs/researches/` — 逆向分析原始记录
- `docs/specs/` — 核心功能规格文档
