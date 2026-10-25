// Ambition CBT Mode — Production AI Backend
// Secure, fast & optimized for Vercel Serverless limits

module.exports = async (req, res) => {
  const allowedOrigin = 'https://ambition-cbt-mode.vercel.app';
  const origin = req.headers.origin;

  if (origin === allowedOrigin || process.env.NODE_ENV === 'development') {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, context, history, image, images } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 80000) {
    return res.status(400).json({ error: 'BAD_INPUT', message: 'Message missing or invalid.' });
  }

  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return res.status(500).json({ error: 'NO_KEY', message: 'GEMINI_API_KEY missing.' });
  }

  const isCBT = context && (context.source === 'ambition-cuet-cbt' || context.source === 'cbt-test-studio');
  const mode = (context && context.mode) || 'chat';

  let allImages = [];
  if (Array.isArray(images) && images.length) {
    allImages = images.filter(i => i && i.data && i.mime);
  } else if (image && image.data && image.mime) {
    allImages = [image];
  }
  const hasImages = allImages.length > 0;

  let systemPrompt = '';

  if (hasImages && (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes')) {
    systemPrompt = 'You are a high-speed Indian competitive exam question extractor for CUET UG.\nExtract all valid MCQs from the given images.\nRULES:\n1. NEVER invent questions. Extract ONLY what is visible in the image.\n2. Standard 4 options per question. ans must be exact 0-based integer index (0, 1, 2, or 3).\n3. Use LaTeX for math ($...$).\n4. Output ONLY a valid JSON array. No markdown, no prose.\nJSON Schema: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';
  } else if (isCBT && mode === 'extract') {
    systemPrompt = 'You are an expert exam question extractor for CUET.\nExtract explicit MCQs from the provided text. Never invent questions.\nOptions must be exactly 4. ans is index 0-3.\nUse LaTeX for math. Output ONLY a valid JSON array.\n[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';
  } else if (isCBT && mode === 'notes') {
    systemPrompt = 'You are a CUET question setter.\nGenerate high-yield MCQs based on the provided notes/concepts.\n4 options, 1 correct. ans is index 0-3. Use LaTeX for math.\nOutput ONLY a valid JSON array.\n[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';
  } else if (isCBT && mode === 'ai') {
    systemPrompt = 'You are a premier CUET UG question setter.\nGenerate NCERT-based PYQ-pattern MCQs.\n4 options, 1 correct. ans is index 0-3. Use LaTeX for math ($...$).\nOutput ONLY a valid JSON array.\n[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';
  } else {
    systemPrompt = 'You are Ambition AI Coach for CUET aspirants. Supportive, motivating, concise. Output plain text.';
  }

  let contents = [{ role: 'user', parts: [{ text: message }] }];
  if (hasImages) {
    for (const img of allImages) {
      contents[0].parts.push({
        inline_data: { mime_type: img.mime, data: img.data }
      });
    }
  }

  // UPDATED: Most stable and working Gemini models
  const models = [
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest'
  ];

  let lastError = '';

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9500);

      const genConfig = { maxOutputTokens: 8192, temperature: isCBT ? 0.1 : 0.7 };
      if (isCBT) genConfig.responseMimeType = 'application/json';

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: genConfig
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const parts = data.candidates?.[0]?.content?.parts;
        let text = parts ? parts.map(p => p.text || '').join('').trim() : '';

        if (text) {
          if (isCBT) {
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            const start = text.indexOf('[');
            const end = text.lastIndexOf(']');
            if (start >= 0 && end > start) text = text.slice(start, end + 1);
          }
          return res.status(200).json({ message: text });
        }
        lastError = `[${model}] Empty output`;
        continue;
      }

      const errMsg = data.error?.message || `HTTP ${response.status}`;
      lastError = `[${model}] ${errMsg}`;

      if (response.status === 401 || response.status === 403) {
        return res.status(401).json({ error: 'AUTH_ERROR', message: 'API Key invalid or expired.' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'Quota limit cross ho gayi. 1 minute baad try karein.' });
      }
    } catch (err) {
      lastError = err.name === 'AbortError' ? `[${model}] Timeout (>9.5s)` : `[${model}] ${err.message}`;
    }
  }

  return res.status(502).json({
    error: 'AI_TIMEOUT_OR_BUSY',
    message: 'AI request process nahi ho saki. Chhote chunks ya clear photo upload karein.',
    detail: lastError
  });
};

module.exports.config = { maxDuration: 15 };
