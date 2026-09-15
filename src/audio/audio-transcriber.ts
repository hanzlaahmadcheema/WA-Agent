import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TranscriptionResult {
  success: boolean;
  text?: string;
  provider?: string;
  error?: string;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimetype: string = 'audio/ogg'
): Promise<TranscriptionResult> {
  const tmpDir = '/tmp/wa-agent-media';
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const ext = mimetype.includes('mp4') ? '.m4a' : mimetype.includes('mpeg') ? '.mp3' : '.ogg';
  const filePath = path.join(tmpDir, `voice_${Date.now()}${ext}`);
  fs.writeFileSync(filePath, audioBuffer);

  try {
    let lastProviderError: string | undefined;

    // 1. Try Groq Whisper API (Fastest and free/low-cost)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const text = await transcribeViaOpenAiCompatibleApi(
          filePath,
          'https://api.groq.com/openai/v1/audio/transcriptions',
          groqKey,
          'whisper-large-v3'
        );
        if (text) {
          return { success: true, text, provider: 'Groq Whisper' };
        }
      } catch (e: any) {
        lastProviderError = `Groq Whisper: ${e.message}`;
        console.warn('[AudioTranscriber] Groq API transcription error:', e.message);
      }
    }

    // 2. Try OpenAI Whisper API
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const text = await transcribeViaOpenAiCompatibleApi(
          filePath,
          'https://api.openai.com/v1/audio/transcriptions',
          openaiKey,
          'whisper-1'
        );
        if (text) {
          return { success: true, text, provider: 'OpenAI Whisper' };
        }
      } catch (e: any) {
        lastProviderError = `OpenAI Whisper: ${e.message}`;
        console.warn('[AudioTranscriber] OpenAI API transcription error:', e.message);
      }
    }

    // 3. Try Local Whisper CLI binary
    try {
      const { stdout } = await execFileAsync('whisper', [filePath, '--output_format', 'txt', '--output_dir', tmpDir], {
        timeout: 30000,
      });
      const txtPath = filePath.replace(/\.[^.]+$/, '.txt');
      if (fs.existsSync(txtPath)) {
        const txt = fs.readFileSync(txtPath, 'utf8').trim();
        fs.unlinkSync(txtPath);
        if (txt) {
          return { success: true, text: txt, provider: 'Local Whisper CLI' };
        }
      }
    } catch {
      // Local whisper not available
    }

    return {
      success: false,
      error:
        lastProviderError ||
        'No audio transcription engine configured.\nSet `GROQ_API_KEY`, `OPENAI_API_KEY`, or install `whisper` CLI in `/etc/wa-agent/environment`.',
    };
  } finally {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

async function transcribeViaOpenAiCompatibleApi(
  filePath: string,
  endpoint: string,
  apiKey: string,
  model: string
): Promise<string | null> {
  const cleanKey = apiKey.replace(/^["']|["']$/g, '').trim();

  // 1. Primary: curl -4 (forces IPv4, handles multipart streaming natively, avoids Node IPv6 dual-stack resets)
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-4',
        '-s',
        '--max-time',
        '30',
        '-H',
        `Authorization: Bearer ${cleanKey}`,
        '-F',
        `file=@${filePath}`,
        '-F',
        `model=${model}`,
        endpoint,
      ],
      { timeout: 35000 }
    );
    if (stdout) {
      const json = JSON.parse(stdout);
      if (json.text) {
        return json.text.trim();
      }
      if (json.error) {
        throw new Error(json.error.message || JSON.stringify(json.error));
      }
    }
  } catch (curlErr: any) {
    console.warn('[AudioTranscriber] curl transport error, attempting fetch fallback:', curlErr.message);
  }

  // 2. Fallback: native fetch
  const fileData = fs.readFileSync(filePath);
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);
  const filename = path.basename(filePath);
  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  const body = Buffer.concat(parts);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API HTTP ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}
