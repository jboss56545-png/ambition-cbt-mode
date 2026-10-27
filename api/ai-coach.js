// Ambition CBT Mode — Blazing Fast AI Backend
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
  if (!key) return res.status(500).json({ error: 'NO_KEY', message: 'GEMINI_API_KEY missing on Vercel.' });

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

  const mathRule = 
    '7. CRITICAL MATH RULE: Wrap ALL math expressions and formulas (in both "q" and every item in "options") inside `$ ... $` delimiters (e.g. "$-x \\\\cos^{-1} x + \\\\sqrt{1 - x^2} + C$"). Do NOT leave raw LaTeX outside `$ ... $`. Inside JSON strings, ALWAYS escape backslashes as `\\\\` (e.g. `\\\\frac`, `\\\\sqrt`, `\\\\tan`, `\\\\cos`).\n\n';

  if (hasImages && (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes')) {
    system =
      'You are an expert Indian exam question extractor.\n\n' +
      'MISSION: Extract ALL valid exam questions from the image and convert to standard 4-option MCQ format.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Extract questions that are ACTUALLY PRESENT in the image. Do NOT invent questions from different subjects.\n' +
      '2. If the image is blurry, try your best to read it. ONLY return [] if the image has absolutely no text/questions.\n' +
      '3. Question text must be EXACT. If it has statements (A, B, C, D), put EACH statement on a NEW LINE using \\n.\n' +
      '4. REMOVE all option prefixes from the options array! Do NOT include (a), (b), (A), 1, 2. Just the raw text.\n' +
      '5. Exactly 4 options, ONE correct. "ans" = 0-based index (0,1,2,3).\n' +
      '6. If direct question without options, SOLVE carefully. Only 1 option must be 100% correct.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'extract') {
    system =
      'You are an expert CUET exam question extractor.\n\n' +
      'CRITICAL RULES:\n' +
      '1. Extract ONLY the questions present in the text.\n' +
      '2. If the text doesn\'t have questions, return [].\n' +
      '3. Question text EXACT. Statements (A, B, C, D) on new lines using \\n.\n' +
      '4. REMOVE option prefixes (a), (b), (A), 1. from the array items.\n' +
      '5. Exactly 4 options, ONE correct. "ans" = 0 to 3.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'notes') {
    system =
      'You are a senior CUET UG paper setter.\n' +
      'Generate high-yield NCERT MCQs. 4 options, 1 correct. REMOVE any prefixes from options array.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else if (isCBT && mode === 'ai') {
    system =
      'You are an expert CUET UG paper setter. Generate MCQs matching Oswaal/Arihant style.\n' +
      '4 options, 1 correct. REMOVE any prefixes from options array.\n' +
      mathRule +
      'FORMAT — Reply with ONLY a valid JSON array:\n' +
      '[{"q":"...","options":["text1","text2","text3","text4"],"ans":0,"topic":"...","diff":"easy","explain":""}]\n\n' +
      'USER REQUEST:\n' + JSON.stringify(context || {});

  } else {
    system = 'You are "The Raven", a wise and encouraging AI coach for competitive exam students. Supportive, concise.\n\n' +
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

  // Models untouched as requested!
  const models = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-3.5-flash-lite'
  ];

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

  if (authError) return res.status(401).json({ error: 'AUTH_ERROR', message: 'API Key problem: ' + authError });
  if (sawQuota) return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'API quota limit hit. Wait 1 min.' });
  return res.status(502).json({ error: 'AI_UNAVAILABLE', message: 'AI is busy. Please retry.' });
};

module.exports.config = { maxDuration: 60 };
