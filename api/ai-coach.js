// Ambition CBT Mode — Production AI Backend
// Secure, fast & optimized for Vercel Serverless limits

module.exports = async (req, res) => {
  const allowedOrigin = 'https://ambition-cbt-mode.vercel.app';
  const origin = req.headers.origin;

  // Domain security check (CORS)
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
    return res.status(500).json({
      error: 'NO_KEY',
      message: 'GEMINI_API_KEY missing in Vercel Environment Variables.'
    });
  }

  const isCBT = context && (context.source === 'ambition-cuet-cbt' || context.source === 'cbt-test-studio');
  const mode = (context && context.mode) || 'chat';

  // Collect and validate base64 images
  let allImages = [];
  if (Array.isArray(images) && images.length) {
    allImages = images.filter(i => i && i.data && i.mime);
  } else if (image && image.data && image.mime) {
    allImages = [image];
  }
  const hasImages = allImages.length > 0;

  let systemPrompt = '';

  // 1. IMAGE & SCANNED OCR EXTRACT
  if (hasImages && (mode === 'scanned-extract' || mode === 'image-extract' || mode === 'extract' || mode === 'notes')) {
    systemPrompt =
      'You are a high-speed Indian competitive exam question extractor for CUET UG.\n' +
      'Extract all valid MCQs from the given images.\n' +
      'RULES:\n' +
      '1. NEVER invent questions. Extract ONLY what is visible in the image.\n' +
      '2. Standard 4 options per question. ans must be exact 0-based integer index (0, 1, 2, or 3).\n' +
      '3. Use LaTeX for math ($...$).\n' +
      '4. Output ONLY a valid JSON array. No markdown, no prose.\n' +
      'JSON Schema: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';

  // 2. TEXT-BASED QUESTION PAPER EXTRACT
  } else if (isCBT && mode === 'extract') {
    systemPrompt =
      'You are an expert exam question extractor for CUET.\n' +
      'Extract explicit MCQs from the provided text. Never invent questions.\n' +
      'Options must be exactly 4. ans is index 0-3.\n' +
      'Use LaTeX for math. Output ONLY a valid JSON array.\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';

  // 3. GENERATE MCQS FROM NOTES
  } else if (isCBT && mode === 'notes') {
    systemPrompt =
      'You are a CUET question setter.\n' +
      'Generate high-yield MCQs based on the provided notes/concepts.\n' +
      '4 options, 1 correct. ans is index 0-3. Use LaTeX for math.\n' +
      'Output ONLY a valid JSON array.\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';

  // 4. AI PRACTICE TEST GENERATION
  } else if (isCBT && mode === 'ai') {
    systemPrompt =
      'You are a premier CUET UG question setter.\n' +
      'Generate NCERT-based PYQ-pattern MCQs.\n' +
      '4 options, 1 correct. ans is index 0-3. Use LaTeX for math ($...$).\n' +
      'Output ONLY a valid JSON array.\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"chapter","diff":"medium","explain":""}]';

  // 5. GENERAL CHAT / FALLBACK
  } else {
    systemPrompt =
      'You are Ambition AI Coach for CUET aspirants. Supportive, motivating, concise. Output plain text.';
  }

  // Build payload
  let contents = [{ role: 'user', parts: [{ text: message }] }];

  if (hasImages) {
    for (const img of allImages) {
      contents[0].parts.push({
        inline_data: {
          mime_type: img.mime,
          data: img.data
        }
      });
    }
  }

  // Fast & reliable models list (Free-tier safe)
  const models = [
    (process.env.GEMINI_MODEL || '').trim(),
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ].filter((m, i, a) => m && a.indexOf(m) === i);

  let lastError = '';

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9500); // 9.5s timeout to stay inside Vercel limits

      const genConfig = {
        maxOutputTokens: 8192,
        temperature: isCBT ? 0.1 : 0.7
      };
      if (isCBT) genConfig.responseMimeType = 'application/json';

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
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
        return res.status(401).json({ error: 'AUTH_ERROR', message: 'Vercel me GEMINI_API_KEY galat hai ya expire ho gayi hai.' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'Gemini free quota limit cross ho gayi. 1 minute baad try karein.' });
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
