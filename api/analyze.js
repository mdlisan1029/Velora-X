const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unique = (items) => items.filter((v, i, arr) => v && arr.indexOf(v) === i);

function modelCandidates() {
  return unique([
    process.env.GEMINI_VISION_MODEL,
    process.env.GEMINI_MODEL,
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
  ].map(String));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isModelSelectionError(status, message) {
  if ([404].includes(status)) return true;
  if (status !== 400) return false;
  const text = String(message || '').toLowerCase();
  return /model|not found|unsupported|no longer available|invalid.*model|not available/.test(text);
}

async function callGemini({ apiKey, model, contents }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 5000 },
      }),
      signal: controller.signal,
    });

    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: { message: raw } }; }
    const message = String(data?.error?.message || `Gemini request failed (${upstream.status})`).slice(0, 800);

    if (upstream.ok) {
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((part) => part?.text || '')
        .join('')
        .trim();
      return { ok: true, text: text || 'No analysis response was returned.' };
    }

    return { ok: false, status: upstream.status, message };
  } catch (err) {
    return {
      ok: false,
      status: err?.name === 'AbortError' ? 504 : 502,
      message: err?.name === 'AbortError' ? 'Gemini analysis request timed out.' : (err?.message || 'Gemini request failed.'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Gemini API key is not configured in Vercel.' });

    const body = req.body || {};
    const prompt = String(body.prompt || 'Analyze the attached file carefully.').trim().slice(0, 12000);
    const a = body.attachment || {};
    const name = String(a.name || 'attachment').slice(0, 160);
    const mimeType = String(a.mimeType || 'application/octet-stream').toLowerCase();

    const supportedBinary = mimeType === 'application/pdf' || mimeType.startsWith('image/');
    const supportedText = mimeType.startsWith('text/') || /json|javascript|xml|yaml|markdown|csv/.test(mimeType);
    if (!supportedBinary && !supportedText) {
      return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
    }

    const parts = [{
      text: `You are Velora X's multimodal file analyst. The attached file is named "${name}". Answer the user's request using the file as evidence. Be accurate, concise, and say when information is unclear.\n\nUser request:\n${prompt}`,
    }];

    if (a.kind === 'text') {
      const text = String(a.text || '');
      if (!text) return res.status(400).json({ error: 'The text/code attachment is empty.' });
      parts.push({ text: `\n--- FILE CONTENT: ${name} ---\n${text}\n--- END FILE ---` });
    } else {
      const base64 = String(a.base64 || '');
      if (!base64) return res.status(400).json({ error: 'Attachment data is missing.' });
      parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
    }

    const candidates = modelCandidates();
    let lastMessage = '';
    const attemptLog = [];

    for (const model of candidates) {
      // Retry transient capacity/rate-limit failures before moving to the next model.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await callGemini({ apiKey, model, contents: [{ role: 'user', parts }] });
        attemptLog.push({ model, status: result.status || 200, attempt: attempt + 1 });

        if (result.ok) {
          return res.status(200).json({
            ok: true,
            model,
            text: result.text,
            fallback: model !== candidates[0],
            attempts: attemptLog,
          });
        }

        lastMessage = result.message;

        // Model is unavailable/invalid: immediately try the next candidate.
        if (isModelSelectionError(result.status, result.message)) break;

        // Retry only transient failures; wait briefly with exponential backoff.
        if (isRetryableStatus(result.status) && attempt === 0) {
          await sleep(1200);
          continue;
        }

        break;
      }
    }

    return res.status(502).json({
      error: lastMessage || 'Gemini multimodal analysis failed.',
      fallbackTried: candidates,
      attempts: attemptLog,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Multimodal analysis failed.' });
  }
}
