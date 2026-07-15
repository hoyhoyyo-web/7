/**
 * Vercel Serverless Function
 * POST /api/generate
 * 텍스트 → AI 피드백/질문 (gpt-4o-mini)
 *
 * 환경변수: OPENAI_API_KEY
 */

const LLM_MODEL = 'gpt-4o-mini';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: '요청 본문 파싱 실패' });
  }

  const { system, user, max_tokens = 1000 } = body || {};

  if (!user) return res.status(400).json({ error: 'user 메시지가 필요합니다.' });

  try {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: Math.min(Number(max_tokens) || 1000, 2000),
        messages,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI GPT 오류:', response.status, errText);
      return res.status(response.status).json({
        error: 'GPT 오류 (' + response.status + ')',
        detail: errText,
      });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text });

  } catch (e) {
    console.error('generate 오류:', e);
    if (e.name === 'TimeoutError') {
      return res.status(504).json({ error: 'AI 응답 타임아웃 (30초)' });
    }
    return res.status(500).json({ error: 'GPT 처리 오류: ' + e.message });
  }
}
