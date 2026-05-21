# ASR Review Studio

A Vercel + Supabase web app for uploading audio, running DashScope Qwen ASR, editing transcripts, and exporting corrected notes.

## Architecture

- Frontend: React/Vite, deployed on Vercel.
- API proxy: Vercel `/api/*` forwards to a Supabase Edge Function.
- Backend: Supabase Edge Function `asr-api`.
- Storage: private Supabase Storage bucket `audio-uploads`.
- Database: Supabase Postgres table `app_state` plus `asr_jobs`.
- ASR: DashScope `qwen3-asr-flash`.

## Local Frontend

```bash
npm install
npm run dev
```

The Vite dev server runs on `http://127.0.0.1:5174` and proxies `/api` to `http://127.0.0.1:5173` for local backend development.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md).

Required cloud environment variables:

- Supabase Edge Function secrets: `DASHSCOPE_API_KEY`, `PUBLIC_PASSWORD`, `PUBLIC_AUTH_TOKEN`, `ASR_MAX_BASE64_BYTES`
- Vercel environment variable: `SUPABASE_FUNCTION_URL`

Do not commit API keys, uploaded audio, local databases, or `.env` files.
