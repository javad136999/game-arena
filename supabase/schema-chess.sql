-- Game Arena — chess add-on
-- Run this AFTER supabase/schema.sql (needs matches, match_players, wallets, transactions).
-- Adds the state table for chess and locks it down the same way rps_moves is locked down:
-- no client insert/update policy — only the chess-move Edge Function (service role key,
-- after validating the move server-side with chess.js) is allowed to write to it.

create table if not exists chess_games (
  match_id   uuid primary key references matches (id) on delete cascade,
  fen        text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  pgn        text not null default '',
  turn       text not null default 'w' check (turn in ('w', 'b')),
  updated_at timestamptz not null default now()
);

alter table chess_games enable row level security;

create policy "chess games are publicly readable"
  on chess_games for select
  using (true);

-- Intentionally no insert/update policy here. A player's browser never
-- writes a fen/pgn directly — it calls the chess-move Edge Function, which
-- validates the move with chess.js and writes using the service role key.
-- This is what stops someone from POSTing a fake "I'm in checkmate, pay me"
-- position straight into the table.

alter publication supabase_realtime add table chess_games;
