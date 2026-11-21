-- Preparatory schema. Apply to your own Supabase project after Auth is configured.
-- The current app does not upload data or expose a Supabase service-role key.
create table public.library_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  album_id text not null check (length(album_id) between 1 and 100),
  album jsonb not null check (
    jsonb_typeof(album) = 'object'
    and album ? 'id' and album ? 'title'
    and album->>'id' = album_id
  ),
  status text not null default 'wanted' check (status in ('wanted', 'listened')),
  rating numeric(3,1) check (rating between 0 and 10 and mod(rating * 2, 1) = 0),
  note text not null default '' check (length(note) <= 5000),
  category text not null default '' check (length(category) <= 100),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, album_id)
);

create index library_records_user_updated_idx on public.library_records(user_id, updated_at);
alter table public.library_records enable row level security;

create policy "Users read their own records"
on public.library_records for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users insert their own records"
on public.library_records for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update their own records"
on public.library_records for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Ordinary deletion is a tombstone update; clients cannot hard-delete records.
revoke all on public.library_records from anon, authenticated;
grant select, insert, update on public.library_records to authenticated;
