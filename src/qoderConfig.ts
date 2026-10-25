/**
 * qoderConfig.ts — Qoder 通道配置（与 qwenwork 独立端口/模型/凭据）。
 *
 * Qoder 与 qwenwork 网关同协议族，但账号体系独立：
 * - 推理：api3.qoder.sh（Cosy 签名，国际版 Qoder 的推理主机）
 * - 凭据：openapi.qoder.sh 的设备授权（PKCE S256 + deviceToken/poll）
 *
 * 凭据由插件自持并自行轮换（`.env QODER_KEYS` 只保存 refresh token），
 * 不读取、不写回任何 Qoder App 文件 —— 与「仅自包含网页 OAuth 登录」边界一致。
 */

import dotenv from 'dotenv';

dotenv.config();

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

export interface QoderSettings {
  port: number;
  availableModels: string[];

  // —— Qoder 通道（api3.qoder.sh）——
  baseUrl: string;              // 推理网关 base
  oauthBaseUrl: string;         // 设备授权/令牌 API base（openapi.qoder.sh）
  authBaseUrl: string;          // 网页授权页 origin（/device/selectAccounts）
  clientId: string;             // 设备授权 OAuth client_id（官方客户端常量）
  devicePollPath: string;       // deviceToken/poll 相对路径
  deviceRefreshPath: string;    // deviceToken/refresh 相对路径
  userInfoPath: string;         // userinfo 相对路径（登录后展示账号）
  loginTimeoutMs: number;       // 设备授权轮询总超时
  machineId: string;            // 设备标识显式覆盖（空 = 自动生成并持久化到 .env）
  userAgent: string;            // 登录/刷新请求的 UA（对齐官方 CLI 流量）

  // —— xrl-router 集成配置 ——
  xrlRouterUrl: string;
}

export const qoderSettings: QoderSettings = {
  // 19069 已被 xrp-workbuddy 占用；Qoder 默认用 19070
  port: parseInt(env('QODER_PORT', '19070'), 10),
  availableModels: (process.env.QODER_MODELS || 'qfmodel,dfmodel')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  baseUrl: env('QODER_BASE_URL', 'https://api3.qoder.sh'),
  oauthBaseUrl: env('QODER_OAUTH_BASE', 'https://openapi.qoder.sh'),
  authBaseUrl: env('QODER_AUTH_BASE', 'https://qoder.com'),
  clientId: env('QODER_CLIENT_ID', 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'),
  devicePollPath: env('QODER_DEVICE_POLL_PATH', '/api/v1/deviceToken/poll'),
  deviceRefreshPath: env('QODER_DEVICE_REFRESH_PATH', '/api/v1/deviceToken/refresh'),
  userInfoPath: env('QODER_USERINFO_PATH', '/api/v1/userinfo'),
  loginTimeoutMs: parseInt(env('QODER_LOGIN_TIMEOUT_MS', '300000'), 10),
  machineId: env('QODER_MACHINE_ID', ''),
  userAgent: env('QODER_LOGIN_UA', 'QoderWork/1.1.75'),

  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
