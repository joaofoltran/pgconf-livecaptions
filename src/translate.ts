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

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  const onAbort = () => child.abort(parent.reason);
  if (parent.aborted) {
    onAbort();
    return () => {};
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

type Attempt = {
  promise: Promise<string>;
  firstToken: Promise<void>;
  hasToken: () => boolean;
  abort: () => void;
};

function startAttempt(
  config: AppConfig,
  text: string,
  direction: Direction,
  options: TranslateOptions,
  provider: Provider,
  timeoutMs: number,
  onPartial: (partial: string) => void
): Attempt {
  const abort = new AbortController();
  const unlink = linkAbort(options.signal, abort);
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let gotToken = false;
  let markToken!: () => void;
  const firstToken = new Promise<void>((resolve) => (markToken = resolve));

  const promise = translateCaption(config, text, direction, {
    ...options,
    provider,
    signal: abort.signal,
    onPartial: (partial) => {
      if (!gotToken) {
        gotToken = true;
        markToken();
      }
      onPartial(partial);
    },
  }).finally(() => {
    clearTimeout(timer);
    unlink();
  });
  promise.catch(() => {});
  return { promise, firstToken, hasToken: () => gotToken, abort: () => abort.abort() };
}

export type HedgeOptions = TranslateOptions & {
  fallback?: Provider | null;
  // With a fallback: start it if the preferred provider has streamed nothing by
  // fallbackAfterMs, and abort the preferred provider if it has streamed nothing
  // by cutoffMs. Without a fallback, only timeoutMs applies.
  fallbackAfterMs: number;
  cutoffMs: number;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  skipPreferred?: boolean;
  // Called at most once per call: when the preferred provider rejects or is cut
  // off. Caller aborts are not failures.
  onPreferredFailure?: (why: string, err?: unknown) => void;
  onPreferredSuccess?: () => void;
  // Milliseconds to the preferred provider's first token, or null when it was cut off.
  onPreferredFirstToken?: (ms: number | null) => void;
};

// Send to the preferred provider only. If it streams nothing by fallbackAfterMs,
// start the fallback; its text shows until the preferred provider streams. The
// preferred provider wins whenever it streams before cutoffMs: the fallback is
// aborted and its text replaced. Past the cutoff, the preferred provider is
// aborted and the fallback stays. A preferred stream that fails after its first
// token continues on the fallback from the text already emitted.
export async function translateWithHedge(
  config: AppConfig,
  text: string,
  direction: Direction,
  options: HedgeOptions
): Promise<string> {
  const fallback = options.fallback ?? null;
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? options.timeoutMs;
  const callerAborted = () => options.signal?.aborted === true;
  const state = { emitted: "", reported: false };
  const reportFailure = (why: string, err?: unknown) => {
    if (state.reported || callerAborted()) return;
    state.reported = true;
    options.onPreferredFailure?.(why, err);
  };
  const emit = (partial: string) => {
    state.emitted = partial;
    options.onPartial?.(partial);
  };
  // A hedged fallback's text shows only until the attempt it yields to streams.
  const startFallback = (opts: TranslateOptions = options, yieldTo?: Attempt) =>
    startAttempt(config, text, direction, opts, fallback!, fallbackTimeoutMs, (partial) => {
      if (!yieldTo?.hasToken()) emit(partial);
    });

  if (options.skipPreferred) {
    if (!fallback) throw new Error("Preferred provider skipped and no fallback is configured");
    return startFallback().promise;
  }

  const startedAt = Date.now();
  let backup: Attempt | null = null;
  let cutOff = false;
  const timers: NodeJS.Timeout[] = [];
  const preferred = startAttempt(
    config,
    text,
    direction,
    options,
    options.provider ?? primaryProvider(config),
    options.timeoutMs,
    emit
  );
  const settled = preferred.promise.then(
    () => {},
    (err) => {
      if (!cutOff) reportFailure(preferred.hasToken() ? "error after first token" : "error", err);
    }
  );
  void preferred.firstToken.then(() => {
    timers.forEach(clearTimeout);
    backup?.abort();
    options.onPreferredFirstToken?.(Date.now() - startedAt);
  });

  if (fallback) {
    timers.push(
      setTimeout(() => {
        if (!preferred.hasToken()) backup ??= startFallback(options, preferred);
      }, options.fallbackAfterMs),
      setTimeout(() => {
        if (preferred.hasToken()) return;
        cutOff = true;
        options.onPreferredFirstToken?.(null);
        reportFailure("no first token");
        preferred.abort();
      }, options.cutoffMs)
    );
  }

  // Decide only once the preferred provider has streamed or failed, so the
  // fallback cannot win before the cutoff.
  await Promise.race([preferred.firstToken, settled]);
  timers.forEach(clearTimeout);

  if (!preferred.hasToken()) {
    if (callerAborted() || !fallback) return preferred.promise;
    backup ??= startFallback(options, preferred);
    return backup.promise;
  }
  try {
    const out = await preferred.promise;
    options.onPreferredSuccess?.();
    return out;
  } catch (err) {
    if (callerAborted() || !fallback) throw err;
    return startFallback({ ...options, prefix: state.emitted.trim() || options.prefix }).promise;
  }
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
      // Extra fields come first: they must not override the request's own fields.
      ...provider.extraBody,
      model: provider.model,
      temperature: 0,
      max_tokens: 400,
      stream: true,
      ...(provider.serviceTier ? { service_tier: provider.serviceTier } : {}),
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
