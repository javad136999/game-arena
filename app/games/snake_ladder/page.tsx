"use client";

// app/games/snake_ladder/page.tsx — v2, real board + real rules
//
// Renders an actual 10x10 numbered board (classic boustrophedon layout:
// 1-10 left-to-right on the bottom row, 11-20 right-to-left above it, and
// so on up to 100). Ladder-base and snake-head squares are color-coded.
// Each player gets a colored token (blue = first to join, red = second).
// A token that hasn't rolled a 6 yet sits in a "home" area above the
// board instead of on square 1.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import GameNav from "@/components/GameNav";

type MatchStatus = "waiting" | "active" | "finished";

type BoardState = {
  positions: Record<string, number>;
  turn_order: string[];
  current_turn: string | null;
  last_roll: number | null;
  status: "active" | "finished";
};

const STAKE = 0;
const LADDERS: Record<number, number> = { 4: 14, 9: 31, 20: 38, 28: 84, 40: 59, 51: 67, 63: 81, 71: 91 };
const SNAKES: Record<number, number> = { 17: 7, 54: 34, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 99: 78 };

const PLAYER_COLORS = ["#3b82f6", "#ef4444"]; // blue, red
const PLAYER_NAMES_FA = ["آبی", "قرمز"];

// Build the classic boustrophedon board: board[0] is the TOP row on screen,
// board[9] is the BOTTOM row (which holds squares 1-10).
function buildBoard(): number[][] {
  const rows: number[][] = new Array(10);
  for (let rowFromBottom = 0; rowFromBottom < 10; rowFromBottom++) {
    const base = rowFromBottom * 10;
    const leftToRight = rowFromBottom % 2 === 0;
    const row: number[] = [];
    for (let col = 0; col < 10; col++) {
      row.push(leftToRight ? base + col + 1 : base + (10 - col));
    }
    rows[9 - rowFromBottom] = row;
  }
  return rows;
}
const BOARD = buildBoard();

export default function SnakeLadderPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>("waiting");
  const [seats, setSeats] = useState<string[]>([]);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [status, setStatus] = useState("در حال اتصال...");
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      setUserId(user.id);

      setStatus("در حال پیدا کردن حریف...");
      const { data: id, error } = await supabase.rpc("find_or_create_match", {
        p_game_type: "snake_ladder",
        p_stake: STAKE,
      });
      if (error || cancelled) {
        setStatus("خطا در matchmaking: " + error?.message);
        return;
      }
      setMatchId(id as string);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!matchId) return;

    const fetchInitial = async () => {
      const { data: m } = await supabase.from("matches").select("status").eq("id", matchId).single();
      if (m) setMatchStatus(m.status as MatchStatus);

      const { data: players } = await supabase
        .from("match_players")
        .select("user_id, joined_at")
        .eq("match_id", matchId)
        .order("joined_at", { ascending: true });
      if (players) setSeats(players.map((p) => p.user_id as string));

      const { data } = await supabase.from("snake_ladder_games").select("*").eq("match_id", matchId).maybeSingle();
      if (data) setBoard(data as BoardState);
    };
    fetchInitial();

    const channel = supabase
      .channel(`sl-${matchId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, (payload) =>
        setMatchStatus((payload.new as { status: MatchStatus }).status)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "snake_ladder_games", filter: `match_id=eq.${matchId}` },
        (payload) => setBoard(payload.new as BoardState)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  useEffect(() => {
    if (matchStatus === "waiting") {
      setStatus("در انتظار حریف...");
      return;
    }
    if (board?.status === "finished") {
      setStatus("بازی تمام شد");
      return;
    }
    const myTurn = board ? board.current_turn === userId : seats[0] === userId;
    setStatus(myTurn ? "نوبت توئه — تاس بنداز" : "نوبت حریف");
  }, [matchStatus, board, seats, userId]);

  const roll = async () => {
    setError(null);
    setRolling(true);
    const { data, error } = await supabase.rpc("roll_dice", { p_match_id: matchId });
    setRolling(false);
    if (error) setError(error.message);
    else if (data?.winner) setStatus(data.winner === userId ? "بردی! 🏆" : "باختی");
  };

  const orderedSeats = board?.turn_order ?? seats;
  const canRoll =
    matchStatus === "active" &&
    board?.status !== "finished" &&
    (board ? board.current_turn === userId : seats[0] === userId);

  // squareNumber -> row/col lookup, built once
  const squarePos = useMemo(() => {
    const map = new Map<number, { row: number; col: number }>();
    BOARD.forEach((row, r) => row.forEach((n, c) => map.set(n, { row: r, col: c })));
    return map;
  }, []);

  const tokensBySquare = useMemo(() => {
    const map = new Map<number, string[]>(); // square -> [user_id,...]
    orderedSeats.forEach((uid) => {
      const pos = board?.positions[uid] ?? 0;
      if (pos > 0) {
        map.set(pos, [...(map.get(pos) ?? []), uid]);
      }
    });
    return map;
  }, [board, orderedSeats]);

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Snakes &amp; Ladders</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* home area: tokens that haven't rolled a 6 yet */}
      <div className="flex gap-6">
        {orderedSeats.map((uid, i) => {
          const pos = board?.positions[uid] ?? 0;
          if (pos > 0) return null;
          const isMe = uid === userId;
          return (
            <div key={uid} className="flex flex-col items-center gap-1">
              <div
                className="w-7 h-7 rounded-full border-2 border-white/40 flex items-center justify-center text-[10px] font-bold text-white"
                style={{ backgroundColor: PLAYER_COLORS[i] }}
              >
                {isMe ? "من" : ""}
              </div>
              <span className="text-[10px] text-text-3">{PLAYER_NAMES_FA[i]} — خانه (منتظر ۶)</span>
            </div>
          );
        })}
      </div>

      {/* the board */}
      <div className="grid grid-cols-10 gap-0.5 bg-white/5 p-1 rounded-lg w-full max-w-md aspect-square">
        {BOARD.flat().map((num) => {
          const tokens = tokensBySquare.get(num) ?? [];
          const isLadder = num in LADDERS;
          const isSnake = num in SNAKES;
          return (
            <div
              key={num}
              className={`relative flex items-center justify-center text-[9px] rounded-sm ${
                isLadder ? "bg-green-900/40" : isSnake ? "bg-red-900/40" : "bg-surface"
              }`}
              style={{ aspectRatio: "1 / 1" }}
            >
              <span className="absolute top-0.5 left-0.5 text-text-3">{num}</span>
              {isLadder && <span className="text-[10px]">🪜</span>}
              {isSnake && <span className="text-[10px]">🐍</span>}
              <div className="absolute inset-0 flex items-center justify-center gap-0.5">
                {tokens.map((uid) => {
                  const i = orderedSeats.indexOf(uid);
                  return (
                    <div
                      key={uid}
                      className="w-3.5 h-3.5 rounded-full border border-white/60"
                      style={{ backgroundColor: PLAYER_COLORS[i] }}
                      title={uid === userId ? "شما" : "حریف"}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {board?.last_roll && <p className="text-2xl">🎲 {board.last_roll}</p>}

      <button onClick={roll} disabled={rolling || !canRoll} className="rounded-lg border border-white/10 px-6 py-3 disabled:opacity-40">
        {rolling ? "..." : "تاس بنداز"}
      </button>
    </div>
  );
}
