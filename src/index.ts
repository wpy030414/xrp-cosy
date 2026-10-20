/**
 * qwenwork 插件入口（V24 契约）：
 *   Hono 网关 + WebSocket 插件注册（connect ws://127.0.0.1:19068/ws/plugin）。
 *
 * 通道差异（端口/模型/转发）由 config + client 提供；通用骨架见 server.ts。
 */

import { settings } from './config';
import { forwardChatCompletions, displayName } from './client';
import { startPluginServer } from './server';

export default startPluginServer({
  pluginId: 'plugin-qwenwork',
  backend: 'qwenwork',
  port: settings.port,
  baseUrl: settings.qwenBaseUrl,
  models: settings.availableModels,
  displayName,
  routerUrl: settings.xrlRouterUrl,
  forward: forwardChatCompletions,
});
