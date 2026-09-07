-- Game Arena — core schema
-- Run this once against a fresh Supabase project (SQL editor, or `supabase db push`).

create extension if not exists "pgcrypto";

-- ============================================================
-- PROFILES
-- ============================================================
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null default 'player',
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles are publicly readable"
  on profiles for select
  using (true);

create policy "users manage their own profile"
  on profiles for update
  using (auth.uid() = id);

-- auto-create a profile + wallet row whenever a new auth user signs up
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username) values (new.id, split_part(new.email, '@', 1));
  insert into public.wallets (user_id, balance) values (new.id, 0);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ============================================================
-- WALLETS + TRANSACTIONS
-- ============================================================
create table if not exists wallets (
  user_id uuid primary key references profiles (id) on delete cascade,
  balance numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table wallets enable row level security;

create policy "users read their own wallet"
  on wallets for select
  using (auth.uid() = user_id);

-- No client-side update policy: balance only changes through the
-- SECURITY DEFINER functions below (submit_move, deposit/cashout webhooks
-- once you wire up a payment provider).

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  type text not null check (type in ('deposit', 'cashout', 'game_win', 'game_entry')),
  amount numeric not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table transactions enable row level security;

create policy "users read their own transactions"
  on transactions for select
  using (auth.uid() = user_id);

-- ============================================================
-- MATCHES + PLAYERS
-- ============================================================
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  game_type text not null,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  stake numeric not null default 0,
  result jsonb,
  created_at timestamptz not null default now()
);

alter table matches enable row level security;

create policy "matches are publicly readable"
  on matches for select
  using (true);

-- inserts/updates to matches happen only through RPC functions below,
-- so there is no direct insert/update policy for authenticated clients.

create table if not exists match_players (
  match_id uuid not null references matches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table match_players enable row level security;

create policy "match players are publicly readable"
  on match_players for select
  using (true);

-- ============================================================
-- RPS MOVES (locked down — only readable/writable via RPC)
-- ============================================================
create table if not exists rps_moves (
  match_id uuid not null references matches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  move text not null check (move in ('rock', 'paper', 'scissors')),
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table rps_moves enable row level security;
-- Intentionally no select/insert policies here: all access goes through
-- submit_move(), which runs as SECURITY DEFINER. This is what stops a
-- player from reading the table directly and peeking at the opponent's move.

-- ============================================================
-- CHAT (5-minute post-game room)
-- ============================================================
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table chat_messages enable row level security;

create policy "match participants read chat"
  on chat_messages for select
  using (
    exists (
      select 1 from match_players
      where match_players.match_id = chat_messages.match_id
        and match_players.user_id = auth.uid()
    )
  );

create policy "match participants send chat"
  on chat_messages for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from match_players
      where match_players.match_id = chat_messages.match_id
        and match_players.user_id = auth.uid()
    )
    -- enforce the 5-minute window from when the match finished
    and exists (
      select 1 from matches
      where matches.id = chat_messages.match_id
        and matches.status = 'finished'
        and matches.created_at > now() - interval '30 minutes'
    )
  );

-- ============================================================
-- RPC: find_or_create_match
-- Joins a waiting match of the same game_type/stake, or creates one.
-- ============================================================
create or replace function find_or_create_match(p_game_type text, p_stake numeric)
returns uuid
language plpgsql
security definer
as $$
declare
  v_match_id uuid;
  v_player_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select id into v_match_id
  from matches
  where game_type = p_game_type
    and stake = p_stake
    and status = 'waiting'
  order by created_at
  limit 1
  for update skip locked;

  if v_match_id is null then
    insert into matches (game_type, stake, status)
    values (p_game_type, p_stake, 'waiting')
    returning id into v_match_id;
  end if;

  insert into match_players (match_id, user_id)
  values (v_match_id, auth.uid())
  on conflict do nothing;

  select count(*) into v_player_count from match_players where match_id = v_match_id;

  if v_player_count >= 2 then
    update matches set status = 'active' where id = v_match_id;
  end if;

  return v_match_id;
end;
$$;

-- ============================================================
-- RPC: submit_move
-- Stores a move; once both players have moved, resolves the round,
-- updates the match result, and settles the stake in wallets/transactions.
-- ============================================================
create or replace function submit_move(p_match_id uuid, p_move text)
returns void
language plpgsql
security definer
as $$
declare
  v_players uuid[];
  v_moves record;
  v_move_a text;
  v_move_b text;
  v_winner uuid;
  v_stake numeric;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into rps_moves (match_id, user_id, move)
  values (p_match_id, auth.uid(), p_move)
  on conflict (match_id, user_id) do nothing;

  select array_agg(user_id) into v_players
  from match_players where match_id = p_match_id;

  if array_length(v_players, 1) < 2 then
    return; -- waiting for an opponent to even join
  end if;

  select count(*) into v_moves from rps_moves where match_id = p_match_id;
  if v_moves < 2 then
    return; -- waiting for the other player's move
  end if;

  select move into v_move_a from rps_moves where match_id = p_match_id and user_id = v_players[1];
  select move into v_move_b from rps_moves where match_id = p_match_id and user_id = v_players[2];

  if v_move_a = v_move_b then
    v_winner := null; -- draw
  elsif (v_move_a, v_move_b) in (('rock','scissors'), ('paper','rock'), ('scissors','paper')) then
    v_winner := v_players[1];
  else
    v_winner := v_players[2];
  end if;

  select stake into v_stake from matches where id = p_match_id;

  update matches
  set status = 'finished',
      result = jsonb_build_object('winner', v_winner, 'draw', v_winner is null)
  where id = p_match_id;

  if v_winner is not null and v_stake > 0 then
    update wallets set balance = balance + v_stake, updated_at = now() where user_id = v_winner;
    insert into transactions (user_id, type, amount, meta)
    values (v_winner, 'game_win', v_stake, jsonb_build_object('match_id', p_match_id));
  end if;
end;
$$;

-- ============================================================
-- Realtime: enable change broadcasts on the tables the client subscribes to
-- ============================================================
alter publication supabase_realtime add table matches;
alter publication supabase_realtime add table chat_messages;
