-- Praxis tables (shared Supabase project with Lumina V1.3; praxis_* prefix
-- keeps the two apps fully isolated). Open policies = single-user phase.
do $$
declare t text;
begin
  foreach t in array array['praxis_assets','praxis_refs','praxis_elements','praxis_rules','praxis_results','praxis_signals','praxis_jobs','praxis_spend']
  loop
    execute format('create table if not exists %I (id text primary key, data jsonb not null, updated_at timestamptz default now())', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "open_all" on %I', t);
    execute format('create policy "open_all" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

create table if not exists praxis_kv (key text primary key, value jsonb, updated_at timestamptz default now());
alter table praxis_kv enable row level security;
drop policy if exists "open_all" on praxis_kv;
create policy "open_all" on praxis_kv for all using (true) with check (true);

-- Image storage: pixels live in a public bucket, rows keep only URLs.
-- (Inline base64 in jsonb rows eventually hits statement timeouts.)
insert into storage.buckets (id, name, public)
values ('praxis-images', 'praxis-images', true)
on conflict (id) do nothing;

drop policy if exists "praxis images read"   on storage.objects;
drop policy if exists "praxis images write"  on storage.objects;
drop policy if exists "praxis images update" on storage.objects;
create policy "praxis images read"   on storage.objects for select using (bucket_id = 'praxis-images');
create policy "praxis images write"  on storage.objects for insert with check (bucket_id = 'praxis-images');
create policy "praxis images update" on storage.objects for update using (bucket_id = 'praxis-images');
