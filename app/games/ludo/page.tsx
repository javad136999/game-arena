"use client";

// app/games/ludo/page.tsx
// Simplified 4-player ludo: one token per player, private 57-square track,
// no captures. Same shape as the snake_ladder page but for 4 players.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import GameNav from "@/components/GameNav";

type BoardState = {
  positions: Record<string, number>;
  turn_order: string[];
  current_turn: string | null;
  last_roll: number | null;
  status: "active" | "finished";
};

const STAKE = 0;
const FINISH = 57;

export default function LudoPage() {
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

      setStatus("در انتظار ۴ بازیکن...");
      const { data: id, error } = await supabase.rpc("find_or_create_ludo_match", { p_stake: STAKE });
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
    setStatus("در انتظار بقیه‌ی بازیکن‌ها...");

    const fetchInitial = async () => {
      const { data } = await supabase.from("ludo_games").select("*").eq("match_id", matchId).maybeSingle();
      if (data) setBoard(data as BoardState);
    };
    fetchInitial();

    const channel = supabase
      .channel(`ludo-${matchId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ludo_games", filter: `match_id=eq.${matchId}` },
        (payload) => setBoard(payload.new as BoardState)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  useEffect(() => {
    if (!board) return;
    if (board.status === "finished") setStatus("بازی تمام شد");
    else setStatus(board.current_turn === userId ? "نوبت توئه — تاس بنداز" : "منتظر نوبت...");
  }, [board, userId]);

  const roll = async () => {
    setError(null);
    setRolling(true);
    const { data, error } = await supabase.rpc("roll_dice_ludo", { p_match_id: matchId });
    setRolling(false);
    if (error) setError(error.message);
    else if (data?.winner) setStatus(data.winner === userId ? "بردی! 🏆" : "یکی دیگه برد");
  };

  const others = board?.turn_order.filter((id) => id !== userId) ?? [];

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Ludo</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="w-full max-w-sm space-y-2">
        <div className="flex justify-between text-sm">
          <span>شما</span>
          <span>{board && userId ? board.positions[userId] ?? 0 : 0} / {FINISH}</span>
        </div>
        {board && userId && (
          <div className="h-2 rounded bg-white/10">
            <div
              className="h-2 rounded bg-gold"
              style={{ width: `${((board.positions[userId] ?? 0) / FINISH) * 100}%` }}
            />
          </div>
        )}

        {others.map((id) => (
          <div key={id}>
            <div className="flex justify-between text-xs text-text-3">
              <span>حریف</span>
              <span>{board?.positions[id] ?? 0} / {FINISH}</span>
            </div>
            <div className="h-1.5 rounded bg-white/5">
              <div
                className="h-1.5 rounded bg-white/30"
                style={{ width: `${((board?.positions[id] ?? 0) / FINISH) * 100}%` }}
              />
            </div>
          </div>
        ))}
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