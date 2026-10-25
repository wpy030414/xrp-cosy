# xrp-cosy

> qwenwork / qoder 双通道的 xrl-router 插件 — **唯一登录方式为自包含网页 OAuth**（设备授权 + PKCE），把两个 Cosy 签名网关包装成 OpenAI Chat Completions 兼容的本地服务。

```
客户端 → xrl-router :19068 → 本插件（qwenwork / qoder 两个独立进程）→ 上游网关
         ↑ 协议转换、故障转移            ↑ 凭证自持、Cosy 签名、SSE 解包
```

| 通道 | 上游网关 | 登录入口 | 模型 |
|------|---------|---------|------|
| qwenwork | `gateway.qwenwork.cn` | `pnpm log-in` | Standard / Pro / Qwen3.8-Max |
| qoder | `api3.qoder.sh` | `pnpm log-in:qoder` | Qwen3.8-Flash / DeepSeek-Flash |

## 这是什么？

- xrl-router 的 Cosy 协议族插件，纯翻译层：只把 OpenAI Chat Completions 桥接到上游，不引入业务逻辑
- **自包含登录**：两条通道都走各自的官方设备授权流程（浏览器完成登录 → `deviceToken/poll` 轮询换票），本机**不需要安装千问办公 App / Qoder App**
- 凭据由插件自持并自行轮换，refresh token 只落在本仓库 `.env`（git-ignore + mode 600 守卫），不读写任何 App 文件
- 通过 WebSocket 向 xrl-router 注册（V24 契约，无 `keys`），由 Router 统一做鉴权、路由、密钥轮转

## 为什么存在？

- 国内 AI 网关协议壁垒高（RSA+AES+MD5 签名体系），普通 OpenAI 客户端无法直接调用；xrl-router 是统一 LLM 路由层，通过插件协议扩展对不同后端的支持
- qoder 与 qwenwork 共用推理路径与签名链，仅 host、`business.product`、`agent_id` 和账号体系不同，因此复用同一套转发核心
- 登录链路全部收敛为网页 OAuth：无本地回调监听、无 App 依赖、无 Electron 文件解密，「拷项目 → 浏览器登录 → serve」即可部署

## 如何安装和运行？

前置要求：Node.js ≥ 20、pnpm、xrl-router 运行在 `http://localhost:19068`

```bash
pnpm install

# qwenwork 通道（19067）
pnpm log-in                 # 浏览器完成设备授权，refresh token 写入 .env QWEN_KEYS
pnpm serve

# qoder 通道（19070）
pnpm log-in:qoder           # 浏览器完成设备授权，refresh token 写入 .env QODER_KEYS
pnpm serve:qoder
```

只读诊断：

```bash
pnpm log-in --status            # qwenwork：扣费身份 + 个人/企业双池余额
pnpm log-in --list-orgs         # qwenwork：列企业组织（取 --team-id）
pnpm log-in --identity biz      # qwenwork：切换企业积分扣费身份
pnpm log-in:qoder --status      # qoder：凭据是否可刷新 + 账号信息 + 有效期
pnpm typecheck                  # src + scripts 全量类型检查
```

## 当前状态

- 阶段：开发中
- 已知限制：
  - qwenwork access token ~1h 过期（自动刷新）；refresh token 有服务端绝对过期时间（<24h 告警提示重登）
  - qoder access token ~30 天、refresh token ~1 年（自动轮换，轮换值同步 `.env QODER_KEYS`）
  - 两条通道都不依赖官方 App；`.env` 丢失或 refresh token 全部作废时，只能重新走网页登录
  - 无自动化测试（纯翻译层）

## 核心技术

- 语言 / 框架 / 关键依赖：TypeScript 5 · Hono 4 · ws 8 · tsx 4 · pnpm
- 签名算法：AES-128-CBC + RSA_PKCS1 + MD5（逆向自官方客户端，两个通道共用）
- 登录：设备授权 + PKCE S256 + `deviceToken/poll` 轮询 + `deviceToken/refresh` 轮换
  - qwenwork：`gateway.qwenwork.cn/device/selectAccounts` → `deviceToken/poll`
  - qoder：`qoder.com/device/selectAccounts` → `openapi.qoder.sh/api/v1/deviceToken/poll`

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
- [docs/specs/qwenwork-device-login.md](./docs/specs/qwenwork-device-login.md) — qwenwork 网页登录规格
- [docs/specs/qoder-device-login.md](./docs/specs/qoder-device-login.md) — qoder 网页登录规格
- [docs/researches/](./docs/researches/) — 逆向分析原始记录
