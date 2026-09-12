export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Gemini API key is not configured. Add GEMINI_API_KEY in Vercel.' });
    }

    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const mode = body.mode === 'deep' ? 'deep' : 'search';
    const model = String(process.env.GEMINI_RESEARCH_MODEL || body.model || 'gemini-2.5-flash').trim();
    const domain = String(body.domain || '').trim();

    const instructions = mode === 'deep'
      ? [
          'Act as a careful research analyst.',
          'Use Google Search extensively and synthesize information from multiple relevant sources.',
          'Cross-check important claims, prefer primary or authoritative sources, and distinguish facts from inference.',
          'Produce a structured research report with a concise executive summary, key findings, important caveats, and a final conclusion.',
          'Do not invent sources or facts. When evidence is conflicting, say so.',
        ]
      : [
          'Answer the user using fresh information from Google Search when useful.',
          'Prefer authoritative and recent sources for time-sensitive claims.',
          'Be concise but include the key facts needed to answer the question.',
        ];

    const domainHint = domain
      ? `Prefer sources from these domains when relevant: ${domain}. You may use other authoritative sources when necessary.`
      : '';

    const prompt = `${instructions.join(' ')}\n${domainHint}\n\nUser request:\n${query}`.trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: mode === 'deep' ? 0.25 : 0.35,
          maxOutputTokens: Math.min(Number(body.maxOutputTokens) || (mode === 'deep' ? 7000 : 3500), 12000),
        },
      }),
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: { message: raw } }; }

    if (!upstream.ok) {
      const message = data?.error?.message || `Gemini research request failed (${upstream.status})`;
      return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({ error: String(message).slice(0, 800) });
    }

    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || [])
      .map(part => part?.text || '')
      .join('')
      .trim();

    const metadata = candidate?.groundingMetadata || {};
    const queries = Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : [];
    const sources = [];
    const seen = new Set();

    for (const chunk of (metadata.groundingChunks || [])) {
      const web = chunk?.web;
      const uri = String(web?.uri || '').trim();
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({
        title: String(web?.title || uri).trim(),
        url: uri,
      });
    }

    return res.status(200).json({
      ok: true,
      mode,
      model,
      text: text || 'No research answer was returned.',
      queries,
      sources: sources.slice(0, 20),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Research service failed.' });
  }
}
