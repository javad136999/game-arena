-- Game Arena — hokm add-on
-- Run this AFTER supabase/schema.sql and (if you added it) schema-chess.sql.
-- Adds 4-player matchmaking for hokm and the state tables that only the
-- hokm-action Edge Function is allowed to write to.

-- ============================================================
-- 4-PLAYER MATCHMAKING
-- find_or_create_match() only ever waits for 2 players. Hokm needs 4,
-- so it gets its own RPC rather than changing the shared one (which RPS
-- and chess both already depend on).
-- ============================================================
create or replace function find_or_create_hokm_match(p_stake numeric)
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
  where game_type = 'hokm'
    and stake = p_stake
    and status = 'waiting'
  order by created_at
  limit 1
  for update skip locked;

  if v_match_id is null then
    insert into matches (game_type, stake, status)
    values ('hokm', p_stake, 'waiting')
    returning id into v_match_id;
  end if;

  insert into match_players (match_id, user_id)
  values (v_match_id, auth.uid())
  on conflict do nothing;

  select count(*) into v_player_count from match_players where match_id = v_match_id;

  if v_player_count >= 4 then
    update matches set status = 'active' where id = v_match_id;
  end if;

  return v_match_id;
end;
$$;

-- ============================================================
-- HOKM PUBLIC STATE — everything that is safe for all 4 players to see:
-- whose turn it is, the trump suit, the trick in progress, the score.
-- No hands in here. Locked down like matches: only the hokm-action Edge
-- Function (service role) writes to it.
-- ============================================================
create table if not exists hokm_games (
  match_id      uuid primary key references matches (id) on delete cascade,
  phase         text not null default 'bidding' check (phase in ('bidding', 'playing', 'finished')),
  teams         jsonb not null default '{}',   -- { "A": [user_id, user_id], "B": [user_id, user_id] }
  turn_order    jsonb not null default '[]',   -- [user_id, user_id, user_id, user_id] seating order
  hakem         uuid,
  trump         text,                          -- 'S' | 'H' | 'D' | 'C' once chosen
  current_trick jsonb not null default '[]',   -- [{ "user_id": ..., "card": "AS" }, ...] this trick so far
  lead_suit     text,
  current_turn  uuid,
  tricks_won    jsonb not null default '{"A":0,"B":0}',
  result        jsonb,                         -- { winner: "A"|"B" } once phase = finished
  updated_at    timestamptz not null default now()
);

alter table hokm_games enable row level security;

create policy "hokm participants read public state"
  on hokm_games for select
  using (
    exists (
      select 1 from match_players
      where match_players.match_id = hokm_games.match_id
      and match_players.user_id = auth.uid()
    )
  );

-- No insert/update policy — only hokm-action (service role) writes here.

alter publication supabase_realtime add table hokm_games;

-- ============================================================
-- HOKM HANDS — one row per player per match, holding ONLY that player's
-- own cards. RLS restricts select to auth.uid() = user_id, and because
-- Supabase realtime re-applies RLS per subscriber, a player who subscribes
-- to this table only ever receives their OWN row's changes — an opponent's
-- hand never reaches their browser, even over the realtime channel.
-- ============================================================
create table if not exists hokm_hands (
  match_id   uuid not null references matches (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  cards      jsonb not null default '[]', -- ["AS","TH",...] — this player's remaining cards
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table hokm_hands enable row level security;

create policy "players read only their own hand"
  on hokm_hands for select
  using (auth.uid() = user_id);

-- No insert/update policy — only hokm-action (service role) deals cards
-- and removes a card when it's played.

alter publication supabase_realtime add table hokm_hands;
