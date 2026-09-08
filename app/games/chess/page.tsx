"use client";

// app/games/chess/page.tsx
//
// CHANGED: click-to-move instead of drag-and-drop. Click a piece you own
// on your turn -> its legal destination squares highlight in red -> click
// one of them to move. Click the same piece again, or an empty/illegal
// square, to deselect. Legal moves are computed locally with chess.js
// (for highlighting only); the actual move is still validated server-side
// by the chess-move Edge Function, same as before.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const STAKE = 0;

export default function ChessPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [fen, setFen] = useState(STARTING_FEN);
  const [turn, setTurn] = useState<"w" | "b">("w");
  const [myColor, setMyColor] = useState<"w" | "b" | null>(null);
  const [status, setStatus] = useState("در حال اتصال...");
  const [selected, setSelected] = useState<Square | null>(null);
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
      const { data: m } = await supabase.from("matches").select("id, status, stake, result").eq("id", matchId).single();
      if (m) setMatch(m as MatchRow);

      const { data: g } = await supabase.from("chess_games").select("fen, turn").eq("match_id", matchId).maybeSingle();
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
          setSelected(null); // clear selection whenever the board updates
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

  const canMove = match?.status === "active" && turn === myColor;

  // legal destination squares for the currently selected piece
  const legalTargets: Square[] = useMemo(() => {
    if (!selected) return [];
    const moves = chessRef.current.moves({ square: selected, verbose: true }) as { to: Square }[];
    return moves.map((m) => m.to);
  }, [selected, fen]);

  const submitMove = useCallback(
    async (from: Square, to: Square) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const { data, error } = await supabase.functions.invoke("chess-move", {
        body: { match_id: matchId, from, to, promotion: "q" },
      });
      if (error || (data && (data as { error?: string }).error)) {
        console.error(error ?? (data as { error?: string }).error);
      }
    },
    [matchId]
  );

  const onSquareClick = useCallback(
    (square: Square) => {
      if (!canMove) return;

      const piece = chessRef.current.get(square);

      if (selected && legalTargets.includes(square)) {
        // move to a highlighted legal square
        const from = selected;
        setSelected(null);
        submitMove(from, square);
        return;
      }

      if (piece && piece.color === myColor) {
        // select (or re-select) one of my own pieces
        setSelected((prev) => (prev === square ? null : square));
        return;
      }

      // clicked an empty / illegal / opponent square with nothing selected — clear
      setSelected(null);
    },
    [canMove, selected, legalTargets, myColor, submitMove]
  );

  const customSquareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (selected) {
      styles[selected] = { backgroundColor: "rgba(255, 215, 0, 0.4)" }; // gold highlight on the selected piece
    }
    for (const sq of legalTargets) {
      styles[sq] = {
        background: "radial-gradient(circle, rgba(220,38,38,0.7) 25%, transparent 26%)",
      }; // red dot on legal destinations
    }
    return styles;
  }, [selected, legalTargets]);

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <GameNav />
      <h1 className="text-xl font-bold">Chess</h1>
      <p className="text-sm text-gray-500">{status}</p>
      {myColor && <p className="text-xs text-gray-400">شما: {myColor === "w" ? "سفید" : "سیاه"}</p>}

      <div className="w-full max-w-[480px]">
        <Chessboard
          position={fen}
          onSquareClick={onSquareClick}
          customSquareStyles={customSquareStyles}
          boardOrientation={myColor === "b" ? "black" : "white"}
          arePiecesDraggable={false}
        />
      </div>
    </div>
  );
}
