-- Game Arena — shelem add-on
-- Run this AFTER supabase/schema.sql (and schema-hokm.sql is not required —
-- shelem has its own tables, structured the same way for consistency).

-- ============================================================
-- 4-PLAYER MATCHMAKING (same pattern as find_or_create_hokm_match)
-- ============================================================
create or replace function find_or_create_shelem_match(p_stake numeric)
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
  where game_type = 'shelem'
    and stake = p_stake
    and status = 'waiting'
  order by created_at
  limit 1
  for update skip locked;

  if v_match_id is null then
    insert into matches (game_type, stake, status)
    values ('shelem', p_stake, 'waiting')
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
-- SHELEM PUBLIC STATE — bids, trump, trick in progress, score.
-- No hands here. Only shelem-action (service role) writes to it.
-- ============================================================
create table if not exists shelem_games (
  match_id      uuid primary key references matches (id) on delete cascade,
  phase         text not null default 'bidding' check (phase in ('bidding', 'choosing_trump', 'playing', 'finished')),
  teams         jsonb not null default '{}',   -- { "A": [user_id, user_id], "B": [user_id, user_id] }
  turn_order    jsonb not null default '[]',
  bids          jsonb not null default '{}',   -- { user_id: number|null } null = pass
  highest_bid   int,
  bid_winner    uuid,
  trump         text,
  current_trick jsonb not null default '[]',
  lead_suit     text,
  current_turn  uuid,
  tricks_won    jsonb not null default '{"A":0,"B":0}',
  result        jsonb,                         -- { winner: "A"|"B", bid: n, made: bool }
  updated_at    timestamptz not null default now()
);

alter table shelem_games enable row level security;

create policy "shelem participants read public state"
  on shelem_games for select
  using (
    exists (
      select 1 from match_players
      where match_players.match_id = shelem_games.match_id
      and match_players.user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table shelem_games;

-- ============================================================
-- SHELEM HANDS — same private-per-row pattern as hokm_hands.
-- ============================================================
create table if not exists shelem_hands (
  match_id   uuid not null references matches (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  cards      jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

alter table shelem_hands enable row level security;

create policy "players read only their own shelem hand"
  on shelem_hands for select
  using (auth.uid() = user_id);

alter publication supabase_realtime add table shelem_hands;
