#!/usr/bin/env tsx
/**
 * log-in.ts — qwenwork 渠道的凭据入口：网页登录 + 扣费身份管理（device flow，无需千问办公 App）。
 *
 * qwenwork 渠道的凭据事务全部收口在这一个命令里：
 *   pnpm log-in                                 扫码登录（扣费身份：个人版 personal）
 *   pnpm log-in --identity biz [--team-id id]   扫码登录并把扣费身份切到企业积分池
 *   pnpm log-in --list-orgs                     只读：列企业组织与席位/套餐（用来取 --team-id）
 *   pnpm log-in --status                        只读：诊断当前扣费身份与个人/企业双池余额
 *
 * 登录流程：
 * 1. 生成 PKCE + nonce + machineId → 拼 selectAccounts 登录 URL
 * 2. 打开系统浏览器 → 用户钉钉扫码（完成态登记在服务端，无需本地回调）
 * 3. 本地每秒轮询 deviceToken/poll → 拿到 {token, refresh_token}
 * 4. adoptCredential + forceRefresh 验证刷新链 → 备份 QWEN_KEYS 到 .env
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/config';
import { adoptCredential, forceRefresh, getToken, type QwenTokenState } from '../src/auth';
import { extractUidFromToken } from '../src/client';
import { buildAuthUrl, buildDeviceLoginParams, DeviceFlowError, openInBrowser, pollDeviceFlow, readCredentialIdentity } from '../src/deviceLogin';
import { fetchBizOrgs, getBizToken, fetchBalance, type BizOrg } from '../src/bizIdentity';
import { assertEnvGitIgnored, writeEnvValue } from '../src/envStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../');

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 12)}…${s.slice(-4)}` : '(无效)');

/** 取命令行参数值（--key value 形式；value 不得以 -- 开头） */
function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
}

const hasFlag = (name: string): boolean => process.argv.includes(name);

/** 组织可用性判据：非 active / 无套餐的组织，switch-team 会被服务端回落成个人身份 */
const orgUsable = (o: BizOrg): boolean => o.status === 'active' && o.hasActivePlan;

/** 身份可读化（undecodable 时降级为「无法判定」，不误报） */
function identityLabel(isBiz: boolean, undecodable: boolean): string {
  if (undecodable) return '无法判定';
  return isBiz ? '企业版（biz）' : '个人版（c_site）';
}

/** 组织表（--list-orgs 与 --status 共用）；withHint 附可复制的 --team-id 命令 */
function printOrgTable(orgs: BizOrg[], withHint = false): void {
  if (!orgs.length) {
    console.log('（无企业组织）\n');
    return;
  }
  console.log(`企业组织 ${orgs.length} 个：`);
  for (const o of orgs) {
    const usable = orgUsable(o);
    console.log(`  ${usable ? '✅' : '❌'} ${o.orgName}（${o.teamName}）`);
    console.log(`     team_id=${o.teamId}  corpId=${o.corpId}  status=${o.status}  has_active_plan=${o.hasActivePlan}`);
    if (withHint) {
      console.log(usable
        ? `     → pnpm log-in --identity biz --team-id ${o.teamId}`
        : '     → 无有效席位/套餐：switch-team 会被服务端回落成个人身份，请先在网页端处理');
    }
  }
  console.log('');
}

/** 只读取当前凭据（两个只读模式的共用前置；失败返回 null 并已打印原因） */
async function readRootToken(): Promise<QwenTokenState | null> {
  try {
    return await getToken();
  } catch (e: any) {
    fail(`无法取到可用凭据：${e.message}（请先完成一次登录：pnpm log-in）`);
    return null;
  }
}

