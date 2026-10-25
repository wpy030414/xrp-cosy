# DECISIONS — 设计决策记录

> 本文件记录项目关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

版本：0.8.0 | 最后更新：2026-10-25

---

## D-1: 为什么从独立 Anthropic 代理重构为 xrl-router 插件？

**背景**：旧架构包含 `adapter.ts`（Anthropic ↔ OpenAI 格式翻译）和 `deapClient.ts`（DEAP 协议头构造），作为独立的 Anthropic Messages API 代理运行。

**问题**：
- 密钥管理与 xrl-router 重复，两套 key pool 同步困难喵～
- Anthropic `tools` / `tool_use` 格式翻译复杂且易出错，边界情况多
- 无法复用 xrl-router 已有的重试、限流、分发逻辑

**决策**：纯协议桥接插件。插件只做 OpenAI → 网关协议的转换，密钥管理、重试策略、请求分发全部交给 xrl-router 处理喵。

**证据**：commit `63eb217` 删除了 `adapter.ts`、`deapClient.ts`、`types.ts`、`search.ts`，仅保留协议桥接层喵～

---

## D-3: 为什么 serve 现在自行管理 token 而非只消费密钥池？

**背景**：最初设计是 `capture-key` 负责提取 refresh token 写入 `.env`，serve 只从 `Authorization` 头消费 xrl-router 下发的 token。每请求都 refresh 一次。

**问题**：
- 每请求 refresh → refresh token 轮换互踩 → 不到 1 小时就断链，需频繁重新登录
- 插件和千问 App 同时持有 refresh token，各自刷新会导致对方的 token 失效

**决策**：serve 自行管理 token 生命周期（`getToken()` 缓存 + 按需刷新 + auth-v2.dat 文件监听）。

**收益**：
- **按需刷新**：5 分钟缓冲期内零网络请求，平均 1 小时才刷新 1 次（之前每请求都刷）
- **双向同步**：refresh 后写回 auth-v2.dat，千问 App 下次读取时拿到新 token，不互踩
- **文件监听**：千问 App 自己刷新时，插件自动拾取新值，只要 App 在后台就几乎不用重新登录

**证据**：`src/auth.ts`（`getToken()` / `startAuthFileWatch()` / `encryptAuthFile()`）、`src/client.ts`（`forwardChatCompletions` 改用 `getToken()`）

---

## D-4: 为什么心跳 30s？

**背景**：插件通过 WebSocket 心跳维持与 xrl-router 的连接喵～

**决策**：`HEARTBEAT_INTERVAL_MS = 30000`。

**原因**：
- WebSocket 最佳实践，避免中间件空闲断连（典型超时 60s）
- V24 契约要求每 30s 心跳，Router 端 90s 无心跳标记离线

**证据**：`src/pluginClient.ts`

---

## D-5: 为什么 qwenwork 用 RSA_PKCS1 而不是 RSA_OAEP？

**背景**：qwenwork 通道需要用公钥加密 cosyKey 参数喵～

**决策**：使用 `RSA_PKCS1_PADDING` 而非 `RSA_OAEP_PADDING`。

**原因**：逆向工程发现 asar 代码中显式使用 PKCS1_PADDING。实验验证：OAEP 返回 `101 Signature invalid`，PKCS1 返回 HTTP 200喵。

**证据**：`src/signer.ts`（`crypto.constants.RSA_PKCS1_PADDING`，注释标注「PKCS1 非 OAEP」）

---

## D-7: 为什么 qwenwork 非流式需要聚合 chunk？

**背景**：qwenwork 网关无论 `stream` 参数如何，始终返回 SSE 流喵～

**决策**：当客户端请求非流式模式时，插件在本地聚合所有 chunk，返回完整的 JSON 响应。

**原因**：
- OpenAI 客户端在非流式模式下期望收到完整的 JSON 对象
- 插件需要聚合 `delta.content` + `delta.reasoning_content` + `delta.tool_calls` 等字段

**证据**：`src/client.ts`（chunk 聚合逻辑）

---

## D-8: 为什么现在写回 auth-v2.dat？（推翻旧决策 → 已被 D-16 再次推翻）

