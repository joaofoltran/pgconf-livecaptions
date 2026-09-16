import type { AppConfig, Direction } from "./config.js";

// Compara ignorando caixa, hífens e underscores: o STT transcreve
// "write ahead log" e o termo cadastrado é "write-ahead log".
// Os espaços nas bordas garantem casamento por palavra inteira
// ("WAL" não casa com "wall").
function normalizeForMatch(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

// Só os termos que aparecem nesta frase. Mandar a lista toda em cada requisição
// gastaria tokens (e latência) sem necessidade.
function doNotTranslateList(keyterms: string[], text: string): string {
  const haystack = normalizeForMatch(text);
  return keyterms
    .filter((term) => haystack.includes(normalizeForMatch(term)))
    .slice(0, 20)
    .join(", ");
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof Error && /\b429\b/.test(err.message);
}

export type TranslationContext = {
  source: string;
  translated: string;
};

export type Provider = {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
  serviceTier?: string;
};

export function primaryProvider(config: AppConfig): Provider {
  return {
    baseUrl: config.openaiBaseUrl,
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    extraBody: config.openaiExtraBody,
    serviceTier: config.openaiServiceTier,
  };
}

export type TranslateOptions = {
  context?: TranslationContext;
  // A frase ainda está sendo falada: não inventar um fim para ela.
  unfinished?: boolean;
  onPartial?: (partial: string) => void;
  signal?: AbortSignal;
  provider?: Provider;
  // Texto já exibido no telão: a saída deve começar exatamente por ele.
  prefix?: string;
};

export async function translateCaption(
  config: AppConfig,
  text: string,
  direction: Direction,
  options: TranslateOptions = {}
): Promise<string> {
  const { context, unfinished, onPartial, signal, prefix } = options;
  const provider = options.provider ?? primaryProvider(config);
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!provider.apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const source = direction === "en-pt" ? "English" : "Brazilian Portuguese";
  const target = direction === "en-pt" ? "Brazilian Portuguese" : "English";
  const names = doNotTranslateList(config.keyterms, trimmed);
  const haystack = normalizeForMatch(trimmed);
  const hints = config.glossary
    .filter((g) => haystack.includes(normalizeForMatch(g.term)))
    .slice(0, 6)
    .map((g) => `"${g.term}": ${g.hint}`)
    .join(" ");

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0,
      max_tokens: 400,
      stream: true,
      ...(provider.serviceTier ? { service_tier: provider.serviceTier } : {}),
      ...provider.extraBody,
      messages: [
        {
          role: "system",
          content: [
            `You translate live conference captions from ${source} to ${target}.`,
            "The event is a PostgreSQL and database conference: resolve ambiguous words",
            "in that domain (tools, infrastructure, SQL), not in everyday senses.",
            `Write natural, fluent ${target} as a native speaker would say it out loud.`,
            "Reorder words and restructure the sentence when that reads better;",
            "never translate word by word.",
            "The input comes from speech recognition, so it may lack punctuation or",
            "contain small errors: infer the intended meaning and add clean punctuation.",
            "Do not add, omit, or explain anything. Output one line only,",
            "with no quotes and no notes.",
            ...(unfinished
              ? [
                  "This caption is mid-sentence: the speaker is still talking.",
                  "Translate only what is there, keep it open, and do not add a final",
                  "period or invent an ending. If the input stops mid-clause, your output",
                  "stops mid-clause too; never add an idea that is not in the input.",
                ]
              : []),
            ...(prefix
              ? [
                  `The translation shown on screen so far is: "${prefix}". Output the`,
                  `complete translation, beginning verbatim with "${prefix}" (copy it`,
                  "character for character) and continuing naturally so the whole line",
                  "is grammatical.",
                ]
              : []),
            ...(hints ? [`Domain notes for words in this caption: ${hints}`] : []),
            ...(names
              ? [
                  "Never translate or respell these technical names and acronyms;",
                  `copy them exactly (fixing hyphens/casing to this form): ${names}.`,
                  "If the input is only such a term, output it as-is.",
                ]
              : []),
          ].join(" "),
        },
        ...(context
          ? [
              { role: "user", content: context.source },
              { role: "assistant", content: context.translated },
            ]
          : []),
        { role: "user", content: trimmed },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text();
    throw new Error(`OpenAI failed ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) continue;
      const payload = trimmedLine.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: { choices?: Array<{ delta?: { content?: string } }> };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      out += delta;
      onPartial?.(out);
    }
  }

  const final = out.trim();
  if (!final) throw new Error("OpenAI returned empty translation");
  return final;
}
