# Deployment

Target architecture:

- Vercel hosts the React/Vite frontend.
- Vercel `/api/*` is a thin proxy to Supabase Edge Function `asr-api`.
- Supabase stores app state in Postgres and audio in private Storage bucket `audio-uploads`.
- DashScope Qwen ASR is called from the Supabase Edge Function.
- AI calibration requests are called from the Supabase Edge Function using per-request browser settings, or server-side fallback secrets.

## Supabase

1. Create or select a Supabase project.
2. Apply the migration:

```bash
supabase db push --project-ref <project-ref>
```

3. Set Edge Function secrets:

```bash
supabase secrets set --project-ref <project-ref> \
  DASHSCOPE_API_KEY='<dashscope-key>' \
  PUBLIC_PASSWORD='<shared-password>' \
  PUBLIC_AUTH_TOKEN='<long-random-token>' \
  ASR_MAX_BASE64_BYTES='7340032'
```

Optional server-side defaults for calibration:

```bash
supabase secrets set --project-ref <project-ref> \
  AI_BASE_URL='https://api.deepseek.com' \
  AI_MODEL='deepseek-chat' \
  DEEPSEEK_API_KEY='<deepseek-key>'
```

Google login:

1. In Google Cloud OAuth, add this authorized redirect URI:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

2. In Supabase Auth Providers, enable Google with the Google OAuth client ID and secret.
3. In Supabase Auth URL configuration, add app redirect URLs:

```text
https://asr-web-app.vercel.app/auth/google/callback
http://127.0.0.1:5174/auth/google/callback
```

4. Deploy the function:

```bash
supabase functions deploy asr-api --project-ref <project-ref> --no-verify-jwt
```

Function URL:

```text
https://<project-ref>.supabase.co/functions/v1/asr-api
```

## Vercel

Set this environment variable in the Vercel project:

```text
SUPABASE_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/asr-api
```

For the current Supabase project, the proxy has a non-secret fallback:

```text
https://nsysrnnnbvodxgoooyoj.supabase.co/functions/v1/asr-api
```

The production Vercel build uses `npm run build` and publishes `dist/`. Keep `api/[...path].js` at the project root so `/api/*` continues to proxy to Supabase.

Then deploy:

```bash
vercel deploy
```

For production:

```bash
vercel deploy --prod
```

## Current Limits

The first cloud version keeps the existing app-state JSON shape to reduce migration risk. Audio transcription uses `qwen3-asr-flash` base64 input, so it is intended for shorter audio under `ASR_MAX_BASE64_BYTES`. Pause/resume/cancel endpoints are implemented for UI compatibility, but Supabase Edge Functions do not keep a long-running local worker alive, so long audio should move to a Storage signed URL + DashScope async task flow.
