"use client";

// app/games/shelem/page.tsx
// BUGFIX: same deadlock family as hokm — bidding UI needed `state` to
// exist to know whose turn it is, but state doesn't exist until someone
// bids. Fixed by tracking seating order independently (seats[0] always
// bids first, per the Edge Function's convention).

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import GameNav from "@/components/GameNav";

type MatchStatus = "waiting" | "active" | "finished";
type Phase = "bidding" | "choosing_trump" | "playing" | "finished";
type Suit = "S" | "H" | "D" | "C";
const SUIT_LABEL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_COLOR: Record<Suit, string> = { S: "#111", H: "#c0392b", D: "#c0392b", C: "#111" };

type PublicState = {
  match_id: string;
  phase: Phase;
  teams: { A: string[]; B: string[] };
  turn_order: string[];
  bids: Record<string, number | null>;
  highest_bid: number | null;
  bid_winner: string | null;
  trump: Suit | null;
  current_trick: { user_id: string; card: string }[];
  lead_suit: Suit | null;
  current_turn: string | null;
  tricks_won: { A: number; B: number };
  result: { winner: "A" | "B"; bid: number; made: boolean } | null;
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

export default function ShelemPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>("waiting");
  const [seats, setSeats] = useState<string[]>([]); // join order — seats[0] bids first
  const [state, setState] = useState<PublicState | null>(null);
  const [hand, setHand] = useState<string[]>([]);
  const [status, setStatus] = useState("در حال اتصال...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      setUserId(user.id);

      setStatus("در انتظار ۴ بازیکن...");
      const { data: id, error } = await supabase.rpc("find_or_create_shelem_match", { p_stake: STAKE });
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
    if (!matchId || !userId) return;

    const fetchInitial = async () => {
      const { data: m } = await supabase.from("matches").select("status").eq("id", matchId).single();
      if (m) setMatchStatus(m.status as MatchStatus);

      const { data: players } = await supabase
        .from("match_players")
        .select("user_id, joined_at")
        .eq("match_id", matchId)
        .order("joined_at", { ascending: true });
      if (players) setSeats(players.map((p) => p.user_id as string));

      const { data: g } = await supabase.from("shelem_games").select("*").eq("match_id", matchId).maybeSingle();
      if (g) setState(g as PublicState);
      const { data: h } = await supabase
        .from("shelem_hands")
        .select("cards")
        .eq("match_id", matchId)
        .eq("user_id", userId)
        .maybeSingle();
      if (h) setHand(h.cards as string[]);
    };
    fetchInitial();

    const channel = supabase
      .channel(`shelem-${matchId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, (payload) =>
        setMatchStatus((payload.new as { status: MatchStatus }).status)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shelem_games", filter: `match_id=eq.${matchId}` },
        (payload) => setState(payload.new as PublicState)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shelem_hands", filter: `match_id=eq.${matchId}` },
        (payload) => setHand((payload.new as { cards: string[] }).cards)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, userId]);

  useEffect(() => {
    if (matchStatus === "waiting") {
      setStatus("در انتظار ۴ بازیکن...");
      return;
    }
    const currentBidder = state?.current_turn ?? seats[0];
    if (!state || state.phase === "bidding") {
      setStatus(currentBidder === userId ? "نوبت پیشنهاد توئه" : "منتظر پیشنهاد بقیه...");
    } else if (state.phase === "choosing_trump") {
      setStatus(state.bid_winner === userId ? "خالتو انتخاب کن" : "منتظر انتخاب حکم...");
    } else if (state.phase === "playing") {
      setStatus(state.current_turn === userId ? "نوبت توئه" : "منتظر نوبت...");
    } else if (state.phase === "finished") {
      const myTeam: "A" | "B" | null = state.teams.A.includes(userId ?? "") ? "A" : state.teams.B.includes(userId ?? "") ? "B" : null;
      setStatus(state.result?.winner === myTeam ? `تیم شما برد! (پیشنهاد ${state.result?.bid}) 🏆` : `تیم شما باخت (پیشنهاد ${state.result?.bid})`);
    }
  }, [matchStatus, state, seats, userId]);

  const placeBid = async (bid: number | null) => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("shelem-action", {
      body: { action: "place_bid", match_id: matchId, bid },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const chooseTrump = async (trump: Suit) => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("shelem-action", {
      body: { action: "choose_trump", match_id: matchId, trump },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const playCard = async (card: string) => {
    setError(null);
    const { data, error } = await supabase.functions.invoke("shelem-action", {
      body: { action: "play_card", match_id: matchId, card },
    });
    if (error || (data as { error?: string })?.error) setError((data as { error?: string })?.error ?? error?.message ?? "خطا");
  };

  const myTurn = state?.current_turn === userId;
  const currentBidder = state?.current_turn ?? seats[0];
  const canBid = matchStatus === "active" && (!state || state.phase === "bidding") && currentBidder === userId;
  const bidOptions = Array.from({ length: 7 }, (_, i) => 7 + i).filter((n) => n > (state?.highest_bid ?? 6));

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Shelem</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {state?.highest_bid != null && (
        <p className="text-sm">
          بالاترین پیشنهاد: {state.highest_bid}
          {state.trump && (
            <>
              {" "}
              — حکم: <span style={{ color: SUIT_COLOR[state.trump] }}>{SUIT_LABEL[state.trump]}</span>
            </>
          )}
          {" — "}دست‌ها: A {state.tricks_won.A} / B {state.tricks_won.B}
        </p>
      )}

      {canBid && (
        <div className="flex flex-wrap gap-2 justify-center">
          {bidOptions.map((n) => (
            <button key={n} onClick={() => placeBid(n)} className="px-3 py-1 rounded border border-white/10">
              {n}
            </button>
          ))}
          <button onClick={() => placeBid(null)} className="px-3 py-1 rounded border border-white/10 text-red-400">
            پاس
          </button>
        </div>
      )}

      {state?.phase === "choosing_trump" && state.bid_winner === userId && (
        <div className="flex gap-2">
          {(["S", "H", "D", "C"] as Suit[]).map((s) => (
            <button key={s} onClick={() => chooseTrump(s)} className="w-12 h-12 rounded-lg border border-white/10 text-xl" style={{ color: SUIT_COLOR[s] }}>
              {SUIT_LABEL[s]}
            </button>
          ))}
        </div>
      )}

      {state?.phase === "playing" && (
        <div className="flex gap-2 mb-4">
          {state.current_trick.map((p) => (
            <CardView key={p.user_id} card={p.card} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 justify-center max-w-lg">
        {hand.map((c) => (
          <button
            key={c}
            onClick={() => myTurn && state?.phase === "playing" && playCard(c)}
            disabled={!myTurn || state?.phase !== "playing"}
            className="disabled:opacity-50"
          >
            <CardView card={c} />
          </button>
        ))}
      </div>
    </div>
  );
}
