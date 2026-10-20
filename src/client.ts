/**
 * qwenwork/client.ts — qwenwork 通道转发：OpenAI Chat Completions → gateway.qwenwork.cn。
 *
 * 对每个请求：
 *  1. 取 OAuth token（自动刷新）
 *  2. encryptUserInfo → cosy-key / info（每请求新 16B AES key）
 *  3. generateAuthToken → authorization（md5 绑定 body/path/时间戳，天然防重放）
 *  4. body 明文透传（去 Encode=1；必需 request_id/session_id/business 自动补）
 *  5. 流式/非流式透传
 *
 * 通用签名/解包逻辑在 forward.ts；本文件只保留 qwenwork 的通道差异。
 */

import { settings } from './config';
import { getToken, refreshDeviceToken, type QwenTokenState } from './auth';
import { buildSignMaterial, buildAuthHeaders } from './signer';
import { forwardChatCompletionsGeneric } from './forward';

/**
 * qwenwork 应用层挡位 → 展示名（注册时给 xrl-router 展示用）。
 * 2026-09 新版（App 1.2.5）：挡位名即模型名，展示名取目录 display_name 英文值。
 */
const DISPLAY_NAMES: Record<string, string> = {
  'flash': 'Standard',
  'pro': 'Pro',
  'qwen3.8-max-preview': 'Qwen3.8-Max',
};

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] || modelId;
}

/** 云端挡位目录条目（qwork 场景，2026-09 新版 `/api/v2/model/list`） */
export interface QwenCatalogModel {
  key: string;
  displayName: string;
  displayNameEn?: string;
  priceFactor?: number;
  isDefault?: boolean;
  isNew?: boolean;
  maxInputTokens?: number;
}

/**
 * 拉取云端挡位目录（`GET /api/v2/model/list?Encode=1`）。
 * 目录响应为明文 JSON（按 scene 分组），提取 qwork 场景下启用的挡位喵。
 */
export async function fetchModelCatalog(): Promise<QwenCatalogModel[]> {
  const token = await getToken();
  const material = buildSignMaterial(token);
  const url = `${settings.qwenBaseUrl}/api/v2/model/list?Encode=1`;
  const auth = buildAuthHeaders(material, { url, body: '' });
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...COSY_STATIC_HEADERS,
      'Accept': 'application/json',
      'Authorization': auth.authorization,
      'Cosy-Key': auth.cosyKey,
      'Cosy-Date': auth.cosyDate,
      'Cosy-User': auth.cosyUser,
    },
  });
  if (!res.ok) throw new Error(`qwenwork 模型目录拉取失败：HTTP ${res.status}`);
  const data: any = await res.json();
  const list: any[] = Array.isArray(data?.qwork) ? data.qwork : [];
  return list
    .filter((m) => m && typeof m.key === 'string' && m.enable !== false)
    .map((m) => ({
      key: m.key,
      displayName: m.display_name ?? m.key,
      displayNameEn: m.i18n?.display_name?.en,
      priceFactor: typeof m.price_factor === 'number' ? m.price_factor : undefined,
      isDefault: m.is_default === true,
      isNew: m.is_new === true,
      maxInputTokens: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
    }));
}

/** 从 Authorization 头取出 refresh token（xrl-router 密钥池 QWEN_KEYS 的透传） */
function extractRefreshToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const t = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  return t.startsWith('ory_rt_') ? t : null;
}

/** 从 OAuth access token（JWT）payload 解出 uid（deviceToken/refresh 响应无 user 字段） */
export function extractUidFromToken(token: string): string {
  try {
    const part = token.split('.')[1] || '';
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json.sub || json.uid || json.user_id || '';
  } catch { return ''; }
}

/** 当前平台标识（对齐官方客户端格式：`${arch}_${platform}`，如 `x86_64_win32`） */
const MACHINE_OS = `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}_${process.platform}`;

const COSY_STATIC_HEADERS: Record<string, string> = {
  'Cosy-Business-Product': 'qoder_work',
  'Cosy-Business-Type': 'agent',
  'Cosy-ClientType': '6',
  'Cosy-Data-Policy': 'disagree',
  'Cosy-MachineId': 'unknown',
  'Cosy-MachineToken': 'unknown',
  'Cosy-MachineType': '5',
  'Cosy-Scene': 'qwork',
  'Cosy-MachineOs': MACHINE_OS,
  'Cosy-Version': '1.1.59',
  'Login-Version': 'v2',
  'x-model-source': 'system',
};

const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common';

/**
 * 转发 OpenAI Chat Completions 请求到 qwenwork 推理网关。
 *
 * token 策略（方案 A）：
 * - 使用 getToken() 缓存管理（5min 缓冲，过期才刷新）
 * - 不再每请求都 refresh（避免轮换互踩导致 refresh token 失效）
 * - auth-v2.dat 文件监听自动拾取千问 App 的刷新
 * - Authorization header 透传的 refresh token 仅作灾备源
 */
export async function forwardChatCompletions(
  body: any,
  res: any,
  authHeader?: string,
): Promise<void> {
  return forwardChatCompletionsGeneric(body, res, authHeader, {
    provider: 'qwenwork',
    baseUrl: settings.qwenBaseUrl,
    path: INFER_PATH,
    query: INFER_QUERY,
    staticHeaders: COSY_STATIC_HEADERS,
    // 新版网关（1.2.5+）缺少 `business.product` 时会以 503「Model catalog unavailable」拒绝，
    // 补上 `business: { product: 'qoder_work' }` 后旧明文签名链（MD5 Cosy）仍然可用，无需 Encode=1 / WASM。
    product: 'qoder_work',
    defaultModel: 'flash',
    modelHeaderName: 'x-model-key',
    getToken,
    fallbackAuth: async (h) => {
      const rt = extractRefreshToken(h);
      if (!rt) return null;
      const token: QwenTokenState = await refreshDeviceToken(rt);
      token.user = { uid: extractUidFromToken(token.token) };
      return token;
    },
    ensureUid: (token) => {
      if (!token.user?.uid) {
        token.user = { ...token.user, uid: extractUidFromToken(token.token) };
      }
    },
    authErrorMessage: '无可用 token 源（请确保千问办公 App 已登录）',
  });
}
