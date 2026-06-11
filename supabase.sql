-- RINOTE Phase 1 — Supabase スキーマ
-- SupabaseダッシュボードのSQL Editorに貼り付けて実行してください

-- ① 投資理由の記録
create table if not exists records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  reason text not null,
  decision text not null default '記録',
  period text default '',
  anxiety text default '',
  signal text default '',
  checks jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table records enable row level security;

create policy "own records select" on records
  for select using (auth.uid() = user_id);
create policy "own records insert" on records
  for insert with check (auth.uid() = user_id);
create policy "own records update" on records
  for update using (auth.uid() = user_id);
create policy "own records delete" on records
  for delete using (auth.uid() = user_id);

-- ② 1日の照合回数（サーバーのservice keyのみが書き込む）
create table if not exists rl_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table rl_usage enable row level security;
-- RLSポリシーを作らない＝anonキーではアクセス不可。service keyのみが操作できる。

-- ③ 通知機能の開始を希望するメールアドレス
create table if not exists notif_list (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

alter table notif_list enable row level security;

create policy "own notif insert" on notif_list
  for insert with check (auth.uid() = user_id);
create policy "own notif select" on notif_list
  for select using (auth.uid() = user_id);
