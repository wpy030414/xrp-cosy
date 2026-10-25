# qoder-device-login: 网页设备授权登录（无 App 自举）

## 目标

不依赖 Qoder App，通过「浏览器完成登录 + 本地轮询」的设备授权流程直接获取第一份 qoder 凭据（access token + refresh token），写入 `.env QODER_KEYS` 后交由 [qoderAuth](../src/qoderAuth.ts) 的刷新链自动轮换。

**入口**：`pnpm log-in:qoder`（`scripts/log-in-qoder.ts`）——qoder 渠道唯一的凭据入口；`--status` 为只读诊断，`--no-browser` 只打印授权链接。Qoder App 链路已随 D-17 移除，插件不读取、不写回 `auth.v1.dat`。

## 协议来源

- 在线探活（2026-10-25）：`qoder.com/device/selectAccounts` 返回 302 → `qoder.com/users/sign-in?oauth_callback=…`；`openapi.qoder.sh/api/v1/deviceToken/poll` 对未知 nonce 返回 `404 {"errorCode":"NotFound"}`。
- 公开逆向资料交叉验证：
  - `shuishuipingan/qoder2api-hub` — 双区常量表（client_id / openapi / website / nonce 形态）、PKCE、poll/refresh
  - `lidge-jun/opencodex` — Qoder CN OAuth provider（PKCE + `deviceToken/poll` + `deviceToken/refresh`）
  - `Liki4/qodercli2api` — PKCE / deviceToken / jobToken 协议逆向记录

## 输入输出

**输入：**
- `buildQoderDeviceLoginParams(repoRoot?)`：生成 `{ verifier, challenge, nonce, machineId }`
- `buildQoderAuthUrl(handles)`：拼网页授权 URL
- `openInBrowser(url)`：best-effort 打开系统浏览器（`src/openBrowser.ts`）
- `pollQoderDeviceFlow(handles, opts?)`：轮询 poll 端点直到登录完成 / 超时
- `runQoderDeviceLogin(opts?)`：组合流

> 账号信息拉取在 `src/qoderAuth.ts` 的 `fetchQoderUserInfo()`（签名链需要 `user.uid`；uid 未知时刷新会自动补全）。

**输出：**
- `QoderDeviceCredential`：`{ token, refreshToken, expiresAt, refreshTokenExpiresAt?, nonce, challenge }`
- refresh token 为 `drt-` 前缀，进入 `qoderAuth.ts` 的 `deviceToken/refresh` 轮换链

## 关键约束

### 登录 URL（国际区）

```
{authBaseUrl}/device/selectAccounts           # 默认 https://qoder.com
  ?challenge=<base64url(sha256(verifier))>    # PKCE S256
  &challenge_method=S256
  &nonce=<32-hex>                             # 国际版 nonce = uuid4().hex（无横线）
  &client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
  &machine_id=<uuid>                          # .env QODER_MACHINE_ID 持久化
```

- **国际版不传 `redirect_uri`**（CN 版才带 `qoder-work-cn://`）；带错参数可能被服务端拒绝
- PKCE verifier：64 字符，字符集 `A-Za-z0-9-._~`（RFC 7636 unreserved），`crypto.randomInt` 取字符
- machineId：优先级 env `QODER_MACHINE_ID` > `.env QODER_MACHINE_ID` > 首次生成 UUID 并持久化
- 浏览器跳转链：`/device/selectAccounts` → 302 `qoder.com/users/sign-in?oauth_callback=…&directLogin=true` → 用户完成登录/扫码 → 服务端把凭据绑定到我们的 nonce/challenge

### 轮询 deviceToken/poll

```
GET {oauthBaseUrl}/api/v1/deviceToken/poll?nonce=..&verifier=..&challenge_method=S256
Headers: Accept: application/json
         User-Agent: QoderWork/1.1.75
         X-Request-Id: <randomUUID()>
```

**轮询语义**：

| 情形 | 处理 |
|------|------|
| `404`（`errorCode: NotFound`） | 尚未授权 → 间隔 1.5s 继续 |
| `202` | 尚未授权 → 继续 |
| `400` + `errorCode: NotFound` / `INVALID_DEVICE_FLOW` | 尚未授权 → 继续（兼容旧语义） |
| `400` 其他 errorCode | 协议错误 → 抛 `QoderDeviceFlowError` |
| 其他非 2xx | 抛 `QoderDeviceFlowError`（带 httpStatus） |
| 网络错误（含单请求 15s 超时） | 连续 ≥5 次才中止，成功响应后计数清零 |
| 2xx | 进入绑定校验 |

