const trimSlash = (value) => String(value || '').replace(/\/+$/, '');

const TAVILY_URL = `${trimSlash(process.env.TAVILY_BASE_URL || 'https://api.tavily.com')}/search`;
const NARA_BASE = trimSlash(process.env.NARA_BASE_URL || 'https://router.bynara.id/v1');
const DEFAULT_NARA_MODEL = process.env.NARA_RESEARCH_MODEL || process.env.NARA_MODEL || 'agnes-2.5-flash';

const TAVILY_TIMEOUT = 20000;
const NARA_TIMEOUT = 18000;

function parseDomains(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((x) => x.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .slice(0, 50);
}

function isNewsQuery(text) {
  return /\b(news|today|tonight|latest|breaking|recent|this week|current|now|price|market)\b/i.test(text);
}

function uniqueByUrl(results) {
  const seen = new Set();
  return (Array.isArray(results) ? results : []).filter((item) => {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Upstream request timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(upstream) {
  const raw = await upstream.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return { message: raw }; }
}

async function tavilySearch(query, { advanced = false, domains = [] } = {}) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY is not configured in Vercel.');

  const news = isNewsQuery(query);
  const body = {
    query,
    search_depth: advanced ? 'advanced' : 'basic',
    topic: news ? 'news' : 'general',
    max_results: advanced ? 6 : 8,
    include_answer: advanced ? false : 'basic',
    include_raw_content: false,
    ...(domains.length ? { include_domains: domains } : {}),
    ...(news ? { time_range: 'week' } : {}),
  };

  const upstream = await fetchWithTimeout(TAVILY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, TAVILY_TIMEOUT);

  const data = await parseResponse(upstream);
  if (!upstream.ok) {
    const message = data?.detail || data?.message || data?.error || `Tavily search failed (${upstream.status})`;
    throw new Error(String(message).slice(0, 800));
  }

  return {
    answer: String(data?.answer || '').trim(),
    results: Array.isArray(data?.results) ? data.results : [],
    credits: Number(data?.usage?.credits || (advanced ? 2 : 1)),
  };
}

function sourcePayload(results) {
  return uniqueByUrl(results).map((r) => ({
    title: String(r.title || r.url || 'Source').trim(),
    url: String(r.url || '').trim(),
    snippet: String(r.content || '').trim().slice(0, 700),
    score: Number.isFinite(Number(r.score)) ? Number(r.score) : undefined,
  })).filter((s) => s.url);
}

function buildResearchPrompt(query, results, mode) {
  const instruction = mode === 'deep'
    ? 'Act as a careful research analyst. Synthesize the supplied web evidence into a structured report. Cross-check claims, prefer primary or authoritative evidence, explicitly note uncertainty or conflicting evidence, and do not invent facts or citations. Include an executive summary, key findings, evidence, caveats, and conclusion.'
    : 'Answer the user using the supplied fresh web evidence. Prioritize recent and authoritative sources, distinguish fact from inference, stay focused, and do not invent facts or citations.';

  const evidence = results.slice(0, 18).map((r, i) =>
    `SOURCE ${i + 1}\nTitle: ${String(r.title || '').trim()}\nURL: ${String(r.url || '').trim()}\nSnippet: ${String(r.content || '').trim()}`
  ).join('\n\n');

  return `${instruction}\n\nUser request:\n${query}\n\nWeb evidence:\n${evidence}`;
}

async function synthesizeWithNara(query, results, mode) {
  const key = process.env.NARA_API_KEY;
  if (!key) return { text: '', degraded: true, reason: 'NARA_API_KEY is not configured in Vercel.' };

  const payload = {
    model: DEFAULT_NARA_MODEL,
    messages: [
      { role: 'system', content: 'You are Velora X Research, a source-grounded web research assistant.' },
      { role: 'user', content: buildResearchPrompt(query, results, mode) },
    ],
    temperature: 0.2,
    max_tokens: mode === 'deep' ? 5000 : 2400,
  };

  let lastReason = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const upstream = await fetchWithTimeout(`${NARA_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, NARA_TIMEOUT);

      const data = await parseResponse(upstream);
      if (!upstream.ok) {
        lastReason = String(data?.error?.message || data?.message || `Nara synthesis failed (${upstream.status})`).slice(0, 800);
        if (attempt === 0 && [408, 425, 429, 500, 502, 503, 504].includes(upstream.status)) {
          await new Promise((r) => setTimeout(r, 900));
          continue;
        }
        return { text: '', degraded: true, reason: lastReason };
      }

      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (text) return { text, degraded: false, reason: '' };
      lastReason = 'Nara returned no text.';
    } catch (err) {
      lastReason = err?.message || 'Nara synthesis failed.';
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
    }
  }

  return { text: '', degraded: true, reason: String(lastReason).slice(0, 800) };
}

function buildDeepQueries(query) {
  const q = String(query || '').trim();
  return [q, `${q} official primary sources`, `${q} latest developments analysis evidence`];
}

function fallbackText(query, results, tavilyAnswer, mode) {
  if (tavilyAnswer) {
    return `${tavilyAnswer}\n\n_Web search completed. AI synthesis was temporarily unavailable; the source list below is from Tavily._`;
  }
  if (!results.length) return 'No web results were returned for this query.';
  const top = results.slice(0, 8).map((r, i) => `${i + 1}. ${r.title || r.url}\n${r.url}\n${String(r.content || '').trim().slice(0, 300)}`).join('\n\n');
  return `Web search completed, but AI synthesis was temporarily unavailable. Here are the most relevant results:\n\n${top}`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) return res.status(400).json({ ok: false, error: 'query is required' });

    if (!process.env.TAVILY_API_KEY) {
      return res.status(503).json({ ok: false, error: 'TAVILY_API_KEY is not configured in Vercel.' });
    }

    const mode = body.mode === 'deep' ? 'deep' : 'search';
    const domains = parseDomains(body.domain);

    let results = [];
    let queries = [];
    let tavilyCredits = 0;
    let tavilyAnswer = '';

    if (mode === 'search') {
      const found = await tavilySearch(query, { advanced: false, domains });
      results = uniqueByUrl(found.results).slice(0, 8);
      queries = [query];
      tavilyCredits = found.credits;
      tavilyAnswer = found.answer;
    } else {
      const planned = buildDeepQueries(query);
      const settled = await Promise.allSettled(planned.map((q) => tavilySearch(q, { advanced: true, domains })));
      const found = settled.map((item) => item.status === 'fulfilled'
        ? item.value
        : { results: [], credits: 0, error: item.reason?.message || 'Search failed.' });
      queries = planned;
      tavilyCredits = found.reduce((sum, x) => sum + Number(x.credits || 0), 0);
      results = uniqueByUrl(found.flatMap((x) => x.results || [])).slice(0, 18);

      if (!results.length && found.every((x) => x.error)) {
        return res.status(502).json({ ok: false, error: found[0].error || 'All deep research searches failed.' });
      }
    }

    const sources = sourcePayload(results);
    const synthesis = await synthesizeWithNara(query, results, mode);
    const text = synthesis.text || fallbackText(query, results, tavilyAnswer, mode);

    return res.status(200).json({
      ok: true,
      mode,
      model: DEFAULT_NARA_MODEL,
      text,
      queries,
      sources,
      tavilyCredits,
      provider: `Tavily + NaraRouter (${DEFAULT_NARA_MODEL})`,
      degraded: synthesis.degraded,
      warning: synthesis.degraded ? synthesis.reason : '',
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err?.message || 'Web research service failed.' });
  }
}
