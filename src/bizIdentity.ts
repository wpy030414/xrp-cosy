/**
 * qwenwork/bizIdentity.ts — 企业身份（biz）凭据铸造与校验。
 *
 * 逆向 + 实测结论（2026-10-20）：
 * - 设备流（selectAccounts → poll）铸出的 ory_rt_/access token **永远是 c_site（个人）身份**：
 *   `selectAccounts` 的 query 与 `redirect_uri` 均为白名单精确校验（多带任何参数一律
 *   400 INVALID_DEVICE_FLOW），身份无法从登录 URL 注入；SPA 的 space/corpId 只作用于
 *   网页会话自身，不回流到设备流凭据。
 * - 但用这把 c_site access token 调 `POST {qwenWebBase}/biz/user/v1/auth/switch-team`
 *   （body 需 team_id），服务端会在 `Set-Cookie: token=<JWT>` 里回铸一把**企业身份 JWT**：
 *   claims 含 `aud:"biz"` / `biz_org_id` / `biz_team_id` / `biz_org_type`，**有效期约 15 天**，
 *   可直接作为 cosy 签名链的 security_oauth_token（实测推理内层 200）。
 * - 扣费钱包随身份切换（`GET {qwenWebBase}/user/balance`）：
 *   c_site → 个人池；biz → 企业池（has_active_plan=true）。这是判定"烧哪边积分"的唯一可观测判据。
 *
 * 语义边界（主人的要求）：个人版是合法选择，本模块**只在企业模式下生效**；
 * 未开启企业模式时链路行为与历史完全一致。
 */

import crypto from 'node:crypto';
import { settings } from './config';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export interface BizTokenClaims {
  /** 企业身份体的 user_id（与 c_site 的 sub 不同） */
  sub: string;
  aud: string;
  exp: number;
  bizOrgId: string;
  bizTeamId: string;
  bizOrgType: string;
  username: string;
}

export interface BizToken {
  /** 企业身份 JWT（作为 security_oauth_token 使用） */
  jwt: string;
  claims: BizTokenClaims;
  /** 过期时刻（ms epoch） */
  expiresAt: number;
}

export class BizIdentityError extends Error {}

function decode(jwt: string): any {
  const part = jwt.split('.')[1] || '';
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw new BizIdentityError('biz token 不是可解析的 JWT');
  }
}

/** 解析并校验企业 JWT（aud 必须为 biz，且未过期） */
export function parseBizToken(jwt: string): BizToken {
  const p = decode(jwt);
  if (p.aud !== 'biz') throw new BizIdentityError(`凭据 aud=${p.aud}（期望 biz）——不是企业身份`);
  const exp = Number(p.exp ?? 0);
  return {
    jwt,
    claims: {
      sub: String(p.sub ?? ''),
      aud: String(p.aud ?? ''),
      exp,
      bizOrgId: String(p.biz_org_id ?? ''),
      bizTeamId: String(p.biz_team_id ?? ''),
      bizOrgType: String(p.biz_org_type ?? ''),
      username: String(p.username ?? ''),
    },
    expiresAt: exp * 1000,
  };
}

export interface BizOrg {
  orgId: string;
  teamId: string;
  orgName: string;
  teamName: string;
  status: string;
  hasActivePlan: boolean;
  /** 钉钉 corpId（association_id） */
  corpId: string;
}

