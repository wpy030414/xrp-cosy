#!/usr/bin/env tsx
/**
 * login-web.ts — qwenwork 网页登录（device flow，无需千问办公 App）。
 *
 * 1. 生成 PKCE + nonce + machineId → 拼 selectAccounts 登录 URL
 * 2. 打开系统浏览器 → 用户钉钉扫码（完成态登记在服务端，无需本地回调）
 * 3. 本地每秒轮询 deviceToken/poll → 拿到 {token, refresh_token}
 * 4. adoptCredential + forceRefresh 验证刷新链 → 备份 QWEN_KEYS 到 .env
 *
 * 对应 pnpm log-in（App 链路的旧抓取工具为 pnpm capture-key / pnpm log-in:app）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/config';
import { adoptCredential, forceRefresh, getToken } from '../src/auth';
import { extractUidFromToken } from '../src/client';
import { buildAuthUrl, buildDeviceLoginParams, DeviceFlowError, openInBrowser, pollDeviceFlow, readCredentialIdentity } from '../src/deviceLogin';
import { fetchBizOrgs, getBizToken, fetchBalance } from '../src/bizIdentity';
import { assertEnvGitIgnored, writeEnvValue } from '../src/envStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../');

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 12)}…${s.slice(-4)}` : '(无效)');

export async function main(): Promise<void> {
  console.log('🔑 xrl-router-plugin-qwenwork · 网页登录（device flow，无需千问办公 App）\n');


  // 0. 安全守卫必须最先：后续 forceRefresh 会经 syncEnvRefreshToken 无守卫写 .env
  if (!assertEnvGitIgnored(REPO_ROOT)) {
    process.exitCode = 1;
    return;
  }

  // 0.5 只读列组织：用当前凭据查可用企业组织，供 --team-id 取值（不触发登录流程）
  if (process.argv.includes('--list-orgs')) {
    let cur;
    try {
      cur = await getToken();
    } catch (e: any) {
      fail(`无法取到可用凭据：${e.message}（请先完成一次登录）`);
      process.exitCode = 1;
      return;
    }
    let orgs;
    try {
      orgs = await fetchBizOrgs(cur.token);
    } catch (e: any) {
      fail(`组织列表获取失败：${e.message}`);
      process.exitCode = 1;
      return;
    }
    const idn = readCredentialIdentity(cur.token);
    console.log(`根凭据身份：${idn.isBiz ? '企业版（biz）' : '个人版（c_site）'}  企业组织 ${orgs.length} 个\n`);
    if (!orgs.length) console.log('（无企业组织）\n');
    for (const o of orgs) {
      const usable = o.status === 'active' && o.hasActivePlan;
      console.log(`${usable ? '✅' : '❌'} ${o.orgName}（${o.teamName}）`);
      console.log(`     team_id=${o.teamId}  corpId=${o.corpId}  status=${o.status} has_active_plan=${o.hasActivePlan}`);
      console.log(usable
        ? `     → pnpm log-in --identity biz --team-id ${o.teamId}`
        : '     → 无有效席位/套餐：switch-team 会被服务端回落成个人身份，请先在网页端处理');
      console.log('');
    }
    return;
  }

  // 1. 参数解析（首跑会生成并持久化 QWEN_MACHINE_ID）
  //    身份语义（实测）：设备流铸出的根凭据**恒为 c_site（个人）** —— selectAccounts 的 query 与
  //    redirect_uri 都是白名单精确校验，身份无法从登录 URL 注入。企业身份改由
  //    POST /biz/user/v1/auth/switch-team 从根凭据**派生**（约 15 天有效，见 src/bizIdentity.ts）。
  //    --identity personal 是主人的合法选择（烧个人积分），一律放行；
  //    --identity biz 则当场派生并校验，铸不出企业就拒绝落盘，绝不静默烧个人池。
  const argOf = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
  };
  const identityRaw = argOf('--identity');
  const teamId = argOf('--team-id');
  if (identityRaw !== undefined && identityRaw !== 'biz' && identityRaw !== 'personal') {
    fail(`--identity 只接受 biz 或 personal（收到：${identityRaw}）`);
    process.exitCode = 1;
    return;
  }
  const identity = (identityRaw ?? 'personal') as 'biz' | 'personal';

  const handles = buildDeviceLoginParams(REPO_ROOT);
  const url = buildAuthUrl(handles);
  const bar = '─'.repeat(78);
  console.log(`▶ 请在浏览器完成钉钉登录（扫码）——扣费身份：${identity === 'biz' ? '企业版（biz）' : '个人版（personal）'}：`);
  console.log(`\n${bar}\n${url}\n${bar}\n`);
  if (!process.argv.includes('--no-open')) {
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
  console.log(`   根凭据身份：${idn.undecodable ? '无法判定' : idn.isBiz ? '企业版（biz）' : '个人版（c_site）'}  sub=${idn.sub.slice(0, 12) || '?'}…  ${idn.username}`);
  if (identity === 'biz') {
    console.log('▶ 用根凭据派生企业身份（POST /biz/user/v1/auth/switch-team）…');
    try {
      const { biz, org } = await getBizToken(cred.token, teamId || undefined);
      const bal = await fetchBalance(biz.jwt);
      console.log(ok(`企业身份铸造成功：${org.orgName}（${org.teamName}）`));
      console.log(`     企业 user_id=${biz.claims.sub.slice(0, 12)}…  有效期至 ${new Date(biz.expiresAt).toISOString()}`);
      console.log(`     企业钱包余额=${bal.balance}（个人池对照见 --list-orgs / /user/balance）`);
    } catch (e: any) {
      fail(`企业身份派生失败：${e.message}`);
      console.error('   → 未写入 QWEN_IDENTITY=biz，保持原扣费身份；请先用 pnpm log-in --list-orgs 确认组织为 active + 有套餐。');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('   （扣费身份：个人版 personal —— 主人的主动选择，已如实采用）');
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

  // 5. App 共存提示（检测到 App 登录态时保持不动：两条链独立，互不影响）
  if (fs.existsSync(settings.qwenOauthTokenPath)) {
    console.log(`ℹ️ 检测到千问办公 App 登录态（${settings.qwenOauthTokenPath}），已保持不动。`);
  }

  console.log(`\n🎉 完成！pnpm serve 即可使用（无需千问办公 App）。当前扣费身份：${identity === 'biz' ? '企业版（biz，企业积分池）' : '个人版（personal，个人积分池）'}。`);
  console.log('   切换身份：pnpm log-in --identity biz [--team-id <team_id>]；查可用组织：pnpm log-in --list-orgs');
}

// 直接运行（pnpm log-in）时执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
}
