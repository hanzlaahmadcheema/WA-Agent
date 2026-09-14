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
  const fileData = fs.readFileSync(filePath);
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2);

  const filename = path.basename(filePath);
  const parts: Buffer[] = [];

  // Model part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
    )
  );

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`
    )
  );
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
