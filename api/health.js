import { getProviders } from './providers.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const providers = getProviders();
  const publicProviders = providers.map(p => ({
    id: p.id,
    name: p.name,
    model: p.model,
    models: p.models || [p.model],
    chat: p.chat,
    image: Boolean(p.imageUrl || p.imageModel),
    video: Boolean(p.videoUrl || p.videoModel),
    website: p.website || ''
  }));
  return res.status(200).json({ count: publicProviders.length, providers: publicProviders });
}
