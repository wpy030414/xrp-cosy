/**
 * server.ts — 通道共用的 Hono 网关 + 端口释放 + 插件注册启动骨架。
 *
 * 具体通道只提供：pluginId / backend / port / models / displayName / forward。
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { spawn } from 'child_process';
import { PluginClient } from './pluginClient';

export interface PluginServerOptions {
  pluginId: string;
  /** 日志与健康检查中的通道名（qwenwork / qoder） */
  backend: string;
  port: number;
  /** 健康检查展示的上游 base */
  baseUrl: string;
  models: string[];
  displayName: (modelId: string) => string;
  routerUrl: string;
  forward: (body: any, res: any, authHeader?: string) => Promise<void>;
}

export function createApp(opts: PluginServerOptions): Hono {
  const app = new Hono();

  app.use('*', cors());

  app.get('/', (c) => {
    return c.json({
      version: '0.2.0',
      service: opts.pluginId,
      status: 'running',
      mode: 'plugin',
      backend: opts.backend,
      endpoints: { chat: '/v1/chat/completions', health: '/health' },
    });
  });

  app.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      backend: opts.backend,
      plugin_mode: true,
      base_url: opts.baseUrl,
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json();
    const authHeader = c.req.header('authorization');

    // Hono 的 res 不直接暴露 Node.js ServerResponse，需要用 stream 方式处理 SSE
    // 使用 c.body() 配合 ReadableStream 或直接用 c.res
    return new Promise<Response>((resolve) => {
      // 构造一个仿 Response 写入器，桥接 Hono 和 forward 的 res.write/res.end 模式
      const chunks: (string | Buffer)[] = [];
      let statusCode = 200;
      const headers = new Map<string, string>();
      let headersSent = false;
      let ended = false;

      const mockRes: any = {
        writableEnded: false,
        headersSent: false,
        socket: null,
        on(event: string, _cb: () => void) {
          // Hono 场景下 close 事件由 AbortController 处理
          if (event === 'close') {
            // 暂存，后续由 abort 触发
          }
        },
        removeListener(_event: string, _cb: () => void) {},
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        setHeader(name: string, value: string) {
          headers.set(name.toLowerCase(), value);
        },
        type(contentType: string) {
          headers.set('content-type', contentType);
          return mockRes;
        },
        json(data: any) {
          if (ended) return;
          headers.set('content-type', 'application/json');
          const body = JSON.stringify(data);
          headersSent = true;
          mockRes.headersSent = true;
          ended = true;
          mockRes.writableEnded = true;
          resolve(new Response(body, {
            status: statusCode,
            headers: Object.fromEntries(headers),
          }));
        },
        send(data: string) {
          if (ended) return;
          headersSent = true;
          mockRes.headersSent = true;
          ended = true;
          mockRes.writableEnded = true;
          resolve(new Response(data, {
            status: statusCode,
            headers: Object.fromEntries(headers),
          }));
        },
        write(chunk: string | Buffer) {
          if (ended) return;
          chunks.push(chunk);
        },
        end() {
          if (ended) return;
          headersSent = true;
          mockRes.headersSent = true;
          ended = true;
          mockRes.writableEnded = true;
          const bodyStr = chunks.join('');
          resolve(new Response(bodyStr, {
            status: statusCode,
            headers: Object.fromEntries(headers),
          }));
        },
        flush() {
          // no-op for Hono (no Express compression middleware)
        },
      };

      opts.forward(body, mockRes, authHeader);
    });
  });

  return app;
}

/**
 * 检测并释放指定端口（跨平台支持）
 * 排除自身 PID（process.pid）：端口被本进程占用时（如热重启/重复启动），不自杀喵～
 */
async function killPortProcess(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  const selfPid = String(process.pid);
  return new Promise((resolve) => {
    if (isWindows) {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (data) => { output += data.toString(); });
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== selfPid && !pids.includes(pid)) pids.push(pid);
          }
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('close', () => resolve());
      });
    } else {
      const lsof = spawn('lsof', ['-ti', `:${port}`]);
      let pids = '';
      lsof.stdout.on('data', (data) => { pids += data.toString(); });
      lsof.stderr.on('data', () => {});
      lsof.on('close', (code) => {
        if (code === 0 && pids.trim()) {
          const pidList = pids.trim().split('\n').filter((p) => p.trim() && p.trim() !== selfPid);
          if (pidList.length === 0) return resolve();
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
    }
  });
}

async function startServer(opts: PluginServerOptions, app: Hono): Promise<void> {
  await killPortProcess(opts.port);

  serve({
    fetch: app.fetch,
    port: opts.port,
    hostname: '0.0.0.0',
  }, (info) => {
    console.log(`[${opts.backend}] listening on http://localhost:${info.port} (pid ${process.pid})`);

    const pluginClient = new PluginClient({
      routerUrl: opts.routerUrl,
      pluginId: opts.pluginId,
      port: opts.port,
      models: opts.models,
      displayName: opts.displayName,
    });

    const shutdown = () => {
      pluginClient.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

/** 返回 Hono app 供导出/测试；后台启动监听与插件注册 */
export function startPluginServer(opts: PluginServerOptions): Hono {
  const app = createApp(opts);
  void startServer(opts, app);
  return app;
}
