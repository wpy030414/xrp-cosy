#!/usr/bin/env tsx
/**
 * credits.ts — 诊断：当前扣费身份与双池余额（个人 / 企业）。
 *
 * 扣费归属只由签名凭据的身份决定（c_site = 个人池，biz = 企业池），
 * 而服务端返回 200 并不告诉你钱从哪个池走 —— 本脚本用余额差把它变成可观测项。
 *
 * 用法：pnpm credits
 */

import { settings } from '../src/config';
import { getToken } from '../src/auth';
import { readCredentialIdentity } from '../src/deviceLogin';
import { fetchBizOrgs, getBizToken, fetchBalance, peekBizToken, type BizOrg } from '../src/bizIdentity';

const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`❌ ${s}`);

async function main(): Promise<void> {
  console.log('🧭 qwenwork 扣费身份诊断\n');
  console.log(`配置：QWEN_IDENTITY=${settings.qwenIdentity}` +
    `${settings.qwenIdentity === 'biz' ? `  QWEN_BIZ_TEAM_ID=${settings.qwenBizTeamId || '(自动挑选)'}` : ''}\n`);

  const root = await getToken();
  const idn = readCredentialIdentity(root.token);
  console.log('根凭据（设备流铸出，恒 c_site）');
  console.log(`  身份 = ${idn.undecodable ? '无法判定' : idn.isBiz ? '企业版（biz）' : '个人版（c_site）'}  user_id=${idn.sub.slice(0, 12)}…  ${idn.username}`);
  console.log(`  有效期至 = ${new Date(root.expiresAt).toISOString()}`);
  const pBal = await fetchBalance(root.token);
  console.log(`  个人池余额 = ${pBal.balance}\n`);

  let orgs: BizOrg[] = [];
  try { orgs = await fetchBizOrgs(root.token); } catch (e: any) { console.warn(`⚠️ 组织列表获取失败：${e.message}`); }
  if (orgs.length) {
    console.log(`企业组织 ${orgs.length} 个：`);
    for (const o of orgs) {
      console.log(`  ${o.status === 'active' && o.hasActivePlan ? '✅' : '❌'} ${o.orgName}（${o.teamName}）` +
        `  team_id=${o.teamId}  status=${o.status}  has_active_plan=${o.hasActivePlan}`);
    }
    console.log('');
  }

  try {
    const cached = peekBizToken();
    const { biz, org } = cached
      ? { biz: cached, org: { orgName: cached.claims.bizOrgId } as any }
      : await getBizToken(root.token, settings.qwenBizTeamId || undefined);
    const eBal = await fetchBalance(biz.jwt);
    console.log(`企业凭据（switch-team 派生${cached ? '，命中缓存' : '，本次新铸'}）`);
    console.log(`  aud=biz  企业 user_id=${biz.claims.sub.slice(0, 12)}…  org_id=${biz.claims.bizOrgId.slice(0, 12)}…`);
    console.log(`  组织 = ${org?.orgName ?? biz.claims.bizOrgId}  有效期至 = ${new Date(biz.expiresAt).toISOString()}`);
    console.log(`  企业池余额 = ${eBal.balance}\n`);
    if (settings.qwenIdentity === 'biz') {
      ok(`当前 serve 会以【企业身份】签名 → 烧企业积分池（${org?.orgName ?? '企业组织'}）`);
    } else {
      ok('当前 serve 以【个人身份】签名 → 烧个人积分池（个人版是合法选择；要切企业：pnpm log-in --identity biz）');
    }
  } catch (e: any) {
    fail(`企业凭据不可用：${e.message}`);
    if (settings.qwenIdentity === 'biz') {
      console.error('  → 已拒绝降级：biz 模式下铸造失败会直接返回 401，不会偷偷烧个人积分');
      console.error('  → 用 pnpm log-in --list-orgs 看组织可用性；无 active+有套餐的组织请先在网页端处理席位');
    }
  }
}

main().catch((e) => { fail(`未捕获异常：${e.message}`); process.exit(1); });
