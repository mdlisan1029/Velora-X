import { getProviders } from './providers.js';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_MESSAGE_CHARS = 120000;

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return '{}'; }
}

function providerError(provider, status, payload) {
  const raw = payload?.error?.message || payload?.message || `HTTP ${status}`;
  return {
    provider: provider.name,
    status,
    message: String(raw).slice(0, 500),
  };
}

function buildRequestBody(body, provider) {
  const out = {
    model: body.model === 'auto' || !body.model ? provider.model : body.model,
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
  };

  if (Number.isInteger(body.max_tokens) && body.max_tokens > 0) {
    out.max_tokens = Math.min(body.max_tokens, 16000);
  }
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
  if (body.stream) out.stream = true;
  return out;
}

function getErrorPayload(payloadText) {
  try { return JSON.parse(payloadText); } catch { return { message: payloadText }; }
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

    const serialized = safeJson(body.messages);
    if (serialized.length > MAX_MESSAGE_CHARS) {
      return res.status(413).json({ error: 'Message payload is too large.' });
    }

    const configured = getProviders();
    if (!configured.length) {
      return res.status(503).json({
        error: 'No providers configured. Add API keys in Vercel Environment Variables.'
      });
    }

    // Optional explicit provider ordering from the client.
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
      const url = `${provider.baseUrl}/chat/completions`;
      const controller = new AbortController();
      const timeoutMs = Math.max(8000, Math.min(Number(body.timeoutMs) || 45000, 60000));
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${provider.key}`,
            'Content-Type': 'application/json',
            'Accept': stream ? 'text/event-stream, application/json' : 'application/json',
          },
          body: JSON.stringify(buildRequestBody(body, provider)),
          signal: controller.signal,
        });

        if (!upstream.ok) {
          const text = await upstream.text();
          const payload = getErrorPayload(text);
          const err = providerError(provider, upstream.status, payload);
          errors.push(err);
          if (RETRYABLE.has(upstream.status) || upstream.status === 401 || upstream.status === 403 || upstream.status === 404) {
            continue;
          }
          continue;
        }

        if (stream && upstream.body) {
          clearTimeout(timer);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Velora-Provider', provider.id);
          res.setHeader('X-Velora-Model', body.model === 'auto' || !body.model ? provider.model : body.model);
          res.flushHeaders?.();

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          const idleMs = 45000;
          let idleTimer;
          const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(), idleMs);
          };
          resetIdle();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              resetIdle();
              if (value) res.write(decoder.decode(value, { stream: true }));
            }
          } catch (err) {
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
          model: data.model || provider.model,
          data,
          fallbackCount: errors.length,
        });
      } catch (err) {
        errors.push({ provider: provider.name, status: 0, message: err.name === 'AbortError' ? 'Request timed out' : err.message });
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    const expose = String(process.env.EXPOSE_PROVIDER_ERRORS || 'false').toLowerCase() === 'true';
    return res.status(503).json({
      error: 'All configured AI providers failed or are unavailable.',
      ...(expose ? { providers: errors } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
