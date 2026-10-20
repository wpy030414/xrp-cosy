/**
 * forward.ts — OpenAI Chat Completions → Cosy 网关的通用转发核心。
 *
 * qwenwork / qoder 两个通道共享：
 *  - Cosy 签名（每请求新 AES key）
 *  - 外层 SSE 解包（`{"body":"<inner>","statusCodeValue":200}`）
 *  - 流式 tool_calls 标准化 / 非流式 delta 聚合
 * 通道差异（host、路径、business.product、必需 body 字段、静态头）由调用方通过 options 注入。
 */

import { randomUUID } from 'node:crypto';
import { buildSignMaterial, buildAuthHeaders, type SignToken } from './signer';

export interface ForwardOptions {
  /** 日志前缀（如 qwenwork / qoder） */
  provider: string;
  baseUrl: string;
  path: string;
  query?: string;
  staticHeaders: Record<string, string>;
  /** 缺省 business.product */
  product: string;
  /** body 缺省 model */
  defaultModel: string;
  /** 从 body.model 读取模型 key 并写入该头（qwenwork/qoder 均为 x-model-key） */
  modelHeaderName?: string;
  /** 仅在客户端未提供时补齐的 body 字段（如 qoder 的 agent_id） */
  bodyDefaults?: Record<string, unknown>;
  getToken: () => Promise<SignToken>;
  /** token 全失效时的灾备源（qwenwork 用 Router 透传的 refresh token） */
  fallbackAuth?: (authHeader: string | undefined) => Promise<SignToken | null>;
  /** 补充 uid（qwenwork 从 JWT 解出） */
  ensureUid?: (token: SignToken) => void;
  /** 无可用 token 时的 401 文案 */
  authErrorMessage: string;
}