/** --list-orgs：列可用企业组织，供 --team-id 取值（不触发登录、不改扣费身份） */
async function listOrgsMode(): Promise<boolean> {
  const root = await readRootToken();
  if (!root) return false;
  let orgs: BizOrg[];
  try {
    orgs = await fetchBizOrgs(root.token);
  } catch (e: any) {
    fail(`组织列表获取失败：${e.message}`);
    return false;
  }
  const idn = readCredentialIdentity(root.token);
  console.log(`根凭据身份：${identityLabel(idn.isBiz, idn.undecodable)}  sub=${idn.sub.slice(0, 12) || '?'}…  ${idn.username}\n`);
  printOrgTable(orgs, true);
  return true;
}

/**
 * --status：扣费身份诊断。判据是「钱从哪个钱包走」——服务端返回 200 并不告诉你这一点，
 * 而个人池/企业池余额（GET /user/balance，凭据身份决定归属）是可观测的硬证据。
 *
 * 副作用边界：读企业池必须先派生 biz 凭据，而派生用的 switch-team 会改动账号在服务端的
 * team 上下文。因此 personal 模式下默认**不**碰它，要读企业池需显式 --probe-biz。
 */
async function statusMode(probeBiz: boolean): Promise<boolean> {
  const root = await readRootToken();
  if (!root) return false;
  const idn = readCredentialIdentity(root.token);

  console.log('配置与根凭据');
  console.log(`  QWEN_IDENTITY=${settings.qwenIdentity}` +
    `${settings.qwenIdentity === 'biz' ? `   QWEN_BIZ_TEAM_ID=${settings.qwenBizTeamId || '(自动挑选)'}` : ''}`);
  console.log(`  根凭据（设备流铸出）身份 = ${identityLabel(idn.isBiz, idn.undecodable)}` +
    `  user_id=${idn.sub.slice(0, 12) || '?'}…  ${idn.username}`);
  console.log(`  根凭据有效期至 = ${new Date(root.expiresAt).toISOString()}`);
  const personalBal = await fetchBalance(root.token);
  console.log(`  个人池余额 = ${personalBal.balance}\n`);

  let orgs: BizOrg[] = [];
  try {
    orgs = await fetchBizOrgs(root.token);
  } catch (e: any) {
    console.warn(`⚠️ 组织列表获取失败：${e.message}\n`);
  }
  if (orgs.length) printOrgTable(orgs, true);

  if (settings.qwenIdentity !== 'biz') {
    if (!probeBiz) {
      console.log('企业池：未查询 —— 当前为个人版，诊断刻意不调 switch-team（它会改动账号的服务端 team 上下文）');
      console.log('  要一并读企业池：pnpm log-in --status --probe-biz');
      ok('当前 serve 以【个人身份】签名 → 烧个人积分池（个人版是合法选择；要切企业：pnpm log-in --identity biz）');
      return true;
    }
    console.log('ℹ️ --probe-biz：将派生企业凭据（服务端 team 上下文会随之切换），不改动 QWEN_IDENTITY 配置\n');
  }

  try {
    const { biz, org } = await getBizToken(root.token, settings.qwenBizTeamId || undefined);
    const enterpriseBal = await fetchBalance(biz.jwt);
    console.log('企业凭据（switch-team 派生）');
    console.log(`  aud=biz  企业 user_id=${biz.claims.sub.slice(0, 12)}…  org_id=${biz.claims.bizOrgId.slice(0, 12)}…`);
    console.log(`  组织 = ${org.orgName}（${org.teamName}）  有效期至 = ${new Date(biz.expiresAt).toISOString()}`);
    console.log(`  企业池余额 = ${enterpriseBal.balance}\n`);
  } catch (e: any) {
    fail(`企业凭据不可用：${e.message}`);
    if (settings.qwenIdentity === 'biz') {
      console.error('  → serve 会直接返回 401（已拒绝降级）：不会偷偷烧个人积分');
      console.error('  → 先 pnpm log-in --list-orgs 确认组织为 active + 有套餐，再 pnpm log-in --identity biz 重登');
    }
    return false;
  }

  if (settings.qwenIdentity === 'biz') ok('当前 serve 以【企业身份】签名 → 烧企业积分池');
  else ok('当前 serve 以【个人身份】签名 → 烧个人积分池（个人版是合法选择）');
  return true;
}

