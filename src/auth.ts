/**
 * qwenwork/auth.ts — 千问办公 OAuth token 管理。
 *
 * 来源：对 QwenWorkCN 的逆向（docs/QWENWORKCN_REVERSE.md §6.8/§6.9 + Windows 实机验证）
 * - auth-v2.dat 是 Electron safeStorage 加密（v10 头）：
 *   · macOS：Keychain 取密码 → PBKDF2(1003, saltysalt) → AES-128-CBC(IV=0x20)
 *   · Windows：v10 + AES-256-GCM（12B nonce + 密文 + 16B tag）
 *     - 密钥：Local State 的 os_crypt.encrypted_key（"DPAPI\0" 前缀 + blob）
 *     - DPAPI 解包（entropy=NULL, CurrentUser）→ 32B AES key
 * - 刷新：POST {base}/api/v1/deviceToken/refresh，body {refresh_token, target}
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { settings } from './config';
import { decryptSafeStorageJson, encryptSafeStorageJson, type SafeStorageOptions } from './safeStorage';

export interface QwenUserInfo {
  uid: string;
  name?: string;
  email?: string;
}

export interface QwenTokenState {
  /** OAuth access token（JWT，~1h 有效，作为 encryptUserInfo 的 security_oauth_token） */
  token: string;
  /** ory_rt_ 刷新令牌（deviceToken/refresh 轮换） */
  refreshToken: string;
  user: QwenUserInfo;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  /** refresh token 过期时间（ms epoch，新版 refresh/poll 响应才返回；undefined = 服务端未告知） */
  refreshTokenExpiresAt?: number;
  /** 原始解密 JSON（写回时保留千问办公字段：loginDeviceId 等） */
  raw?: any;
}

/** qwenwork 的 safeStorage 参数（auth-v2.dat + Electron userData） */
function qwenSafeStorageOptions(): SafeStorageOptions {
  return {
    userDataDir: settings.qwenUserDataDir,
    keychainService: settings.qwenKeychainService,
    keychainAccount: settings.qwenKeychainAccount,
  };
}

/** 解密 auth-v2.dat（Electron safeStorage：macOS Keychain / Windows AES-256-GCM） */
function decryptAuthFile(filePath: string): QwenTokenState {
  const json = decryptSafeStorageJson(filePath, qwenSafeStorageOptions());
  if (typeof json.token !== 'string' || typeof json.refreshToken !== 'string') {
    throw new Error('auth.dat 缺少 token/refreshToken（未登录千问办公？）');
  }
  return {
    token: json.token,
    refreshToken: json.refreshToken,
    user: {
      uid: json.user?.id ?? '',
      name: json.user?.name,
      email: json.user?.email,
    },
    expiresAt: json.expiresAt ? Date.parse(json.expiresAt) : 0,
    raw: json,
  };
}

/** 加密 JSON → auth-v2.dat 格式（写回千问办公 App 登录态，复用已有 AES key） */
function encryptAuthFile(filePath: string, json: any): void {
  encryptSafeStorageJson(filePath, json, qwenSafeStorageOptions());
}