**旧决策（已废弃）**：插件绝不写回 `auth-v2.dat`，只写 `.env QWEN_KEYS`。

**旧原因**：担心外部写入会污染千问 App 的登录态。

**问题**：
- refresh token 采用轮换（rotation）策略，每次刷新产生新 token 并作废旧 token
- 插件刷新后 `.env` 拿到新 token，但 `auth-v2.dat` 里的旧 token 已失效
- 千问 App 下次用旧 token 刷新 → 链断 → 用户被迫重新登录
- 实际测试：千问 App 不做文件完整性校验，写回加密格式正确即可

**决策**：refresh 成功后用 `encryptAuthFile()` 写回 `auth-v2.dat`（与解密完全对称的加密方式）。

> ⚠️ **本决策已于 2026-10-20 被 D-16 推翻**：取消千问办公 App 支持后，插件不再读写 `auth-v2.dat`，写回分支与 `encryptAuthFile()` 一并删除。以下保留原文供历史参考。

**收益**：
- 插件和千问 App 持有相同的 refresh token，不再轮换互踩
- 只要 App 保持后台运行，token 链可以持续续命

**证据**：`src/auth.ts`（`encryptAuthFile()`、`refreshDeviceToken()` 写回逻辑）

---

## D-9: 为什么移除模型别名映射并精简默认模型列表？

**背景**：早期 `qwenwork/client.ts` 维护了 `MODEL_ALIASES`（`glm-5.2` → `qwork-advanced`）和 `resolveModel()`，`config.ts` 的默认 `AVAILABLE_MODELS` 包含 `claude-opus-4-8,gpt-4o`，注册消息中按 model_id 含 `opus` 判断 `tier`。

**问题**：
- qwenwork 通道实际上只有 `qwork-advanced` 一个可用模型，别名映射让客户端误以为可以发 `glm-5.2` 请求
- `claude-opus-4-8` 和 `gpt-4o` 从未在 qwenwork 通道真正可用，默认列出会误导用户
- `tier` 按 `opus` 关键字判断是脆弱的启发式逻辑

**决策**：
- 删除 `MODEL_ALIASES` 和 `resolveModel()`：客户端发什么 model 就透传什么，缺省默认 `qwork-advanced`
- `tier` 统一硬编码为 `'custom'`

**收益**：消除多模型假象，减少用户配置错误；插件注册信息与实际能力一致喵。

**证据**：`src/config.ts`（默认值）、`src/pluginClient.ts`（`tier: 'custom'`）、`src/client.ts`（无 MODEL_ALIASES）

---

## D-11: 为什么 qwenwork 重新引入多模型列表？（部分推翻 D-9）

**背景**：D-9 决策将 qwenwork 默认模型精简为仅 `qwork-advanced`，认为只有一个可用模型喵～

**问题**：
- 实际上 qwenwork 网关已支持多个模型：`qwork-auto`（Qwen3.7-plus）、`qwork-lite`（DeepSeek-V4-flash）、`qmodel_latest`（Qwen3.8-max）
- 只暴露一个模型限制了用户选择

**决策**：重新扩展默认模型列表为 4 个，同时保留 `DISPLAY_NAMES` 映射给 xrl-router 展示用。

**收益**：用户可以通过 xrl-router 选择不同的模型，灵活性更高喵。

**证据**：`src/config.ts`（默认模型列表）、`src/client.ts`（DISPLAY_NAMES）

---

## D-12: 为什么 serve 去掉了 tsx watch？

**背景**：`pnpm serve` 原先用 `tsx watch` 自动监听文件变更重启喵～

**问题**：
- `auth-v2.dat` 文件监听（`fs.watch`）已经覆盖了 token 自动拾取需求
- `tsx watch` 监听整个 `src/` 目录，开发时频繁重启反而干扰调试
- watch 模式的进程管理与 `fs.watch` 的 watcher 生命周期可能冲突

**决策**：`serve` 改为 `tsx`（无 watch），文件变更需手动重启。

**证据**：`package.json` scripts 字段

---

## D-14: 为什么迁移到 V24 契约 + Hono + 废除 wukong？

