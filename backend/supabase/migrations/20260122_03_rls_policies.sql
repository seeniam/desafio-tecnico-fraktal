alter table public.documents enable row level security;

drop policy if exists "read own or public" on public.documents;
create policy "read own or public"
on public.documents for select
using (auth.uid() = user_id OR is_public = true);

drop policy if exists "insert own" on public.documents;
create policy "insert own"
on public.documents for insert
with check (auth.uid() = user_id);

drop policy if exists "update own" on public.documents;
create policy "update own"
on public.documents for update
using (auth.uid() = user_id);

drop policy if exists "delete own" on public.documents;
create policy "delete own"
on public.documents for delete
using (auth.uid() = user_id);
