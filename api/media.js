import { getProviders } from './providers.js';

const retryable = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NARA_VIDEO_ORIGIN = 'https://api-images.bynara.id';

function responseJson(text) {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

function imageBody(body, provider) {
  return {
    model: body.model || provider.imageModel,
    prompt: String(body.prompt || '').trim(),
    size: body.size || '1024x1024',
    quality: body.quality || 'auto',
    ...(provider.id === 'nara' ? {} : { n: Math.min(Number(body.n) || 1, 4) })
  };
}

function videoBody(body, provider) {
  return {
    model: body.model || provider.videoModel,
    prompt: String(body.prompt || '').trim(),
    duration: Math.max(3, Math.min(Number.parseInt(body.duration, 10) || 5, 15)),
    ...(body.mode ? { mode: String(body.mode) } : { mode: 't2v' }),
    ...(body.resolution ? { resolution: body.resolution } : { resolution: '720p' }),
    ...(body.ratio ? { ratio: body.ratio } : { ratio: '16:9' })
  };
}

function collectUrls(data, type) {
  const urls = [];
  const dataItems = Array.isArray(data?.data) ? data.data : [];
  for (const item of dataItems) {
    if (item?.url) urls.push(item.url);
    else if (item?.b64_json) urls.push(`data:${type === 'video' ? 'video/mp4' : 'image/png'};base64,${item.b64_json}`);
    else if (item?.output_url) urls.push(item.output_url);
  }
  if (data?.url) urls.push(data.url);
  if (data?.output_url) urls.push(data.output_url);
  if (Array.isArray(data?.output)) urls.push(...data.output.filter(x => typeof x === 'string'));
  return urls;
}

function normalizeVideoUrl(url) {
  if (!url) return '';
  try { return new URL(url, NARA_VIDEO_ORIGIN).toString(); } catch { return String(url); }
}

async function fetchWithTimeout(url, options, timeoutMs = 55000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pollNaraVideo(endpoint, jobId, timeoutMs = 50000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    const statusUrl = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(jobId)}`;
    const r = await fetchWithTimeout(statusUrl, {
      headers: { Authorization: `Bearer ${process.env.NARA_API_KEY}`, Accept: 'application/json' }
    }, 8000);
    const text = await r.text();
    const data = responseJson(text);
    if (!r.ok) {
      const msg = data?.error?.message || data?.message || `Nara video status failed (${r.status})`;
      throw new Error(String(msg).slice(0, 800));
    }
    const status = String(data?.status || '').toLowerCase();
    if (status === 'succeeded' || status === 'completed' || status === 'done') {
      const urls = collectUrls(data, 'video');
      if (data?.url) urls.push(normalizeVideoUrl(data.url));
      const unique = [...new Set(urls.filter(Boolean).map(normalizeVideoUrl))];
      if (unique.length) return { urls: unique, raw: data };
      throw new Error('Nara video finished but returned no downloadable URL.');
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(String(data?.error?.message || data?.message || 'Nara video generation failed.').slice(0, 800));
    }
  }
  return { pending: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.method === 'GET') {
    const providerId = String(req.query?.providerId || '');
    const jobId = String(req.query?.jobId || '');
    if (providerId !== 'nara' || !jobId || !process.env.NARA_API_KEY) {
      return res.status(400).json({ error: 'providerId=nara and jobId are required.' });
    }
    try {
      const result = await pollNaraVideo('https://api-images.bynara.id/v1/videos', jobId, 12000);
      return res.status(200).json({ ok: true, providerId: 'nara', type: 'video', ...result });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Video status check failed.' });
    }
  }

  const body = req.body || {};
  const type = body.type === 'video' ? 'video' : 'image';
  if (!body.prompt || String(body.prompt).length > 12000) return res.status(400).json({ error: 'A valid prompt is required.' });

  const providers = getProviders().filter(p => type === 'image'
    ? (p.imageUrl || p.imageModel)
    : (p.videoUrl || p.videoModel));

  if (!providers.length) {
    return res.status(503).json({
      error: `No ${type} provider is configured. Add ${type}Url or ${type}Model to PROVIDERS_JSON, or configure a compatible built-in provider.`
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

    if (type === 'image' && !provider.imageModel && !body.model) {
      errors.push({ provider: provider.name, status: 400, message: 'This provider needs an image model. Set NARA_IMAGE_MODEL or enter a model in Media Studio.' });
      continue;
    }
    if (type === 'video' && !provider.videoModel && !body.model) {
      errors.push({ provider: provider.name, status: 400, message: 'This provider needs a video model.' });
      continue;
    }

    const payload = type === 'image' ? imageBody(body, provider) : videoBody(body, provider);

    try {
      const upstream = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload)
      }, type === 'video' && provider.id === 'nara' ? 55000 : 45000);

      const text = await upstream.text();
      const data = responseJson(text);
      if (!upstream.ok && upstream.status !== 202) {
        errors.push({ provider: provider.name, status: upstream.status, message: data?.error?.message || data?.message || `HTTP ${upstream.status}` });
        if (retryable.has(upstream.status) || upstream.status === 401 || upstream.status === 403 || upstream.status === 404) continue;
        continue;
      }

      if (type === 'video' && provider.id === 'nara' && upstream.status === 202 && data?.id) {
        try {
          const result = await pollNaraVideo(endpoint, data.id, 50000);
          if (result?.pending) {
            return res.status(202).json({ ok: true, provider: provider.name, providerId: provider.id, type, pending: true, jobId: data.id, message: 'Video is still processing. Please wait a little and retry.' });
          }
          return res.status(200).json({ ok: true, provider: provider.name, providerId: provider.id, type, ...result });
        } catch (pollErr) {
          return res.status(502).json({ error: pollErr?.message || 'Nara video polling failed.', provider: provider.name, providerId: provider.id, jobId: data.id });
        }
      }

      const urls = collectUrls(data, type);
      if (!urls.length) {
        return res.status(502).json({ error: `${provider.name} returned no usable ${type} URL.`, provider: provider.name, providerId: provider.id, raw: data });
      }

      return res.status(200).json({ provider: provider.name, providerId: provider.id, type, urls, raw: data });
    } catch (err) {
      errors.push({ provider: provider.name, status: 0, message: err?.name === 'AbortError' ? 'Provider request timed out.' : err?.message || 'Request failed.' });
    }
  }

  return res.status(503).json({ error: `All configured ${type} providers failed.`, errors });
}
