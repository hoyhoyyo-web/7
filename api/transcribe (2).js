/**
 * Vercel Serverless Function
 * POST /api/transcribe
 * 음성 파일 → 텍스트 (OpenAI Whisper)
 */

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다.' });

  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'multipart/form-data 형식이 필요합니다.' });
    }

    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'boundary를 찾을 수 없습니다.' });
    const boundary = boundaryMatch[1];

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const bodyStr = buffer.toString('binary');
    const parts = bodyStr.split('--' + boundary);

    let audioData = null;
    let audioMime = 'audio/webm';
    let audioFilename = 'audio.webm';

    for (const part of parts) {
      if (part.includes('name="audio"') || part.includes('filename=')) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        const mimeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        if (mimeMatch) audioMime = mimeMatch[1].trim();
        const fnMatch = headers.match(/filename="([^"]+)"/i);
        if (fnMatch) audioFilename = fnMatch[1];
        const dataStart = headerEnd + 4;
        const dataEnd = part.lastIndexOf('\r\n');
        if (dataEnd > dataStart) {
          audioData = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
        }
        break;
      }
    }

    if (!audioData || audioData.length === 0) {
      return res.status(400).json({ error: '음성 데이터를 찾을 수 없습니다.' });
    }

    // OpenAI Whisper FormData 구성
    const newBoundary = '----FormBoundary' + Math.random().toString(36).substr(2);
    const CRLF = '\r\n';

    const modelPart = Buffer.from(
      `--${newBoundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-1${CRLF}`,
      'utf8'
    );
    const langPart = Buffer.from(
      `--${newBoundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}en${CRLF}`,
      'utf8'
    );
    const fileHeader = Buffer.from(
      `--${newBoundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${audioFilename}"${CRLF}Content-Type: ${audioMime}${CRLF}${CRLF}`,
      'utf8'
    );
    const fileFooter = Buffer.from(`${CRLF}--${newBoundary}--${CRLF}`, 'utf8');
    const newBody = Buffer.concat([modelPart, langPart, fileHeader, audioData, fileFooter]);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': `multipart/form-data; boundary=${newBoundary}`,
      },
      body: newBody,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI STT 오류:', response.status, errText);
      return res.status(response.status).json({ error: 'STT 오류 (' + response.status + ')', detail: errText });
    }

    const data = await response.json();
    return res.status(200).json({ text: (data.text || '').trim() });

  } catch (e) {
    console.error('transcribe 오류:', e);
    return res.status(500).json({ error: 'STT 처리 오류: ' + e.message });
  }
}
