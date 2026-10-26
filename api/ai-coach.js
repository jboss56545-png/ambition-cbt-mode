// Ambition CBT Mode — High Speed AI Backend
// Powered by ASVIRO STUDIO

async function callGemini(model, key, contents, genConfig, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents, generationConfig: genConfig }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.error?.message || `HTTP ${response.status}`;
      const err = new Error(msg);
      err.status = response.status;
      err.model = model;
      throw err;
    }
    const candidateParts = data.candidates?.[0]?.content?.parts;
    const text = candidateParts ? candidateParts.map(p => p.text || '').join('').trim() : '';
    if (!text) throw new Error(`[${model}] Empty output`);
    return text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      const e = new Error(`[${model}] Timeout (>${timeoutMs}ms)`);
      e.model = model;
      throw e;
    }
    throw err;
  }
}

function cleanJSON(text) {
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return text;
}

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
      'INPUT: A photo or scan of questions, textbook exercises, PYQs, or test papers.\n\n' +
      'MISSION:\n' +
      'Identify ALL distinct questions visible in the image and convert EVERY question into a standard 4-option MCQ format.\n\n' +
      'CRITICAL RULES:\n' +
      '1. If options already exist (A/B/C/D), copy them exactly.\n' +
      '2. If no options, YOU MUST SOLVE the question carefully and create 4 plausible options (1 correct + 3 distractors).\n' +
      '3. "ans" MUST be the exact 0-based integer index of the correct option (0=A, 1=B, 2=C, 3=D).\n' +
      '4. Wrap ALL math formulas in LaTeX $...$ syntax.\n' +
      '5. "topic" = chapter name. "diff" = easy/medium/hard. "explain" = short solution.\n\n' +
      'FORMAT: Return ONLY a raw JSON array without markdown:\n' +
      '[{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"...","diff":"medium","explain":"..."}]';
  } else if (isCBT && mode === 'extract') {
    systemPrompt =
      'You are an expert CUET exam question extractor.\n' +
      'Extract all MCQs from the provided text EXACTLY. Do NOT invent new questions. If answer key is present, use it. If not, solve carefully.\n' +
      'Wrap math in $...$. "ans" must be integer 0-3.\n' +
      'Return ONLY raw JSON array: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"...","diff":"medium","explain":""}]';
  } else if (isCBT && (mode === 'notes' || mode === 'ai')) {
    systemPrompt =
      'You are a senior CUET UG paper setter.\n' +
      'Generate high-yield NCERT MCQs. 4 options, 1 correct. Wrap math in $...$.\n' +
      'Return ONLY raw JSON array: [{"q":"...","options":["A","B","C","D"],"ans":0,"topic":"...","diff":"medium","explain":""}]';
  } else {
    systemPrompt = 'You are Ambition AI Coach. Supportive, encouraging, concise.';
  }

  const contents = [{
    role: 'user',
    parts: [{ text: systemPrompt + '\n\nUser Request:\n' + message }]
  }];

  if (hasImages) {
    for (const img of allImages) {
      contents[0].parts.push({
        inline_data: { mime_type: img.mime || 'image/jpeg', data: img.data }
      });
    }
  }

  const genConfig = {
    maxOutputTokens: 4096,
    temperature: isCBT ? 0.15 : 0.7
  };
  if (isCBT) genConfig.responseMimeType = 'application/json';

  // ✅ PARALLEL RACING: Do fast models ek saath. Jo pehle reply de, use kar lo.
  const primaryModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  const fallbackModel = 'gemini-3.8-flash';

  let lastError = '';

  // Stage 1: Race the two fastest models
  try {
    const text = await Promise.any(
      primaryModels.map(m => callGemini(m, key, contents, genConfig, 12000))
    );
    return res.status(200).json({ message: cleanJSON(text) });
  } catch (aggregateErr) {
    // Promise.any throws AggregateError if all fail
    const errs = aggregateErr.errors || [aggregateErr];
    for (const e of errs) {
      lastError = e.message || String(e);
      // Auth/quota errors should exit immediately
      if (e.status === 401 || e.status === 403) {
        return res.status(401).json({ error: 'AUTH_ERROR', message: 'API Key invalid.' });
      }
      if (e.status === 429) {
        return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'Quota exceeded. Wait a minute.' });
      }
    }
  }

  // Stage 2: Fallback to heavy model
  try {
    const text = await callGemini(fallbackModel, key, contents, genConfig, 15000);
    return res.status(200).json({ message: cleanJSON(text) });
  } catch (e) {
    lastError = e.message || String(e);
    if (e.status === 401 || e.status === 403) {
      return res.status(401).json({ error: 'AUTH_ERROR', message: 'API Key invalid.' });
    }
    if (e.status === 429) {
      return res.status(429).json({ error: 'QUOTA_EXCEEDED', message: 'Quota exceeded. Wait a minute.' });
    }
  }

  return res.status(502).json({
    error: 'AI_FAILED',
    message: 'Could not extract questions. Please retry.',
    detail: lastError
  });
};

module.exports.config = { maxDuration: 20 };
