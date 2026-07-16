/**
 * Vercel Serverless Function
 * POST /api/transcribe
 * GROQ 우선 STT → 실패 시 OpenAI 자동 전환
 */

export const config = { api: { bodyParser: false } };

// ── MIME → 확장자 매핑 ──
const MIME_TO_EXT = {
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};

function getFilename(mimeType, original) {
  if (original && original !== 'blob') return original;
  const ext = MIME_TO_EXT[mimeType?.split(';')[0]] || 'audio';
  const nameMap = {
    'audio/mp4': 'recording.mp4',
    'audio/m4a': 'recording.m4a',
    'audio/x-m4a': 'recording.m4a',
    'audio/webm': 'recording.webm',
  };
  return nameMap[mimeType?.split(';')[0]] || 'recording.' + ext;
}

// ── JSON 응답 헬퍼 ──
function createJsonResponse(res, data, status = 200) {
  return res.status(status).json(data);
}

// ── multipart에서 오디오 추출 ──
async function getAudioFile(req, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1];

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const bodyStr = buffer.toString('binary');
  const parts = bodyStr.split('--' + boundary);

  for (const part of parts) {
    if (!part.includes('name="audio"') && !part.includes('filename=')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.substring(0, headerEnd);
    const mimeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const fnMatch = headers.match(/filename="([^"]+)"/i);

    const mimeType = mimeMatch ? mimeMatch[1].trim() : 'audio/webm';
    const originalFilename = fnMatch ? fnMatch[1] : null;

    const dataStart = headerEnd + 4;
    const dataEnd = part.lastIndexOf('\r\n');
    if (dataEnd <= dataStart) continue;

    const audioBuffer = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
    return { audioBuffer, mimeType, originalFilename };
  }
  return null;
}