**背景**：xrl-router 插件系统升级到 V24 契约，要求：
1. register 不带 `keys` 字段（Router 不再为插件管理密钥，凭证由插件方自持）
2. 不发 `keys_update` 消息
3. `provider.kind` 改为 `chat_completions`
4. 心跳不带 timestamp
5. HTTP 框架必须用 Hono
6. register 带 `workdir`（Router 伴生启动 cwd）

同时 wukong 通道（钉钉悟空 DEAP）实际使用频率低，且密钥管理复杂（~29天过期、MITM 抓包、daemon 依赖），维护成本高。

**决策**：
- 废除所有 keys 相关逻辑（env 轮询、`loadCurrentKeys`、`keys_update` 推送）
- Express → Hono（`@hono/node-server`）
- 完全移除 wukong 通道（源码、脚本、文档）
- `plugin_id` 改为 `plugin-qwenwork`（符合 V24 命名约定）
- `provider.kind` 改为 `chat_completions`
- 新增 `log-in` 脚本（网页 device-flow 登录 + App 链路诊断）→ 保留原有 `capture-key` 逻辑

**收益**：
- 对齐 Router V24 契约，避免 register 被拒绝
- 代码量减少 ~40%（移除 wukong 双通道逻辑、channel 分发、env 轮询）
- 单通道简化，降低维护负担
- Hono 更轻量，SSE 处理更灵活

**证据**：
- `src/pluginClient.ts`（无 keys、无 env 轮询）
- `src/index.ts`（Hono，无 channel 分发）
- `src/config.ts`（无 deap 配置、无 Channel 类型）
- `package.json`（无 express/cors，有 hono/@hono/node-server，有 login 脚本）
- 删除文件：`src/channel.ts`、`src/wukong/`、`scripts/wukong/`、相关 docs

---

## D-15: 为什么企业积分靠 switch-team 派生，而不是在登录 URL 上选企业版？

**背景**：训练员反馈「网页登录后烧的是个人版积分，不是企业版」。网页登录页（`/biz/signin`）确实有企业/个人可选，
官方 CLI 也确实拿到过企业身份（`~/.qwenworkcn/.status.json`：`user_type=enterprise`、`plan=企业基础版`）。

**问题**：
- 设备流铸出的 access token **恒为个人身份**：`is_biz=false`、`sub=e549d75e-…`（c_site），而企业身份体是**另一个 user_id**（`f644d61f-…`）——不是同一账号加标签，是两套账号体
- 曾假设「登录 URL 带 `space=org&corpId` 即可」，**被实验否证**：`selectAccounts` 的 query 与 `redirect_uri` 都是白名单精确校验，多带任何参数（space/type/org_id/corpId/target/login_hint…）一律 `400 INVALID_DEVICE_FLOW`，实测 15 个候选参数全军覆没
- 网页 SPA 的 `space`/`corpId`（bundle：`pte()`/`mq()`/`CGt()`）只作用于**网页会话自身**，不回流到设备流凭据；且产品内置「企业无席位 → 自动切回个人」（埋点 `qwenwork_enterprise_no_seat_guide.auto_switch_personal_triggered`）
- `QWEN_TARGET` 换不掉身份：实测 `target` 仅 `c` 合法，`b`/`org`/`e` 一律 `400 INVALID_REFRESH_REQUEST`

**决策**：企业身份作为**派生凭据**，而非登录期凭据——用设备流根凭据（恒 c_site）调
`POST {qwenWebBase}/biz/user/v1/auth/switch-team`（body 需 `team_id`），从响应的 `Set-Cookie: token=<JWT>`
取回企业 JWT（`aud=biz`、`biz_org_id`、约 15 天有效），直接充当 cosy 签名链的 `security_oauth_token`，
并把 `Cosy-User`/`info.uid` 换成企业身份体的 `sub`。配置项 `QWEN_IDENTITY=personal|biz`（默认 personal）。

**关键取舍**：
- **个人版是合法选择，不禁止**：默认 personal 直接走根凭据，行为与历史完全一致；只有 `biz` 才派生企业凭据
- **绝不静默降级**：`biz` 模式下铸造失败一律抛错并禁掉 `fallbackAuth`（否则「以为在烧企业、实际在烧个人」——正是本次事故本身）
- **不发 `Cosy-Organization-Id` 头**：消融矩阵实测 biz token 不带该头才走对模型池（带上的 B2 退化为空 delta）；身份完全由 JWT 承载
- **缓存按根凭据 sub 分键**：换账号（重跑 log-in）自动重铸，避免把 A 的企业身份用到 B 上

