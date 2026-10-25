// Ambition CBT Mode — Production AI Backend
// Robust JSON extractor for Text, Scanned PDFs & Photos

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

  // Extract all images
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
      'You are a high-speed Indian competitive exam (CUET/CBSE) question extractor.\n' +
      'TASK: Look at the image carefully and extract all Multiple Choice Questions (MCQs).\n' +
      'RULES:\n' +
      '1. Extract every MCQ visible with all 4 options (A, B, C, D).\n' +
      '2. If the answer is marked or obvious, set "ans" as 0 (for A), 1 (for B), 2 (for C), or 3 (for D). If unsure, solve it factually and assign correct option index (0 to 3).\n' +
      '3. If question has less than 4 options, make plausible options so there are exactly 4.\n' +
      '4. If no complete question is visible, construct 1-2 standard CUET MCQs based on whatever text/topic is visible.\n' +
      '5. For math/formulas use LaTeX notation wrapped in $...$.\n' +
      '6. OUTPUT ONLY A RAW JSON ARRAY of objects. Never wrap in markdown, never output prose.\n' +
      'Format:\n' +
      '[{"q":"Question text","options":["Option A","Option B","Option C","Option D"],"ans":0,"topic":"Subject","diff":"medium","explain":"Brief reason"}]';
  } else if (isCBT && mode === 'extract') {
    systemPrompt =
      'You are an expert CUET exam question extractor.\n' +
      'TASK: Extract questions from the provided text into standard 4-option MCQs.\n' +
      'If explicit MCQs exist, extract them accurately. If not, generate standard CUET MCQs based on the provided text concepts.\n' +
      'Options must be exactly 4. "ans" must be integer 0, 1, 2, or 3. Math in $...$.\n' +
      'OUTPUT ONLY JSON ARRAY: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"Subject","diff":"medium","explain":""}]';
  } else if (isCBT && (mode === 'notes' || mode === 'ai')) {
    systemPrompt =
      'You are a senior CUET UG paper setter.\n' +
      'Generate high-yield NCERT/PYQ standard MCQs based on the prompt.\n' +
      'Exactly 4 options, "ans" is 0-3, vary answer keys. Math in $...$.\n' +
      'OUTPUT ONLY JSON ARRAY: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"Subject","diff":"medium","explain":""}]';
  } else {
    systemPrompt = 'You are Ambition AI Coach for CUET aspirants. Concise, supportive, helpful.';
  }

  // Construct request contents
  let parts = [];
  if (hasImages) {
    for (const img of allImages) {
      parts.push({
        inlineData: {
          mimeType: img.mime || 'image/jpeg',
          data: img.data
        }
      });
    }
  }
  parts.push({ text: systemPrompt + '\n\nUser Content/Instruction:\n' + message });

  const contents = [{ role: 'user', parts: parts }];

  // Fallback models in priority order
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
      const timeoutId = setTimeout(() => controller.abort(), 13500);

      const genConfig = {
        maxOutputTokens: 8192,
        temperature: isCBT ? 0.1 : 0.7
      };
      if (isCBT) {
        genConfig.responseMimeType = 'application/json';
      }

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
          if (isCBT) {
            text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            const start = text.indexOf('[');
            const end = text.lastIndexOf(']');
            if (start >= 0 && end > start) {
              text = text.slice(start, end + 1);
            }
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
      lastError = err.name === 'AbortError' ? `[${model}] Timeout (>13.5s)` : `[${model}] ${err.message}`;
    }
  }

  return res.status(502).json({
    error: 'AI_FAILED',
    message: 'Could not extract questions from file/image.',
    detail: lastError
  });
};

module.exports.config = { maxDuration: 15 };
