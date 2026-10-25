// Ambition CBT Mode — Production AI Backend
// Powered by ASVIRO STUDIO

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, context, image, images } = req.body || {};
  if (!message || typeof message !== 'string' || message.length > 100000) {
    return res.status(400).json({ error: 'BAD_INPUT', message: 'Message missing or invalid.' });
  }

  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return res.status(500).json({ error: 'NO_KEY', message: 'GEMINI_API_KEY missing in Vercel settings.' });
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

  if (hasImages || mode === 'image-extract' || mode === 'scanned-extract') {
    systemPrompt =
      'You are an expert Indian exam question extractor and solver for CUET UG and CBSE Class 12.\n' +
      'INPUT: A photo or scan of questions, textbook exercises, PYQs, or test papers (e.g. Mathematics Integrals, Calculus, Physics, Chemistry, Biology).\n\n' +
      'MISSION:\n' +
      'Identify ALL distinct questions visible in the image and convert EVERY question into a standard 4-option MCQ format.\n\n' +
      'CRITICAL RULES FOR NON-MCQ & DIRECT QUESTIONS:\n' +
      '1. If questions already have options (A/B/C/D), copy them accurately.\n' +
      '2. If questions do NOT have options (like "Evaluate \\int x^2 \\sin^2 x dx" or numbered exercise problems), YOU MUST SOLVE THE QUESTION CAREFULLY.\n' +
      '3. Create 4 plausible options (A, B, C, D) where ONE option is the factually and mathematically correct solution, and the other 3 are realistic distractors.\n' +
      '4. "ans" MUST be the exact 0-based integer index of the correct option (0 for A, 1 for B, 2 for C, 3 for D).\n' +
      '5. For ALL mathematical and scientific formulas, symbols, fractions, powers, and integrals, ALWAYS wrap them in LaTeX syntax: $...$.\n' +
      '6. "topic" = Chapter name if identifiable (e.g. "Integrals", "Calculus"), else "CUET Mathematics".\n' +
      '7. "diff" = easy, medium, or hard.\n' +
      '8. "explain" = brief step-by-step solution.\n\n' +
      'FORMAT:\n' +
      'Return ONLY a valid, raw JSON array of objects without any markdown fences or conversational text:\n' +
      '[{"q":"Evaluate $\\\\int \\\\frac{x + \\\\sin x}{1 + \\\\cos x} dx$","options":["$x \\\\tan\\\\frac{x}{2} + C$","$\\\\tan\\\\frac{x}{2} + C$","$x \\\\cot\\\\frac{x}{2} + C$","$\\\\ln\vert{}1+\\\\cos x\vert{} + C$"],"ans":0,"topic":"Integrals","diff":"medium","explain":"Using half angle identities..."}]';
  } else if (isCBT && mode === 'extract') {
    systemPrompt =
      'You are an expert CUET exam question extractor.\n' +
      'Convert questions or exercise problems into standard 4-option MCQs. If options are missing, solve and create 4 options with one correct answer.\n' +
      'Math in $...$. "ans" must be integer 0 to 3.\n' +
      'Return ONLY a raw JSON array: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"Subject","diff":"medium","explain":""}]';
  } else if (isCBT && (mode === 'notes' || mode === 'ai')) {
    systemPrompt =
      'You are a senior CUET UG paper setter.\n' +
      'Generate high-yield NCERT standard MCQs. 4 options, 1 correct. Math in $...$.\n' +
      'Return ONLY a raw JSON array: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"Subject","diff":"medium","explain":""}]';
  } else {
    systemPrompt = 'You are Ambition AI Coach. Supportive, encouraging, concise.';
  }

  let contents = [
    {
      role: 'user',
      parts: [
        { text: systemPrompt + '\n\nUser Request / Context:\n' + message }
      ]
    }
  ];

  if (hasImages) {
    for (const img of allImages) {
      contents[0].parts.push({
        inline_data: {
          mime_type: img.mime || 'image/jpeg',
          data: img.data
        }
      });
    }
  }

  const models = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ];

  let lastError = '';

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 14000);

      const genConfig = {
        maxOutputTokens: 8192,
        temperature: isCBT ? 0.15 : 0.7
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
            contents,
            generationConfig: genConfig
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const candidateParts = data.candidates?.[0]?.content?.parts;
        let text = candidateParts ? candidateParts.map(p => p.text || '').join('').trim() : '';

        if (text) {
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');
          if (start >= 0 && end > start) {
            text = text.slice(start, end + 1);
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
        return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'API quota exceeded. Please wait a minute.' });
      }
    } catch (err) {
      lastError = err.name === 'AbortError' ? `[${model}] Timeout (>14s)` : `[${model}] ${err.message}`;
    }
  }

  return res.status(502).json({
    error: 'AI_FAILED',
    message: 'Could not extract questions from image/file.',
    detail: lastError
  });
};

module.exports.config = { maxDuration: 15 };
