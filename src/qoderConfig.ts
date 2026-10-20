/**
 * qoderConfig.ts — Qoder 通道配置（与 qwenwork 独立端口/模型/凭据）。
 *
 * Qoder 与 qwenwork 网关同协议族，但账号体系独立：
 * - 推理：api3.qoder.sh（同样的 /algo/.../agent_chat_generation + Cosy 签名）
 * - 凭据：Qoder App 的 auth.v1.dat（Electron safeStorage）
 */

import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config();

/** Qoder 默认 Electron userData 目录（Windows %APPDATA% / macOS Application Support） */
function detectQoderUserDataDir(): string {
  const envVal = process.env.QODER_USER_DATA_DIR;
  if (envVal) return envVal;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'com.qoder.app.stable');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'com.qoder.app.stable');
}

function detectQoderTokenPath(): string {
  const envVal = process.env.QODER_OAUTH_TOKEN_PATH;
  if (envVal) return envVal;
  return path.join(detectQoderUserDataDir(), 'auth.v1.dat');
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

export interface QoderSettings {
  port: number;
  availableModels: string[];
  baseUrl: string;
  oauthTokenPath: string;
  userDataDir: string;
  keychainService: string;
  keychainAccount: string;
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
  oauthTokenPath: detectQoderTokenPath(),
  userDataDir: detectQoderUserDataDir(),
  // macOS Keychain 名称未在真机验证；可用 QODER_KEYCHAIN_* 覆盖
  keychainService: env('QODER_KEYCHAIN_SERVICE', 'Qoder Safe Storage'),
  keychainAccount: env('QODER_KEYCHAIN_ACCOUNT', 'Qoder Key'),

  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
