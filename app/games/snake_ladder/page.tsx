"use client";

// app/games/snake_ladder/page.tsx
//
// Simplest of the games so far: no Edge Function needed, everything goes
// through the roll_dice() RPC (same pattern as submit_move for RPS) since
// the rules are simple and there's no hidden information to protect — the
// board is publicly readable, just like matches/chess_games.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

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
    setStatus("در انتظار حریف...");

    const fetchInitial = async () => {
      const { data } = await supabase.from("snake_ladder_games").select("*").eq("match_id", matchId).maybeSingle();
      if (data) setBoard(data as BoardState);
    };
    fetchInitial();

    const channel = supabase
      .channel(`sl-${matchId}`)
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
    if (!board) return;
    if (board.status === "finished") {
      setStatus(board.current_turn === null ? "بازی تمام شد" : "بازی تمام شد");
    } else {
      setStatus(board.current_turn === userId ? "نوبت توئه — تاس بنداز" : "نوبت حریف");
    }
  }, [board, userId]);

  const roll = async () => {
    setError(null);
    setRolling(true);
    const { data, error } = await supabase.rpc("roll_dice", { p_match_id: matchId });
    setRolling(false);
    if (error) setError(error.message);
    else if (data?.winner) setStatus(data.winner === userId ? "بردی! 🏆" : "باختی");
  };

  const myPos = board && userId ? board.positions[userId] ?? 0 : 0;
  const oppId = board?.turn_order.find((id) => id !== userId);
  const oppPos = board && oppId ? board.positions[oppId] ?? 0 : 0;

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <h1 className="text-xl font-bold">Snakes &amp; Ladders</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-8 text-sm">
        <p>شما: خانه {myPos}</p>
        <p>حریف: خانه {oppPos}</p>
      </div>

      {board?.last_roll && <p className="text-2xl">🎲 {board.last_roll}</p>}

      <button
        onClick={roll}
        disabled={rolling || board?.status === "finished" || board?.current_turn !== userId}
        className="rounded-lg border border-white/10 px-6 py-3 disabled:opacity-40"
      >
        {rolling ? "..." : "تاس بنداز"}
      </button>
    </div>
  );
}
