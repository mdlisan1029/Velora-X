import { getProviders } from './providers.js';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const AGNES_API_ROOT = 'https://apihub.agnes-ai.com';
const AGNES_VIDEO_POLL_MS = 5000;

function parseJson(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 55000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function imagePayload(body, provider) {
  const payload = {
    model: body.model || provider.imageModel,
    prompt: String(body.prompt || '').trim(),
    size: body.size || '1024x1024',
  };
  if (provider.id === 'agnes') {
    payload.extra_body = { response_format: 'url' };
  } else {
    payload.quality = body.quality || 'auto';
    payload.n = Math.min(Number(body.n) || 1, 4);
  }
  return payload;
}

function parseSize(size) {
  const m = String(size || '').match(/^(\d+)x(\d+)$/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1152, height: 768 };
}

function videoPayload(body, provider) {
  if (provider.id === 'agnes') {
    const { width, height } = parseSize(body.size || '1280x720');
    const seconds = Math.max(3, Math.min(parseInt(String(body.duration || '5'), 10) || 5, 8));
    return {
      model: body.model || provider.videoModel,
      prompt: String(body.prompt || '').trim(),
      width,
      height,
      num_frames: seconds * 24 + 1,
      frame_rate: 24,
    };
  }
  return {
    model: body.model || provider.videoModel,
    prompt: String(body.prompt || '').trim(),
    duration: Math.max(3, Math.min(parseInt(String(body.duration || '5'), 10) || 5, 15)),
    size: body.size,
  };
}

function collectUrls(data, type) {
  const urls = [];
  const add = (v) => { if (typeof v === 'string' && v.trim()) urls.push(v.trim()); };
  const items = Array.isArray(data?.data) ? data.data : [];
  for (const item of items) {
    add(item?.url);
    add(item?.output_url);
    add(item?.video_url);
    if (item?.b64_json) add(`data:${type === 'video' ? 'video/mp4' : 'image/png'};base64,${item.b64_json}`);
  }
  add(data?.url);
  add(data?.output_url);
  add(data?.video_url);
  if (Array.isArray(data?.output)) data.output.forEach(add);
  if (Array.isArray(data?.videos)) data.videos.forEach((v) => add(v?.url || v?.video_url || v));
  return [...new Set(urls)];
}

function videoIdFrom(data) {
  return String(data?.video_id || data?.id || data?.data?.video_id || data?.data?.id || '').trim();
}

function statusFrom(data) {
  return String(data?.status || data?.data?.status || '').toLowerCase();
}

async function pollAgnesVideo(videoId, maxMs = 55000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const r = await fetchWithTimeout(`${AGNES_API_ROOT}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.AGNES_API_KEY}`, Accept: 'application/json' },
    }, 10000);
    const text = await r.text();
    const data = parseJson(text);
    if (!r.ok) {
      const msg = data?.error?.message || data?.message || `Agnes video status failed (${r.status})`;
      throw new Error(String(msg).slice(0, 900));
    }
    const status = statusFrom(data);
    if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
      const urls = collectUrls(data, 'video');
      if (!urls.length) throw new Error('Agnes video completed but returned no video URL.');
      return { urls, raw: data };
    }
    if (['failed', 'error', 'cancelled'].includes(status)) {
      throw new Error(String(data?.error?.message || data?.message || 'Agnes video generation failed.').slice(0, 900));
    }
    await new Promise(resolve => setTimeout(resolve, AGNES_VIDEO_POLL_MS));
  }
  return { pending: true };
}

async function callProvider(provider, type, body) {
  const endpoint = type === 'image'
    ? (provider.imageUrl || `${provider.baseUrl}/images/generations`)
    : provider.videoUrl;
  if (!endpoint) throw new Error(`No ${type} endpoint configured for ${provider.name}.`);

  const payload = type === 'image' ? imagePayload(body, provider) : videoPayload(body, provider);
  const upstream = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  }, type === 'video' ? 55000 : 55000);

  const text = await upstream.text();
  const data = parseJson(text);
  if (!upstream.ok && upstream.status !== 202) {
    const msg = data?.error?.message || data?.message || `HTTP ${upstream.status}`;
    const error = new Error(String(msg).slice(0, 900));
    error.status = upstream.status;
    throw error;
  }

  if (type === 'video') {
    const videoId = videoIdFrom(data);
    if (provider.id === 'agnes' && videoId) {
      return { ...await pollAgnesVideo(videoId), videoId };
    }
    if (provider.id === 'nara' && videoId) {
      const naraOrigin = 'https://api-images.bynara.id';
      const r = await fetchWithTimeout(`${naraOrigin}/v1/videos/${encodeURIComponent(videoId)}`, {
        headers: { Authorization: `Bearer ${provider.key}`, Accept: 'application/json' },
      }, 10000);
      const d = parseJson(await r.text());
      const urls = collectUrls(d, 'video');
      if (urls.length) return { urls, raw: d, videoId };
    }
  }

  const urls = collectUrls(data, type);
  if (!urls.length) throw new Error(`${provider.name} returned no usable ${type} URL.`);
  return { urls, raw: data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const type = body.type === 'video' ? 'video' : 'image';
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 12000) {
    return res.status(400).json({ error: 'A valid prompt is required.' });
  }

  const providers = getProviders().filter((p) => type === 'image' ? Boolean(p.imageUrl || p.imageModel) : Boolean(p.videoUrl || p.videoModel));
  if (!providers.length) {
    return res.status(503).json({ error: `No ${type} provider is configured.` });
  }

  const requestedProvider = String(body.providerId || '').trim();
  const ordered = requestedProvider
    ? [...providers].sort((a, b) => Number(b.id === requestedProvider) - Number(a.id === requestedProvider))
    : providers;

  const errors = [];
  for (const provider of ordered) {
    try {
      const result = await callProvider(provider, type, body);
      if (result?.pending) {
        return res.status(202).json({ ok: true, provider: provider.name, providerId: provider.id, type, ...result });
      }
      return res.status(200).json({
        ok: true,
        provider: provider.name,
        providerId: provider.id,
        type,
        ...result,
      });
    } catch (err) {
      errors.push({
        provider: provider.name,
        status: Number(err?.status || 0),
        message: err?.name === 'AbortError' ? 'Provider request timed out.' : String(err?.message || 'Request failed.'),
      });
      const status = Number(err?.status || 0);
      if (RETRYABLE.has(status) || status === 401 || status === 403 || status === 404) continue;
    }
  }

  return res.status(503).json({ error: `All configured ${type} providers failed.`, providers: errors });
}
