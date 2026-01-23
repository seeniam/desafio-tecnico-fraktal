-- Extensions (safe to run multiple times)
create extension if not exists pgcrypto;
create extension if not exists vector;

-- Job queue table
create table if not exists public.document_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
