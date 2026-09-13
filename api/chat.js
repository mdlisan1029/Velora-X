import { getProviders } from './providers.js';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_MESSAGE_CHARS = 120000;

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return '{}'; }
}

function getErrorPayload(payloadText) {
  try { return JSON.parse(payloadText); } catch { return { message: payloadText }; }
}

function providerError(provider, status, payload, model) {
  const raw = payload?.error?.message || payload?.message || `HTTP ${status}`;
  return { provider: provider.name, model, status, message: String(raw).slice(0, 700) };
}

function uniqueModels(provider, requestedModel) {
  const candidates = [];
  if (requestedModel && requestedModel !== 'auto') candidates.push(String(requestedModel));
  if (provider.model && provider.model !== 'auto') candidates.push(String(provider.model));
  if (Array.isArray(provider.models)) candidates.push(...provider.models.map(String));
  return candidates.filter((m, i, arr) => m && arr.indexOf(m) === i);
}

function buildRequestBody(body, provider, model) {
  const isGemini38 = provider.id === 'gemini' && /^gemini-3\.8-flash(?:$|-)/i.test(model);
  const out = { model, messages: body.messages };

  // Gemini 3.8 currently recommends its native thinking configuration and
  // explicitly removes legacy sampling parameters such as temperature/top_p.
  if (!isGemini38) {
    out.temperature = typeof body.temperature === 'number' ? body.temperature : 0.7;
    if (body.top_p != null) out.top_p = body.top_p;
  }

  if (Number.isInteger(body.max_tokens) && body.max_tokens > 0) {
    out.max_tokens = Math.min(body.max_tokens, 16000);
  }
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
  if (body.stream) out.stream = true;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    if (safeJson(body.messages).length > MAX_MESSAGE_CHARS) {
      return res.status(413).json({ error: 'Message payload is too large.' });
    }

    const configured = getProviders();
    if (!configured.length) {
      return res.status(503).json({ error: 'No providers configured. Add API keys in Vercel Environment Variables.' });
    }

    const order = Array.isArray(body.providerOrder) ? body.providerOrder.map(String) : [];
    const providers = order.length
      ? [...configured].sort((a, b) => {
          const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        })
      : configured;

    const errors = [];
    const stream = Boolean(body.stream);

    for (const provider of providers) {
      const requested = body.model === 'auto' ? '' : String(body.model || '');
      const models = uniqueModels(provider, requested);
      if (!models.length) continue;

      for (const model of models) {
        const url = `${provider.baseUrl}/chat/completions`;
        const controller = new AbortController();
        const timeoutMs = Math.max(8000, Math.min(Number(body.timeoutMs) || 45000, 60000));
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const upstream = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${provider.key}`,
              'Content-Type': 'application/json',
              Accept: stream ? 'text/event-stream, application/json' : 'application/json',
            },
            body: JSON.stringify(buildRequestBody(body, provider, model)),
            signal: controller.signal,
          });

          if (!upstream.ok) {
            const text = await upstream.text();
            const payload = getErrorPayload(text);
            errors.push(providerError(provider, upstream.status, payload, model));
            continue;
          }

          if (stream && upstream.body) {
            clearTimeout(timer);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Velora-Provider', provider.id);
            res.setHeader('X-Velora-Model', model);
            res.flushHeaders?.();

            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            let idleTimer;
            const resetIdle = () => {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(() => controller.abort(), 45000);
            };
            resetIdle();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                resetIdle();
                if (value) res.write(decoder.decode(value, { stream: true }));
              }
            } catch {
              if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: 'Upstream stream timed out or closed unexpectedly.' })}\n\n`);
              }
            } finally {
              clearTimeout(idleTimer);
              reader.releaseLock();
              if (!res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
              }
            }
            return;
          }

          const data = await upstream.json();
          clearTimeout(timer);
          return res.status(200).json({
            provider: provider.name,
            providerId: provider.id,
            model: data.model || model,
            data,
            fallbackCount: errors.length,
          });
        } catch (err) {
          errors.push({
            provider: provider.name,
            model,
            status: 0,
            message: err?.name === 'AbortError' ? 'Request timed out' : (err?.message || 'Request failed'),
          });
          continue;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    const expose = String(process.env.EXPOSE_PROVIDER_ERRORS || 'false').toLowerCase() === 'true';
    return res.status(503).json({
      error: 'All configured AI providers failed or are unavailable.',
      ...(expose ? { providers: errors } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Internal server error' });
  }
}