export async function forwardChatCompletionsGeneric(
  body: any,
  res: any,
  authHeader: string | undefined,
  opts: ForwardOptions,
): Promise<void> {
  const prefix = `[${opts.provider}]`;
  const model = body.model || opts.defaultModel;
  const isStream = body.stream === true;

  // 客户端断开时取消上游请求，避免无谓消耗 + 写已关闭的 res
  // 注意：Node.js 24 下 req.on('close') 在请求体消费完就触发（不等连接关闭）
  // 所以必须监听 res.on('close')（连接真正关闭时才触发）
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.on('close', onClientClose);

  let token: SignToken;
  try {
    token = await opts.getToken();
  } catch (_e: any) {
    if (opts.fallbackAuth) {
      try {
        const fallbackToken = await opts.fallbackAuth(authHeader);
        if (!fallbackToken) {
          res.status(401).json({ error: { message: opts.authErrorMessage } });
          return;
        }
        token = fallbackToken;
        console.log(`${prefix} 用密钥池 refresh token 灾备成功`);
      } catch (e2: any) {
        res.status(401).json({ error: { message: `所有 token 源均失效: ${e2.message}` } });
        return;
      }
    } else {
      res.status(401).json({ error: { message: opts.authErrorMessage } });
      return;
    }
  }
  opts.ensureUid?.(token);

  // body：明文透传 + 补 request_id/session_id
  // business 是网关定位模型目录的必需字段（缺省 → qwenwork 503 Model catalog unavailable）
  const forwardBody: any = {
    ...(opts.bodyDefaults ?? {}),
    ...body,
    model,
    request_id: body.request_id || randomUUID(),
    session_id: body.session_id || randomUUID(),
    business: body.business || { product: opts.product },
  };

  // 去掉可能带入的 Encode=1 相关字段（明文网关不需要）
  delete forwardBody.encode;
  delete forwardBody.extra_body;

  const bodyStr = JSON.stringify(forwardBody);
  const material = buildSignMaterial(token);
  const url = `${opts.baseUrl}${opts.path}${opts.query ?? ''}`;
  const auth = buildAuthHeaders(material, { url, body: bodyStr });

  const headers: Record<string, string> = {
    ...opts.staticHeaders,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': auth.authorization,
    'Cosy-Key': auth.cosyKey,
    'Cosy-Date': auth.cosyDate,
    'Cosy-User': auth.cosyUser,
  };
  if (opts.modelHeaderName) headers[opts.modelHeaderName] = model;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: abortController.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      if (!res.headersSent) {
        res.status(upstream.status).type('application/json')
          .send(text || JSON.stringify({ error: { message: `${opts.provider} upstream ${upstream.status}` } }));
      }
      return;
    }

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sentDone = false;

    const emitChunk = (inner: string): void => {
      // 去重：上游本身会发 [DONE]（chunk 数最后一行 data:{}），我们自己只发一次
      if (inner === '{}' || /\[DONE\]/.test(inner)) return;
      res.write(`data: ${inner}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    };

    // tool_calls 分片标准化（适配 xrl-router 的转换逻辑）：
    // xrl-router 把「该 index 的首个 chunk」解析进 content_block_start 的 input（其余分片发 input_json_delta）。
    // 因此：首 chunk 必须发空 arguments（避免 "{" 被消耗），所有 arguments 片段（含首 chunk 的）原样发出，
    // 保证 partial_json 序列以 "{" 开头、拼接后是完整 JSON。
    const seenToolCallIndex = new Set<number>();

    const flushLine = (line: string): void => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      try {
        const outer = JSON.parse(t.slice(5));
        // body 字段可能是 SSE 格式（"data: {...}"）或裸 JSON，统一剥层
        let inner = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? {});
        const innerTrim = inner.trim();
        if (innerTrim.startsWith('data:')) {
          inner = innerTrim.slice(5).trim();
          if (inner === '[DONE]' || inner === '{}') return;
        }
        const raw = JSON.parse(inner);
        const choice = raw.choices?.[0];
        const delta = choice?.delta;

        if (delta?.tool_calls) {
          const out: any[] = [];
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!seenToolCallIndex.has(i)) {
              seenToolCallIndex.add(i);
              // 首 chunk：只带 id/type/name，arguments 置空（触发 content_block_start）
              out.push({
                id: tc.id || '',
                type: tc.type || 'function',
                index: i,
                function: { name: tc.function?.name || '', arguments: '' },
              });
            }
            // arguments 片段原样发出（含首 chunk 的 "{"），作为 input_json_delta 续片
            if (tc.function?.arguments) {
              out.push({ index: i, function: { arguments: tc.function.arguments } });
            }
          }
          emitChunk(JSON.stringify({ ...raw, choices: [{ ...choice, delta: { tool_calls: out } }] }));
        } else {
          emitChunk(inner);
        }
      } catch { /* 忽略无法解析的行 */ }
    };

    // —— 非流式：聚合所有 chunk 为完整 OpenAI JSON ——
    if (!isStream) {
      const parts: any[] = [];
      const usage: any = {};
      let innerId = '';
      let finishReason = 'stop';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const t = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (t.startsWith('data:')) {
              const payload = t.slice(5);
              if (payload === '[DONE]' || payload === '{}') continue;
              try {
                const outer = JSON.parse(payload);
                // body 字段可能是 SSE 格式（"data: {...}"）或裸 JSON，统一剥层
                let bodyStr = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? {});
                const bodyTrim = bodyStr.trim();
                if (bodyTrim.startsWith('data:')) {
                  bodyStr = bodyTrim.slice(5).trim();
                  if (bodyStr === '[DONE]' || bodyStr === '{}') continue;
                }
                const inner = JSON.parse(bodyStr);
                if (inner.id) innerId = inner.id;
                if (inner.choices?.[0]) {
                  const choice = inner.choices[0];
                  if (choice.delta) parts.push(choice.delta);
                  if (choice.finish_reason) finishReason = choice.finish_reason;
                }
                if (inner.usage) Object.assign(usage, inner.usage);
              } catch { /* 跳过无法解析的行 */ }
            }
          }
        }
        // 合并 delta：content/reasoning_content 拼接，tool_calls 按 index 合并
        const content = parts.map(d => d.content).filter(Boolean).join('');
        const reasoning = parts.map(d => d.reasoning_content).filter(Boolean).join('');

        // tool_calls：按 index 分组，拼接 arguments，保留首个 chunk 的 id/name/type
        const toolCallMap = new Map<number, any>();
        for (const d of parts) {
          if (!d.tool_calls) continue;
          for (const tc of d.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCallMap.has(i)) {
              toolCallMap.set(i, {
                id: tc.id || '',
                type: tc.type || 'function',
                index: i,
                function: { name: tc.function?.name || '', arguments: '' },
              });
            }
            const merged = toolCallMap.get(i);
            if (tc.id) merged.id = tc.id;
            if (tc.type) merged.type = tc.type;
            if (tc.function?.name) merged.function.name = tc.function.name;
            if (tc.function?.arguments) merged.function.arguments += tc.function.arguments;
          }
        }

        const msg: any = { role: 'assistant' };
        if (content) msg.content = content;
        if (reasoning) msg.reasoning_content = reasoning;
        if (toolCallMap.size > 0) {
          msg.tool_calls = [...toolCallMap.values()].sort((a, b) => a.index - b.index);
        }

        if (!res.headersSent) {
          res.json({
            id: innerId || `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, message: msg, finish_reason: finishReason }],
            usage: Object.keys(usage).length ? usage : undefined,
          });
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        console.error(`${prefix} 非流式聚合失败:`, e.message);
        if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${e.message}` } });
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // —— 流式：解包透传 ——
    // 上游响应是外层 SSE：data:{"headers":{...},"body":"<内层OpenAI chunk JSON>","statusCodeValue":200}
    // 解包成标准 OpenAI SSE 透传
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          flushLine(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      }
      if (buf.trim()) flushLine(buf);
      if (!sentDone && !res.writableEnded) { res.write('data: [DONE]\n\n'); sentDone = true; }
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error(`${prefix} 流读取失败:`, e.message);
    } finally {
      if (!res.writableEnded) res.end();
    }
  } catch (error: any) {
    // 客户端主动断开 → 正常终止
    if (error.name === 'AbortError') {
      if (!res.writableEnded) res.end();
      return;
    }
    // 已发过头 → 只能静默结束
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(502).json({ error: { message: `Upstream error: ${error.message}` } });
  } finally {
    res.removeListener('close', onClientClose);
  }
}
