const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const OPENAI_BASE = trimSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1');
const DEFAULT_SEARCH_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const DEFAULT_DEEP_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'o4-mini-deep-research';

function jsonError(res, status, message, details = {}) {
  return res.status(status).json({
    ok: false,
    error: String(message || 'Research request failed').slice(0, 1200),
    ...details,
  });
}

function outputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'message') {
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
        else if (typeof content?.text === 'string') chunks.push(content.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

function collectSources(response) {
  const sources = [];
  const seen = new Set();
  const add = (value) => {
    if (!value) return;
    const url = String(value.url || value.uri || value.link || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    sources.push({
      title: String(value.title || value.name || url).trim(),
      url,
    });
  };

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'web_search_call') {
      const action = item.action || {};
      for (const source of Array.isArray(action.sources) ? action.sources : []) add(source);
      for (const source of Array.isArray(action.results) ? action.results : []) add(source);
    }
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        if (annotation?.type === 'url_citation') add(annotation);
      }
    }
  }

  const direct = response?.web_search_call?.action?.sources;
  for (const source of Array.isArray(direct) ? direct : []) add(source);
  return sources.slice(0, 30);
}

function extractQueries(response) {
  const queries = [];
  const seen = new Set();
  const add = (q) => {
    const s = String(q || '').trim();
    if (s && !seen.has(s)) { seen.add(s); queries.push(s); }
  };
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'web_search_call') {
      const action = item.action || {};
      add(action.query);
      for (const q of Array.isArray(action.queries) ? action.queries : []) add(q);
    }
  }
  return queries.slice(0, 12);
}

async function callResponses({ apiKey, model, input, tools, include = [], instructions }) {
  const upstream = await fetch(`${OPENAI_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      instructions,
      tools,
      include,
      max_output_tokens: 12000,
      store: false,
    }),
  });
  const raw = await upstream.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { error: { message: raw } }; }
  return { upstream, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return jsonError(res, 503, 'OPENAI_API_KEY is not configured in Vercel.');

  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) return jsonError(res, 400, 'query is required');

    const mode = body.mode === 'deep' ? 'deep' : 'search';
    const requestedModel = String(body.model || '').trim();
    const model = requestedModel || (mode === 'deep' ? DEFAULT_DEEP_MODEL : DEFAULT_SEARCH_MODEL);
    const domains = String(body.domain || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20);

    const commonInstructions = mode === 'deep'
      ? [
          'Act as a rigorous deep-research analyst.',
          'Research the question thoroughly using the web, cross-check important claims, prioritize primary and authoritative sources, and distinguish facts from inference.',
          'Prefer recent information when the topic is time-sensitive.',
          'Produce a structured report with an executive summary, key findings, evidence, caveats or disagreements, and a concise conclusion.',
          'Cite sources in the answer using source links returned by the web search tool. Never invent citations.',
        ].join(' ')
      : [
          'Act as a web research assistant.',
          'Use web search for current or uncertain information, prioritize authoritative and recent sources, and answer concisely but with enough evidence to support key claims.',
          'Cite important web-derived claims using the source links returned by the web search tool. Never invent citations.',
        ].join(' ');

    const domainInstruction = domains.length
      ? `Prefer sources on these domains when relevant: ${domains.join(', ')}. Use other authoritative sources when necessary.`
      : '';

    const input = `${domainInstruction}\n\nUser request:\n${query}`.trim();
    const include = ['web_search_call.action.sources'];

    // Current hosted web-search tool; fall back to the preview tool for broader model compatibility.
    let result = await callResponses({
      apiKey,
      model,
      input,
      instructions: commonInstructions,
      tools: [{
        type: 'web_search',
        filters: domains.length ? { allowed_domains: domains } : undefined,
        search_context_size: mode === 'deep' ? 'high' : 'medium',
      }],
      include,
    });

    if (!result.upstream.ok && result.upstream.status === 400 && mode === 'search') {
      result = await callResponses({
        apiKey,
        model,
        input,
        instructions: commonInstructions,
        tools: [{
          type: 'web_search_preview',
          domains,
          search_context_size: 'medium',
        }],
        include,
      });
    }

    const { upstream, data } = result;
    if (!upstream.ok) {
      const providerMessage = data?.error?.message || data?.message || `OpenAI research request failed (${upstream.status})`;
      return jsonError(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, providerMessage, {
        provider: 'OpenAI',
        model,
      });
    }

    const text = outputText(data);
    const sources = collectSources(data);
    const queries = extractQueries(data);

    return res.status(200).json({
      ok: true,
      provider: 'OpenAI',
      mode,
      model: data.model || model,
      text: text || 'No research answer was returned.',
      queries,
      sources,
    });
  } catch (err) {
    return jsonError(res, 500, err?.message || 'OpenAI research service failed.');
  }
}
