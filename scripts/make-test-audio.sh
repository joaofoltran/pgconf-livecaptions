#!/usr/bin/env bash
# Gera áudio de teste (16 kHz, mono, PCM 16-bit) com a voz do macOS, em EN e PT,
# com frases do tipo que aparecem numa palestra de Postgres. Saída: test-audio/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/test-audio"
mkdir -p "$OUT"

gen() {
  local name="$1" voice="$2" text="$3"
  local aiff="$OUT/$name.aiff"
  say -v "$voice" -r 175 -o "$aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$aiff" "$OUT/$name.wav"
  rm -f "$aiff"
  echo "$OUT/$name.wav"
}

gen en Samantha "Good morning everyone. Today I want to talk about how Postgres handles the write-ahead log. When autovacuum falls behind, the WAL grows very quickly, and pgvector indexes make it even worse."
gen pt Luciana "Bom dia a todos. Hoje eu quero falar sobre como o Postgres lida com o write-ahead log. Quando o autovacuum atrasa, o WAL cresce muito rápido, e os índices do pgvector deixam isso ainda pior."
gen en-short Samantha "Postgres is really fast."
gen pt-short Luciana "O Postgres é muito rápido."
