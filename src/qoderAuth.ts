/**
 * qoderAuth.ts — Qoder token 管理（自包含网页登录凭据，无 Qoder App 依赖）。
 *
 * 凭据来源只有两条：
 *   ① 内存缓存里的 drt- refresh token → deviceToken/refresh 轮换
 *   ② .env QODER_KEYS（pnpm log-in:qoder 备份的 refresh token）→ 自举刷新
 * 两条都由 `pnpm log-in:qoder`（openapi.qoder.sh 设备授权，PKCE S256）产出，
 * 插件不读取、不写回任何 Qoder App 文件。
 *
 * 刷新：POST {oauthBase}/api/v1/deviceToken/refresh，body {refresh_token}
 * - refresh token 每次刷新都会轮换（drt- 前缀），轮换值同步回 .env QODER_KEYS
 * - access token 有效期约 30 天；refresh token 约 1 年
 */

import { qoderSettings } from './qoderConfig';
import { readEnvValue, writeEnvValue } from './envStore';

export interface QoderUserInfo {
  uid: string;
  name?: string;
  email?: string;
  userType?: string;
  orgId?: string;
  orgName?: string;
}

export interface QoderTokenState {
  /** opaque access token（dt- 前缀） */
  token: string;
  /** opaque refresh token（drt- 前缀，deviceToken/refresh 轮换） */
  refreshToken: string;
  user: QoderUserInfo;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  /** refresh token 过期时间（ms epoch；服务端未告知时为 undefined） */
  refreshTokenExpiresAt?: number;
}

/** deviceToken 响应的 expires_in 是毫秒（官方实测）；极小值按秒兜底 */
const EXPIRES_IN_MS_THRESHOLD = 1e8;
const DEFAULT_ACCESS_TTL_MS = 30 * 24 * 3600_000;

/** 解析 access/refresh token 过期时间（expires_at RFC3339 优先，其次 expires_in） */
export function parseDeviceExpiry(
  expiresAtRaw: unknown,
  expiresInRaw: unknown,
  fallbackMs: number,
): number {
  if (typeof expiresAtRaw === 'string') {
    const t = Date.parse(expiresAtRaw);
    if (!Number.isNaN(t) && t > 0) return t;
  }
  if (typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0) {
    return Date.now() + (expiresInRaw >= EXPIRES_IN_MS_THRESHOLD ? expiresInRaw : expiresInRaw * 1000);
  }
  return Date.now() + fallbackMs;
}

function parseOptionalExpiry(expiresAtRaw: unknown, expiresInRaw: unknown): number | undefined {
  const hasAt = typeof expiresAtRaw === 'string' && !Number.isNaN(Date.parse(expiresAtRaw));
  const hasIn = typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0;
  if (!hasAt && !hasIn) return undefined;
  return hasAt
    ? Date.parse(expiresAtRaw as string)
    : parseDeviceExpiry(undefined, expiresInRaw, DEFAULT_ACCESS_TTL_MS);
}

/**
 * 拉取账号信息（best-effort）。
 *
 * qoder access token 是 opaque token（非 JWT），uid 只能从 userinfo 取；
 * 签名链的 `Cosy-User` / `info.uid` 依赖它，因此在 uid 未知时补一次。
 */
