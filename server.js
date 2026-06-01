const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

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
const WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
const googleClient = WEB_CLIENT_ID ? new OAuth2Client(WEB_CLIENT_ID) : null;

async function verifyGoogleToken(idToken) {
  if (!googleClient) throw new Error('Server missing GOOGLE_WEB_CLIENT_ID');
  const ticket = await googleClient.verifyIdToken({ idToken, audience: WEB_CLIENT_ID });
  const payload = ticket.getPayload();
  return {
    googleUserId: payload.sub,
    email: payload.email,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}

async function upsertUser(u) {
  const r = await pool.query(
    `INSERT INTO users (google_user_id, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_user_id) DO UPDATE
       SET email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           updated_at = now()
     RETURNING credits`,
    [u.googleUserId, u.email, u.name, u.picture],
  );
  return r.rows[0].credits;
}

async function getUserCredits(googleUserId) {
  const r = await pool.query('SELECT credits FROM users WHERE google_user_id = $1', [googleUserId]);
  return r.rows[0] ? r.rows[0].credits : null;
}

async function debitCredit(googleUserId) {
  const r = await pool.query(
    `UPDATE users SET credits = credits - 1, updated_at = now()
     WHERE google_user_id = $1 AND credits >= 1
     RETURNING credits`,
    [googleUserId],
  );
  return r.rows[0] ? r.rows[0].credits : null;
}

async function refundCredit(googleUserId) {
  await pool.query(
    'UPDATE users SET credits = credits + 1, updated_at = now() WHERE google_user_id = $1',
    [googleUserId],
  );
}

async function authFromHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    return await verifyGoogleToken(auth.slice(7));
  } catch {
    return null;
  }
}

