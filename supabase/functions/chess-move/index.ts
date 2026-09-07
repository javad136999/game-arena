// supabase/functions/chess-move/index.ts
//
// Deploy with:  supabase functions deploy chess-move
// Call from the client with the user's session access token in the
// Authorization header — see app/games/chess/page.tsx for the call site.
//
// Why an Edge Function instead of a plpgsql RPC (like submit_move for RPS):
// chess legality (checks, pins, castling rights, en passant, checkmate
// detection...) is impractical to hand-write correctly in SQL. This function
// does the same job submit_move() does for RPS — it is the only thing
// allowed to write to chess_games / settle the stake — it just uses a real
// chess engine (chess.js) to decide whether a move is legal instead of a
// switch statement.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Chess } from "npm:chess.js@1.0.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    // Client the caller actually is, scoped to their JWT — used only to
    // confirm who they are, never to write chess_games/wallets.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await callerClient.auth.getUser();

    if (!user) return json({ error: "Not authenticated" }, 401);

    const { match_id, from, to, promotion } = await req.json();
    if (!match_id || !from || !to) {
      return json({ error: "match_id, from and to are required" }, 400);
    }

    // Service-role client — the only client allowed to write these tables.
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: match, error: matchErr } = await db
      .from("matches")
      .select("id, status, stake, game_type")
      .eq("id", match_id)
      .single();

    if (matchErr || !match) return json({ error: "Match not found" }, 404);
    if (match.game_type !== "chess") return json({ error: "Not a chess match" }, 400);
    if (match.status !== "active") return json({ error: "Match is not active" }, 409);

    const { data: players, error: playersErr } = await db
      .from("match_players")
      .select("user_id, joined_at")
      .eq("match_id", match_id)
      .order("joined_at", { ascending: true });

    if (playersErr || !players || players.length < 2) {
      return json({ error: "Waiting for an opponent" }, 409);
    }

    const isPlayer = players.some((p) => p.user_id === user.id);
    if (!isPlayer) return json({ error: "You are not in this match" }, 403);

    // First joiner plays white, second plays black — same "join order"
    // convention find_or_create_match already uses for player[1]/player[2].
    const myColor: "w" | "b" = players[0].user_id === user.id ? "w" : "b";

    // Ensure the state row exists (first move of the match creates it).
    let { data: state } = await db
      .from("chess_games")
      .select("fen, pgn, turn")
      .eq("match_id", match_id)
      .maybeSingle();

    if (!state) {
      const inserted = await db
        .from("chess_games")
        .insert({ match_id })
        .select("fen, pgn, turn")
        .single();
      if (inserted.error) return json({ error: inserted.error.message }, 500);
      state = inserted.data;
    }

    if (state.turn !== myColor) {
      return json({ error: "Not your turn" }, 409);
    }

    const chess = new Chess(state.fen);

    let moveResult;
    try {
      moveResult = chess.move({ from, to, promotion: promotion ?? "q" });
    } catch {
      moveResult = null;
    }

    if (!moveResult) return json({ error: "Illegal move" }, 400);

    const newFen = chess.fen();
    const newPgn = chess.pgn();
    const newTurn = chess.turn(); // whose turn it is NOW, after this move

    const { error: updateErr } = await db
      .from("chess_games")
      .update({ fen: newFen, pgn: newPgn, turn: newTurn, updated_at: new Date().toISOString() })
      .eq("match_id", match_id);

    if (updateErr) return json({ error: updateErr.message }, 500);

    let gameOver = false;
    let winnerId: string | null = null;
    let reason: string | null = null;

    if (chess.isGameOver()) {
      gameOver = true;
      if (chess.isCheckmate()) {
        // The player who just moved (myColor) delivered checkmate and wins.
        winnerId = user.id;
        reason = "checkmate";
      } else if (chess.isStalemate()) {
        reason = "stalemate";
      } else if (chess.isThreefoldRepetition()) {
        reason = "threefold_repetition";
      } else if (chess.isInsufficientMaterial()) {
        reason = "insufficient_material";
      } else {
        reason = "draw";
      }

      await db
        .from("matches")
        .update({
          status: "finished",
          result: { winner: winnerId, draw: winnerId === null, reason },
        })
        .eq("id", match_id);

      if (winnerId && match.stake > 0) {
        const { data: wallet } = await db
          .from("wallets")
          .select("balance")
          .eq("user_id", winnerId)
          .single();

        await db
          .from("wallets")
          .update({ balance: (wallet?.balance ?? 0) + match.stake, updated_at: new Date().toISOString() })
          .eq("user_id", winnerId);

        await db.from("transactions").insert({
          user_id: winnerId,
          type: "game_win",
          amount: match.stake,
          meta: { match_id, game_type: "chess", reason },
        });
      }
    }

    return json({
      fen: newFen,
      pgn: newPgn,
      turn: newTurn,
      lastMove: { from, to, san: moveResult.san },
      gameOver,
      winner: winnerId,
      reason,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
