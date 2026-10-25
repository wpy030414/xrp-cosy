# Qoder 国际区设备授权登录：逆向与探活记录

> 日期：2026-10-25
> 目标：为 xrp-cosy 的 qoder 通道提供「自包含网页 OAuth 登录」，彻底移除 Qoder App 依赖（D-17）。

## 1. 范围

本记录只覆盖**国际区**（推理 `api3.qoder.sh`）的设备授权/刷新链路，不涉及国际版与国内版的业务差异，也不记录任何真实凭据。

## 2. 公开资料交叉验证

| 来源 | 用途 |
|------|------|
| `shuishuipingan/qoder2api-hub` | 双区常量表（`REALM_CONFIGS`）：openapi / website / client_id / nonce 形态 / 是否传 redirect_uri；`deviceToken/poll`、`deviceToken/refresh` |
| `lidge-jun/opencodex`（commit e246cc9） | Qoder CN OAuth provider：PKCE 生成、poll 容错（404 视为 pending）、token 字段映射 |
| `Liki4/qodercli2api` | PKCE / deviceToken / jobToken 协议逆向记录（README 引用） |
| 本机 `~/.qoder-cn/.cache/endpoint-cache.json` | 官方 CLI 的端点缓存，确认 openapi/gateway 域名分离 |

国际区常量（与上表一致）：

| 常量 | 值 |
|------|-----|
| `openapi` | `https://openapi.qoder.sh` |
| `website` | `https://qoder.com` |
| `client_id` | `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` |
| `nonce` 形态 | `uuid4().hex`（32 位 hex，无横线） |
| `redirect_uri` | 不传 |
| 推理网关 | `https://api3.qoder.sh`（`api2` / `api1` 为故障切换） |
| access token | `dt-` 前缀，约 30 天 |
| refresh token | `drt-` 前缀，约 1 年，每次刷新轮换 |

## 3. 在线探活（2026-10-25）

### 3.1 授权页

```bash
curl -sS -D - "https://qoder.com/device/selectAccounts?challenge=<S256>&challenge_method=S256&nonce=<32hex>&client_id=e883…&machine_id=<uuid>"
```

结果：`HTTP/1.1 302 Found` → `location: https://qoder.com/users/sign-in?oauth_callback=…&directLogin=true`。
说明参数形态被接受；服务端把 `directLogin=true` 注入回跳 URL。

### 3.2 轮询（未知 nonce）

```bash
curl -sS "https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=<32hex>&verifier=<64chars>&challenge_method=S256" \
  -H "Accept: application/json" -H "User-Agent: QoderWork/1.1.75"
```

结果：`HTTP 404` + `{"errorCode":"NotFound","errorMessage":"Not found","requestId":"…"}`。
因此轮询实现把 `404` / `202` 视为「等待授权」。

### 3.3 本机残留 CLI

本机 `~/.qoder-cn` 存在官方 CLI 的配置与日志（`logs/runs/*/qodercli.log`），其中可见：

- `[auth] Login method: none (no credentials found)`（未登录）
- `https://openapi.qoder.com.cn/api/v1/userinfo`、`https://openapi.qoder.com.cn/api/v1/jobToken/exchange`（国内区）
- 端点缓存：`gateway.qoder.com.cn` / `openapi.qoder.com.cn`（国内区）

这些记录用于确认端点命名与鉴权形态（Bearer + 设备流），未提取任何凭据。

## 4. 结论与实现落点

- qoder 国际区具备完整的「PKCE 设备授权 + 轮询换票 + refresh 轮换」链路，可完全脱离 Qoder App
- 实现：`src/qoderDeviceLogin.ts`（登录）、`src/qoderAuth.ts`（刷新/两源回退）、`scripts/log-in-qoder.ts`（入口）
- 规格：[docs/specs/qoder-device-login.md](../specs/qoder-device-login.md)
- 决策：[docs/DECISIONS.md](../DECISIONS.md) D-17

## 5. 尚未实证的点

| 问题 | 现状 | 处理 |
|------|------|------|
| poll 成功响应是否回显 `nonce` / `code_challenge` | 未登录，无法触发成功响应 | 实现为「返回则校验，缺失则接受」 |
| `expires_in` 的确切单位 | 公开实现对国际区记录为毫秒 | 按毫秒解析，`≥1e8` 阈值兜底；`expires_at` 优先 |
| refresh 响应是否包含 `refresh_token_expires_at` | 未实证 | 缺失时不猜测 |
| `userinfo` 字段全集 | 公开实现使用 `id` / `name` / `user_type` / `organization_*` | best-effort 解析，失败不影响凭据落盘 |