// Single-model plan: every request goes to Flux 1.1 Pro Ultra (4 MP).
// The `tier` parameter is accepted for backward compatibility but ignored.
function planForTier(_tier, prompt, aspectRatio, imagePrompt) {
  const ar = aspectRatio || '1:1';
  const input = {
    prompt,
    aspect_ratio: ar,
    output_format: 'jpg',
    safety_tolerance: 2,
    raw: false,
  };
  if (imagePrompt) {
    input.image_prompt = imagePrompt;
    input.image_prompt_strength = 0.35;
  }
  return { model: FLUX_ULTRA, input };
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, DELETE, OPTIONS, GET');

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
      model: FLUX_ULTRA,
      hasToken: Boolean(REPLICATE_API_TOKEN),
      hasDatabase: Boolean(pool),
      hasGoogleAuth: Boolean(googleClient),
    }));
    return;
  }

  // POST /v1/auth/google — body { idToken } → upsert user, return credits
  if (req.method === 'POST' && req.url === '/v1/auth/google') {
    try {
      if (!pool) throw new Error('Server missing DATABASE_URL');
      const body = await readJson(req);
      const idToken = String(body.idToken || '');
      if (!idToken) throw new Error('Missing idToken');
      const user = await verifyGoogleToken(idToken);
      const credits = await upsertUser(user);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user, credits }));
    } catch (error) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
    return;
  }

  // PUT /v1/profile — Authorization: Bearer <id_token>, body { name } → update display name
  if (req.method === 'PUT' && req.url === '/v1/profile') {
    try {
      const auth = await authFromHeader(req);
      if (!auth) throw new Error('Unauthorized');
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
      if (!name) throw new Error('Missing name');
      await pool.query(
        'UPDATE users SET name = $1, updated_at = now() WHERE google_user_id = $2',
        [name, auth.googleUserId],
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name }));
    } catch (error) {
      const code = error.message === 'Unauthorized' ? 401 : 400;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
    return;
  }

  // GET /v1/creations — Authorization: Bearer <id_token> → user's creation history
  if (req.method === 'GET' && req.url === '/v1/creations') {
    try {
      const auth = await authFromHeader(req);
      if (!auth) throw new Error('Unauthorized');
      const r = await pool.query(
        `SELECT c.id::text AS id, c.prompt, c.image_url AS uri, c.model,
                CAST(EXTRACT(EPOCH FROM c.created_at) * 1000 AS BIGINT) AS "createdAt"
         FROM creations c
         JOIN users u ON u.id = c.user_id
         WHERE u.google_user_id = $1
         ORDER BY c.created_at DESC
         LIMIT 200`,
        [auth.googleUserId],
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ creations: r.rows }));
    } catch (error) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
    return;
  }

  // DELETE /v1/creations/:id — Authorization: Bearer <id_token>
  if (req.method === 'DELETE' && req.url && req.url.startsWith('/v1/creations/')) {
    try {
      const auth = await authFromHeader(req);
      if (!auth) throw new Error('Unauthorized');
      const id = req.url.slice('/v1/creations/'.length);
      if (!id) throw new Error('Missing id');
      await pool.query(
        `DELETE FROM creations c USING users u
         WHERE c.user_id = u.id AND u.google_user_id = $1 AND c.id::text = $2`,
        [auth.googleUserId, id],
      );
      res.writeHead(204);
      res.end();
    } catch (error) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
    return;
  }

  // GET /v1/credits — Authorization: Bearer <id_token> → current credit balance
  if (req.method === 'GET' && req.url === '/v1/credits') {
    try {
      const auth = await authFromHeader(req);
      if (!auth) throw new Error('Unauthorized');
      const credits = await getUserCredits(auth.googleUserId);
      if (credits === null) throw new Error('User not found');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ credits }));
    } catch (error) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || String(error) }));
    }
    return;
  }

  if (req.method !== 'POST' || (req.url !== '/v1/generate' && req.url !== '/v1/generations')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let debitedUserId = null;
  try {
    if (!REPLICATE_API_TOKEN) throw new Error('Missing REPLICATE_API_TOKEN');
    if (!pool) throw new Error('Server missing DATABASE_URL');

    const auth = await authFromHeader(req);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const body = await readJson(req);
    const prompt = String(body.prompt || body.input?.prompt || '').trim();
    if (!prompt) throw new Error('Missing prompt');

    const aspectRatio = body.aspect_ratio || body.input?.aspect_ratio;
    const imagePrompt = typeof body.image_prompt === 'string' && body.image_prompt.length > 0
      ? body.image_prompt
      : undefined;

    // Atomic debit (succeeds only if credits >= 1)
    const remaining = await debitCredit(auth.googleUserId);
    if (remaining === null) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'insufficient_credits' }));
      return;
    }
    debitedUserId = auth.googleUserId;

    // Flux is English-only; translate/clean non-English prompts before sending.
    const fluxPrompt = await rewritePromptForFlux(prompt);
    if (fluxPrompt !== prompt) {
      console.log(`[translate] "${prompt}" -> "${fluxPrompt}"`);
    }

    const { model, input } = planForTier(null, fluxPrompt, aspectRatio, imagePrompt);
    const [owner, name] = model.split('/');

    let prediction = await replicateRequest('POST', `/v1/models/${owner}/${name}/predictions`, { input });

    if (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.id) {
      prediction = await pollUntilDone(prediction.id, Date.now() + 90_000);
    }

    if (prediction.status === 'failed') {
      throw new Error(prediction.error || 'Generation failed');
    }

    const url = firstImage(prediction.output);
    if (!url) throw new Error('No image URL returned');

    debitedUserId = null; // commit: do not refund on success

    // Persist creation to the user's history (best-effort — failure here doesn't
    // block the response since the image was generated successfully).
    let creationId = null;
    try {
      const ins = await pool.query(
        `INSERT INTO creations (user_id, prompt, image_url, model)
         SELECT id, $1, $2, $3 FROM users WHERE google_user_id = $4
         RETURNING id::text`,
        [prompt, url, model, auth.googleUserId],
      );
      creationId = ins.rows[0]?.id || null;
    } catch (e) {
      console.error('[creations] save failed', e.message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url,
      imageUrl: url,
      model,
      id: prediction.id,
      status: prediction.status,
      credits: remaining,
      creationId,
    }));
  } catch (error) {
    if (debitedUserId) {
      try { await refundCredit(debitedUserId); } catch {}
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
});

server.listen(PORT, () => {
  console.log(`CreatePicAI backend on :${PORT}`);
  console.log(`  Model:    ${FLUX_ULTRA}`);
  console.log(`  Replicate token: ${Boolean(REPLICATE_API_TOKEN)}`);
  console.log(`  Database:        ${Boolean(pool)}`);
  console.log(`  Google auth:     ${Boolean(googleClient)}`);
});