/** 用 c_site access token 换取可访问的组织列表（只读） */
export async function fetchBizOrgs(cSiteAccessToken: string): Promise<BizOrg[]> {
  const res = await fetch(`${settings.qwenWebBase}/biz/user/v1/auth/identities`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${cSiteAccessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new BizIdentityError(`组织列表获取失败: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  const list: any[] = Array.isArray(j?.identities) ? j.identities : [];
  return list
    .filter((e) => e?.org_type === 'enterprise')
    .map((e) => ({
      orgId: String(e.org_id ?? ''),
      teamId: String(e.team_id ?? ''),
      orgName: String(e.org_name ?? ''),
      teamName: String(e.team_name ?? ''),
      status: String(e.status ?? ''),
      hasActivePlan: e.has_active_plan === true,
      corpId: String(e.association_id ?? ''),
    }));
}

/**
 * 铸造企业身份凭据：POST /biz/user/v1/auth/switch-team → Set-Cookie: token=<biz JWT>。
 * 未指定 teamId 时自动挑选「status=active 且 has_active_plan」的企业组织（frozen/无套餐的组织
 * 会被服务端回落成个人身份，铸出来仍是 c_site，故必须筛掉）。
 */
export async function mintBizToken(
  cSiteAccessToken: string,
  opts: { teamId?: string; allowDowngrade?: boolean } = {},
): Promise<{ biz: BizToken; org: BizOrg }> {
  const orgs = await fetchBizOrgs(cSiteAccessToken);
  if (!orgs.length) throw new BizIdentityError('当前账号没有可用的企业组织');
  const target = opts.teamId
    ? orgs.find((o) => o.teamId === opts.teamId)
    : orgs.find((o) => o.status === 'active' && o.hasActivePlan);
  if (!target) {
    throw new BizIdentityError(
      opts.teamId
        ? `未找到 team_id=${opts.teamId} 的企业组织（可选：${orgs.map((o) => `${o.orgName}/${o.teamId}`).join('、')}）`
        : `无 active + 有套餐的企业组织（现状：${orgs.map((o) => `${o.orgName}=${o.status}/${o.hasActivePlan}`).join('、')}）`,
    );
  }
  const res = await fetch(`${settings.qwenWebBase}/biz/user/v1/auth/switch-team`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${cSiteAccessToken}` },
    body: JSON.stringify({ org_id: target.orgId, team_id: target.teamId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new BizIdentityError(`switch-team 失败: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((s) => /^(?:token)=([^;]+)/.exec(s)?.[1])
    .filter(Boolean)
    .pop();
  if (!cookie) throw new BizIdentityError('switch-team 未返回企业 token（Set-Cookie: token 缺失）');
  const biz = parseBizToken(cookie);
  if (biz.expiresAt < Date.now() + 60_000) throw new BizIdentityError('企业 token 已过期（服务端时钟异常？）');
  if (!opts.allowDowngrade && biz.claims.sub === decode(cSiteAccessToken).sub) {
    throw new BizIdentityError('服务端回落了个人身份（铸出的 sub 与 c_site 相同）——该组织席位可能已失效');
  }
  return { biz, org: target };
}

/** 可观测判据：当前凭据扣的是哪个钱包 */
export async function fetchBalance(accessToken: string): Promise<{ balance: number; raw: any }> {
  const res = await fetch(`${settings.qwenWebBase}/user/balance`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new BizIdentityError(`余额查询失败: HTTP ${res.status}`);
  const j: any = await res.json();
  return { balance: Number(j?.data?.balance ?? NaN), raw: j?.data };
}

/** 身份种类（'biz' = 企业账，'c_site' = 个人账） */
export async function fetchIdentityKind(accessToken: string): Promise<string> {
  const res = await fetch(`${settings.qwenWebBase}/biz/user/v1/auth/me`, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `HTTP_${res.status}`;
  const j: any = await res.json();
  return String(j?.identity_kind ?? 'unknown');
}

/** 便于日志：新 uuid */
export const newRequestId = (): string => crypto.randomUUID();

// ——— 运行时派生凭据（带缓存与自动续期）———

interface BizCacheEntry { biz: BizToken; org: BizOrg; rootSub: string }
let bizCache: BizCacheEntry | null = null;
let minting: Promise<BizCacheEntry> | null = null;

/** 从 JWT 解 sub（缓存分键用，解不开返回空串） */
function subOf(jwt: string): string {
  try { return String(decode(jwt).sub ?? ''); } catch { return ''; }
}
/** 提前 1 天续期（biz JWT 有效期约 15 天） */
const RENEW_BUFFER_MS = 24 * 3600_000;

/**
 * 取企业身份凭据（命中缓存直接返回，否则用根 c_site access token 铸造）。
 * 并发安全：同一时刻只发起一次 switch-team。
 */
export async function getBizToken(
  rootAccessToken: string,
  teamId?: string,
  force = false,
): Promise<{ biz: BizToken; org: BizOrg }> {
  const rootSub = subOf(rootAccessToken);
  // 命中条件：未强制刷新 + 同一根账号 + 未临近过期（换账号必须重铸，否则会把 A 的企业身份用到 B 上）
  if (!force && bizCache && bizCache.rootSub === rootSub
    && Date.now() < bizCache.biz.expiresAt - RENEW_BUFFER_MS) {
    return { biz: bizCache.biz, org: bizCache.org };
  }
  if (!minting) {
    minting = mintBizToken(rootAccessToken, { teamId })
      .then((r) => {
        const entry = { ...r, rootSub: subOf(rootAccessToken) };
        bizCache = entry;
        return entry;
      })
      .finally(() => { minting = null; });
  }
  const hit = await minting;
  return { biz: hit.biz, org: hit.org };
}

/** 清缓存（重新登录 / 根凭据换账号时调用） */
export function resetBizCache(): void {
  bizCache = null;
}

/** 当前缓存的企业凭据（无则 null）——供诊断与状态展示 */
export function peekBizToken(): BizToken | null {
  const c = bizCache;
  return c && c.biz.expiresAt > Date.now() ? c.biz : null;
}
