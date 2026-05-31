const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const FLUX_PRO = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-1.1-pro';
const FLUX_ULTRA = process.env.REPLICATE_MODEL_ULTRA || 'black-forest-labs/flux-1.1-pro-ultra';

// Tier → (model, input) mapping. low/medium use flux-1.1-pro with quality knobs;
// high uses flux-1.1-pro-ultra for the 4MP step up that justifies 10 credits.
function planForTier(tier, prompt, aspectRatio, imagePrompt) {
  const ar = aspectRatio || '1:1';
  const withImage = input => imagePrompt ? { ...input, image_prompt: imagePrompt } : input;
  if (tier === 'low') {
    return {
      model: FLUX_PRO,
      input: withImage({
        prompt,
        aspect_ratio: ar,
        output_format: 'jpg',
        output_quality: 75,
        safety_tolerance: 2,
        prompt_upsampling: false,
      }),
    };
  }
  if (tier === 'high') {
    return {
      model: FLUX_ULTRA,
      input: withImage({
        prompt,
        aspect_ratio: ar,
        output_format: 'jpg',
        safety_tolerance: 2,
        raw: false,
        ...(imagePrompt ? { image_prompt_strength: 0.35 } : null),
      }),
    };
  }
  // medium (default)
  return {
    model: FLUX_PRO,
    input: withImage({
      prompt,
      aspect_ratio: ar,
      output_format: 'jpg',
      output_quality: 90,
      safety_tolerance: 2,
      // prompt_upsampling can conflict with image_prompt — disable when a reference is provided
      prompt_upsampling: imagePrompt ? false : true,
    }),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 24_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function replicateRequest(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const headers = {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const request = https.request(
      {
        hostname: 'api.replicate.com',
        path: urlPath,
        method,
        headers,
      },
      response => {
        let data = '';
        response.on('data', chunk => {
          data += chunk;
        });
        response.on('end', () => {
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            reject(new Error(`Invalid JSON from Replicate (${response.statusCode})`));
            return;
          }
          if (response.statusCode >= 400) {
            reject(new Error(parsed.detail || parsed.title || `Replicate ${response.statusCode}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function firstImage(output) {
  if (Array.isArray(output)) {
    return output[0];
  }
  if (typeof output === 'string') {
    return output;
  }
  return undefined;
}

const TRANSLATE_MODEL = process.env.REPLICATE_TRANSLATE_MODEL || 'meta/meta-llama-3-70b-instruct';

function looksLikelyEnglish(prompt) {
  if (/[ğĞşŞıİöÖüÜçÇ]/.test(prompt)) {
    return false;
  }
  if (/[^\x00-\x7F]/.test(prompt)) {
    return false;
  }
  return true;
}

async function rewritePromptForFlux(prompt) {
  if (looksLikelyEnglish(prompt)) {
    console.log('[translate] skipped (ASCII English):', prompt);
    return prompt;
  }
  console.log('[translate] start:', prompt);
  const [owner, name] = TRANSLATE_MODEL.split('/');
  const system = [
    'You convert user image-generation requests (in any language, often Turkish) into a short literal English noun phrase describing the SCENE to draw.',
    'Rules:',
    '1) Users often make typos. Interpret each word holistically from context. Common typos: "kefi"→"kedi"(cat), "mullan"→"kullanan"(driving/using), "çizet"→"çizer"(draws), "kuş"/"kuşs"→"kuş"(bird).',
    '2) Strip politeness ("çizer misin", "can you draw", "lütfen", "please") — these are NOT part of the scene.',
    '3) Strip the verb "draw"/"çiz" itself — only describe WHAT is in the scene.',
    '4) Preserve every concrete subject and action exactly. Never invent new subjects, never swap one animal for another, never add unrelated scenery.',
    '5) Output ONLY the English noun phrase on one line. No quotes, no preamble, no period.',
  ].join('\n');
  const fewShot = [
    'Input: "Araba kullanan bir kutup ayısı çizer misin"',
    'Output: a polar bear driving a car',
    '',
    'Input: "Araba kullanan kefi çizet misin"',
    'Output: a cat driving a car',
    '',
    'Input: "Araba mullan kedi çizer misin"',
    'Output: a cat driving a car',
    '',
    'Input: "Gökyüzünde uçan bir balina"',
    'Output: a whale flying in the sky',
    '',
    'Input: "lütfen kırmızı bir elma çiz"',
    'Output: a red apple',
  ].join('\n');
  const user = `${fewShot}\n\nInput: "${prompt}"\nOutput:`;
  try {
    const prediction = await replicateRequest('POST', `/v1/models/${owner}/${name}/predictions`, {
      input: {
        prompt: user,
        system_prompt: system,
        max_tokens: 200,
        temperature: 0.1,
        top_p: 0.9,
      },
    });
    console.log('[translate] initial status:', prediction.status, 'id:', prediction.id);
    let final = prediction;
    if (final.status !== 'succeeded' && final.status !== 'failed' && final.id) {
      final = await pollUntilDone(final.id, Date.now() + 30_000);
    }
    console.log('[translate] final status:', final.status, 'output type:', Array.isArray(final.output) ? 'array' : typeof final.output);
    if (final.status !== 'succeeded') {
      console.log('[translate] failed, falling back. error:', final.error);
      return prompt;
    }
    const raw = Array.isArray(final.output) ? final.output.join('') : String(final.output || '');
    console.log('[translate] raw output:', JSON.stringify(raw).slice(0, 300));
    const cleaned = raw
      .trim()
      .replace(/^["'`\s]+|["'`\s]+$/g, '')
      .split(/\n+/)[0]
      .trim();
    console.log('[translate] cleaned:', cleaned);
    return cleaned.length > 2 ? cleaned : prompt;
  } catch (err) {
    console.log('[translate] threw:', err && err.message);
    return prompt;
  }
}

async function pollUntilDone(id, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const prediction = await replicateRequest('GET', `/v1/predictions/${id}`, null);
    if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') {
      return prediction;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('Generation timed out');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      provider: 'replicate',
      models: { pro: FLUX_PRO, ultra: FLUX_ULTRA },
      hasToken: Boolean(REPLICATE_API_TOKEN),
    }));
    return;
  }

  if (req.method !== 'POST' || (req.url !== '/v1/generate' && req.url !== '/v1/generations')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    if (!REPLICATE_API_TOKEN) {
      throw new Error('Missing REPLICATE_API_TOKEN');
    }

    const body = await readJson(req);
    const prompt = String(body.prompt || body.input?.prompt || '').trim();
    if (!prompt) {
      throw new Error('Missing prompt');
    }

    const tier = body.model === 'low' || body.model === 'medium' || body.model === 'high'
      ? body.model
      : (body.tier || 'medium');
    const aspectRatio = body.aspect_ratio || body.input?.aspect_ratio;
    const imagePrompt = typeof body.image_prompt === 'string' && body.image_prompt.length > 0
      ? body.image_prompt
      : undefined;

    // Flux is English-only; translate/clean non-English prompts before sending.
    const fluxPrompt = await rewritePromptForFlux(prompt);
    if (fluxPrompt !== prompt) {
      console.log(`[translate] "${prompt}" -> "${fluxPrompt}"`);
    }

    const { model, input } = planForTier(tier, fluxPrompt, aspectRatio, imagePrompt);
    const [owner, name] = model.split('/');

    let prediction = await replicateRequest('POST', `/v1/models/${owner}/${name}/predictions`, { input });

    if (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.id) {
      // Replicate's Prefer:wait=60 caps at 60s; ultra tier can run longer.
      prediction = await pollUntilDone(prediction.id, Date.now() + 90_000);
    }

    if (prediction.status === 'failed') {
      throw new Error(prediction.error || 'Generation failed');
    }

    const url = firstImage(prediction.output);
    if (!url) {
      throw new Error('No image URL returned');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url,
      imageUrl: url,
      model,
      tier,
      id: prediction.id,
      status: prediction.status,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
});

server.listen(PORT, () => {
  console.log(`CreatePicAI Replicate proxy on http://localhost:${PORT}`);
  console.log(`Endpoint: POST /v1/generate { prompt, model: 'low'|'medium'|'high' }`);
  console.log(`Pro:   ${FLUX_PRO}`);
  console.log(`Ultra: ${FLUX_ULTRA}`);
  console.log(`REPLICATE_API_TOKEN loaded: ${Boolean(REPLICATE_API_TOKEN)}`);
});