export async function fetchQoderUserInfo(token: string): Promise<QoderUserInfo | null> {
  try {
    const url = `${qoderSettings.oauthBaseUrl}${qoderSettings.userInfoPath}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': qoderSettings.userAgent,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as any;
    return {
      uid: String(j.id ?? j.user_id ?? ''),
      name: j.name ? String(j.name) : undefined,
      email: j.email ? String(j.email) : undefined,
      userType: j.user_type ? String(j.user_type) : undefined,
      orgId: j.organization_id ? String(j.organization_id) : undefined,
      orgName: j.organization_name ? String(j.organization_name) : undefined,
    };
  } catch {
    return null;
  }
}

/** uid 未知时补全账号信息（失败不阻塞刷新） */
async function ensureUserInfo(state: QoderTokenState): Promise<QoderTokenState> {
  if (state.user.uid) return state;
  const info = await fetchQoderUserInfo(state.token);
  if (info?.uid) {
    state.user = info;
  } else {
    console.warn('[qoder] 未能取得账号 uid（userinfo 不可用）；签名头 Cosy-User 将为空');
  }
  return state;
}

function syncEnvRefreshToken(refreshToken: string): void {
  if (!writeEnvValue('QODER_KEYS', refreshToken)) {
    console.warn('[qoder] QODER_KEYS 未能写入 .env（git-ignore 守卫未通过），刷新 token 仅存活于本次进程');
  }
}

/** deviceToken/refresh：换取新 token + 轮换 refresh token + 同步 .env */
export async function refreshQoderToken(refreshToken: string): Promise<QoderTokenState> {
  const url = `${qoderSettings.oauthBaseUrl}${qoderSettings.deviceRefreshPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': qoderSettings.userAgent,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`deviceToken/refresh 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json() as any;
  const token = j.device_token ?? j.token;
  if (typeof token !== 'string' || !token) {
    throw new Error('deviceToken/refresh 响应缺 device_token/token');
  }
  const rt = typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : refreshToken;
  const expiresAt = parseDeviceExpiry(j.expires_at, j.expires_in, DEFAULT_ACCESS_TTL_MS);
  const refreshTokenExpiresAt = parseOptionalExpiry(j.refresh_token_expires_at, j.refresh_token_expires_in);

  syncEnvRefreshToken(rt);
  const next: QoderTokenState = {
    token,
    refreshToken: rt,
    user: cached?.user ?? { uid: '' },
    expiresAt,
    refreshTokenExpiresAt,
  };
  if (refreshTokenExpiresAt && refreshTokenExpiresAt < Date.now() + 24 * 3600_000) {
    console.warn(`[qoder] refresh token 将于 ${new Date(refreshTokenExpiresAt).toISOString()} 过期（不足 24h），请重跑 pnpm log-in:qoder`);
  }
  return ensureUserInfo(next);
}

// —— token 缓存与自动刷新 ——
let cached: QoderTokenState | null = null;
let refreshing: Promise<QoderTokenState> | null = null;

/** 获取当前有效 token（缓存 + 临近过期自动刷新，单飞防并发） */
export async function getQoderToken(): Promise<QoderTokenState> {
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) {
    return cached;
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    // 源①：内存缓存里的 refresh token
    if (cached?.refreshToken) {
      try {
        const next = await refreshQoderToken(cached.refreshToken);
        cached = next;
        console.log(`[qoder] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qoder] 缓存的 refresh token 刷新失败（${e.message}），改用 .env QODER_KEYS…`);
      }
    }
    // 源②：.env QODER_KEYS（pnpm log-in:qoder 备份的 refresh token，自举）
    const rt = readEnvValue('QODER_KEYS');
    if (rt) {
      try {
        const next = await refreshQoderToken(rt);
        cached = next;
        console.log(`[qoder] 已用 QODER_KEYS 自举刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qoder] QODER_KEYS 刷新也失败: ${e.message}`);
      }
    }
    throw new Error('无可用 Qoder 凭据（refresh token 均失效或缺失），请运行 pnpm log-in:qoder 网页登录');
  })().finally(() => { refreshing = null; });

  return refreshing;
}

/** 强制刷新一次（log-in:qoder 用：验证刷新链 + 拿到轮换后的 refresh token） */
export async function forceRefreshQoder(): Promise<QoderTokenState> {
  if (!cached?.refreshToken) {
    throw new Error('尚未采纳登录凭据，无法验证刷新链');
  }
  const next = await refreshQoderToken(cached.refreshToken);
  cached = next;
  return next;
}

/** 采纳外部获取的凭据（网页设备授权登录用） */
export function adoptQoderCredential(state: QoderTokenState): void {
  cached = state;
}

/** 初始化凭据管理（启动时调用：只做凭据来源诊断，不发起网络请求） */
export function initQoderTokenManager(): void {
  const rt = readEnvValue('QODER_KEYS');
  if (rt) {
    console.log('[qoder] 已检测到 .env QODER_KEYS（网页登录凭据，运行时按需刷新）');
  } else {
    console.warn('[qoder] 未检测到 Qoder 凭据，请先运行 pnpm log-in:qoder 完成网页登录');
  }
}
