import type { AppConfig, Direction } from "./config.js";

export async function grantDeepgramToken(apiKey: string): Promise<string> {
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: 300 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deepgram grant failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Deepgram grant returned no access_token");
  }
  return data.access_token;
}

export function deepgramListenUrl(
  direction: Direction,
  keyterms: string[],
  endpointing = "300",
  ptLanguage = "multi"
): string {
  const language = direction === "pt-en" ? ptLanguage : "en";
  const params = new URLSearchParams({
    model: "nova-3",
    language,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    smart_format: "true",
    punctuate: "true",
    interim_results: "true",
    endpointing: endpointing,
    utterance_end_ms: "1000",
  });
  // Nova-3 aceita keyterm em inglês e no modo multilíngue ("multi").
  // Em pt-BR monolíngue o suporte é mais recente; se a conexão falhar com
  // "does not support keyterm prompting", use DG_PT_LANGUAGE=multi.
  for (const term of keyterms.slice(0, 100)) {
    params.append("keyterm", term);
  }
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

export function assertDeepgramConfigured(config: AppConfig): void {
  if (!config.deepgramApiKey) {
    throw new Error("DEEPGRAM_API_KEY is not set");
  }
}
