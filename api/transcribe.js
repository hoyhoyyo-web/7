/**
 * Vercel Serverless Function
 * POST /api/transcribe
 * 음성 파일 → 텍스트 (gpt-4o-mini-transcribe)
 *
 * 환경변수: OPENAI_API_KEY
 */

export const config = { api: { bodyParser: false } };

const STT_MODEL = 'whisper-1';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' });

  try {
    // multipart/form-data 파싱
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Content-Type에서 boundary 추출
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'multipart/form-data 형식이 필요합니다.' });
    }

    // OpenAI로 그대로 전달
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': contentType, // boundary 포함 그대로 전달
      },
      body: buffer,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI STT 오류:', response.status, errText);
      return res.status(response.status).json({
        error: 'STT 오류 (' + response.status + ')',
        detail: errText,
      });
    }

    const data = await response.json();
    const text = (data.text || '').trim();

    if (!text) {
      return res.status(200).json({ text: '', empty: true });
    }

    return res.status(200).json({ text });

  } catch (e) {
    console.error('transcribe 오류:', e);
    if (e.name === 'TimeoutError') {
      return res.status(504).json({ error: 'STT 요청 타임아웃 (30초)' });
    }
    return res.status(500).json({ error: 'STT 처리 오류: ' + e.message });
  }
}
