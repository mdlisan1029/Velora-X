import { getProviders } from './providers.js';

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const AGNES_HOST = 'apihub.agnes-ai.com';
const AGNES_BASE = `https://${AGNES_HOST}`;

function parseJson(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
}

function isAgnes(provider) {
  const id = String(provider?.id || '').toLowerCase();
  const name = String(provider?.name || '').toLowerCase();
  const base = String(provider?.baseUrl || '').toLowerCase();
  return id.includes('agnes') || name.includes('agnes') || base.includes('agnes-ai.com');
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

async function fetchTimeout(url, options = {}, ms = 55000) {
  const { controller, timer } = timeoutSignal(ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function imageBody(body, provider) {
  const payload = {
    model: body.model || provider.imageModel,
    prompt: String(body.prompt || '').trim(),
    size: body.size || '1024x1024'
  };
  if (isAgnes(provider)) {
    payload.n = 1;
    payload.extra_body = { response_format: 'url' };
  } else {
    payload.quality = body.quality || 'auto';
    payload.n = Math.min(Number(body.n) || 1, 4);
  }
  return payload;
}

function parseSize(size) {
  const m = String(size || '1152x768').match(/^(\d+)x(\d+)$/i);
  if (!m) return { width: 1152, height: 768 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

function videoFrames(durationSeconds) {
  const seconds = Math.max(3, Math.min(Number.parseFloat(durationSeconds) || 5, 18));
  const wanted = Math.round(seconds * 24);
  const n = Math.max(1, Math.min(55, Math.round((wanted - 1) / 8)));
  return 8 * n + 1;
}

function videoBody(body, provider) {
  if (isAgnes(provider)) {
    const { width, height } = parseSize(body.size || '1152x768');
    return {
      model: body.model || provider.videoModel || 'agnes-video-v2.0',
      prompt: String(body.prompt || '').trim(),
      width,
      height,
      num_frames: videoFrames(body.duration),
      frame_rate: 24
    };
  }

  return {
    model: body.model || provider.videoModel,
    prompt: String(body.prompt || '').trim(),
    duration: Math.max(3, Math.min(Number.parseFloat(body.duration) || 5, 15)),
    ...(body.mode ? { mode: String(body.mode) } : {}),
    ...(body.resolution ? { resolution: body.resolution } : {}),
    ...(body.ratio ? { ratio: body.ratio } : {})
  };
}

function collectMediaUrls(data, type) {
  const urls = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) urls.push(value.trim());
  };
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      push(item?.url);
      push(item?.video_url);
      push(item?.output_url);
      if (item?.b64_json) push(`data:${type === 'video' ? 'video/mp4' : 'image/png'};base64,${item.b64_json}`);
    }
  }
  push(data?.url);
  push(data?.video_url);
  push(data?.output_url);
  if (Array.isArray(data?.output)) data.output.forEach(push);
  return [...new Set(urls)];
}

function providerHostnames(providers) {
  const hosts = new Set([AGNES_HOST, 'storage.googleapis.com']);
  for (const p of providers) {
    for (const raw of [p?.baseUrl, p?.imageUrl, p?.videoUrl]) {
      try { if (raw) hosts.add(new URL(raw).hostname); } catch {}
    }
  }
  return hosts;
}

function assertAllowedUrl(raw, providers) {
  const u = new URL(String(raw || ''));
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) media URLs are allowed.');
  if (!providerHostnames(providers).has(u.hostname)) throw new Error('Media download host is not allowed.');
  return u;
}

function agnesPollUrl(videoId) {
  return `${AGNES_BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
}

function proxyUrlForVideo(providerId, videoId) {
  return `/api/media?stream=video&providerId=${encodeURIComponent(providerId)}&videoId=${encodeURIComponent(videoId)}`;
}

function normalizeExternalUrlForDisplay(url, type, providerId) {
  if (!url) return '';
  if (String(url).startsWith('data:')) return url;
  return `/api/media?proxy=1&type=${encodeURIComponent(type)}&url=${encodeURIComponent(url)}&providerId=${encodeURIComponent(providerId)}`;
}

function completedStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(status || '').toLowerCase());
}
function failedStatus(status) {
  return ['failed', 'error', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

async function getAgnesVideoState(videoId, provider) {
  const r = await fetchTimeout(agnesPollUrl(videoId), {
    headers: { Authorization: `Bearer ${provider.key}`, Accept: 'application/json' }
  }, 12000);
  const text = await r.text();
  const data = parseJson(text);
  if (!r.ok) {
    const msg = data?.error?.message || data?.message || `Agnes video status failed (${r.status})`;
    throw new Error(String(msg).slice(0, 1000));
  }
  const status = String(data?.status || data?.state || '').toLowerCase();
  const urls = collectMediaUrls(data, 'video');
  return { status, data, urls };
}

async function waitForAgnesVideo(videoId, provider, timeoutMs = 55000) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    lastState = await getAgnesVideoState(videoId, provider);
    if (lastState.urls.length || completedStatus(lastState.status)) {
      if (!lastState.urls.length) throw new Error('Agnes video completed but returned no video URL.');
      return { done: true, urls: lastState.urls, raw: lastState.data, status: lastState.status };
    }
    if (failedStatus(lastState.status)) {
      throw new Error(String(lastState.data?.error?.message || lastState.data?.error || lastState.data?.message || 'Agnes video generation failed.').slice(0, 1000));
    }
    await new Promise(resolve => setTimeout(resolve, 3500));
  }
  return { done: false, pending: true, status: lastState?.status || 'queued' };
}

async function proxyExternalMedia(req, res) {
  const providers = getProviders();
  const raw = req.query?.url;
  if (!raw) return res.status(400).json({ error: 'url is required.' });
  let url;
  try { url = assertAllowedUrl(raw, providers); }
  catch (err) { return res.status(403).json({ error: err.message }); }

  try {
    const upstream = await fetchTimeout(url.toString(), { headers: { Accept: '*/*' } }, 55000);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Media upstream returned HTTP ${upstream.status}.` });
    const contentType = upstream.headers.get('content-type') || (req.query?.type === 'video' ? 'video/mp4' : 'image/png');
    const data = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    return res.status(200).send(data);
  } catch (err) {
    return res.status(502).json({ error: err?.name === 'AbortError' ? 'Media download timed out.' : err?.message || 'Media download failed.' });
  }
}

