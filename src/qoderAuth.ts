/**
 * qoderAuth.ts — Qoder 凭据管理（只读）。
 *
 * Qoder App 将登录态写在 userData/auth.v1.dat（Electron safeStorage v10）：
 *   { schemaVersion, token, refreshToken, expiresAt, refreshTokenExpiresAt, user: { id, name, email, ... } }
 *
 * 设计：插件只读取、不刷新、不写回。
 * - Qoder access token 有效期约 30 天，由 Qoder App 自己轮换并写回文件
 * - 插件监听文件变化自动拾取新 token，避免与 App 的 refresh token 轮换互踩
 * - token 过期时提示用户打开 Qoder App 刷新登录
 */

import fs from 'node:fs';
import { qoderSettings } from './qoderConfig';
import { decryptSafeStorageJson, type SafeStorageOptions } from './safeStorage';

export interface QoderTokenState {
  /** opaque access token（dt- 前缀） */
  token: string;
  /** opaque refresh token（drt- 前缀；本通道不消费） */
  refreshToken: string;
  user: { uid: string; name?: string; email?: string };
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  /** 原始解密 JSON（只读保留） */
  raw: any;
}

function qoderSafeStorageOptions(): SafeStorageOptions {
  return {
    userDataDir: qoderSettings.userDataDir,
    keychainService: qoderSettings.keychainService,
    keychainAccount: qoderSettings.keychainAccount,
  };
}

function decryptQoderAuthFile(filePath: string): QoderTokenState {
  const json = decryptSafeStorageJson(filePath, qoderSafeStorageOptions());
  if (typeof json.token !== 'string' || !json.token) {
    throw new Error('auth.v1.dat 缺少 token（Qoder App 未登录？）');
  }
  const expiresAt = typeof json.expiresAt === 'string' ? Date.parse(json.expiresAt) : 0;
  const refreshTokenExpiresAt = typeof json.refreshTokenExpiresAt === 'string'
    ? Date.parse(json.refreshTokenExpiresAt)
    : undefined;
  return {
    token: json.token,
    refreshToken: typeof json.refreshToken === 'string' ? json.refreshToken : '',
    user: {
      uid: json.user?.id ?? '',
      name: json.user?.name,
      email: json.user?.email,
    },
    expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt,
    refreshTokenExpiresAt: refreshTokenExpiresAt && !Number.isNaN(refreshTokenExpiresAt) ? refreshTokenExpiresAt : undefined,
    raw: json,
  };
}

let cached: QoderTokenState | null = null;

// —— auth.v1.dat 文件监听（Qoder App 刷新时自动拾取） ——
let authWatcher: fs.FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
let lastKnownMtime = 0;

function startAuthFileWatch(): void {
  if (authWatcher || !fs.existsSync(qoderSettings.oauthTokenPath)) return;
  try {
    lastKnownMtime = fs.statSync(qoderSettings.oauthTokenPath).mtimeMs;
    authWatcher = fs.watch(qoderSettings.oauthTokenPath, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        try {
          const stat = fs.statSync(qoderSettings.oauthTokenPath);
          if (stat.mtimeMs === lastKnownMtime) return;
          lastKnownMtime = stat.mtimeMs;
          console.log('[qoder] auth.v1.dat 已更新（Qoder App 刷新了 token），重新读取…');
          const fresh = decryptQoderAuthFile(qoderSettings.oauthTokenPath);
          cached = fresh;
          console.log(`[qoder] 已拾取新 token（有效期至 ${new Date(fresh.expiresAt).toISOString()}）`);
        } catch (e: any) {
          console.warn(`[qoder] auth.v1.dat 重读失败: ${e.message}`);
        }
      }, 1000);
    });
    authWatcher.on('error', (err) => {
      console.warn(`[qoder] auth.v1.dat 监听异常: ${err.message}，将重启监听`);
      authWatcher = null;
      setTimeout(startAuthFileWatch, 5000);
    });
    console.log(`[qoder] 已启动 auth.v1.dat 监听（${qoderSettings.oauthTokenPath}）`);
  } catch (e: any) {
    console.warn(`[qoder] 启动 auth.v1.dat 监听失败: ${e.message}`);
  }
}

/**
 * 获取当前有效 token（只读：缓存 + 文件重读）。
 * 不做 refresh：Qoder App 拥有 refresh token 的轮换权，插件写回会与其互踩。
 */
export async function getQoderToken(): Promise<QoderTokenState> {
  if (cached && cached.expiresAt > 0 && Date.now() < cached.expiresAt - 5 * 60_000) {
    return cached;
  }
  if (fs.existsSync(qoderSettings.oauthTokenPath)) {
    const fresh = decryptQoderAuthFile(qoderSettings.oauthTokenPath);
    cached = fresh;
    if (fresh.expiresAt > 0 && Date.now() < fresh.expiresAt - 5 * 60_000) {
      return fresh;
    }
    const when = fresh.expiresAt > 0 ? new Date(fresh.expiresAt).toISOString() : '未知';
    throw new Error(`Qoder access token 已过期（${when}）。本插件只读凭据，请打开 Qoder App 刷新登录后重试`);
  }
  throw new Error(`未找到 Qoder 登录态（${qoderSettings.oauthTokenPath}）。请先登录 Qoder App，或用 QODER_OAUTH_TOKEN_PATH 指定 auth.v1.dat`);
}

/** 初始化凭据管理（启动时调用：加载初始 token + 启动文件监听） */
export function initQoderTokenManager(): void {
  if (fs.existsSync(qoderSettings.oauthTokenPath)) {
    try {
      cached = decryptQoderAuthFile(qoderSettings.oauthTokenPath);
      console.log(`[qoder] 已加载 auth.v1.dat（有效期至 ${new Date(cached.expiresAt).toISOString()}）`);
    } catch (e: any) {
      console.warn(`[qoder] auth.v1.dat 读取失败: ${e.message}`);
    }
  } else {
    console.warn(`[qoder] 未找到 auth.v1.dat（${qoderSettings.oauthTokenPath}），请先登录 Qoder App`);
  }
  startAuthFileWatch();
}
