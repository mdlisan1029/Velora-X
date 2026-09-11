import { getProviders } from './providers.js';

const retryable = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function responseJson(text) {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function imageBody(body, provider) {
  return {
    model: body.model || provider.imageModel || 'gpt-image-1',
    prompt: body.prompt,
    size: body.size || '1024x1024',
    quality: body.quality || 'auto',
    n: Math.min(Number(body.n) || 1, 4)
  };
}

function videoBody(body, provider) {
  return {
    model: body.model || provider.videoModel,
    prompt: body.prompt,
    duration: body.duration,
    size: body.size
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const type = body.type === 'video' ? 'video' : 'image';
  if (!body.prompt || String(body.prompt).length > 12000) return res.status(400).json({ error: 'A valid prompt is required.' });

  const providers = getProviders().filter(p => type === 'image'
    ? (p.imageUrl || p.imageModel)
    : (p.videoUrl || p.videoModel));

  if (!providers.length) {
    return res.status(503).json({
      error: `No ${type} provider is configured. Add ${type}Url or ${type}Model to PROVIDERS_JSON, or configure a built-in compatible provider.`
    });
  }

  const requestedProvider = String(body.providerId || '');
  const ordered = requestedProvider
    ? [...providers].sort((a, b) => (a.id === requestedProvider ? -1 : b.id === requestedProvider ? 1 : 0))
    : providers;

  const errors = [];
  for (const provider of ordered) {
    const endpoint = type === 'image' ? (provider.imageUrl || `${provider.baseUrl}/images/generations`) : provider.videoUrl;
    if (!endpoint) continue;
    const payload = type === 'image' ? imageBody(body, provider) : videoBody(body, provider);

    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const text = await upstream.text();
      const data = responseJson(text);
      if (!upstream.ok) {
        errors.push({ provider: provider.name, status: upstream.status, message: data?.error?.message || data?.message || `HTTP ${upstream.status}` });
        if (retryable.has(upstream.status) || upstream.status === 401 || upstream.status === 403 || upstream.status === 404) continue;
        continue;
      }

      const urls = [];
      const dataItems = Array.isArray(data?.data) ? data.data : [];
      for (const item of dataItems) {
        if (item?.url) urls.push(item.url);
        else if (item?.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
        else if (item?.output_url) urls.push(item.output_url);
      }
      if (data?.url) urls.push(data.url);
      if (data?.output_url) urls.push(data.output_url);
      if (Array.isArray(data?.output)) urls.push(...data.output.filter(x => typeof x === 'string'));

      return res.status(200).json({
        provider: provider.name,
        providerId: provider.id,
        type,
        urls,
        raw: data
      });
    } catch (err) {
      errors.push({ provider: provider.name, status: 0, message: err.message });
    }
  }

  return res.status(503).json({ error: `All configured ${type} providers failed.`, errors });
}
