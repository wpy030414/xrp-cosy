/**
 * qwenwork/auth.ts — 千问办公 OAuth token 管理（网页登录凭据，无 App 依赖）。
 *
 * 凭据来源只有两条（2026-10-20 起取消千问办公 App 支持）：
 *   ① 内存缓存里的 ory_rt_ refresh token → deviceToken/refresh 轮换
 *   ② .env QWEN_KEYS（pnpm log-in 备份的 refresh token）→ 自举刷新
 * 两条都由 `pnpm log-in`（网页 device-flow）产出，插件不再读写任何 App 文件。
 *
 * 刷新：POST {base}/api/v1/deviceToken/refresh，body {refresh_token, target}
 * 历史：曾支持解密/写回 App 的 auth-v2.dat（Electron safeStorage + Keychain/DPAPI）作第三源，
 * 已随 App 支持一并移除（见 docs/DECISIONS.md D-16）。
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { settings } from './config';

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
}

/** deviceToken/refresh：换取新 token + 轮换 refresh token + 同步 .env */
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

  syncEnvRefreshToken(rt);
  return { token, refreshToken: rt, user, expiresAt, refreshTokenExpiresAt: rtExpiresAt };
}

/** 从 .env 读 QWEN_KEYS（pnpm log-in 备份的 refresh token，可作自举源） */
function loadRefreshTokenFromEnv(): string | null {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    const v = parsed.QWEN_KEYS?.trim();
    return v || null;
  } catch { return null; }
}

/** 同步 .env 的 QWEN_KEYS（refresh token 轮换后落盘：重启/换进程可自举续命） */
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
        console.warn(`[qwenwork] 缓存的 refresh token 刷新失败（${e.message}），改用 .env QWEN_KEYS…`);
      }
    }
    // 源②：.env QWEN_KEYS（pnpm log-in 备份的 refresh token，自举：拷项目即可用）
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
    throw new Error('无可用 token 源（refresh token 均已失效，请运行 pnpm log-in 网页登录）');
  })().finally(() => { refreshing = null; });

  return refreshing;
}

/** 强制刷新一次（log-in 用：验证刷新链 + 拿到新 token） */
export async function forceRefresh(): Promise<QwenTokenState> {
  const cur = await getToken();
  const next = await refreshDeviceToken(cur.refreshToken);
  next.user = cur.user;
  cached = next;
  return next;
}

/**
 * 采纳外部获取的凭据（网页 device-flow 登录用）：写入内存缓存。
 * 本模块不再有 App 登录态文件，因此也不会写回任何 App 文件。
 */
export function adoptCredential(state: QwenTokenState): void {
  cached = state;
}