/** deviceToken/refresh：换取新 token + 轮换 refresh token + 写回 auth-v2.dat */
export async function refreshDeviceToken(refreshToken: string): Promise<QwenTokenState> {
  const url = `${settings.qwenBaseUrl}${settings.qwenDeviceRefreshPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, target: settings.qwenTarget }),
  });
  if (!res.ok) {
    throw new Error(`deviceToken/refresh 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json() as any;
  const token = j.device_token ?? j.token;
  const rt = j.refresh_token;
  if (typeof token !== 'string' || typeof rt !== 'string') {
    throw new Error('deviceToken/refresh 响应缺 device_token/refresh_token');
  }
  const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : Date.now() + 3600_000;
  const user = cached?.user ?? { uid: '' };
  // 新版 refresh 响应可携带 refresh token 绝对过期时间（缺失则沿用已知值）
  const rtExpiresAt =
    (typeof j.refresh_token_expires_at === 'string' && !Number.isNaN(Date.parse(j.refresh_token_expires_at))
      ? Date.parse(j.refresh_token_expires_at)
      : typeof j.refresh_token_expires_in === 'number'
        ? Date.now() + j.refresh_token_expires_in * 1000
        : undefined) ?? cached?.refreshTokenExpiresAt;
  if (rtExpiresAt && rtExpiresAt < Date.now() + 24 * 3600_000) {
    console.warn(`[qwenwork] refresh token 将于 ${new Date(rtExpiresAt).toISOString()} 过期（不足 24h），请重跑 pnpm log-in`);
  }

  // 写回 auth-v2.dat：让千问办公 App 也拿到新 refresh token，避免轮换互踩
  if (cached?.raw && fs.existsSync(settings.qwenOauthTokenPath)) {
    try {
      const updatedRaw = { ...cached.raw, token, refreshToken: rt, expiresAt: j.expires_at ?? cached.raw.expiresAt };
      encryptAuthFile(settings.qwenOauthTokenPath, updatedRaw);
      lastKnownMtime = fs.statSync(settings.qwenOauthTokenPath).mtimeMs;
      console.log('[qwenwork] 已写回 auth-v2.dat（千问 App 同步）');
    } catch (e: any) {
      console.warn(`[qwenwork] auth-v2.dat 写回失败（App 可能失步）: ${e.message}`);
    }
  }
  syncEnvRefreshToken(rt);
  return { token, refreshToken: rt, user, expiresAt, refreshTokenExpiresAt: rtExpiresAt, raw: cached?.raw };
}

/** 从 .env 读 QWEN_KEYS（capture-key 备份的 refresh token，可作自举源） */
function loadRefreshTokenFromEnv(): string | null {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    const v = parsed.QWEN_KEYS?.trim();
    return v || null;
  } catch { return null; }
}

/** 同步 .env 的 QWEN_KEYS（单元素密钥池自愈：pluginClient 轮询到新值会推送 xrl-router） */
function syncEnvRefreshToken(refreshToken: string): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));
    if (idx >= 0) lines[idx] = `QWEN_KEYS=${refreshToken}`;
    else lines.push(`QWEN_KEYS=${refreshToken}`);
    fs.writeFileSync(envPath, lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n', { mode: 0o600 });
  } catch (e: any) {
    console.warn(`[qwenwork] QWEN_KEYS 同步失败（不影响运行）: ${e.message}`);
  }
}

// —— token 缓存与自动刷新 ——
let cached: QwenTokenState | null = null;
let refreshing: Promise<QwenTokenState> | null = null;

// —— auth-v2.dat 文件监听（千问 App 刷新时自动拾取新 token） ——
let authWatcher: fs.FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
let lastKnownMtime = 0;

/** 启动 auth-v2.dat 监听（Windows fs.watch 同一文件可能重复触发，靠 debounce + mtime 去重） */
function startAuthFileWatch(): void {
  if (authWatcher || !fs.existsSync(settings.qwenOauthTokenPath)) return;
  try {
    lastKnownMtime = fs.statSync(settings.qwenOauthTokenPath).mtimeMs;
    authWatcher = fs.watch(settings.qwenOauthTokenPath, (_eventType) => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        try {
          const stat = fs.statSync(settings.qwenOauthTokenPath);
          if (stat.mtimeMs === lastKnownMtime) return; // mtime 未变 = 无实际写入
          lastKnownMtime = stat.mtimeMs;
          console.log('[qwenwork] auth-v2.dat 已更新（千问 App 刷新了 token），重新读取…');
          const fresh = decryptAuthFile(settings.qwenOauthTokenPath);
          cached = fresh;
          syncEnvRefreshToken(fresh.refreshToken);
          console.log(`[qwenwork] 已拾取新 token（有效期至 ${new Date(fresh.expiresAt).toISOString()}）`);
        } catch (e: any) {
          console.warn(`[qwenwork] auth-v2.dat 重读失败: ${e.message}`);
        }
      }, 1000);
    });
    authWatcher.on('error', (err) => {
      console.warn(`[qwenwork] auth-v2.dat 监听异常: ${err.message}，将重启监听`);
      authWatcher = null;
      setTimeout(startAuthFileWatch, 5000);
    });
    console.log(`[qwenwork] 已启动 auth-v2.dat 监听（${settings.qwenOauthTokenPath}）`);
  } catch (e: any) {
    console.warn(`[qwenwork] 启动 auth-v2.dat 监听失败: ${e.message}`);
  }
}

