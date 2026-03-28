import { createLogger } from "./logger.js";

const log = createLogger("asr");

export interface AsrConfig {
  /** ASR provider: "whisper" (OpenAI) or "disabled" */
  provider?: "whisper" | "disabled";
  /** API key for Whisper (defaults to OPENAI_API_KEY env) */
  apiKey?: string;
  /** Whisper API base URL */
  baseUrl?: string;
  /** Whisper model (default: "whisper-1") */
  model?: string;
  /** Language for transcription (ISO 639-1 code, default: "zh") */
  language?: string;
}

/**
 * Transcribe audio from a URL using Whisper API.
 * Downloads the audio, then sends to Whisper for transcription.
 */
export async function transcribeFromUrl(
  audioUrl: string,
  config: AsrConfig = {},
): Promise<string | null> {
  if (config.provider === "disabled") return null;

  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("ASR: 未配置 API Key (需要 OPENAI_API_KEY 或 asr.apiKey)");
    return null;
  }

  try {
    // Download audio
    log.info("下载语音...");
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      log.error(`下载语音失败: ${audioRes.status}`);
      return null;
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const contentType = audioRes.headers.get("content-type") || "";

    // Determine file extension from content type
    let ext = "wav";
    if (contentType.includes("mp3") || contentType.includes("mpeg")) ext = "mp3";
    else if (contentType.includes("m4a") || contentType.includes("mp4")) ext = "m4a";
    else if (contentType.includes("ogg")) ext = "ogg";
    else if (contentType.includes("silk")) ext = "silk";

    // silk format needs conversion — for now, try sending as-is
    // Whisper may reject it, in which case we return null
    if (ext === "silk") {
      log.warn("语音为 silk 格式，尝试直接转录（可能失败）");
    }

    // Send to Whisper API
    const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = config.model || "whisper-1";

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: contentType || "audio/wav" });
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", model);
    if (config.language) {
      formData.append("language", config.language);
    } else {
      formData.append("language", "zh");
    }

    log.info(`调用 Whisper ASR (${audioBuffer.length} bytes, ${ext})...`);

    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const errBody = await res.text();
      log.error(`Whisper API error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as { text: string };
    const text = data.text?.trim();

    if (text) {
      log.info(`语音转文字: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
    }

    return text || null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`ASR 失败: ${errMsg}`);
    return null;
  }
}
