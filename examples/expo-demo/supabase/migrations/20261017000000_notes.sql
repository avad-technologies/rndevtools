create table public.notes (
  id bigint generated always as identity primary key,
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.notes enable row level security;
create policy "Notes are readable by anyone" on public.notes for select using (true);
