/**
 * qoderDeviceLogin.ts — Qoder 网页设备授权登录（PKCE S256 + deviceToken/poll）。
 *
 * 协议（逆向自官方 CLI / 桌面端，见 docs/specs/qoder-device-login.md）：
 * 1) 申请授权：浏览器打开 {authBase}/device/selectAccounts
 *      ?challenge=<S256(verifier)>&challenge_method=S256&nonce=<32-hex>
 *      &client_id=<client_id>&machine_id=<machine_id>
 *    （国际版不传 redirect_uri；登录由 qoder.com 托管，插件不经手口令）
 * 2) 轮询换票：GET {oauthBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
 *      404/202 = 尚未授权；200 = {token|device_token, refresh_token, expires_in(ms), ...}
 * 3) 刷新：POST {oauthBase}/api/v1/deviceToken/refresh（见 qoderAuth.ts）
 *
 * 全程无本地回调监听、无 App 依赖：凭据由服务端与我们的 nonce/challenge 绑定。
 */

import crypto from 'node:crypto';
import { qoderSettings } from './qoderConfig';
import { readEnvValue, writeEnvValue } from './envStore';
import { openInBrowser } from './openBrowser';
import { parseDeviceExpiry } from './qoderAuth';

const PKCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const VERIFIER_LENGTH = 64;
const POLL_INTERVAL_MS = 1_500;
const POLL_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_ACCESS_TTL_MS = 30 * 24 * 3600_000;

export interface QoderDeviceHandles {
  verifier: string;
  challenge: string;
  /** 国际版为 32 位 hex（无横线） */
  nonce: string;
  machineId: string;
}

export interface QoderDeviceCredential {
  token: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  nonce: string;
  challenge: string;
}

export class QoderDeviceFlowError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'QoderDeviceFlowError';
  }
}

/** PKCE verifier：64 字符，字符集与长度对齐官方客户端（RFC 7636 unreserved） */
function makeVerifier(): string {
  let s = '';
  while (s.length < VERIFIER_LENGTH) s += PKCE_CHARS[crypto.randomInt(0, PKCE_CHARS.length)];
  return s;
}

/** machineId 解析：env 显式覆盖 > .env QODER_MACHINE_ID > 首次生成并持久化 */
export function resolveQoderMachineId(repoRoot?: string): { id: string; source: 'env' | 'file' | 'generated' } {
  if (qoderSettings.machineId) return { id: qoderSettings.machineId, source: 'env' };
  const saved = readEnvValue('QODER_MACHINE_ID', repoRoot);
  if (saved) return { id: saved, source: 'file' };
  const id = crypto.randomUUID();
  if (writeEnvValue('QODER_MACHINE_ID', id, repoRoot)) {
    console.log('[qoder] 已生成并持久化设备标识（.env QODER_MACHINE_ID）');
  } else {
    console.warn('[qoder] QODER_MACHINE_ID 未能持久化（.env 未 git-ignored？），本次会话使用内存值');
  }
  return { id, source: 'generated' };
}

/** 生成一组登录参数（PKCE + nonce + machineId） */
export function buildQoderDeviceLoginParams(repoRoot?: string): QoderDeviceHandles {
  const verifier = makeVerifier();
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    // 国际版 nonce = uuid4().hex（32-hex，无横线）
    nonce: crypto.randomBytes(16).toString('hex'),
    machineId: resolveQoderMachineId(repoRoot).id,
  };
}