// ── 공급자별 FormData 생성 ──
function createAudioFormData(audioBuffer, mimeType, filename, provider, boundary) {
  const CRLF = '\r\n';
  const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

  const modelPart = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}${model}${CRLF}`,
    'utf8'
  );
  const langPart = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}en${CRLF}`,
    'utf8'
  );
  const fileHeader = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`,
    'utf8'
  );
  const fileFooter = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');

  return Buffer.concat([modelPart, langPart, fileHeader, audioBuffer, fileFooter]);
}

// ── 자동 전환 기준 ──
function shouldFallbackToOpenAI(status, errorType) {
  if (errorType === 'network' || errorType === 'timeout') return true;
  return [429, 500, 502, 503, 504].includes(status);
}

// ── GROQ STT ──
async function transcribeWithGroq(audioBuffer, mimeType, filename, groqKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const boundary = '----GroqBoundary' + Math.random().toString(36).substr(2);
    const body = createAudioFormData(audioBuffer, mimeType, filename, 'groq', boundary);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + groqKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.log(`[STT] Groq 실패: HTTP ${response.status}`);
      return { success: false, status: response.status };
    }

    const data = await response.json();
    const text = data?.text;

    if (typeof text !== 'string' || text.trim() === '') {
      console.log('[STT] Groq 빈 텍스트 → OpenAI로 전환');
      return { success: false, status: 200, emptyText: true };
    }

    console.log(`[STT] Groq 성공 (${audioBuffer.byteLength}bytes, ${mimeType})`);
    return { success: true, text: text.trim() };

  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e.name === 'AbortError';
    console.log(`[STT] Groq ${isTimeout ? '타임아웃' : '네트워크 오류'} → OpenAI로 전환`);
    return { success: false, errorType: isTimeout ? 'timeout' : 'network' };
  }
}

// ── OpenAI STT ──
async function transcribeWithOpenAI(audioBuffer, mimeType, filename, openaiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const boundary = '----OpenAIBoundary' + Math.random().toString(36).substr(2);
    const body = createAudioFormData(audioBuffer, mimeType, filename, 'openai', boundary);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + openaiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.log(`[STT] OpenAI 실패: HTTP ${response.status}`);
      return { success: false, status: response.status, detail: errText };
    }

    const data = await response.json();
    const text = data?.text;

    if (typeof text !== 'string' || text.trim() === '') {
      return { success: false, emptyText: true };
    }

    console.log(`[STT] OpenAI 성공 (자동 전환)`);
    return { success: true, text: text.trim() };

  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e.name === 'AbortError';
    console.log(`[STT] OpenAI ${isTimeout ? '타임아웃' : '오류'}`);
    return { success: false, errorType: isTimeout ? 'timeout' : 'network' };
  }
}

// ── 메인 핸들러 ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });

  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!openaiKey && !groqKey) {
    return createJsonResponse(res, { error: 'API 키가 설정되지 않았습니다.', code: 'NO_API_KEY' }, 500);
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return createJsonResponse(res, { error: 'multipart/form-data 형식이 필요합니다.' }, 400);
  }

  // 오디오 추출
  const audioFile = await getAudioFile(req, contentType);
  if (!audioFile) {
    return createJsonResponse(res, { error: '음성 파일이 없습니다.', code: 'NO_AUDIO_FILE' }, 400);
  }

  const { audioBuffer, mimeType, originalFilename } = audioFile;
  const filename = getFilename(mimeType, originalFilename);

  console.log(`[STT] 요청: ${audioBuffer.byteLength}bytes, ${mimeType}`);

  // 너무 작은 파일 체크
  if (audioBuffer.byteLength < 1000) {
    return createJsonResponse(res, { error: '음성이 너무 짧아요. 다시 말해봐요!', code: 'EMPTY_AUDIO' }, 400);
  }

  // ── Groq 우선 STT 시작 ──
  if (groqKey) {
    const groqResult = await transcribeWithGroq(audioBuffer, mimeType, filename, groqKey);

    if (groqResult.success) {
      return createJsonResponse(res, { text: groqResult.text, provider: 'groq' });
    }

    // Groq 400/413: 파일 문제 → 전환 안 함
    if (groqResult.status === 400 || groqResult.status === 413) {
      return createJsonResponse(res, { error: '음성 파일 형식이 올바르지 않아요.', code: 'INVALID_AUDIO' }, 400);
    }

    // Groq 401/403: 인증 문제 → 전환 안 함
    if (groqResult.status === 401 || groqResult.status === 403) {
      return createJsonResponse(res, { error: 'STT 서버 인증 오류입니다. 선생님께 알려주세요.', code: 'GROQ_AUTH_ERROR' }, 500);
    }

    // 429/5xx/네트워크/타임아웃/빈 텍스트 → OpenAI로 전환
    const shouldFallback = groqResult.emptyText ||
      shouldFallbackToOpenAI(groqResult.status, groqResult.errorType);

    if (!shouldFallback || !openaiKey) {
      return createJsonResponse(res, { error: '음성 변환에 실패했어요. 다시 시도해봐요!', code: 'STT_ALL_PROVIDERS_FAILED' }, 500);
    }
  }
  // ── Groq 우선 STT 끝 ──

  // ── OpenAI 자동 대체 시작 ──
  if (!openaiKey) {
    return createJsonResponse(res, { error: 'OpenAI API 키가 설정되지 않았습니다.', code: 'OPENAI_AUTH_ERROR' }, 500);
  }

  const openaiResult = await transcribeWithOpenAI(audioBuffer, mimeType, filename, openaiKey);

  if (openaiResult.success) {
    return createJsonResponse(res, { text: openaiResult.text, provider: 'openai' });
  }

  if (openaiResult.status === 401 || openaiResult.status === 403) {
    return createJsonResponse(res, { error: 'STT 서버 인증 오류입니다. 선생님께 알려주세요.', code: 'OPENAI_AUTH_ERROR' }, 500);
  }

  if (openaiResult.errorType === 'timeout') {
    return createJsonResponse(res, { error: '응답 시간이 초과됐어요. 다시 시도해봐요!', code: 'STT_TIMEOUT' }, 504);
  }

  return createJsonResponse(res, { error: '음성 변환에 실패했어요. 잠시 후 다시 시도해봐요!', code: 'STT_ALL_PROVIDERS_FAILED' }, 500);
  // ── STT 이중화 처리 끝 ──
}
