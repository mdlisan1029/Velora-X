const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

function normalize(p, index = 0) {
  const name = String(p.name || `Provider ${index + 1}`).trim();
  const id = String(p.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `provider-${index + 1}`);
  const key = String(p.key || '');
  const baseUrl = trimSlash(p.baseUrl || '');
  const model = String(p.model || '');
  if (!key || !baseUrl || !model) return null;
  return {
    id, name, key, baseUrl, model,
    models: Array.isArray(p.models) ? p.models.map(String).filter(Boolean) : [model],
    chat: p.chat !== false,
    imageUrl: trimSlash(p.imageUrl || ''),
    videoUrl: trimSlash(p.videoUrl || ''),
    imageModel: p.imageModel || '',
    videoModel: p.videoModel || '',
    website: p.website || ''
  };
}

function provider(name, envPrefix, defaults = {}) {
  return normalize({
    id: envPrefix.toLowerCase(),
    name,
    key: process.env[`${envPrefix}_API_KEY`],
    baseUrl: process.env[`${envPrefix}_BASE_URL`] || defaults.baseUrl,
    model: process.env[`${envPrefix}_MODEL`] || defaults.model,
    imageUrl: process.env[`${envPrefix}_IMAGE_URL`] || defaults.imageUrl,
    videoUrl: process.env[`${envPrefix}_VIDEO_URL`] || defaults.videoUrl,
    imageModel: process.env[`${envPrefix}_IMAGE_MODEL`] || defaults.imageModel,
    videoModel: process.env[`${envPrefix}_VIDEO_MODEL`] || defaults.videoModel,
    website: defaults.website
  });
}

function parseJsonProviders() {
  const raw = process.env.PROVIDERS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalize).filter(Boolean);
  } catch {
    return [];
  }
}

export function getProviders() {
  const builtIns = [
    provider('NaraRouter', 'NARA', {
      baseUrl: 'https://router.bynara.id/v1',
      model: 'auto',
      imageUrl: 'https://api-images.bynara.id/v1/images/generations',
      videoUrl: 'https://api-images.bynara.id/v1/videos',
      imageModel: process.env.NARA_IMAGE_MODEL || 'agnes-image-2.1-flash',
      videoModel: process.env.NARA_VIDEO_MODEL || 'agnes-video-v2.0',
      website: 'https://router.bynara.id'
    }),
    provider('Agnes AI', 'AGNES', {
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      model: process.env.AGNES_MODEL || 'agnes-2.5-flash',
      imageUrl: 'https://apihub.agnes-ai.com/v1/images/generations',
      videoUrl: 'https://apihub.agnes-ai.com/v1/videos',
      imageModel: process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.1-flash',
      videoModel: process.env.AGNES_VIDEO_MODEL || 'agnes-video-v2.0',
      website: 'https://agnes-ai.com'
    }),
    provider('Google Gemini', 'GEMINI', {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      website: 'https://ai.google.dev'
    }),
    provider('Groq', 'GROQ', { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', website: 'https://groq.com' }),
    provider('OpenRouter', 'OPENROUTER', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b', website: 'https://openrouter.ai' }),
    provider('OpenAI', 'OPENAI', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', imageModel: 'gpt-image-1', website: 'https://platform.openai.com' }),
    provider('Mistral', 'MISTRAL', { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', website: 'https://mistral.ai' }),
    provider('Cerebras', 'CEREBRAS', { baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', website: 'https://cerebras.ai' }),
    provider('Together AI', 'TOGETHER', { baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', website: 'https://together.ai' }),
    provider(process.env.CUSTOM_NAME || 'Custom Gateway', 'CUSTOM', { website: '' })
  ].filter(Boolean);

  const custom = parseJsonProviders();
  const byId = new Map([...builtIns, ...custom].map(p => [p.id, p]));
  return [...byId.values()];
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length < 8) return '••••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