- 总超时：`QODER_LOGIN_TIMEOUT_MS`（默认 300s）
- **绑定校验（防串号）**：响应中**只要出现** `nonce` / `code_challenge` / `code_challenge_method`，就必须与本地逐字匹配（`S256`）；缺失时不猜、不拒绝（官方响应不保证回显）

**成功响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `token` / `device_token` | string | access token（`dt-` 前缀，~30 天） |
| `refresh_token` | string | `drt-` 刷新令牌（轮换式，必需） |
| `expires_in` | number | **毫秒**（官方实测；极小值按秒兜底） |
| `expires_at` | RFC3339 | 优先于 `expires_in` |
| `refresh_token_expires_at` / `_in` | string / number | refresh token 过期（可能缺失；缺失不猜测） |
| `nonce` / `code_challenge` / `code_challenge_method` | string | 若返回则必须校验 |

### 刷新 deviceToken/refresh

```
POST {oauthBaseUrl}/api/v1/deviceToken/refresh
Content-Type: application/json
{ "refresh_token": "drt-…" }

→ { device_token | token, refresh_token, expires_in(ms) | expires_at, … }
```

- 每次刷新都会轮换 refresh token，轮换值立即同步 `.env QODER_KEYS`
- 刷新失败不降级、不静默：`getQoderToken()` 两源均失败时抛错，提示重跑 `pnpm log-in:qoder`

### 登录脚本主流程（scripts/log-in-qoder.ts）

```
0. 打印配置（授权页 / 令牌 API / 推理网关 / client_id）
1. buildQoderDeviceLoginParams()   # 首跑持久化 QODER_MACHINE_ID
2. 打印 + 尽力打开浏览器            # --no-browser 可跳过；URL 恒打印兜底
3. pollQoderDeviceFlow()            # 每 10s 打印等待进度
4. fetchQoderUserInfo()             # best-effort，失败不影响落盘
5. adoptQoderCredential()
6. writeEnvValue('QODER_KEYS', 原始 refresh token)   # 先落盘，避免验证失败丢凭据
7. forceRefreshQoder()              # 验证刷新链；轮换值同步 .env
8. 打印脱敏 token / 有效期 / 账号；指路 pnpm serve:qoder
```

## 验收标准

- [ ] `pnpm log-in:qoder` → 浏览器打开 selectAccounts → 登录 → 打印脱敏 token + 有效期
- [ ] 成功后 `.env` 有 `QODER_KEYS`（轮换后值），且首跑出现 `QODER_MACHINE_ID`
- [ ] `.env` 写入前 `git check-ignore .env` 守卫生效（未忽略则中止）
- [ ] 不登录 → 超时后明确提示「N 秒内未完成登录，可重跑 pnpm log-in:qoder」
- [ ] poll 响应 nonce/challenge 不匹配 → 拒绝采纳并报错
- [ ] 登录后 `pnpm serve:qoder` 正常自举（QODER_KEYS 刷新成功）→ `/v1/chat/completions` 可用
- [ ] `pnpm log-in:qoder --status` 可读出凭据可刷新性、账号与有效期
- [ ] 仓库内不存在对 `auth.v1.dat` 的读取/解密/写回代码

## 已知边界

- **命令名**：`pnpm log-in:qoder`。旧版该命令只做只读诊断；D-17 起改为真实网页登录入口，只读诊断保留为 `--status`
- **Windows 开浏览器**：`cmd /c start` 中 `&` 是命令分隔符，URL 必须加引号并配合 `windowsVerbatimArguments`（见 `src/openBrowser.ts`）
- `expires_in` 单位取毫秒（官方实测）；若服务端改为秒，`parseDeviceExpiry` 的阈值兜底（≥1e8 视为毫秒）仍可工作
- refresh token 轮换权在插件：同一份 `.env` 不应被多个插件实例并发使用
- `--status` 走 `getQoderToken()`：凭据临近/已过期时会刷新并轮换 `.env QODER_KEYS`；避免与运行中的插件实例同时触发刷新
- `machine_id` 丢失（删 .env）→ 下次生成新 UUID，服务端视为新设备，无害
- 设备授权端点若变更，可通过 `QODER_OAUTH_BASE` / `QODER_AUTH_BASE` / `QODER_CLIENT_ID` / `QODER_DEVICE_*` 快速改道
