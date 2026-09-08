"use client";

// app/games/poker/page.tsx
//
// Player picks a table size (2-4) first, then find_or_create_poker_match
// seats them at a table looking for that same size. Once full, all 7 cards
// (2 hole + 5 community) are dealt and a single check/bet/call/fold round
// decides the hand.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import GameNav from "@/components/GameNav";

type Suit = "S" | "H" | "D" | "C";
const SUIT_LABEL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_COLOR: Record<Suit, string> = { S: "#111", H: "#c0392b", D: "#c0392b", C: "#111" };

type PublicState = {
  match_id: string;
  community_cards: string[];
  turn_order: string[];
  active_players: string[];
  to_act: string[];
  bet_state: "none" | "opened";
  bettor: string | null;
  current_turn: string | null;
  phase: "betting" | "finished";
  result: { winners: string[]; reason: "fold" | "showdown"; hand: string | null } | null;
};

const STAKE = 0;

function CardView({ card }: { card: string }) {
  const rank = card.slice(0, -1);
  const suit = card.slice(-1) as Suit;
  return (
    <span
      className="inline-flex items-center justify-center border border-white/10 rounded-md w-9 h-12 text-sm font-semibold bg-surface"
      style={{ color: SUIT_COLOR[suit] }}
    >
      {rank}
      {SUIT_LABEL[suit]}
    </span>
  );
}

export default function PokerPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [tableSize, setTableSize] = useState<number | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [hand, setHand] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) setUserId(user.id);
    })();
  }, []);

  const joinTable = async (size: number) => {
    setTableSize(size);
    setStatus(`در انتظار ${size} نفر...`);
    const { data: id, error } = await supabase.rpc("find_or_create_poker_match", {
      p_stake: STAKE,
      p_num_players: size,
    });
    if (error) {
      setStatus("خطا در matchmaking: " + error.message);
      return;
    }
    setMatchId(id as string);
  };

  useEffect(() => {
    if (!matchId || !userId) return;

    const fetchInitial = async () => {
      const { data: g } = await supabase.from("poker_games").select("*").eq("match_id", matchId).maybeSingle();
      if (g) setState(g as PublicState);
      const { data: h } = await supabase
        .from("poker_hands")
        .select("cards")
        .eq("match_id", matchId)
        .eq("user_id", userId)
        .maybeSingle();
      if (h) setHand(h.cards as string[]);
    };
    fetchInitial();

    const channel = supabase
      .channel(`poker-${matchId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "poker_games", filter: `match_id=eq.${matchId}` },
        (payload) => setState(payload.new as PublicState)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "poker_hands", filter: `match_id=eq.${matchId}` },
        (payload) => setHand((payload.new as { cards: string[] }).cards)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, userId]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "finished") {
      const won = state.result?.winners.includes(userId ?? "");
      const foldedOut = !state.active_players.includes(userId ?? "");
      if (won) setStatus(state.result?.reason === "fold" ? "بردی — حریف فولد کرد 🏆" : `بردی با ${state.result?.hand} 🏆`);
      else if (foldedOut) setStatus("فولد کردی");
      else setStatus(`باختی — دست حریف: ${state.result?.hand ?? ""}`);
    } else {
      setStatus(state.current_turn === userId ? "نوبت توئه" : "منتظر بقیه...");
    }
  }, [state, userId]);

  const act = async (type: "check" | "bet" | "call" | "fold") => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("poker-action", {
      body: { action: "act", match_id: matchId, type },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const myTurn = state?.current_turn === userId;
  const stillIn = state ? state.active_players.includes(userId ?? "") : true;

  if (!tableSize) {
    return (
      <div className="flex flex-col items-center gap-4 p-6">
        <GameNav />
        <h1 className="text-xl font-bold">Poker</h1>
        <p className="text-sm text-gray-500">میز چند نفره؟</p>
        <div className="flex gap-3">
          {[2, 3, 4].map((n) => (
            <button key={n} onClick={() => joinTable(n)} className="rounded-lg border border-white/10 px-5 py-3">
              {n} نفره
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Poker ({tableSize} نفره)</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {state && (
        <div className="flex gap-2 mb-2">
          {state.community_cards.map((c) => (
            <CardView key={c} card={c} />
          ))}
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {hand.map((c) => (
          <CardView key={c} card={c} />
        ))}
      </div>

      {state?.phase === "betting" && myTurn && stillIn && (
        <div className="flex gap-2">
          {state.bet_state === "none" ? (
            <>
              <button onClick={() => act("check")} className="px-4 py-2 rounded border border-white/10">
                Check
              </button>
              <button onClick={() => act("bet")} className="px-4 py-2 rounded border border-white/10">
                Bet
              </button>
            </>
          ) : (
            <>
              <button onClick={() => act("call")} className="px-4 py-2 rounded border border-white/10">
                Call
              </button>
              <button onClick={() => act("fold")} className="px-4 py-2 rounded border border-white/10 text-red-400">
                Fold
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}