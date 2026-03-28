import { createLogger } from "./logger.js";

const log = createLogger("tts");

export interface TtsConfig {
  /** TTS provider: "openai" | "gemini" | "disabled" */
  provider?: "openai" | "gemini" | "disabled";
  /** API key */
  apiKey?: string;
  /** API base URL (for openai provider) */
  baseUrl?: string;
  /** TTS model */
  model?: string;
  /** Voice name */
  voice?: string;
  /** Max characters for voice reply (longer text falls back to text) */
  maxChars?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

const DEFAULT_MAX_CHARS = 300;

/**
 * Convert text to speech. Returns audio buffer, or null on failure.
 */
export async function textToSpeech(
  text: string,
  config: TtsConfig = {},
): Promise<Buffer | null> {
  if (config.provider === "disabled") return null;

  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("TTS: 未配置 API Key");
    return null;
  }

  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  if (text.length > maxChars) {
    log.info(`文本过长 (${text.length} > ${maxChars})，跳过语音合成`);
    return null;
  }

  if (config.provider === "gemini") {
    return geminiTts(text, apiKey, config);
  }
  return openaiTts(text, apiKey, config);
}

/** OpenAI-compatible /audio/speech */
async function openaiTts(text: string, apiKey: string, config: TtsConfig): Promise<Buffer | null> {
  try {
    const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = config.model || "tts-1";
    const voice = config.voice || "alloy";
    const timeout = config.timeout || 30_000;

    log.info(`调用 TTS (${text.length} 字, model: ${model}, voice: ${voice})...`);

    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const errBody = await res.text();
      log.error(`TTS API error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    log.info(`TTS 完成: ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`TTS 失败: ${errMsg}`);
    return null;
  }
}

/** Gemini TTS via generateContent with audio modality */
async function geminiTts(text: string, apiKey: string, config: TtsConfig): Promise<Buffer | null> {
  try {
    const model = config.model || "gemini-2.5-flash-preview-tts";
    const voice = config.voice || "Kore";
    const timeout = config.timeout || 30_000;

    log.info(`调用 Gemini TTS (${text.length} 字, model: ${model}, voice: ${voice})...`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        }),
        signal: AbortSignal.timeout(timeout),
      },
    );

    if (!res.ok) {
      const errBody = await res.text();
      log.error(`Gemini TTS error ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;

    if (data.error) {
      log.error(`Gemini TTS error: ${data.error.message}`);
      return null;
    }

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) {
      log.warn("Gemini TTS: 无返回内容");
      return null;
    }

    for (const part of parts) {
      if (part.inlineData?.data) {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        log.info(`TTS 完成: ${buffer.length} bytes (${part.inlineData.mimeType})`);
        return buffer;
      }
    }

    log.warn("Gemini TTS: 返回中无音频数据");
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`Gemini TTS 失败: ${errMsg}`);
    return null;
  }
}