export async function main(): Promise<void> {
  // 0. 安全守卫必须最先：后续 forceRefresh 会经 syncEnvRefreshToken 无守卫写 .env
  if (!assertEnvGitIgnored(REPO_ROOT)) {
    process.exitCode = 1;
    return;
  }

  // 0.5 只读模式（凭据已在 .env/App 里，无需扫码）——必须在登录流程之前分派
  if (hasFlag('--list-orgs')) {
    console.log('🏢 qwenwork 企业组织列表（只读）\n');
    process.exitCode = (await listOrgsMode()) ? 0 : 1;
    return;
  }
  if (hasFlag('--status')) {
    console.log('🧭 qwenwork 扣费身份诊断（只读）\n');
    process.exitCode = (await statusMode(hasFlag('--probe-biz'))) ? 0 : 1;
    return;
  }

  // 1. 参数解析（首跑会生成并持久化 QWEN_MACHINE_ID）
  //    身份语义（实测）：设备流铸出的根凭据**恒为 c_site（个人）** —— selectAccounts 的 query 与
  //    redirect_uri 都是白名单精确校验，身份无法从登录 URL 注入。企业身份改由
  //    POST /biz/user/v1/auth/switch-team 从根凭据**派生**（约 15 天有效，见 src/bizIdentity.ts）。
  //    --identity personal 是训练员的合法选择（烧个人积分），一律放行；
  //    --identity biz 则当场派生并校验，铸不出企业就拒绝落盘，绝不静默烧个人池。
  const identityRaw = argOf('--identity');
  const teamId = argOf('--team-id');
  if (identityRaw !== undefined && identityRaw !== 'biz' && identityRaw !== 'personal') {
    fail(`--identity 只接受 biz 或 personal（收到：${identityRaw}）`);
    process.exitCode = 1;
    return;
  }
  const identity = (identityRaw ?? 'personal') as 'biz' | 'personal';

  console.log('🔑 xrp-cosy · qwenwork 网页登录（device flow，无需千问办公 App）\n');

  const handles = buildDeviceLoginParams(REPO_ROOT);
  const url = buildAuthUrl(handles);
  const bar = '─'.repeat(78);
  console.log(`▶ 请在浏览器完成钉钉登录（扫码）——扣费身份：${identity === 'biz' ? '企业版（biz）' : '个人版（personal）'}：`);
  console.log(`\n${bar}\n${url}\n${bar}\n`);
  if (!hasFlag('--no-open')) {
    const opened = openInBrowser(url);
    console.log(opened ? '✅ 已尝试打开系统浏览器（未自动打开请手动复制上方 URL）' : '⚠️ 自动打开浏览器失败，请手动复制上方 URL 到浏览器');
  }

  // 2. 轮询等待登录完成
  console.log('▶ 等待登录完成（每秒轮询，最长 %d 秒）…', Math.round(settings.qwenLoginTimeoutMs / 1000));
  let lastPrint = -1;
  let cred;
  try {
    cred = await pollDeviceFlow(handles, {
      onWait: (elapsed) => {
        const sec = Math.floor(elapsed / 1000);
        if (sec - lastPrint >= 15) {
          lastPrint = sec;
          console.log(`   …已等待 ${sec}s`);
        }
      },
    });
  } catch (e: any) {
    fail(e instanceof Error ? e.message : String(e));
    if (!(e instanceof DeviceFlowError)) console.error(`   (${e.constructor?.name})`);
    process.exitCode = 1;
    return;
  }
  ok('登录成功！');
  console.log(`   access token：${mask(cred.token)}（有效期至 ${new Date(cred.expiresAt).toISOString()}）`);
  console.log(`   refresh token：${mask(cred.refreshToken)}`);
  if (cred.refreshTokenExpiresAt) {
    console.log(`   refresh token 有效期至：${new Date(cred.refreshTokenExpiresAt).toISOString()}`);
  }

  // 2.5 身份落地：personal 如实报告；biz 当场派生 + 用钱包口径校验（扣费归属的唯一硬判据）
  const idn = readCredentialIdentity(cred.token);
  console.log(`   根凭据身份：${identityLabel(idn.isBiz, idn.undecodable)}  sub=${idn.sub.slice(0, 12) || '?'}…  ${idn.username}`);
  if (identity === 'biz') {
    console.log('▶ 用根凭据派生企业身份（POST /biz/user/v1/auth/switch-team）…');
    try {
      const { biz, org } = await getBizToken(cred.token, teamId || undefined);
      const bal = await fetchBalance(biz.jwt);
      ok(`企业身份铸造成功：${org.orgName}（${org.teamName}）`);
      console.log(`     企业 user_id=${biz.claims.sub.slice(0, 12)}…  有效期至 ${new Date(biz.expiresAt).toISOString()}`);
      console.log(`     企业钱包余额=${bal.balance}`);
    } catch (e: any) {
      fail(`企业身份派生失败：${e.message}`);
      console.error('   → 未写入 QWEN_IDENTITY=biz，保持原扣费身份；请先用 pnpm log-in --list-orgs 确认组织为 active + 有套餐。');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('   （扣费身份：个人版 personal —— 训练员的主动选择，已如实采用）');
  }

  // 3. 采纳凭据 + 验证刷新链（forceRefresh 内部会轮换 refresh token 并同步 .env）
  adoptCredential({
    token: cred.token,
    refreshToken: cred.refreshToken,
    user: { uid: extractUidFromToken(cred.token) },
    expiresAt: cred.expiresAt,
    refreshTokenExpiresAt: cred.refreshTokenExpiresAt,
  });
  let finalRefreshToken = cred.refreshToken;
  let verified = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const next = await forceRefresh();
      finalRefreshToken = next.refreshToken;
      verified = true;
      ok(`刷新链验证成功：新 access token ${mask(next.token)}（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
      break;
    } catch (e: any) {
      console.warn(`⚠️ 刷新链验证第 ${attempt} 次失败：${e.message}`);
    }
  }
  if (!verified) {
    console.warn('⚠️ 刷新链未验证通过 —— 已备份登录返回的原始 refresh token；若 serve 报 401 请重跑 pnpm log-in');
  }

  // 4. 备份 QWEN_KEYS（轮换后的值；未验证成功则回退原始值）
  if (!writeEnvValue('QWEN_KEYS', finalRefreshToken, REPO_ROOT)) {
    process.exitCode = 1;
    return;
  }
  ok(`refresh token 已备份到 ${path.join(REPO_ROOT, '.env')} 的 QWEN_KEYS（mode 600，git-ignored）`);

  // 4.5 落盘扣费身份（serve 启动时读取，决定签名用根凭据还是派生的企业凭据）
  if (writeEnvValue('QWEN_IDENTITY', identity, REPO_ROOT)) {
    ok(`扣费身份已写入 .env：QWEN_IDENTITY=${identity}`);
  } else {
    console.warn('⚠️ QWEN_IDENTITY 未能写入 .env（serve 将沿用旧值）');
  }
  if (identity === 'biz' && teamId) writeEnvValue('QWEN_BIZ_TEAM_ID', teamId, REPO_ROOT);

  // 5. 结果回显（与 --status 同一判据：余额属于哪个钱包 = 钱从哪个池烧）
  console.log(`\n🎉 完成！pnpm serve 即可使用（无需千问办公 App）。当前扣费身份：${identity === 'biz' ? '企业版（biz，企业积分池）' : '个人版（personal，个人积分池）'}。`);
  console.log('   查身份与双池余额：pnpm log-in --status 　列可用组织：pnpm log-in --list-orgs');
}

// 直接运行（pnpm log-in）时执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
}