async function streamAgnesVideo(req, res) {
  const providerId = String(req.query?.providerId || '');
  const videoId = String(req.query?.videoId || '');
  const provider = getProviders().find(p => p.id === providerId);
  if (!provider || !videoId) return res.status(400).json({ error: 'providerId and videoId are required.' });

  try {
    const result = await waitForAgnesVideo(videoId, provider, 55000);
    if (!result.done) {
      res.setHeader('Retry-After', '5');
      return res.status(202).json({ pending: true, status: result.status, videoId });
    }
    const upstreamUrl = result.urls[0];
    const upstream = await fetchTimeout(upstreamUrl, { headers: { Accept: 'video/*,*/*' } }, 55000);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Video file returned HTTP ${upstream.status}.` });
    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    const data = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    return res.status(200).send(data);
  } catch (err) {
    return res.status(502).json({ error: err?.message || 'Video streaming failed.' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.method === 'GET') {
    if (String(req.query?.proxy || '') === '1') return proxyExternalMedia(req, res);
    if (String(req.query?.stream || '') === 'video') return streamAgnesVideo(req, res);
    return res.status(400).json({ error: 'Unsupported media GET request.' });
  }

  const body = req.body || {};
  const type = body.type === 'video' ? 'video' : 'image';
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 12000) return res.status(400).json({ error: 'A valid prompt is required.' });

  const providers = getProviders().filter(p => type === 'image' ? (p.imageUrl || p.imageModel) : (p.videoUrl || p.videoModel));
  if (!providers.length) return res.status(503).json({ error: `No ${type} provider is configured.` });

  const requestedProvider = String(body.providerId || '');
  const ordered = requestedProvider ? [...providers].sort((a, b) => (a.id === requestedProvider ? -1 : b.id === requestedProvider ? 1 : 0)) : providers;
  const errors = [];

  for (const provider of ordered) {
    const endpoint = type === 'image'
      ? (provider.imageUrl || `${provider.baseUrl}/images/generations`)
      : (provider.videoUrl || `${provider.baseUrl}/videos`);
    const model = body.model || (type === 'image' ? provider.imageModel : provider.videoModel);
    if (!model) { errors.push({ provider: provider.name, status: 400, message: `No ${type} model configured.` }); continue; }

    const payload = type === 'image' ? imageBody(body, provider) : videoBody(body, provider);

    try {
      const upstream = await fetchTimeout(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      }, type === 'video' && isAgnes(provider) ? 55000 : 45000);

      const text = await upstream.text();
      const data = parseJson(text);
      if (!upstream.ok && upstream.status !== 202) {
        const message = data?.error?.message || data?.message || `HTTP ${upstream.status}`;
        errors.push({ provider: provider.name, status: upstream.status, message: String(message).slice(0, 1000) });
        if (RETRYABLE.has(upstream.status) || [401, 403, 404].includes(upstream.status)) continue;
        continue;
      }

      if (type === 'video' && isAgnes(provider)) {
        const videoId = String(data?.video_id || data?.videoId || '');
        if (!videoId) {
          const urls = collectMediaUrls(data, 'video');
          if (urls.length) return res.status(200).json({ provider: provider.name, providerId: provider.id, type, urls: urls.map(u => normalizeExternalUrlForDisplay(u, type, provider.id)), raw: data });
          return res.status(502).json({ error: 'Agnes created a video task but did not return a video_id.', provider: provider.name, raw: data });
        }

        const result = await waitForAgnesVideo(videoId, provider, 55000);
        if (result.done) {
          const displayUrls = result.urls.map(u => normalizeExternalUrlForDisplay(u, 'video', provider.id));
          return res.status(200).json({ provider: provider.name, providerId: provider.id, type, urls: displayUrls, raw: result.raw });
        }

        return res.status(200).json({
          provider: provider.name,
          providerId: provider.id,
          type,
          pending: true,
          jobId: videoId,
          urls: [proxyUrlForVideo(provider.id, videoId)],
          message: 'Video is still processing. The media preview will wait for the video to finish.'
        });
      }

      const urls = collectMediaUrls(data, type);
      if (!urls.length) return res.status(502).json({ error: `${provider.name} returned no usable ${type} URL.`, provider: provider.name, providerId: provider.id, raw: data });
      const displayUrls = urls.map(u => normalizeExternalUrlForDisplay(u, type, provider.id));
      return res.status(200).json({ provider: provider.name, providerId: provider.id, type, urls: displayUrls, raw: data });
    } catch (err) {
      errors.push({ provider: provider.name, status: 0, message: err?.name === 'AbortError' ? 'Provider request timed out.' : err?.message || 'Request failed.' });
    }
  }

  return res.status(503).json({ error: `All configured ${type} providers failed.`, errors });
}
