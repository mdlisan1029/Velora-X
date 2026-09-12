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
    const candidates = [
      process.env.GEMINI_VISION_MODEL,
      process.env.GEMINI_MODEL,
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
    ].filter(Boolean).map(String).filter((v,i,arr)=>arr.indexOf(v)===i);

    const supportedBinary = mimeType === 'application/pdf' || mimeType.startsWith('image/');
    const supportedText = mimeType.startsWith('text/') || /json|javascript|xml|yaml|markdown|csv/.test(mimeType);
    if (!supportedBinary && !supportedText) return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });

    const parts = [{ text: `You are Velora X's multimodal file analyst. The attached file is named "${name}". Answer the user's request using the file as evidence. Be accurate, concise, and say when information is unclear.\n\nUser request:\n${prompt}` }];
    if (a.kind === 'text') {
      const text = String(a.text || '');
      if (!text) return res.status(400).json({ error: 'The text/code attachment is empty.' });
      parts.push({ text: `\n--- FILE CONTENT: ${name} ---\n${text}\n--- END FILE ---` });
    } else {
      const base64 = String(a.base64 || '');
      if (!base64) return res.status(400).json({ error: 'Attachment data is missing.' });
      parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
    }

    let lastMessage = '';
    for (const model of candidates) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 5000 },
        }),
      });
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { data = { error: { message: raw } }; }
      if (upstream.ok) {
        const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join('').trim();
        return res.status(200).json({ ok: true, model, text: text || 'No analysis response was returned.' });
      }
      lastMessage = String(data?.error?.message || `Gemini request failed (${upstream.status})`).slice(0, 700);
      if (![400,404].includes(upstream.status)) break;
    }
    return res.status(502).json({ error: lastMessage || 'Gemini multimodal analysis failed.' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Multimodal analysis failed.' });
  }
}
