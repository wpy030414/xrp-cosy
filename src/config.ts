import dotenv from 'dotenv';

dotenv.config();

export interface Settings {
  port: number;
  availableModels: string[];

  // —— qwenwork 通道（gateway.qwenwork.cn / 智谱 GLM）——
  qwenBaseUrl: string;              // 推理网关 base
  qwenDeviceRefreshPath: string;    // deviceToken/refresh 相对路径
  qwenDevicePollPath: string;       // deviceToken/poll 相对路径（网页 device-flow 登录轮询）
  qwenAuthBase: string;             // 网页登录页 origin（…/device/selectAccounts）
  qwenWebBase: string;              // 网站域 origin（账户/组织 API：/biz/user/v1/*，gateway 上 404）
  qwenClientId: string;             // device-flow OAuth client_id（asar 常量）
  qwenLoginTimeoutMs: number;       // device-flow 登录轮询总超时
  qwenMachineId: string;            // 设备标识显式覆盖（空 = 自动生成并持久化到 .env）
  qwenRsaPublicKeyPath: string;     // asar 硬编码 RSA 公钥 PEM（未提供则用内嵌）
  qwenRefreshIntervalMs: number;    // token 自动刷新检查间隔
  qwenTarget: string;               // deviceToken/refresh 的 target 参数（"c" = 个人）
  /**
   * 计费身份：'personal'（默认，主人主动选个人，合法）| 'biz'（企业积分池）。
   * 'biz' 时运行时用 switch-team 从根 c_site 凭据派生企业 JWT 参与签名（见 bizIdentity.ts）。
   */
  qwenIdentity: 'personal' | 'biz';
  /** 企业模式指定 team（留空 = 自动挑 active + 有套餐的组织） */
  qwenBizTeamId: string;

  // —— xrl-router 集成配置 ——
  xrlRouterUrl: string;
}

/** 按通道读 env 键（qwenwork 读 QWEN_*，跨通道通用读 * 无前缀） */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

/**
 * 解析监听端口：默认端口 19067，可分别同时启动。
 * 各通道只读专用键（QWEN_PORT），不再支持共用 PORT——避免两通道取到同一端口冲突喵。
 */
function resolvePort(): number {
  return parseInt(env('QWEN_PORT', '19067'), 10);
}

export const settings: Settings = {
  port: resolvePort(),
  availableModels: (process.env.AVAILABLE_MODELS || 'flash,pro,qwen3.8-max-preview')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // —— qwenwork 通道 ——
  qwenBaseUrl: env('QWEN_BASE_URL', 'https://gateway.qwenwork.cn'),
  qwenDeviceRefreshPath: env('QWEN_DEVICE_REFRESH_PATH', '/api/v1/deviceToken/refresh'),
  qwenDevicePollPath: env('QWEN_DEVICE_POLL_PATH', '/api/v1/deviceToken/poll'),
  qwenAuthBase: env('QWEN_AUTH_BASE', 'https://gateway.qwenwork.cn'),
  qwenWebBase: env('QWEN_WEB_BASE', 'https://qwenwork.cn'),
  qwenClientId: env('QWEN_CLIENT_ID', 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'),
  qwenLoginTimeoutMs: parseInt(env('QWEN_LOGIN_TIMEOUT_MS', '300000'), 10),
  qwenMachineId: env('QWEN_MACHINE_ID', ''),
  qwenRsaPublicKeyPath: env('QWEN_RSA_PUBLIC_KEY_PATH', ''),
  qwenRefreshIntervalMs: parseInt(env('QWEN_REFRESH_INTERVAL_MS', '600000'), 10), // 10min
  qwenTarget: env('QWEN_TARGET', 'c'),
  qwenIdentity: env('QWEN_IDENTITY', 'personal') === 'biz' ? 'biz' : 'personal',
  qwenBizTeamId: env('QWEN_BIZ_TEAM_ID', ''),

  // xrl-router 集成
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
