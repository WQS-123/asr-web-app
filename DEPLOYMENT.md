# Deployment

Target architecture:

- Vercel hosts the React/Vite frontend.
- Vercel `/api/*` is a thin proxy to Supabase Edge Function `asr-api`.
- Supabase stores app state in Postgres and audio in private Storage bucket `audio-uploads`.
- DashScope Qwen ASR is called from the Supabase Edge Function.

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

Then deploy:

```bash
vercel deploy
```

For production:

```bash
vercel deploy --prod
```

## Current Limits

The first cloud version keeps the existing app-state JSON shape to reduce migration risk. Audio transcription uses `qwen3-asr-flash` base64 input, so it is intended for shorter audio under `ASR_MAX_BASE64_BYTES`. Longer audio should move to a Storage signed URL + DashScope async task flow.
