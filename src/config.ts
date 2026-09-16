import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Direction = "en-pt" | "pt-en";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function parseRooms(): string[] {
  const raw = env("ROOMS", "room-1,room-2,room-3,room-4");
  const rooms = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rooms.length) {
    throw new Error("ROOMS must contain at least one room slug");
  }
  const seen = new Set<string>();
  for (const room of rooms) {
    if (
      room.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room)
    ) {
      throw new Error(
        `Invalid room slug "${room}": use lowercase letters and numbers separated by single hyphens`
      );
    }
    if (seen.has(room)) {
      throw new Error(`Duplicate room slug "${room}" in ROOMS`);
    }
    seen.add(room);
  }
  return rooms;
}

export function tokenEnvName(room: string): string {
  return `TOKEN_${room.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function requiredEnv(name: string, minLength = 1): string {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name} in environment`);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

function integerEnv(name: string, fallback: string, min: number, max: number): number {
  const raw = env(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanEnv(name: string, fallback: "true" | "false"): boolean {
  const value = env(name, fallback);
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

function baseUrlEnv(name: string, fallback: string): string {
  const value = (env(name) || fallback).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function optionalDomain(): string {
  const domain = env("DOMAIN");
  const hostname =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
  if (domain && (domain.length > 253 || !hostname.test(domain))) {
    throw new Error("DOMAIN must be a bare hostname such as captions.example.com");
  }
  return domain;
}

function dgPtLanguageEnv(): "multi" | "pt-BR" {
  const value = env("DG_PT_LANGUAGE") || "multi";
  if (value !== "multi" && value !== "pt-BR") {
    throw new Error("DG_PT_LANGUAGE must be multi or pt-BR");
  }
  return value;
}

export function loadKeyterms(): string[] {
  const file = path.resolve(process.cwd(), "config/keyterms.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readLines(name: string): string[] {
  const file = path.resolve(process.cwd(), `config/${name}`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export type Alias = { canonical: string; pattern: RegExp };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Patroni = patrone, patrono": o STT ouve a pronúncia brasileira de nomes em inglês
// e escreve outra coisa; corrigimos antes de traduzir. Casamento por palavra inteira,
// sem diferenciar caixa; espaços no apelido aceitam qualquer espaçamento ("t c d").
export function loadAliases(): Alias[] {
  const out: Alias[] = [];
  for (const line of readLines("aliases.txt")) {
    const [canonical, rest] = line.split("=").map((s) => s.trim());
    if (!canonical || !rest) continue;
    const alts = rest
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => escapeRegex(s).replace(/\s+/g, "\\s+"));
    if (!alts.length) continue;
    out.push({
      canonical,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, "giu"),
    });
  }
  return out;
}

export type GlossaryHint = { term: string; hint: string };

// "banco: ..." — dica de domínio para o tradutor, incluída só quando a palavra aparece.
export function loadGlossary(): GlossaryHint[] {
  const out: GlossaryHint[] = [];
  for (const line of readLines("glossary.txt")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out.push({ term: line.slice(0, i).trim(), hint: line.slice(i + 1).trim() });
  }
  return out;
}

function parseJsonObject(name: string, raw: string): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function loadConfig() {
  const rooms = parseRooms();
  const tokens: Record<string, string> = {};
  for (const room of rooms) {
    const token = requiredEnv(tokenEnvName(room), 16);
    tokens[room] = token;
  }

  const port = integerEnv("PORT", "3000", 1, 65535);
  const adminPassword = requiredEnv("ADMIN_PASSWORD", 16);
  const sessionSecret = requiredEnv("SESSION_SECRET", 32);
  const deepgramApiKey = requiredEnv("DEEPGRAM_API_KEY");
  const openaiApiKey = requiredEnv("OPENAI_API_KEY");

  return {
    port,
    domain: optionalDomain(),
    adminPassword,
    sessionSecret,
    deepgramApiKey,
    openaiApiKey,
    openaiModel: env("OPENAI_MODEL") || "gpt-4.1-mini",
    // Qualquer API compatível (Groq, Cerebras, ...): troque a base e o modelo.
    openaiBaseUrl: baseUrlEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    // JSON mesclado no corpo de cada chamada, para parâmetros específicos do provedor
    // (ex.: {"reasoning_effort":"low"} nos modelos gpt-oss da Groq).
    openaiExtraBody: parseJsonObject("OPENAI_EXTRA_BODY", env("OPENAI_EXTRA_BODY")),
    // Híbrido: drafts no provedor principal (rápido), final da frase neste outro
    // (mais caprichado). Ativo só se FINAL_API_KEY estiver definida.
    finalProvider: env("FINAL_API_KEY")
      ? {
          baseUrl: baseUrlEnv("FINAL_BASE_URL", "https://api.openai.com/v1"),
          apiKey: env("FINAL_API_KEY"),
          model: env("FINAL_MODEL") || "gpt-4.1-mini",
          extraBody: parseJsonObject("FINAL_EXTRA_BODY", env("FINAL_EXTRA_BODY")),
          serviceTier: env("FINAL_SERVICE_TIER") || undefined,
        }
      : null,
    // Segundo provedor para o final da frase quando o principal trava ou falha.
    // Ativo só se FALLBACK_API_KEY estiver definida.
    fallback: env("FALLBACK_API_KEY")
      ? {
          baseUrl: baseUrlEnv("FALLBACK_BASE_URL", "https://api.openai.com/v1"),
          apiKey: env("FALLBACK_API_KEY"),
          model: env("FALLBACK_MODEL") || "gpt-4.1-mini",
          extraBody: parseJsonObject("FALLBACK_EXTRA_BODY", env("FALLBACK_EXTRA_BODY")),
        }
      : null,
    openaiServiceTier: env("OPENAI_SERVICE_TIER"),
    dgEndpointing: String(integerEnv("DG_ENDPOINTING", "300", 50, 5000)),
    // "multi" = Nova-3 multilíngue: aceita keyterms em PT e lida com fala em
    // português misturada com jargão em inglês. Use "pt-BR" para voltar ao antigo.
    dgPtLanguage: dgPtLanguageEnv(),
    // true = o áudio vai para o servidor, que fala com o Deepgram (menos saltos
    // quando o VPS está perto do Deepgram/OpenAI). false = navegador fala direto.
    sttProxy: booleanEnv("STT_PROXY", "true"),
    liveDrafts: booleanEnv("LIVE_DRAFTS", "true"),
    draftIntervalMs: integerEnv("DRAFT_INTERVAL_MS", "350", 100, 60_000),
    // Teto somado das 4 salas. Default assume Tier 2 (5.000 req/min); no Tier 1 use 6.
    draftsPerSecond: integerEnv("DRAFTS_PER_SECOND", "15", 1, 1000),
    rooms,
    tokens,
    keyterms: loadKeyterms(),
    aliases: loadAliases(),
    glossary: loadGlossary(),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return cryptoTimingSafeEqual(aa, bb);
}
