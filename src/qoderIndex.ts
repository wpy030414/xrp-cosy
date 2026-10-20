/**
 * qoder 插件入口（V24 契约）。
 *
 * 与 qwenwork 独立进程、独立端口（QODER_PORT，默认 19070）与独立 plugin_id。
 */

import { qoderSettings } from './qoderConfig';
import { initQoderTokenManager } from './qoderAuth';
import { forwardChatCompletions, displayName } from './qoderClient';
import { startPluginServer } from './server';

initQoderTokenManager();

export default startPluginServer({
  pluginId: 'plugin-qoder',
  backend: 'qoder',
  port: qoderSettings.port,
  baseUrl: qoderSettings.baseUrl,
  models: qoderSettings.availableModels,
  displayName,
  routerUrl: qoderSettings.xrlRouterUrl,
  forward: forwardChatCompletions,
});
