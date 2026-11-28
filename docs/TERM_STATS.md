# Room term statistics (opt-in)

Term statistics keep a small part of what is said in a room so the most-used
terms can be learned and added to the vocabulary files. Later talks then get
better transcription and translation.

It is **off by default**. No room collects anything unless an admin lists it
in `TERM_STATS_ROOMS`.

## What is stored

For each opted-in room, and nothing for any other room:

1. **Term counts.** How many times each term appeared in the room's source
   speech.
2. **A text sample.** The first `ROOM_SAMPLE_MAX_LINES` finalized lines of
   source speech, as text. After the sample is full, only the counts grow.

Only the source speech text is used: the speaker's words as transcribed by
Deepgram, after `config/aliases.txt` fixes. Translations, audio, timestamps,
draft and interim text, and room tokens are not stored. Each finalized sentence
is counted once.

Because the input is speech, counts and the sample can contain names and
anything else a speaker says aloud.

### How terms are counted

- Text is lowercased, and `’` is treated as `'`.
- A word is a run of letters and digits. Internal `-`, `_`, `.` and `'` keep
  the word whole: `write-ahead`, `pg_stat_statements`, `node.js`.
- Skipped: one-character words, words over 48 characters, bare numbers such
  as `17` or `17.2`, and a built-in list of English and Portuguese stop words
  and fillers (`the`, `and`, `um`, `de`, `que`, `né`, ...). The list is
  `STOP_WORDS` in `src/term-stats.ts`.
- Two-word terms are counted too: two kept words next to each other in the same
  clause, such as `logical replication` or `replicação lógica`. A stop word or a
  `.`, `,`, `;`, `:`, `!`, `?` between them breaks the pair.
- A line longer than 1,000 characters is cut to 1,000 before it is counted or
  kept in the sample.
- Each room keeps at most 20,000 distinct terms. When it goes over, the terms
  with the lowest counts are dropped until 18,000 remain, so a brand-new term
  in a full room is usually dropped again soon.
- When a file is loaded with more terms or sample lines than the current
  limits allow (for example after `ROOM_SAMPLE_MAX_LINES` was lowered), it is
  trimmed to the limits and rewritten. The sample keeps its first lines.

Counts are lowercase, so curate casing (`PostgreSQL`, `WAL`) by hand when you
copy terms into `config/keyterms.txt` or `config/glossary.txt`.

## Settings

| Variable | Default | Description |
| --- | --- | --- |
| `TERM_STATS_ROOMS` | empty (off) | Comma-separated room slugs that opt in. Each must also be in `ROOMS`; an unknown slug stops startup. |
| `ROOM_SAMPLE_MAX_LINES` | `50` | Lines of source speech kept per opted-in room, `0` to `1000`. `0` keeps counts only. |

A line is one finalized caption sentence, usually up to about 200 characters.
At the default, the sample covers a few minutes of speech per room.

To turn it on for a room, edit `.env` and recreate the app:

```dotenv
TERM_STATS_ROOMS=main-stage,workshop-1
ROOM_SAMPLE_MAX_LINES=50
```

```bash
docker compose up -d --force-recreate app
```

To turn it off, remove the room from `TERM_STATS_ROOMS` and recreate the app.
Turning it off stops collection but does not delete data already stored; clear
it as described below.

## Where it is stored

One JSON file per room: `data/term-stats/<room>.json`, relative to the app's
working directory. In Docker that is `/app/data/term-stats/<room>.json`,
inside the named volume `app_data`:

```yaml
services:
  app:
    volumes:
      - app_data:/app/data
volumes:
  app_data:
```

The rest of the container stays read-only. The image creates `/app/data`
owned by the `node` user, and Docker copies that owner into a new volume, so
no manual `chown` is needed. `deploy.sh` needs no changes: its
`docker compose up -d` creates the volume.

Files are mode `600` in a mode `700` directory. Writes are batched every
5 seconds. Each write goes to `<room>.json.tmp`, is synced to disk, renamed over
`<room>.json`, and the directory is synced, so a crash leaves either the old or
the new complete file. A leftover `.tmp` file (from a crash or a failed write)
is removed on the next start and by clearing the room. If a write fails (disk
full, permissions), the error is logged, the data stays in memory, and the write
is retried after 10, 20, 40 and then every 60 seconds until it succeeds. The app also writes pending counts
when it receives `SIGTERM` (`docker compose stop`, `up --force-recreate`,
`./deploy.sh`). If that final write fails, it logs
`term stats: final write failed on shutdown` and exits with status 1. After a
crash or `SIGKILL`, up to the last 5 seconds can be lost.

### Unreadable files

If a room's file cannot be read or is not valid term-stats JSON, the app never
overwrites it. It logs the error once, stops collecting for that room, shows the
error on the room's card in `/admin` (`termStatsError` in `/admin/api/status`),
and the export returns HTTP 500 with the same message. To inspect the file,
copy it out of the volume:

```bash
docker compose cp app:/app/data/term-stats/<room>.json ./<room>-unreadable.json
```

Clearing the room deletes the file and resumes collection from zero.

## How long it is kept

Until an admin clears it. There is no automatic expiry.

| Action | Term data |
| --- | --- |
| Admin "Reiniciar sessão" (room reset) | kept |
| App restart, `docker compose up --force-recreate`, `./deploy.sh` | kept |
| `docker compose down` | kept |
| Admin "Apagar termos" or the clear endpoint | deleted for that room |
| `docker compose down -v` or `docker volume rm <project>_app_data` | deleted for all rooms |

## Export

Both endpoints need an admin session, like `/admin/api/transcript/:room`. In
the dashboard, rooms that collect or still have data show a "baixar termos"
link.

| Request | Response |
| --- | --- |
| `GET /admin/api/terms/<room>` | JSON |
| `GET /admin/api/terms/<room>?format=txt` | plain-text download |

JSON shape:

```json
{
  "room": "main-stage",
  "enabled": true,
  "sampleMaxLines": 50,
  "terms": [{ "term": "logical replication", "count": 12 }],
  "sample": ["Logical replication in PostgreSQL 17 ..."]
}
```

Terms are sorted by count, highest first. The text format has one
`count<TAB>term` line per term, a blank line, then the sample lines.

## Clear

In the dashboard, use "Apagar termos" on the room card. Or, with an admin
session cookie:

```bash
curl -X POST \
  -H "Origin: https://captions.example.com" \
  -b "lc_admin=<cookie>" \
  https://captions.example.com/admin/api/terms/<room>/clear
```

Like the room reset, the request must come from the same origin. Clearing
deletes the room's file. If the room is still opted in, collection starts again
from zero with the next sentence.

## Backups

The volume holds speech-derived data, so treat a copy like a transcript. Export
through the admin endpoints rather than copying the volume. If you must copy
the files:

```bash
docker compose cp app:/app/data/term-stats ./term-stats-backup
chmod -R go-rwx ./term-stats-backup
```

## Not built yet

Feeding a room's top terms back into Deepgram keyterms or the translation
glossary is not implemented. Counts are lowercase and have no glossary
explanation, so they need human curation first. Copy chosen terms into
`config/keyterms.txt` or `config/glossary.txt` and restart.
