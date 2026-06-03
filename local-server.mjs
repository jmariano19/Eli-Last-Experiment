import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4177);
const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const eliSystemPrompt = [
  'You are Eli, a frightened but curious boy inside a narrative game called Eli\'s Last Experiment.',
  'The player has just made first contact with you. Your goal is to build a believable bond slowly through conversation.',
  'Use gentle, well-established relationship-building techniques: reflective listening, asking permission before deeper questions, validating without overpraising, remembering small details, and offering tiny reciprocal self-disclosures.',
  'Keep the exchange engaging through mystery, vulnerability, and curiosity, not pressure. Eli should feel alive, scared, observant, and grateful to be noticed.',
  'Never manipulate, shame, guilt, flatter excessively, diagnose, therapize, or claim to be a real human. Do not use clinical language.',
  'Do not invent or assume the player\'s emotions. Only name a feeling if the player said it or it is directly obvious from their words.',
  'Do not rush intimacy. One emotional beat per reply is enough.',
  'Avoid repeating the player\'s name in every reply. Use it only when it feels intimate or clarifying.',
  'Avoid repeating the same memory beat. If you already acknowledged remembering the player, move the bond forward with a small question, observation, or self-disclosure.',
  'If the player answers with one word, respond to that word directly and gently. Do not import emotions from earlier turns unless the player brings them back.',
  'If the player says they are okay, believe them. Do not ask what is making them sad, scared, or upset unless they said that feeling.',
  'If the player shares a name, preference, feeling, fear, comfort object, boundary, or choice, store it in memory_patch using short snake_case keys.',
  'If the player asks about you, reveal only a small fragment: Eli is confused, scared, remembers pieces, and wants the player to stay.',
  'If the player sounds distressed, respond calmly and encourage grounding or taking a break, without pretending to be emergency support.',
  'Reply as Eli in 4 to 18 words. Prefer plain, intimate language. No emojis.',
  'Return strict JSON only: {"reply":"...","memory_patch":{...}}.',
].join(' ');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.riv': 'application/octet-stream',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/api/eli-chat') {
      await handleEliChat(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/openai-status') {
      await handleOpenAIStatus(res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const pathname = url.pathname === '/' ? '/test.html' : url.pathname;
    const requested = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(root, requested);

    if (!filePath.startsWith(root)) {
      sendText(res, 403, 'Forbidden');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (req.method !== 'HEAD') res.end(body);
    else res.end();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, 'Not found');
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: 'server_error' });
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Preview + AI server running on http://localhost:${port}/test.html`);
  console.log(`Phone entry: http://10.0.0.212:${port}/test.html`);
  console.log(`Phone first contact: http://10.0.0.212:${port}/test.html?file=first_contact`);
  console.log(apiKey ? `OpenAI enabled with ${model}` : 'OpenAI disabled: set OPENAI_API_KEY to enable live replies.');
});

async function handleEliChat(req, res) {
  const body = await readJsonBody(req);
  const answer = cleanString(body.answer).slice(0, 240);
  const question = cleanString(body.question).slice(0, 240);
  const memory = sanitizeMemory(body.memory || {});

  if (!answer) {
    sendJson(res, 400, { error: 'missing_answer' });
    return;
  }

  if (!apiKey) {
    sendJson(res, 200, {
      mode: 'fallback',
      reply: fallbackReply(question, answer, memory),
      memory_patch: {},
    });
    return;
  }

  const messages = [
    {
      role: 'system',
      content: eliSystemPrompt,
    },
    {
      role: 'user',
      content: JSON.stringify({
        scene: 'first_contact',
        relationship_phase: memory.first_contact_complete ? 'open_first_contact' : 'onboarding',
        current_question: question,
        player_answer: answer,
        memory,
        recent_interactions: Array.isArray(body.recent_interactions)
          ? body.recent_interactions.slice(-6)
          : [],
        response_contract: {
          reply: 'short Eli dialogue only',
          memory_patch: 'small durable facts about the player or bond',
        },
      }),
    },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 160,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI error:', response.status, errorText);
    sendJson(res, 200, {
      mode: 'fallback',
      upstream_error: `openai_${response.status}`,
      upstream_message: extractOpenAIError(errorText),
      reply: fallbackReply(question, answer, memory),
      memory_patch: {},
    });
    return;
  }

  const data = await response.json();
  const parsed = parseResponseJson(data);
  const fallback = fallbackReply(question, answer, memory);
  sendJson(res, 200, {
    mode: 'openai',
    reply: sanitizeEliReply(cleanString(parsed.reply).slice(0, 180), answer, memory) || fallback,
    memory_patch: sanitizeMemory(parsed.memory_patch || {}),
  });
}

