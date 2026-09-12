export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'OpenAI API key is not configured. Add OPENAI_API_KEY in Vercel.' });
  }

  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });

    const mode = body.mode === 'deep' ? 'deep' : 'search';
    const defaultSearchModel = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
    const defaultDeepModel = process.env.OPENAI_RESEARCH_MODEL || 'o3-deep-research';
    const model = String(body.model || (mode === 'deep' ? defaultDeepModel : defaultSearchModel)).trim();
    const domain = String(body.domain || '').trim();

    const instructions = mode === 'deep'
      ? [
          'Act as a rigorous research analyst.',
          'Perform multi-step web research and synthesize the strongest available evidence.',
          'Prefer primary sources, official documentation, peer-reviewed or otherwise authoritative material.',
          'Cross-check important claims and explicitly distinguish facts, uncertainty, and inference.',
          'Produce a structured report with an executive summary, key findings, evidence, caveats, and conclusion.',
          'Use citations to support factual claims and never invent sources.',
        ]
      : [
          'Answer using fresh information from the web.',
          'Use authoritative and recent sources when the topic is time-sensitive.',
          'Be concise but sufficiently detailed to answer the request.',
          'Cite important factual claims with web sources.',
        ];

    if (domain) {
      instructions.push(`Prefer relevant sources from these domains when possible: ${domain}`);
    }

    const payload = {
      model,
      instructions: instructions.join(' '),
      input: query,
      tools: [{ type: 'web_search_preview' }],
      include: ['web_search_call.action.sources'],
      max_output_tokens: Math.min(
        Number(body.maxOutputTokens) || (mode === 'deep' ? 12000 : 5000),
        16000
      ),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mode === 'deep' ? 55000 : 50000);

    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: { message: raw } }; }

    if (!upstream.ok) {
      const providerMessage = data?.error?.message || `OpenAI research request failed (${upstream.status})`;
      return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
        .json({ error: String(providerMessage).slice(0, 1200) });
    }

    const text = String(data?.output_text || '').trim();
    const queries = [];
    const sources = [];
    const seenQueries = new Set();
    const seenSources = new Set();

    for (const item of Array.isArray(data?.output) ? data.output : []) {
      if (item?.type === 'web_search_call') {
        const actionSources = item?.action?.sources || item?.results || [];
        for (const source of Array.isArray(actionSources) ? actionSources : []) {
          const url = String(source?.url || source?.uri || '').trim();
          if (!url || seenSources.has(url)) continue;
          seenSources.add(url);
          sources.push({
            title: String(source?.title || url).trim(),
            url,
          });
        }
        const queryList = item?.action?.queries || item?.queries || [];
        for (const q of Array.isArray(queryList) ? queryList : []) {
          const queryText = String(q?.search_query || q?.query || q || '').trim();
          if (queryText && !seenQueries.has(queryText)) {
            seenQueries.add(queryText);
            queries.push(queryText);
          }
        }
      }

      const annotations = item?.content?.flatMap?.(part => part?.annotations || []) || [];
      for (const ann of annotations) {
        const url = String(ann?.url || ann?.source?.url || '').trim();
        if (!url || seenSources.has(url)) continue;
        seenSources.add(url);
        sources.push({
          title: String(ann?.title || ann?.source?.title || url).trim(),
          url,
        });
      }
    }

    // Some Responses payloads expose source data under response-level included items.
    for (const source of Array.isArray(data?.web_search_call?.action?.sources) ? data.web_search_call.action.sources : []) {
      const url = String(source?.url || source?.uri || '').trim();
      if (!url || seenSources.has(url)) continue;
      seenSources.add(url);
      sources.push({ title: String(source?.title || url).trim(), url });
    }

    return res.status(200).json({
      ok: true,
      mode,
      model,
      text: text || 'No research answer was returned.',
      queries: queries.slice(0, 20),
      sources: sources.slice(0, 30),
    });
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? 'OpenAI research request timed out. Try a narrower request or use Web Search instead of Deep Research.'
      : (err?.message || 'Research service failed.');
    return res.status(500).json({ error: message });
  }
}
