#!/usr/bin/env tsx
/**
 * log-in-qoder.ts — qoder 渠道的凭据入口：自包含网页 OAuth 设备授权（无需 Qoder App）。
 *
 *   pnpm log-in:qoder            打开浏览器完成登录，凭据落 .env QODER_KEYS（refresh token）
 *   pnpm log-in:qoder --status   只读诊断：当前凭据能否刷新、有效期与账号信息
 *   pnpm log-in:qoder --no-browser  只打印授权链接，不自动打开浏览器
 *
 * 流程：
 * 1. 生成 PKCE S256 + nonce(32-hex) + machineId → 拼 qoder.com/device/selectAccounts
 * 2. 浏览器完成登录（登录页由 qoder.com 托管，插件不经手口令、不监听本地回调）
 * 3. 轮询 openapi.qoder.sh/api/v1/deviceToken/poll 取 {token, refresh_token}
 * 4. adopt → forceRefresh 验证轮换链 → QODER_KEYS 写入 .env
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qoderSettings } from '../src/qoderConfig';
import { adoptQoderCredential, fetchQoderUserInfo, forceRefreshQoder, getQoderToken, type QoderTokenState } from '../src/qoderAuth';
import { QoderDeviceFlowError, runQoderDeviceLogin } from '../src/qoderDeviceLogin';
import { writeEnvValue } from '../src/envStore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../');

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : '(无效)');
const fmtTime = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : '未知');

const hasFlag = (name: string): boolean => process.argv.includes(name);

function printConfig(): void {
  console.log('配置');
  console.log(`  授权页   = ${qoderSettings.authBaseUrl}/device/selectAccounts`);
  console.log(`  令牌 API = ${qoderSettings.oauthBaseUrl}`);
  console.log(`  推理网关 = ${qoderSettings.baseUrl}`);
  console.log(`  client_id = ${qoderSettings.clientId}`);
  console.log('  可用 env 覆盖：QODER_OAUTH_BASE · QODER_AUTH_BASE · QODER_CLIENT_ID · QODER_MACHINE_ID\n');
}

function printCredential(state: QoderTokenState): void {
  console.log('凭据');
  console.log(`  access token  = ${mask(state.token)}  有效期至 ${fmtTime(state.expiresAt)}`);
  console.log(`  refresh token = ${mask(state.refreshToken)}` +
    (state.refreshTokenExpiresAt ? `  有效期至 ${fmtTime(state.refreshTokenExpiresAt)}` : ''));
  if (state.user.uid || state.user.name) {
    const org = state.user.orgName ? `  组织=${state.user.orgName}` : '';
    console.log(`  账号 = ${state.user.name ?? '?'}（${state.user.uid || '?'}）${state.user.userType ? `  ${state.user.userType}` : ''}${org}`);
  }
  console.log('');
}

/** --status：只读诊断（会按需刷新；刷新成功即代表凭据链可用） */
async function statusMode(): Promise<boolean> {
  printConfig();
  try {
    const state = await getQoderToken();
    ok('凭据可用（刷新链正常）');
    printCredential(state);
    return true;
  } catch (e: any) {
    fail(`凭据不可用：${e.message}`);
    console.log('   修复：运行 pnpm log-in:qoder 重新完成网页登录');
    return false;
  }
}

/** 登录主流程 */
async function loginMode(openBrowser: boolean): Promise<boolean> {
  printConfig();
  console.log('正在申请设备授权…（浏览器完成登录后会自动继续）\n');

  let lastProgressAt = 0;
  let credential;
  try {
    credential = await runQoderDeviceLogin({
      openBrowser,
      repoRoot: REPO_ROOT,
      onAuthUrl: (url) => {
        console.log('请登录以下地址（已尝试自动打开浏览器）：');
        console.log(`  ${url}\n`);
        if (!openBrowser) console.log('（--no-browser：请手动复制上面的链接到浏览器）\n');
      },
      onWait: (elapsed) => {
        if (elapsed - lastProgressAt >= 10_000) {
          lastProgressAt = elapsed;
          console.log(`  …等待授权完成（${Math.round(elapsed / 1000)}s）`);
        }
      },
    });
  } catch (e: any) {
    if (e instanceof QoderDeviceFlowError) fail(e.message);
    else fail(`登录失败：${e.message}`);
    return false;
  }

  ok('网页授权完成，已取得凭据');

  const user = await fetchQoderUserInfo(credential.token);
  const state: QoderTokenState = {
    token: credential.token,
    refreshToken: credential.refreshToken,
    user: user ?? { uid: '' },
    expiresAt: credential.expiresAt,
    refreshTokenExpiresAt: credential.refreshTokenExpiresAt,
  };
  adoptQoderCredential(state);

  // 先落盘原始 refresh token：即使下一步验证失败，凭据也不丢
  if (!writeEnvValue('QODER_KEYS', state.refreshToken, REPO_ROOT)) {
    fail('QODER_KEYS 写入 .env 失败（.env 未被 git 忽略？），凭据仅存活于本次进程');
    return false;
  }
  ok('QODER_KEYS 已写入 .env（已 git-ignore 守卫）');

  // 验证刷新链：成功后 refresh token 轮换，并同步回 .env
  let refreshed: QoderTokenState;
  try {
    refreshed = await forceRefreshQoder();
    ok('刷新链验证通过（refresh token 已轮换并同步 .env）');
  } catch (e: any) {
    fail(`刷新链验证失败：${e.message}`);
    console.log('   原始凭据已保存；若服务运行中 token 到期，请重新运行 pnpm log-in:qoder');
    return false;
  }

  printCredential(refreshed);
  ok('登录完成。启动 qoder 通道：pnpm serve:qoder');
  return true;
}

async function main(): Promise<void> {
  if (hasFlag('--status')) {
    process.exitCode = (await statusMode()) ? 0 : 1;
    return;
  }
  process.exitCode = (await loginMode(!hasFlag('--no-browser'))) ? 0 : 1;
}

main().catch((e) => {
  fail(`未预期的错误：${e?.stack ?? e}`);
  process.exitCode = 1;
});
