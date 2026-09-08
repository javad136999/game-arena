"use client";

// app/games/chess/page.tsx
//
// Follows the same shape as app/games/rps/page.tsx:
//   1. find_or_create_match() to get paired with an opponent
//   2. subscribe to postgres_changes on `matches` (status -> active/finished)
//   3. subscribe to postgres_changes on `chess_games` (fen/turn updates)
//   4. send each move through the chess-move Edge Function (server-validated)
//
// NOTE ON IMPORTS: this assumes the same browser Supabase client your other
// game pages use. If your project's helper lives at a different path than
// "@/lib/supabase", update the import below to match — everything else is
// self-contained.

import { useCallback, useEffect, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { supabase } from "@/lib/supabase/client";
import GameNav from "@/components/GameNav";
type MatchStatus = "waiting" | "active" | "finished";

type MatchRow = {
  id: string;
  status: MatchStatus;
  stake: number;
  result: { winner: string | null; draw: boolean; reason?: string } | null;
};

type ChessGameRow = {
  fen: string;
  turn: "w" | "b";
};

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const STAKE = 0; // wired to 0 until the payment decision from README §5 is resolved

export default function ChessPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [fen, setFen] = useState(STARTING_FEN);
  const [turn, setTurn] = useState<"w" | "b">("w");
  const [myColor, setMyColor] = useState<"w" | "b" | null>(null);
  const [status, setStatus] = useState("در حال اتصال...");
  const chessRef = useRef(new Chess());

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
        p_game_type: "chess",
        p_stake: STAKE,
      });
      if (error || cancelled) {
        setStatus("خطا در matchmaking: " + error?.message);
        return;
      }
      setMatchId(id as string);

      const { data: players } = await supabase
        .from("match_players")
        .select("user_id, joined_at")
        .eq("match_id", id)
        .order("joined_at", { ascending: true });

      if (players && players.length > 0) {
        setMyColor(players[0].user_id === user.id ? "w" : "b");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 2. subscribe to match status + chess board state
  useEffect(() => {
    if (!matchId) return;

    setStatus("در انتظار حریف...");

    const fetchInitial = async () => {
      const { data: m } = await supabase
        .from("matches")
        .select("id, status, stake, result")
        .eq("id", matchId)
        .single();
      if (m) setMatch(m as MatchRow);

      const { data: g } = await supabase
        .from("chess_games")
        .select("fen, turn")
        .eq("match_id", matchId)
        .maybeSingle();
      if (g) {
        setFen(g.fen);
        setTurn(g.turn);
        chessRef.current.load(g.fen);
      }
    };
    fetchInitial();

    const channel = supabase
      .channel(`chess-${matchId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
        (payload) => setMatch(payload.new as MatchRow)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chess_games", filter: `match_id=eq.${matchId}` },
        (payload) => {
          const row = payload.new as ChessGameRow;
          setFen(row.fen);
          setTurn(row.turn);
          chessRef.current.load(row.fen);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  useEffect(() => {
    if (match?.status === "active") setStatus("نوبت بازی");
    if (match?.status === "finished") {
      if (match.result?.draw) setStatus("مساوی شد");
      else if (match.result?.winner === userId) setStatus("بردی! \uD83C\uDFC6");
      else if (match.result?.winner) setStatus("باختی");
    }
  }, [match, userId]);

  const onDrop = useCallback(
    async (sourceSquare: Square, targetSquare: Square) => {
      if (!matchId || match?.status !== "active" || turn !== myColor) return false;

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return false;

      const { data, error } = await supabase.functions.invoke("chess-move", {
        body: { match_id: matchId, from: sourceSquare, to: targetSquare, promotion: "q" },
      });

      if (error || (data && (data as { error?: string }).error)) {
        console.error(error ?? (data as { error?: string }).error);
        return false; // react-chessboard snaps the piece back
      }

      return true;
    },
    [matchId, match, turn, myColor]
  );

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Chess</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {myColor && <p className="text-xs text-gray-400">شما: {myColor === "w" ? "سفید" : "سیاه"}</p>}

      <div className="w-full max-w-[480px]">
        <Chessboard
          position={fen}
          onPieceDrop={(from, to) => {
            onDrop(from as Square, to as Square);
            return true; // optimistic UI; onDrop reverts via realtime if rejected
          }}
          boardOrientation={myColor === "b" ? "black" : "white"}
          arePiecesDraggable={match?.status === "active" && turn === myColor}
        />
      </div>
    </div>
  );
}