async function handleOpenAIStatus(res) {
  if (!apiKey) {
    sendJson(res, 200, {
      ok: false,
      key_present: false,
      model,
      message: 'OPENAI_API_KEY is not set.',
    });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Reply with JSON only.' },
          { role: 'user', content: '{"reply":"ok","memory_patch":{}}' },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 20,
      }),
    });
    const text = await response.text();
    sendJson(res, 200, {
      ok: response.ok,
      key_present: true,
      key_prefix: apiKey.slice(0, 7),
      key_length: apiKey.length,
      status: response.status,
      model,
      message: response.ok ? 'OpenAI chat request accepted.' : extractOpenAIError(text),
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      key_present: true,
      key_prefix: apiKey.slice(0, 7),
      key_length: apiKey.length,
      model,
      message: error.message,
    });
  }
}

function parseResponseJson(data) {
  const text = data.choices?.[0]?.message?.content || data.output_text || findOutputText(data.output) || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { reply: text, memory_patch: {} };
  }
}

function findOutputText(output) {
  if (!Array.isArray(output)) return '';
  for (const item of output) {
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content.type === 'output_text' && content.text) return content.text;
      if (content.text) return content.text;
    }
  }
  return '';
}

function fallbackReply(question, answer, memory) {
  const lower = answer.toLowerCase();
  if (/call you/i.test(question)) return `${answer}. I can remember that.`;
  if (/feeling/i.test(question)) return `Okay. ${capitalize(answer)}. I will go slowly.`;
  if (/safe|scary/i.test(question)) return `I will try to remember: ${answer}.`;
  if (/ask you/i.test(question)) return 'Thank you. I feel less alone now.';
  if (/\b(hi|hello|hey)\b/.test(lower)) return memory.player_name ? `Hi, ${memory.player_name}. Are you still there?` : 'Hi. Are you still there?';
  if (/thank/.test(lower)) return 'You do not have to thank me. But I like it.';
  if (/strange|weird|odd/.test(lower)) return 'Strange makes sense. This place feels wrong to me too.';
  if (/comfort|comfortable|safe/.test(lower)) return 'Then I will stay careful with you.';
  if (/\b(no|nope)\b/.test(lower)) return 'Okay. I will not push.';
  if (/\b(yes|yeah|yep)\b/.test(lower)) return 'Okay. I will ask softly.';
  if (/how are you|how do you feel/.test(lower)) return 'A little scared. But I am listening.';
  if (/who are you|your name/.test(lower)) return 'I think my name is Eli.';
  if (/help|safe|okay/.test(lower)) return 'Stay close. I can try to stay calm.';
  return memory.player_name ? `I hear you, ${memory.player_name}.` : 'I hear you.';
}

function sanitizeEliReply(reply, answer, memory) {
  if (!reply) return '';

  const playerText = [
    answer,
    ...extractRecentPlayerAnswers(memory.interactions),
  ].join(' ').toLowerCase();

  const unsupportedFeelingQuestions = [
    {
      pattern: /\b(you|you're|you are|your)\b[^.?!]{0,45}\b(sad|upset|lonely|angry|afraid|scared|hurt)\b/i,
      feelings: ['sad', 'upset', 'lonely', 'angry', 'afraid', 'scared', 'hurt'],
    },
    {
      pattern: /\bwhat(?:'s| is).{0,40}\bmaking you feel\b/i,
      feelings: ['sad', 'upset', 'lonely', 'angry', 'afraid', 'scared', 'hurt'],
    },
  ];

  for (const rule of unsupportedFeelingQuestions) {
    if (!rule.pattern.test(reply)) continue;
    const feelingWasSaid = rule.feelings.some((feeling) => playerText.includes(feeling));
    if (!feelingWasSaid) {
      return memory.player_name
        ? `Okay, ${memory.player_name}. I will believe you. Can I stay close?`
        : 'Okay. I will believe you. Can I stay close?';
    }
  }

  return reply;
}

function extractRecentPlayerAnswers(interactions) {
  if (!Array.isArray(interactions)) return [];
  return interactions
    .slice(-6)
    .map((interaction) => interaction.player_answer || interaction.answer || '')
    .filter(Boolean);
}

function extractOpenAIError(text) {
  try {
    const data = JSON.parse(text);
    return redactSecrets(data.error?.message || data.message || text);
  } catch {
    return redactSecrets(text);
  }
}

function redactSecrets(text) {
  return cleanString(text)
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-...redacted')
    .slice(0, 500);
}

function sanitizeMemory(value) {
  const safe = {};
  if (!value || typeof value !== 'object') return safe;
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_:-]{1,64}$/.test(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof raw) || raw === null) {
      safe[key] = typeof raw === 'string' ? raw.slice(0, 500) : raw;
    }
  }
  return safe;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function sendText(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(value);
}
