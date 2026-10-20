# xrl-router-plugin-qwenwork

> xrl-router 的 qwenwork / qoder 双通道插件 — 把千问办公与 Qoder 的 AI 网关包装成 OpenAI Chat Completions 兼容的本地服务喵～

```
客户端 → xrl-router → 本插件（qwenwork / qoder 两个独立进程）→ 上游网关
```

| 通道 | 上游网关 | 模型 |
|------|---------|------|
| qwenwork | `gateway.qwenwork.cn` | Standard / Pro / Qwen3.8-Max |
| qoder | `api3.qoder.sh` | Qwen3.8-Flash / DeepSeek-Flash |

## 这是什么？
- 定位：xrl-router 的 qwenwork / qoder 通道插件，纯翻译层
- 解决的核心问题：把两个同协议族网关的 Cosy 签名体系桥接为标准 OpenAI Chat Completions API，让 Claude Code / Cursor 等客户端零改动接入

## 为什么存在？
- 背景 / 动机：国内 AI 网关协议壁垒高（RSA+AES+MD5 签名体系），普通 OpenAI 客户端无法直接调用；xrl-router 是统一 LLM 路由层，通过插件协议扩展对不同后端的支持
- qoder 与 qwenwork 共用推理路径与签名链，仅 host、`business.product`、`agent_id` 和账号体系不同，因此复用同一套转发核心

## 如何安装和运行？
- 前置要求：Node.js ≥ 20、pnpm、xrl-router 运行在 `http://localhost:19068`
- 安装步骤：`pnpm install`
- qwenwork：`pnpm log-in`（网页扫码获取凭据）→ `pnpm serve`（端口 19067）
- qoder：登录 Qoder App → `pnpm serve:qoder`（端口 19070；插件**只读** `auth.v1.dat`，不刷新、不写回）

## 当前状态
- 阶段：开发中
- 已知限制：qwenwork access token ~1h 过期（自动刷新）、refresh token 有服务端绝对过期时间（<24h 告警提示重登）；qoder 凭据完全交给 Qoder App 维护（插件只读，过期需打开 App 刷新）；无自动化测试

## 核心技术
- 语言 / 框架 / 关键依赖：TypeScript 5 · Hono 4 · ws 8 · tsx 4 · pnpm
- 签名算法：AES-128-CBC + RSA_PKCS1 + MD5（逆向自 asar，两个通道共用）
- OAuth：qwenwork 走 deviceToken/refresh 轮换 + PKCE device-flow 网页登录；qoder 只读 App 的 `auth.v1.dat`

## 验证

```bash
curl http://localhost:19067/health
# → {"status":"healthy","backend":"qwenwork","plugin_mode":true,"base_url":"https://gateway.qwenwork.cn"}

curl http://localhost:19070/health
# → {"status":"healthy","backend":"qoder","plugin_mode":true,"base_url":"https://api3.qoder.sh"}
```

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Non Goals
- [docs/PRD.md](./docs/PRD.md) — 功能需求与存在的意义
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、协议、模块设计
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策的历史原因
- [docs/researches/qwenwork-desktop-reverse.md](./docs/researches/qwenwork-desktop-reverse.md) — 千问办公桌面 App 逆向分析
- [docs/specs/](./docs/specs/) — 核心功能规格文档
