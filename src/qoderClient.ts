/**
 * qoderClient.ts — Qoder 通道转发：OpenAI Chat Completions → api3.qoder.sh。
 *
 * 与 qwenwork 的差异：
 * - host 为 api3.qoder.sh（目录在 /algo/api/v2/model/list）
 * - business.product = qoder，且 body 必须带 agent_id（缺省 agent_common）
 * - 凭据来自自包含网页登录（openapi.qoder.sh 设备授权，qoderAuth.ts 自持轮换）
 */

import { qoderSettings } from './qoderConfig';
import { getQoderToken } from './qoderAuth';
import { forwardChatCompletionsGeneric } from './forward';

/** Qoder 目录中的模型 key → 展示名（当前账号启用 qfmodel / dfmodel） */
const DISPLAY_NAMES: Record<string, string> = {
  'auto': 'Auto',
  'ultimate': 'Ultimate',
  'fast': 'Fast',
  'performance': 'Performance',
  'efficient': 'Efficient',
  'smodel': 'Sonus',
  'cmodel': 'Cantus',
  'qmodel_38max': 'Qwen3.8-Max',
  'qfmodel': 'Qwen3.8-Flash',
  'qmodel_latest': 'Qwen3.7-Max',
  'qmodel': 'Qwen3.7-Plus',
  'kmodel_latest': 'Kimi-K3',
  'kmodel': 'Kimi-K2.8-Preview',
  'gmodel': 'GLM-5.3',
  'gfmodel': 'GLM-5.3-Flash',
  'dmodel': 'DeepSeek-V4-Pro',
  'dfmodel': 'DeepSeek-Flash',
  'mmodel': 'MiniMax-M3.1-Flash',
};

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] || modelId;
}

const MACHINE_OS = `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}_${process.platform}`;

const COSY_STATIC_HEADERS: Record<string, string> = {
  'Cosy-Business-Product': 'qoder',
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
  'X-Qoder-Remote-Api-Version': '2',
  'User-Agent': 'Qoder/0.4.8',
};

const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common';

export async function forwardChatCompletions(
  body: any,
  res: any,
  authHeader?: string,
): Promise<void> {
  return forwardChatCompletionsGeneric(body, res, authHeader, {
    provider: 'qoder',
    baseUrl: qoderSettings.baseUrl,
    path: INFER_PATH,
    query: INFER_QUERY,
    staticHeaders: COSY_STATIC_HEADERS,
    product: 'qoder',
    defaultModel: qoderSettings.availableModels[0] || 'qfmodel',
    modelHeaderName: 'x-model-key',
    // Qoder 的 agent router 依赖 agent_id 定位 flow；缺失时内层 400
    // "None flow nodes found for router agent_router"（实测 qwenwork 不需要该字段）。
    bodyDefaults: { agent_id: 'agent_common' },
    getToken: getQoderToken,
    authErrorMessage: '无可用 Qoder token（请先运行 pnpm log-in:qoder 完成网页登录）',
  });
}
