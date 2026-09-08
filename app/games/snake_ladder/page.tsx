"use client";

// app/games/snake_ladder/page.tsx
//
// BUGFIX: the roll_dice() RPC only creates the snake_ladder_games row on
// the FIRST call — but the old version of this page only enabled the
// button once that row already existed, and never watched `matches`
// directly, so nobody could ever make the first roll and the status text
// stayed stuck on "در انتظار حریف" forever even after the match went
// active. Fixed by: (1) fetching match_players to know who joined first
// (the RPC's turn_order[0]) and allowing THAT player to roll even before
// the board row exists, and (2) subscribing to `matches` directly so the
// status text updates the moment the match goes active.

import { useEffect, useState } from "react";
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

const STAKE = 0; // wired to 0 until the payment decision from README §5 is resolved

export default function SnakeLadderPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>("waiting");
  const [seats, setSeats] = useState<string[]>([]); // join order — seats[0] gets the first roll
  const [board, setBoard] = useState<BoardState | null>(null);
  const [status, setStatus] = useState("در حال اتصال...");
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);

  // 1. auth + matchmaking
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

  // 2. subscribe to match status, seating order, and the board
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
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
        (payload) => setMatchStatus((payload.new as { status: MatchStatus }).status)
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

  const myPos = board && userId ? board.positions[userId] ?? 0 : 0;
  const oppId = (board?.turn_order ?? seats).find((id) => id !== userId);
  const oppPos = board && oppId ? board.positions[oppId] ?? 0 : 0;

  const canRoll =
    matchStatus === "active" &&
    board?.status !== "finished" &&
    (board ? board.current_turn === userId : seats[0] === userId);

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Snakes &amp; Ladders</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-8 text-sm">
        <p>شما: خانه {myPos}</p>
        <p>حریف: خانه {oppPos}</p>
      </div>

      {board?.last_roll && <p className="text-2xl">🎲 {board.last_roll}</p>}

      <button onClick={roll} disabled={rolling || !canRoll} className="rounded-lg border border-white/10 px-6 py-3 disabled:opacity-40">
        {rolling ? "..." : "تاس بنداز"}
      </button>
    </div>
  );
}