/** 拼网页授权 URL（qoder.com 托管登录，完成后由插件轮询取票） */
export function buildQoderAuthUrl(h: QoderDeviceHandles): string {
  const u = new URL('/device/selectAccounts', qoderSettings.authBaseUrl);
  u.searchParams.set('challenge', h.challenge);
  u.searchParams.set('challenge_method', 'S256');
  u.searchParams.set('nonce', h.nonce);
  u.searchParams.set('client_id', qoderSettings.clientId);
  u.searchParams.set('machine_id', h.machineId);
  return u.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询 deviceToken/poll 直到登录完成 */
export async function pollQoderDeviceFlow(
  h: QoderDeviceHandles,
  opts: { timeoutMs?: number; intervalMs?: number; onWait?: (elapsedMs: number, lastStatus: number) => void } = {},
): Promise<QoderDeviceCredential> {
  const timeoutMs = opts.timeoutMs ?? qoderSettings.loginTimeoutMs;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let failures = 0;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    try {
      const url = new URL(qoderSettings.devicePollPath, qoderSettings.oauthBaseUrl);
      url.searchParams.set('nonce', h.nonce);
      url.searchParams.set('verifier', h.verifier);
      url.searchParams.set('challenge_method', 'S256');
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': qoderSettings.userAgent,
          'X-Request-Id': crypto.randomUUID(),
        },
        signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
      });
      lastStatus = res.status;

      // 404 / 202 = 尚未授权（官方实测：未知 nonce → 404 NotFound）
      if (res.status === 404 || res.status === 202) {
        failures = 0;
        opts.onWait?.(Date.now() - startedAt, lastStatus);
        await sleep(intervalMs);
        continue;
      }
      if (res.status === 400) {
        const j = await res.json().catch(() => null) as any;
        const code = String(j?.errorCode ?? '');
        if (code === 'NotFound' || code === 'INVALID_DEVICE_FLOW') {
          failures = 0;
          opts.onWait?.(Date.now() - startedAt, lastStatus);
          await sleep(intervalMs);
          continue;
        }
        throw new QoderDeviceFlowError(`deviceToken/poll 400: ${j?.errorMessage ?? '未知错误'}`, 400);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new QoderDeviceFlowError(`deviceToken/poll 失败: HTTP ${res.status} ${detail}`, res.status);
      }

      const j = await res.json() as any;
      // 绑定校验（防串号）：服务端返回了绑定字段就必须逐字匹配
      if (typeof j.nonce === 'string' && j.nonce && j.nonce !== h.nonce) {
        throw new QoderDeviceFlowError('poll 响应 nonce 不匹配，拒绝采纳');
      }
      if (typeof j.code_challenge === 'string' && j.code_challenge && j.code_challenge !== h.challenge) {
        throw new QoderDeviceFlowError('poll 响应 code_challenge 不匹配，拒绝采纳');
      }
      if (typeof j.code_challenge_method === 'string' && j.code_challenge_method && j.code_challenge_method !== 'S256') {
        throw new QoderDeviceFlowError('poll 响应 challenge_method 非 S256，拒绝采纳');
      }

      const token = j.token ?? j.device_token;
      if (typeof token !== 'string' || !token) {
        throw new QoderDeviceFlowError('poll 响应缺少 token/device_token');
      }
      if (typeof j.refresh_token !== 'string' || !j.refresh_token) {
        throw new QoderDeviceFlowError('poll 响应缺少 refresh_token（无法长期续期）');
      }

      return {
        token,
        refreshToken: j.refresh_token,
        expiresAt: parseDeviceExpiry(j.expires_at, j.expires_in, DEFAULT_ACCESS_TTL_MS),
        refreshTokenExpiresAt: (() => {
          const at = typeof j.refresh_token_expires_at === 'string' ? Date.parse(j.refresh_token_expires_at) : NaN;
          if (!Number.isNaN(at) && at > 0) return at;
          if (typeof j.refresh_token_expires_in === 'number') {
            return parseDeviceExpiry(undefined, j.refresh_token_expires_in, DEFAULT_ACCESS_TTL_MS);
          }
          return undefined;
        })(),
        nonce: h.nonce,
        challenge: h.challenge,
      };
    } catch (e: any) {
      if (e instanceof QoderDeviceFlowError) throw e; // 协议错误：致命
      failures += 1; // 网络错误（含单请求超时）：容忍至 MAX_CONSECUTIVE_FAILURES
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        throw new QoderDeviceFlowError(`连续 ${failures} 次网络错误: ${e.message}`);
      }
      opts.onWait?.(Date.now() - startedAt, lastStatus);
      await sleep(intervalMs);
    }
  }
  const hint =
    lastStatus === 404 || lastStatus === 202 || lastStatus === 400
      ? '（全程未检测到授权完成——请确认浏览器已打开登录页并完成登录）'
      : '';
  throw new QoderDeviceFlowError(
    `${Math.round(timeoutMs / 1000)} 秒内未完成登录，可重跑 pnpm log-in:qoder${hint}`,
    lastStatus,
  );
}

/** 组合流：生成参数 → 拼授权 URL → 开浏览器 → 轮询 */
export async function runQoderDeviceLogin(
  opts: {
    openBrowser?: boolean;
    timeoutMs?: number;
    repoRoot?: string;
    onAuthUrl?: (url: string) => void;
    onWait?: (elapsedMs: number, lastStatus: number) => void;
  } = {},
): Promise<QoderDeviceCredential> {
  const h = buildQoderDeviceLoginParams(opts.repoRoot);
  const url = buildQoderAuthUrl(h);
  opts.onAuthUrl?.(url);
  if (opts.openBrowser !== false) openInBrowser(url);
  return pollQoderDeviceFlow(h, { timeoutMs: opts.timeoutMs, onWait: opts.onWait });
}
