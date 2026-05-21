create extension if not exists pgcrypto;

create table if not exists public.app_state (
  id text primary key default 'default',
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.asr_jobs (
  id text primary key,
  doc_id text,
  status text not null default 'running',
  stage text not null default '',
  error text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public)
values ('audio-uploads', 'audio-uploads', false)
on conflict (id) do nothing;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_state_touch_updated_at on public.app_state;
create trigger app_state_touch_updated_at
before update on public.app_state
for each row execute function public.touch_updated_at();

drop trigger if exists asr_jobs_touch_updated_at on public.asr_jobs;
create trigger asr_jobs_touch_updated_at
before update on public.asr_jobs
for each row execute function public.touch_updated_at();

alter table public.app_state enable row level security;
alter table public.asr_jobs enable row level security;

drop policy if exists "service role can manage app state" on public.app_state;
create policy "service role can manage app state"
on public.app_state
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service role can manage asr jobs" on public.asr_jobs;
create policy "service role can manage asr jobs"
on public.asr_jobs
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
