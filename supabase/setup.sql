-- Handlelista: kjør dette én gang i Supabase → SQL Editor
-- Én rad holder hele den felles lista. Tabellen er låst (RLS uten regler),
-- så bare edge-funksjonen «handlelista» kan lese og skrive.

create table if not exists public.handlelista_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.handlelista_state enable row level security;

insert into public.handlelista_state (id, data)
values ('hjemme', '{"v": 0, "items": [], "often": {}}')
on conflict (id) do nothing;

-- Mellomlager for Kassalapp-oppslag (lignende varer, metadata). Bare edge-funksjonen bruker den.
create table if not exists public.handlelista_cache (
  key text primary key,
  data jsonb not null,
  expires_at timestamptz not null
);
alter table public.handlelista_cache enable row level security;
create index if not exists handlelista_cache_expires on public.handlelista_cache (expires_at);