**证据**（2026-10-20 端到端实测，双池余额对比为硬判据）：

| 模式 | 个人池 Δ | 企业池 Δ | 结果 |
|---|---|---|---|
| `QWEN_IDENTITY=biz` | **0** | **-0.002** | HTTP 200 正常回复 |
| `QWEN_IDENTITY=personal` | -0.0017 | **0** | 与上行构成双向对照 |
| `biz` + 不存在 team_id | **0** | — | HTTP 401 明确报错，未降级 |

**实现**：`src/bizIdentity.ts`（mint/getBizToken/fetchBalance）· `src/client.ts`（`getSigningToken`）·
`scripts/log-in.ts`（`--identity biz [--team-id]` / `--list-orgs` / `--status`）

## D-16: 为什么取消千问办公 App 支持？

**背景**：插件的凭据链曾有三个源：内存缓存 → **App 的 `auth-v2.dat`（Electron safeStorage 解密）** → `.env QWEN_KEYS`。
自 D-15 的网页 device-flow 登录（`pnpm log-in`）打通后，第一个 refresh token 已不再需要 App 产出。

**问题**：
- App 支路是**只为兜底而存在的复杂度**：解密（Keychain/PBKDF2/AES-CBC、Windows DPAPI/AES-GCM）+ 加密写回 + `fs.watch` 文件监听三套机制，
  占 `auth.ts` 近半代码，却只服务「本机恰好装着 App」这一种部署形态
- 与 App 双向同步（D-8）本质是**在两个持有同一轮换式 refresh token 的程序之间协调**：写回格式一旦与新版 App 不一致就污染对方登录态，
  风险随 App 升级持续存在，收益只是省一次扫码
- macOS 首次访问 Keychain 会弹系统授权框，Windows 依赖 powershell.exe + DPAPI，跨平台故障面与排查成本高（`auth-v2.dat 解密失败`/`文件头不是 v10` 一类）
- 扣费身份（D-15）要求凭据来源可解释、可复现：混入 App 解出的凭据后，「当前烧哪个池」的诊断会多一个不可控变量

**决策**：删除千问办公 App 链路，凭据来源收敛为**两源**（内存缓存 → `.env QWEN_KEYS`），两者都由 `pnpm log-in` 网页 device-flow 产出：
- `src/auth.ts`：删除 `decryptAuthFile()` / `encryptAuthFile()` / `startAuthFileWatch()` / `initTokenManager()` 与 `QwenTokenState.raw`
- `src/safeStorage.ts`：删除 `encryptSafeStorageJson()`（写回能力随 App 一起消失），模块收窄为**仅 qoder 通道只读解密**

> ⚠️ **后续**：`src/safeStorage.ts` 已随 D-17（qoder 改为自包含网页登录）整体删除，仓库不再包含任何 Electron safeStorage 解密代码。
- `src/config.ts`：删除 `qwenOauthTokenPath` / `qwenUserDataDir` / `qwenKeychainService` / `qwenKeychainAccount` 及对应 4 个环境变量
- 删除 `scripts/log-in-app.ts`（`pnpm log-in:app`）与 `docs/specs/capture-key-qwenwork.md`
- `QWEN_IDENTITY=biz` 的诊断/派生链不受影响：派生始终用设备流根凭据

**代价（已知取舍）**：`.env QWEN_KEYS` 丢失或全部作废时，只能重新扫码恢复，没有 App 兜底；跨机器部署靠拷 `.env`。

**证据**：删除后 `pnpm exec tsc` 全绿（src + scripts），`pnpm log-in --status` 走 QWEN_KEYS 自举成功（根凭据 + 双池余额可读），
`pnpm serve` 在无 App 的机器上正常启动并注册；本机 `auth-v2.dat` 本就不存在，此前一直是「缺文件 → 静默跳到下一源」路径，功能等价。

---

---

## D-17: 为什么更名 xrp-cosy，并让 qoder 也改成自包含网页登录？