/** 获取当前有效 token（缓存 + 临近过期自动刷新，单飞防并发） */
export async function getToken(): Promise<QwenTokenState> {
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) {
    return cached;
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    // 源①：内存缓存里的 refresh token（有就刷新）
    if (cached?.refreshToken) {
      try {
        const next = await refreshDeviceToken(cached.refreshToken);
        next.user = cached.user;
        cached = next;
        console.log(`[qwenwork] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qwenwork] token 刷新失败（${e.message}），尝试从 auth-v2.dat 拾取…`);
        // 刷新链可能断了（App 那边也刷新过）→ 立刻重读文件试试
      }
    }
    // 源②：auth-v2.dat（App 登录态，优先持久源；监听器可能已更新 cached，但这里强制重读）
    if (fs.existsSync(settings.qwenOauthTokenPath)) {
      try {
        const fresh = decryptAuthFile(settings.qwenOauthTokenPath);
        // 如果文件里的 token 还有效（非过期）→ 直接用
        if (fresh.expiresAt > Date.now() + 5 * 60_000) {
          cached = fresh;
          console.log(`[qwenwork] 从 auth-v2.dat 拾取有效 token（有效期至 ${new Date(fresh.expiresAt).toISOString()}）`);
          return fresh;
        }
        // 文件里的也过期了 → 用它的 refresh token 刷新
        try {
          const next = await refreshDeviceToken(fresh.refreshToken);
          next.user = fresh.user;
          cached = next;
          console.log(`[qwenwork] 用 auth-v2.dat 的 refresh token 刷新成功（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
          return next;
        } catch (e2: any) {
          console.warn(`[qwenwork] auth-v2.dat 的 refresh token 也失效: ${e2.message}`);
        }
      } catch (e: any) {
        console.warn(`[qwenwork] auth-v2.dat 解密失败: ${e.message}`);
      }
    }
    // 源③：.env QWEN_KEYS（capture-key 备份的 refresh token，自举：拷项目即可用）
    const rt = loadRefreshTokenFromEnv();
    if (rt) {
      try {
        const next = await refreshDeviceToken(rt);
        next.user = cached?.user ?? { uid: '' };
        cached = next;
        console.log(`[qwenwork] 已用 QWEN_KEYS 自举刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qwenwork] QWEN_KEYS 刷新也失败: ${e.message}`);
      }
    }
    throw new Error('无可用 token 源（所有 refresh token 均已失效，请运行 pnpm log-in 网页登录，或打开千问办公 App 登录）');
  })().finally(() => { refreshing = null; });

  return refreshing;
}

/** 初始化 token 管理（启动时调用：加载初始 token + 启动文件监听） */
export function initTokenManager(): void {
  startAuthFileWatch();
}

/** 强制刷新一次（capture-key 用：验证刷新链 + 拿到新 token） */
export async function forceRefresh(): Promise<QwenTokenState> {
  const cur = await getToken();
  const next = await refreshDeviceToken(cur.refreshToken);
  next.user = cur.user;
  cached = next;
  return next;
}

/**
 * 采纳外部获取的凭据（网页 device-flow 登录用）：写入内存缓存。
 * state 无 raw → 后续 refreshDeviceToken 的 auth-v2.dat 写回条件（cached?.raw && exists）天然不成立，
 * 即网页登录凭据永不写回 App 登录态文件（与 App 链路独立，互不干扰）。
 */
export function adoptCredential(state: QwenTokenState): void {
  cached = state;
}
