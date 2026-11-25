import type { AppConfig, Direction } from "./config.js";

// Compares while ignoring case, hyphens, and underscores: STT transcribes
// "write ahead log" while the registered term is "write-ahead log".
// Padding with spaces ensures whole-word matching
// ("WAL" does not match "wall").
function normalizeForMatch(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

// Include only terms found in this sentence. Sending the full list with every
// request would waste tokens (and latency).
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
  // The sentence is still being spoken: do not invent an ending.
  unfinished?: boolean;
  onPartial?: (partial: string) => void;
  signal?: AbortSignal;
  provider?: Provider;
  // Text already shown on screen: output must begin with it exactly.
  prefix?: string;
};

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): void {
  if (!parent) return;
  if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  parent.addEventListener("abort", () => child.abort(parent.reason), { once: true });
}

type AttemptLabel = "preferred" | "fallback";

type TranslateAttempt = {
  promise: Promise<string>;
  firstToken: Promise<void>;
  abort: AbortController;
};

function startAttempt(
  config: AppConfig,
  text: string,
  direction: Direction,
  options: TranslateOptions,
  provider: Provider,
  timeoutMs: number,
  label: AttemptLabel,
  state: { winner: AttemptLabel | null },
  onFirstToken: () => void
): TranslateAttempt {
  const abort = new AbortController();
  linkAbort(options.signal, abort);
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  let sawToken = false;
  let resolveFirstToken: () => void = () => {};
  const firstToken = new Promise<void>((resolve) => {
    resolveFirstToken = resolve;
  });

  const promise = translateCaption(config, text, direction, {
    ...options,
    provider,
    signal: abort.signal,
    onPartial: (partial) => {
      if (!sawToken) {
        sawToken = true;
        if (!state.winner) state.winner = label;
        resolveFirstToken();
        onFirstToken();
      }
      if (state.winner === label) options.onPartial?.(partial);
    },
  }).finally(() => clearTimeout(timer));

  void promise.catch(() => {});
  return { promise, firstToken, abort };
}

export type HedgeOptions = TranslateOptions & {
  fallback?: Provider | null;
  firstTokenMs: number;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  skipPreferred?: boolean;
  onPreferredStall?: (why: string) => void;
};

// Start the preferred provider immediately. If it produces no token within
// firstTokenMs, start fallback in parallel and keep whichever streams first.
export async function translateWithHedge(
  config: AppConfig,
  text: string,
  direction: Direction,
  options: HedgeOptions
): Promise<string> {
  const fallback = options.fallback ?? null;
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? options.timeoutMs;
  const preferred = options.provider ?? primaryProvider(config);
  const state: { winner: AttemptLabel | null } = { winner: null };

  if (options.skipPreferred) {
    if (!fallback) {
      throw new Error("Preferred provider skipped and no fallback is configured");
    }
    const attempt = startAttempt(
      config,
      text,
      direction,
      options,
      fallback,
      fallbackTimeoutMs,
      "fallback",
      state,
      () => {}
    );
    return attempt.promise;
  }

  const preferredAttempt = startAttempt(
    config,
    text,
    direction,
    options,
    preferred,
    options.timeoutMs,
    "preferred",
    state,
    () => {}
  );

  if (!fallback) {
    const outcome = await Promise.race([
      preferredAttempt.firstToken.then(() => "token" as const),
      preferredAttempt.promise.then(
        () => "done" as const,
        () => "fail" as const
      ),
      abortableDelay(options.firstTokenMs, options.signal).then(() => "stall" as const),
    ]);
    if (outcome === "stall") {
      preferredAttempt.abort.abort();
      options.onPreferredStall?.("no first token");
      throw new Error(`No first translation token in ${options.firstTokenMs} ms`);
    }
    if (outcome === "fail") options.onPreferredStall?.("error");
    return preferredAttempt.promise;
  }

  let outcome: "token" | "done" | "fail" | "stall";
  try {
    outcome = await Promise.race([
      preferredAttempt.firstToken.then(() => "token" as const),
      preferredAttempt.promise.then(
        () => "done" as const,
        () => "fail" as const
      ),
      abortableDelay(options.firstTokenMs, options.signal).then(() => "stall" as const),
    ]);
  } catch (err) {
    preferredAttempt.abort.abort();
    throw err;
  }

  if (outcome === "token" || outcome === "done") {
    return preferredAttempt.promise;
  }

  const why = outcome === "fail" ? "error" : "no first token";
  options.onPreferredStall?.(why);

  const fallbackAttempt = startAttempt(
    config,
    text,
    direction,
    options,
    fallback,
    fallbackTimeoutMs,
    "fallback",
    state,
    () => {
      if (state.winner === "fallback") preferredAttempt.abort.abort();
    }
  );

  const race = await Promise.race([
    preferredAttempt.firstToken.then(() => "preferred" as const),
    fallbackAttempt.firstToken.then(() => "fallback" as const),
    preferredAttempt.promise.then(
      () => "preferred" as const,
      () => "preferred-fail" as const
    ),
    fallbackAttempt.promise.then(
      () => "fallback" as const,
      () => "fallback-fail" as const
    ),
  ]);

  if (race === "preferred") {
    fallbackAttempt.abort.abort();
    return preferredAttempt.promise;
  }
  if (race === "fallback") {
    preferredAttempt.abort.abort();
    return fallbackAttempt.promise;
  }
  if (race === "preferred-fail") {
    preferredAttempt.abort.abort();
    return fallbackAttempt.promise;
  }
  fallbackAttempt.abort.abort();
  return preferredAttempt.promise;
}

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
