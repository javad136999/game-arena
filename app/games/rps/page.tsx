"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { Match } from "@/lib/types";

type Move = "rock" | "paper" | "scissors";

export default function RpsPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [myMove, setMyMove] = useState<Move | null>(null);
  const [status, setStatus] = useState("Log in to play.");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserId(data.user.id);
        setStatus("Ready to find a match.");
      }
    });
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, []);

  async function findMatch() {
    if (!userId) return;
    setStatus("Finding an opponent…");

    // find_or_create_match is a Postgres function (see supabase/schema.sql).
    // It atomically joins a waiting match of the same stake or creates a new one.
    const { data, error } = await supabase.rpc("find_or_create_match", {
      p_game_type: "rps",
      p_stake: 0
    });
    if (error) {
      setStatus(error.message);
      return;
    }

    const matchId = data as string;
    const { data: matchRow } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .single();
    setMatch(matchRow as Match);
    setStatus(
      (matchRow as Match).status === "active" ? "Opponent found — choose your move." : "Waiting for an opponent…"
    );
    subscribe(matchId);
  }

  function subscribe(matchId: string) {
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    const channel = supabase
      .channel(`match-${matchId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
        (payload) => {
          const updated = payload.new as Match;
          setMatch(updated);
          if (updated.status === "active") setStatus("Opponent found — choose your move.");
          if (updated.status === "finished") {
            const result = updated.result as { winner?: string; draw?: boolean } | null;
            if (result?.draw) setStatus("Draw.");
            else if (result?.winner === userId) setStatus("You won!");
            else setStatus("You lost.");
          }
        }
      )
      .subscribe();
    channelRef.current = channel;
  }

  async function submitMove(move: Move) {
    if (!match) return;
    setMyMove(move);
    setStatus("Move submitted — waiting for opponent…");
    // submit_move is SECURITY DEFINER: it stores the move and only reveals /
    // computes the result once both players have moved, so no client can peek
    // at the opponent's choice early.
    const { error } = await supabase.rpc("submit_move", {
      p_match_id: match.id,
      p_move: move
    });
    if (error) setStatus(error.message);
  }

  return (
    <div className="max-w-sm mx-auto text-center">
      <h1 className="font-display text-xl font-semibold mb-2">Rock, paper, scissors</h1>
      <p className="text-sm text-text-2 mb-6">{status}</p>

      {!match && (
        <button
          onClick={findMatch}
          disabled={!userId}
          className="bg-coral text-white font-semibold rounded-xl px-6 py-3 text-sm disabled:opacity-40"
        >
          Find match
        </button>
      )}

      {match && match.status !== "finished" && (
        <div className="flex gap-3 justify-center">
          {(["rock", "paper", "scissors"] as Move[]).map((m) => (
            <button
              key={m}
              onClick={() => submitMove(m)}
              disabled={myMove !== null}
              className={`w-20 h-20 rounded-xl border text-sm font-semibold capitalize ${
                myMove === m ? "border-gold text-gold" : "border-white/10 text-text-2"
              } disabled:opacity-40`}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      {match && match.status === "finished" && (
        <button
          onClick={() => {
            setMatch(null);
            setMyMove(null);
            setStatus("Ready to find a match.");
          }}
          className="bg-gold text-[#231A08] font-semibold rounded-xl px-6 py-3 text-sm"
        >
          Play again
        </button>
      )}
    </div>
  );
}
