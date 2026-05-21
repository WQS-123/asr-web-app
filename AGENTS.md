# AGENTS.md

Instructions for coding agents working on this repository.

## Project Shape

- `src/`: React frontend.
- `api/[...path].js`: Vercel proxy for `/api/*` requests.
- `supabase/functions/asr-api/`: Supabase Edge Function backend.
- `supabase/migrations/`: Supabase schema and storage setup.
- `DEPLOYMENT.md`: deployment checklist.

## Rules

- Keep secrets out of git. Use Supabase secrets and Vercel environment variables.
- Do not commit uploaded audio, local database files, runtime caches, or `.env` files.
- Keep transcription API-only through DashScope Qwen ASR. Do not add local ASR fallback code.
- Prefer small, deployment-focused changes.
- For production, use Supabase Storage for audio and Supabase Edge Functions for backend behavior.

## Checks

Run the checks that are available in the environment:

```bash
npm run build
node --check 'api/[...path].js'
python3 -m json.tool vercel.json
python3 -m json.tool supabase/functions/asr-api/deno.json
```
