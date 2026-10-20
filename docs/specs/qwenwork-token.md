# qwenwork-token: OAuth Token 生命周期管理

## 目标

管理 `pnpm log-in`（网页 device-flow）产出的 OAuth token 的缓存、自动刷新与灾备，为签名模块提供有效的 access token + refresh token。**千问办公 App 支持已取消**（2026-10-20，见 `docs/DECISIONS.md` D-16）：本模块不读取也不写回任何 App 文件，凭据完全自持喵～

## 输入输出

**输入：**
- `getToken()`：无参，返回当前有效 `QwenTokenState`（缓存 + 按需刷新）
- `refreshDeviceToken(refreshToken)`：接受 `ory_rt_` 前缀的 refresh token，返回新 `QwenTokenState`
- `forceRefresh()`：无参，强制刷新一次（`pnpm log-in` 用于验证刷新链）
- `adoptCredential(state)`：把扫码登录得到的凭据写入内存缓存

**输出：**
- `QwenTokenState`：`{ token, refreshToken, user: { uid, name, email }, expiresAt, refreshTokenExpiresAt? }`
  （已无 `raw` 字段——它曾是「写回 App 登录态时保留千问内部字段」的载体）

## 关键约束

### Token 缓存策略（两源）

```
  getToken() 调用
      │
  cached 存在且 expiresAt > now + 5min？
      │ 是 → 直接返回，零网络请求
      │ 否 ↓
  ① cached.refreshToken → refreshDeviceToken()
      │ 失败 ↓
  ② .env QWEN_KEYS → refreshDeviceToken()
      │ 失败 ↓
  throw Error('无可用 token 源（refresh token 均已失效，请运行 pnpm log-in 网页登录）')
```

缓存检查：`Date.now() < expiresAt - 5 * 60_000`（提前 5 分钟刷新）。并发防重：`refreshing` Promise 单飞。

### deviceToken/refresh API

- **URL**：`{qwenBaseUrl}{qwenDeviceRefreshPath}`（默认 `https://gateway.qwenwork.cn/api/v1/deviceToken/refresh`）
- **Body**：`{ "refresh_token": "<ory_rt_...>", "target": "c" }`（`target` 实测仅 `c` 合法，且与扣费身份无关）
- **响应**：`{ device_token, refresh_token（轮换后的新值）, expires_at }`
- **字段兼容**：`j.device_token ?? j.token`
- **过期时间**：`expires_at` 为 ISO 字符串 → `Date.parse()`；缺失则 `Date.now() + 3600_000`
- **刷新后唯一持久化动作**：`syncEnvRefreshToken()` → `.env QWEN_KEYS`
  （不再写回 `auth-v2.dat`；插件与外部程序的冲突面归零）

### syncEnvRefreshToken

把轮换后的新 refresh token 落到 `.env` 的 `QWEN_KEYS` 行。refresh token 是**轮换式**的（新值作废旧值），所以这一步是凭据能跨进程续命的关键：重启 serve / 换机器部署时都能从 `.env` 自举，不必重新扫码。

### 单飞防并发

- `refreshing` promise 变量：有正在刷新的则直接返回该 promise
- `.finally(() => { refreshing = null })` 确保清理

### forceRefresh

- 先 `getToken()` 获取当前 state → 用其 `refreshToken` 刷新 → 更新缓存
- `pnpm log-in` 用它验证「新铸的凭据刷新链真的通」，验证失败仍备份原始值并告警

### 与扣费身份的关系

本模块只管**根凭据**（设备流铸出，恒 c_site / 个人身份）。扣费身份为 `biz` 时，签名侧另有
`src/bizIdentity.ts` 用根凭据派生企业 JWT（见 `docs/specs/qwenwork-device-login.md` §7、`DECISIONS.md` D-15）。
两条链独立：根凭据刷新不影响已派生的企业凭据，反之亦然。

### safeStorage 格式参考（本通道已不使用）

千问办公 / Qoder 的登录态文件都是 Electron safeStorage（`v10` 头），本仓库仍需在 **qoder 通道只读解密** `auth.v1.dat`：

- **通用**：前 3 字节必须是 `v10`（自动剥离 UTF-8 BOM 容错）
- **macOS**：Keychain 取密码（`security find-generic-password`，去尾换行）→ `PBKDF2(pw, "saltysalt", 1003, 16, sha1)` → `AES-128-CBC(IV=0x20×16)`
- **Windows**：`Local State` 的 `os_crypt.encrypted_key` → base64 → 去 `DPAPI\0` 前缀 → PowerShell `ProtectedData.Unprotect`（entropy=NULL，CurrentUser）→ 32B AES key → `AES-256-GCM`（`v10` 后 = 12B nonce + 密文 + 16B tag）

实现位于共享模块 `src/safeStorage.ts`。**加密（写回）能力已随 App 支持移除**，该模块现在只导出解密函数。

## 验收标准

- [ ] 首次调用 `getToken()`，`.env QWEN_KEYS` 有值 → 自举刷新返回
- [ ] access token 剩余 > 5 分钟 → 直接返回缓存，零网络请求
- [ ] access token 临近过期（< 5min 缓冲）→ 自动用 refresh token 刷新
- [ ] refresh 成功后 `.env QWEN_KEYS` 已更新为轮换后的新值
- [ ] refresh 成功**不写任何 App 文件**（`auth-v2.dat` 不存在也能全链路运行）
- [ ] 并发调用 `getToken()` → 只触发一次网络刷新（单飞）
- [ ] `forceRefresh()` 返回新的 token + 新的 refresh token（已轮换）
- [ ] 两源均失效 → 抛错文案指向 `pnpm log-in`（不再提 App 登录）
- [ ] `refresh_token_expires_at` 距今 < 24h → 打印告警提示重登

## 已知边界

- **无 App 兜底**：取消 App 支持后，`.env QWEN_KEYS` 丢失（或全被服务端作废）只能靠重新扫码登录恢复
- `.env` 不存在时 `loadRefreshTokenFromEnv` 返回 null（不报错）
- `syncEnvRefreshToken` 失败只 `console.warn`，不抛异常（不影响主流程）
- `cached.user` 在自举刷新时为空 `{ uid: '' }`（`.env` 无用户信息），后续从 JWT 解出
- refresh token 服务端有绝对过期时间（实测约数十天），到期须重跑 `pnpm log-in`
- Windows 上 `.env` 的 mode 600 为尽力语义（NTFS 无完整 POSIX 位）
