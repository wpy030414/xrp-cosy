#!/usr/bin/env tsx
/**
 * log-in-qoder.ts — qoder 渠道的凭据入口：App 登录态拾取 + 诊断（**全程只读**）。
 *
 * qoder 与 qwenwork 的凭据模型不同：本渠道**没有** device-flow 登录，登录态由 Qoder App
 * 自己维护（`auth.v1.dat`，Electron safeStorage），refresh token 的轮换权归 App。
 * 所以这里的「log-in」= 确认插件能不能读到一份有效凭据，并把不可读的原因分级说清楚。
 *
 *   pnpm log-in:qoder            诊断 Qoder 登录态 + 打印将注册的模型列表
 *
 * 只读承诺（AGENTS.md 边界，脚本自身可验证）：
 * - 只调用 `decryptSafeStorageJson`（读），绝不调用任何写接口，绝不 refresh 上游
 * - 运行前后对比 `auth.v1.dat` 的 mtime，若发生变化则**报错退出**——证明本次运行没碰过 App 文件
 */

import fs from 'node:fs';
import { qoderSettings } from '../src/qoderConfig';
import { getQoderToken } from '../src/qoderAuth';
import { displayName } from '../src/qoderClient';

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const mask = (s: string): string => (s && s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : '(无效)');

/** 已知展示名映射的候选挡位（与 src/qoderClient.ts DISPLAY_NAMES 对齐；诊断脚本内联一份避免动生产代码） */
const KNOWN_MODELS = ['qfmodel', 'dfmodel', 'gfmodel', 'dmodel', 'mmodel'];

/** 只读：文件指纹（不存在则 null） */
function fingerprint(): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(qoderSettings.oauthTokenPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch { return null; }
}

function printEnvHint(): void {
  console.log('配置');
  console.log(`  登录态文件 = ${qoderSettings.oauthTokenPath}`);
  console.log(`  userData   = ${qoderSettings.userDataDir}`);
  if (process.platform === 'darwin') {
    console.log(`  Keychain   = ${qoderSettings.keychainService} / ${qoderSettings.keychainAccount}`);
  }
  console.log('  可用 env 覆盖：QODER_OAUTH_TOKEN_PATH · QODER_USER_DATA_DIR · QODER_KEYCHAIN_SERVICE · QODER_KEYCHAIN_ACCOUNT\n');
}

function printModels(): void {
  const list = qoderSettings.availableModels;
  console.log(`将注册给 xrl-router 的模型（${list.length} 个，QODER_MODELS 可覆盖）：`);
  for (const m of list) console.log(`  ${m}  →  ${displayName(m)}`);
  const extras = KNOWN_MODELS.filter((m) => !list.includes(m));
  if (extras.length) {
    console.log(`  （另有已知的未启用挡位：${extras.map((m) => `${m}=${displayName(m)}`).join('、')}）`);
  }
  console.log('');
}

async function main(): Promise<void> {
  console.log('🔑 xrl-router-plugin · qoder 渠道凭据诊断（只读，不刷新、不写回）\n');
  printEnvHint();
  printModels();

  const before = fingerprint();
  if (!before) {
    fail(`未找到 Qoder 登录态：${qoderSettings.oauthTokenPath}`);
    console.error('   → 请打开 Qoder App 完成登录（首次登录会生成 auth.v1.dat），再重跑本命令');
    console.error('   → 或登录的是别的目录：用 QODER_OAUTH_TOKEN_PATH 指定 auth.v1.dat');
    process.exitCode = 1;
    return;
  }
  console.log(`▶ 解密 ${qoderSettings.oauthTokenPath}（若弹钥匙串授权请点「允许」）…`);

  let state;
  try {
    state = await getQoderToken();
  } catch (e: any) {
    fail(`读取失败：${e.message}`);
    if (/已过期/.test(e.message)) {
      console.error('   → 本通道只读凭据，不能替 App 刷新：打开 Qoder App 让它重新登录续期，再重跑');
    } else if (/v10|safeStorage|Keychain|DPAPI|powershell/.test(e.message)) {
      console.error('   → 解密失败：确认登录态来自本机同一用户；macOS 需在钥匙串弹窗点「允许」，');
      console.error('     或本机 Qoder 的 Keychain 条目名不同，用 QODER_KEYCHAIN_SERVICE/ACCOUNT 覆盖');
    } else {
      console.error('   → 排查：Qoder App 是否已登录？auth.v1.dat 是否被别的账号覆盖过？');
    }
    process.exitCode = 1;
    return;
  }

  ok(`登录用户：${state.user.name || state.user.uid}（${state.user.email || '无邮箱'}）`);
  console.log(`   access token：${mask(state.token)}（前缀 ${state.token.slice(0, 3)}，opaque，非 JWT）`);
  console.log(`   有效期至：${state.expiresAt > 0 ? new Date(state.expiresAt).toISOString() : '未知'}` +
    `  ${state.expiresAt > Date.now() ? '（剩余 ' + Math.round((state.expiresAt - Date.now()) / 3600_000) + 'h）' : '（已过期）'}`);
  if (state.refreshTokenExpiresAt) {
    console.log(`   refresh token 有效期至：${new Date(state.refreshTokenExpiresAt).toISOString()}（轮换权归 Qoder App，插件不消费）`);
  }

  // 只读自证：mtime/size 未变 = 本次运行没写过 App 的登录态文件
  const after = fingerprint();
  if (!after || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    fail('auth.v1.dat 在本次运行中发生了变化——违反只读边界，请检查是否有其他进程（Qoder App 自身刷新）在写');
    process.exitCode = 1;
    return;
  }
  ok('只读校验通过：auth.v1.dat 的 mtime/size 未变化（本命令未写入任何 App 文件）');

  console.log('\n🎉 qoder 通道凭据可用，`pnpm serve:qoder` 即可启动（默认端口 %d）。', qoderSettings.port);
}

main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
