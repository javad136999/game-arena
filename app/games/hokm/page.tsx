"use client";

// app/games/hokm/page.tsx
//
// Same shape as chess/rps pages:
//   1. find_or_create_hokm_match() — waits for 4 players instead of 2
//   2. subscribe to hokm_games (public state: whose turn, trump, trick, score)
//   3. subscribe to hokm_hands filtered to this user (RLS guarantees this
//      is the ONLY row this client can ever receive — opponents' hands
//      never reach the browser, even over the realtime channel)
//   4. call the hokm-action Edge Function for choose_trump / play_card
//
// NOTE ON IMPORTS: matches this repo's client at "@/lib/supabase/client".
// Adjust if your project uses a different path.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type Phase = "bidding" | "playing" | "finished";
type Suit = "S" | "H" | "D" | "C";

const SUIT_LABEL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_COLOR: Record<Suit, string> = { S: "#111", H: "#c0392b", D: "#c0392b", C: "#111" };

type PublicState = {
  match_id: string;
  phase: Phase;
  teams: { A: string[]; B: string[] };
  turn_order: string[];
  hakem: string | null;
  trump: Suit | null;
  current_trick: { user_id: string; card: string }[];
  lead_suit: Suit | null;
  current_turn: string | null;
  tricks_won: { A: number; B: number };
  result: { winner: "A" | "B" } | null;
};

const STAKE = 0; // wired to 0 until the payment decision from README §5 is resolved

function Card({ card }: { card: string }) {
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

export default function HokmPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [hand, setHand] = useState<string[]>([]);
  const [status, setStatus] = useState("در حال اتصال...");
  const [error, setError] = useState<string | null>(null);

  // 1. auth + matchmaking
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      setUserId(user.id);

      setStatus("در انتظار ۴ بازیکن...");
      const { data: id, error } = await supabase.rpc("find_or_create_hokm_match", {
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

  // 2. subscribe to public state + my hand
  useEffect(() => {
    if (!matchId || !userId) return;

    const fetchInitial = async () => {
      const { data: g } = await supabase.from("hokm_games").select("*").eq("match_id", matchId).maybeSingle();
      if (g) setState(g as PublicState);

      const { data: h } = await supabase
        .from("hokm_hands")
        .select("cards")
        .eq("match_id", matchId)
        .eq("user_id", userId)
        .maybeSingle();
      if (h) setHand(h.cards as string[]);
    };
    fetchInitial();

    const channel = supabase
      .channel(`hokm-${matchId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "hokm_games", filter: `match_id=eq.${matchId}` },
        (payload) => setState(payload.new as PublicState)
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "hokm_hands",
          filter: `match_id=eq.${matchId}`, // RLS still restricts this to MY row only
        },
        (payload) => setHand((payload.new as { cards: string[] }).cards)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, userId]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "bidding") setStatus(state.hakem === userId ? "خالتو انتخاب کن (حاکم تویی)" : "منتظر انتخاب حکم توسط حاکم...");
    if (state.phase === "playing") setStatus(state.current_turn === userId ? "نوبت توئه" : "منتظر نوبت...");
    if (state.phase === "finished") {
      const myTeam: "A" | "B" | null = state.teams.A.includes(userId ?? "") ? "A" : state.teams.B.includes(userId ?? "") ? "B" : null;
      setStatus(state.result?.winner === myTeam ? "تیم شما برد! 🏆" : "تیم شما باخت");
    }
  }, [state, userId]);

  const chooseTrump = async (trump: Suit) => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("hokm-action", {
      body: { action: "choose_trump", match_id: matchId, trump },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const playCard = async (card: string) => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("hokm-action", {
      body: { action: "play_card", match_id: matchId, card },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const myTurn = state?.current_turn === userId;

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <h1 className="text-xl font-bold">Hokm</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {state?.trump && (
        <p className="text-sm">
          حکم: <span style={{ color: SUIT_COLOR[state.trump] }}>{SUIT_LABEL[state.trump]}</span> — دست‌های برده‌شده: A {state.tricks_won.A} / B {state.tricks_won.B}
        </p>
      )}

      {state?.phase === "bidding" && state.hakem === userId && (
        <div className="flex gap-2">
          {(["S", "H", "D", "C"] as Suit[]).map((s) => (
            <button
              key={s}
              onClick={() => chooseTrump(s)}
              className="w-12 h-12 rounded-lg border border-white/10 text-xl"
              style={{ color: SUIT_COLOR[s] }}
            >
              {SUIT_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      {state?.phase === "playing" && (
        <div className="flex gap-2 mb-4">
          {state.current_trick.map((p) => (
            <Card key={p.user_id} card={p.card} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
        {hand.map((c) => (
          <button key={c} onClick={() => myTurn && playCard(c)} disabled={!myTurn} className="disabled:opacity-50">
            <Card card={c} />
          </button>
        ))}
      </div>
    </div>
  );
}
