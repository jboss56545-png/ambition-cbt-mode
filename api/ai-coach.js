// CBT Test Studio — AI Master Backend (PDF + Image + Scanned PDF)
// Powered by ASVIRO STUDIO

async function fetchGemini(model, key, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const reply = (text) => res.status(200).json({ message: text });

  const { message, context, history, image, images } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 80000) {
    return res.status(400).json({ error: 'BAD_INPUT', message: 'Message missing or too long.' });
  }

  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return res.status(500).json({ error: 'NO_KEY', message: 'Setup: GEMINI_API_KEY missing on Vercel.' });

  const isCBT = context && (context.source === 'cbt-test-studio' || context.source === 'ambition-cuet-cbt');
  const mode = (context && context.mode) || 'chat';

  let allImages = [];
  if (Array.isArray(images) && images.length) {
    allImages = images.filter(i => i && i.data && i.mime);
  } else if (image && image.data && image.mime) {
    allImages = [image];
  }
  const hasImages = allImages.length > 0;

  let system = '';

  if (hasImages && (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes')) {
    system =
      'You are an expert at extracting exam questions from photos/scans of Indian educational material.\n\n' +
      'YOUR MISSION:\n' +
      'Extract ALL valid exam questions and convert to standard 4-option MCQ format.\n\n' +
      'STRICT RULES:\n' +
      '1. Copy question text EXACTLY. Do NOT paraphrase.\n' +
      '2. Preserve original answer if given (map A/B/C/D → 0/1/2/3, 1/2/3/4 → 0/1/2/3).\n' +
      '3. Every question: exactly 4 options, ONE correct.\n' +
      '4. If options are missing (direct question), YOU MUST SOLVE IT. Add 4 plausible options where EXACTLY ONE IS 100% CORRECT mathematically/factually.\n' +
      '5. "topic" = chapter name if visible, else "General".\n' +
      '6. "diff" = easy/medium/hard.\n' +
      '7. "explain" = short reasoning if available, else "".\n' +
      '8. For ALL math formulas, ALWAYS use LaTeX with `$` syntax. Example: `$\\int x^2 dx$`, `$\\frac{a}{b}$`.\n' +
      '9. If NO questions found in these images, return [] — but only after thorough reading.\n\n' +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"question text","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'extract') {
    system =
      'You are an expert at extracting exam questions from Indian educational PDFs.\n\n' +
      'STRICT RULES:\n' +
      '1. Copy question text EXACTLY.\n' +
      '2. Preserve original answer (map A/B/C/D → 0/1/2/3).\n' +
      '3. Exactly 4 options, ONE correct.\n' +
      '4. If options are missing, YOU MUST SOLVE IT. Create 4 options where ONLY ONE IS 100% CORRECT.\n' +
      '5. "topic" = chapter name, else "General".\n' +
      '6. "diff" = easy/medium/hard.\n' +
      '7. "explain" = short reasoning if available, else "".\n' +
      '8. For ALL math formulas, ALWAYS use LaTeX with `$` syntax. Example: `$\\int x^2 dx$`, `$\\frac{a}{b}$`.\n' +
      '9. Extract EVERY valid question. If none, return [].\n\n' +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"ch","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'notes') {
    system =
      'You are an expert Indian exam question setter.\n' +
      'Generate high-quality MCQs based on the CONCEPTS in the given notes.\n' +
      'RULES: 4 options, ONE correct, vary index (0,1,2,3), plausible distractors, cover DIFFERENT concepts.\n' +
      'For ALL math formulas, ALWAYS use LaTeX with `$` syntax.\n' +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"topic","diff":"easy","explain":"why"}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'ai') {
    system =
      'You are an expert Indian competitive-exam question setter with 20 years experience.\n' +
      'Generate MCQs matching EXACT style of PYQ books (Oswaal, Arihant, MTG).\n' +
      'RULES: 4 options, ONE correct, vary index (0,1,2,3). "topic" = exact chapter. "diff" = easy/medium/hard.\n' +
      'For ALL math formulas, ALWAYS use LaTeX with `$` syntax. Example: `$\\int x^2 dx$`, `$\\frac{a}{b}$`.\n' +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"ch","diff":"easy","explain":"why"}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else {
    system = 'You are "The Raven", a wise and encouraging AI coach for competitive exam students. Supportive, motivating, concise. Natural language (Hinglish/English mix OK).\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {}) + '\n\nUser Message: ' + message;
  }

  let msgs = (Array.isArray(history) ? history : [])
    .slice(-10)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) msgs = [{ role: 'user', content: message }];

  let contents = msgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  if (hasImages) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      for (const img of allImages) {
        lastMsg.parts.push({
          inline_data: { mime_type: img.mime, data: img.data }
        });
      }
    }
  }

  const models = [
    (process.env.GEMINI_MODEL || '').trim(),
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest'
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  let lastErr = '';
  let sawQuota = false;
  let authError = '';

  for (const model of models) {
    try {
      const temp = isCBT ? 0.15 : 0.85;
      const genConfig = { maxOutputTokens: 8192, temperature: temp };
      if (isCBT) genConfig.responseMimeType = 'application/json';

      const r = await fetchGemini(model, key, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: genConfig
      }, 45000);

      const data = await r.json().catch(() => ({}));

      if (r.ok) {
        const parts = data.candidates?.[0]?.content?.parts;
        let text = parts ? parts.map(p => p.text || '').join('').trim() : '';
        if (text) {
          if (isCBT) {
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            const fb = text.indexOf('[');
            const lb = text.lastIndexOf(']');
            if (fb >= 0 && lb > fb) text = text.slice(fb, lb + 1);
          }
          return reply(text);
        }
        lastErr = '[' + model + '] Empty response';
        continue;
      }

      const msg = (data.error && data.error.message) || ('HTTP ' + r.status);
      lastErr = '[' + model + '] ' + r.status + ': ' + msg;
      
      if (r.status === 401 || r.status === 403) { authError = msg; break; }
      if (r.status === 429) { sawQuota = true; break; }
      
    } catch (e) {
      lastErr = '[' + model + '] ' + (e.name === 'AbortError' ? 'Timeout' : e.message);
    }
  }

  if (authError) return res.status(401).json({ error: 'AUTH_ERROR', message: 'Google API key problem: ' + authError, detail: lastErr });
  if (sawQuota) return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'API quota limit hit. Please wait 1 minute.', detail: lastErr });
  return res.status(502).json({ error: 'AI_UNAVAILABLE', message: 'AI is currently busy. Please retry.', detail: lastErr });
};

module.exports.config = { maxDuration: 60 };