**背景**：项目家族统一为 `xrp-*` 命名，本仓库定位为 **Cosy 协议族**（qwenwork / qoder 共用签名链）的双通道插件，远程仓库已更名为 `xrp-cosy`。与此同时，产品边界收敛为一条硬约束：**仅支持自包含网页 OAuth 登录**。

**问题**：
- D-16 之后 qwenwork 已无 App 依赖，但 qoder 仍是唯一例外：只读 `auth.v1.dat`（Electron safeStorage 解密），refresh token 轮换权归 Qoder App
- 这条支路把「能否部署」绑定在「本机是否装着 Qoder App 并已登录」，且需要 Keychain/DPAPI 解密、文件监听等一整套平台相关机制
- 与「仅自包含网页 OAuth」直接冲突，也让两条通道的凭据模型不对称（一个自持轮换、一个只读寄生）

**可行性验证**（2026-10-25，在线探活 + 公开逆向资料交叉验证）：
- 国际区设备授权入口：`https://qoder.com/device/selectAccounts?challenge&challenge_method=S256&nonce&client_id&machine_id`
  → 实测 HTTP 302 跳转 `qoder.com/users/sign-in?oauth_callback=…`（登录页托管，插件不经手口令）
- 换票轮询：`GET https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`
  → 未知 nonce 实测 HTTP 404 `{"errorCode":"NotFound"}`（等待授权语义）
- 刷新：`POST https://openapi.qoder.sh/api/v1/deviceToken/refresh`（`drt-` refresh token，轮换式）
- 常量与参数差异（国际版）：`client_id=e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`、nonce 为 32-hex、**不传** redirect_uri
- 交叉来源：`shuishuipingan/qoder2api-hub`（双区常量表、PKCE、poll/refresh）、`lidge-jun/opencodex`（Qoder CN OAuth provider）、`Liki4/qodercli2api`（PKCE / deviceToken / jobToken 逆向记录）

**决策**：
1. 项目更名 `xrp-cosy`（`package.json` / README / AGENTS / docs）；xrl-router 的 `plugin_id` 保持 `plugin-qwenwork` / `plugin-qoder`，避免破坏既有 Router 配置
2. qoder 登录改为自包含网页设备授权：`src/qoderDeviceLogin.ts`（PKCE S256 + nonce + machineId + poll + userinfo）
3. `src/qoderAuth.ts` 从「只读拾取」重写为「自持轮换」：两源 fallback（内存缓存 → `.env QODER_KEYS`），刷新后轮换值同步 `.env`
4. `scripts/log-in-qoder.ts` 从「只读诊断」改为真实登录入口（`--status` 保留为只读诊断）
5. 删除 `src/safeStorage.ts`，仓库不再包含任何 Electron safeStorage 解密代码；不读取、不写回 `auth.v1.dat`
6. 新增 `src/openBrowser.ts`，把两通道共用的「打开系统浏览器」从 `deviceLogin.ts` 下沉

**代价（已知取舍）**：
- 失去 App 兜底：`.env QODER_KEYS` 丢失或 refresh token 全部作废时，只能重新走网页登录
- refresh token 轮换权收归插件：同一份 `.env` 不应被多个插件实例并发使用（与 qwenwork 相同的单进程假设）
- 官方设备授权端点若变更，需要同步更新 `QODER_*` 配置；参数已全部环境变量化以便快速改道

**证据**：`pnpm typecheck` 全绿（src + scripts）；`pnpm log-in:qoder --no-browser` 实测可生成授权 URL 并持续轮询（未授权时保持 pending）；`openapi.qoder.sh` 未知 nonce 返回 404 NotFound。

---

## 已废弃的决策（历史参考）

以下决策涉及已移除的 wukong 通道，仅供历史参考：

- ~~**D-2**~~：wukong 流式直接透传字节流（wukong 通道已移除）
- ~~**D-6**~~：DEAP 流式不能带 Accept: text/event-stream（wukong 通道已移除）
- ~~**D-10**~~：wukong 流式改为按行拆分 + 逐行 flush（wukong 通道已移除）
- ~~**D-13**~~：双通道不同默认端口 19067/19066（wukong 通道已移除）
