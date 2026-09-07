// supabase/functions/hokm-action/index.ts
//
// Deploy with:  supabase functions deploy hokm-action
//
// Handles both hokm actions from the client:
//   { action: "choose_trump", match_id, trump: "S"|"H"|"D"|"C" }
//   { action: "play_card",    match_id, card: "AS" }
//
// Same role as submit_move (RPS) / chess-move (chess): this is the ONLY
// thing allowed to write hokm_games / hokm_hands / settle the stake. The
// client never has direct insert/update access to any of those tables.
//
// On the first call for a match (always choose_trump, made by the hakem),
// this function also does the deal: shuffles a 52-card deck, assigns
// 13 cards to each of the 4 players, and assigns teams by seat order
// (seat 0 & 2 = team A, seat 1 & 3 = team B — seats are join order from
// match_players, same convention chess uses for white/black).

import { createClient } from "npm:@supabase/supabase-js@2";

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

const SUITS = ["S", "H", "D", "C"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;

type Card = string; // e.g. "AS", "TH"
type Suit = (typeof SUITS)[number];

function suitOf(card: Card): Suit {
  return card[card.length - 1] as Suit;
}
function rankValue(card: Card): number {
  return RANKS.indexOf(card.slice(0, -1) as (typeof RANKS)[number]);
}

function freshShuffledDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
    } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated" }, 401);

    const body = await req.json();
    const { action, match_id } = body;
    if (!action || !match_id) return json({ error: "action and match_id are required" }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: match, error: matchErr } = await db
      .from("matches")
      .select("id, status, stake, game_type")
      .eq("id", match_id)
      .single();

    if (matchErr || !match) return json({ error: "Match not found" }, 404);
    if (match.game_type !== "hokm") return json({ error: "Not a hokm match" }, 400);
    if (match.status !== "active") return json({ error: "Waiting for all 4 players" }, 409);

    const { data: players, error: playersErr } = await db
      .from("match_players")
      .select("user_id, joined_at")
      .eq("match_id", match_id)
      .order("joined_at", { ascending: true });

    if (playersErr || !players || players.length < 4) {
      return json({ error: "Waiting for all 4 players" }, 409);
    }
    const seats = players.map((p) => p.user_id as string);
    if (!seats.includes(user.id)) return json({ error: "You are not in this match" }, 403);

    let { data: state } = await db
      .from("hokm_games")
      .select("*")
      .eq("match_id", match_id)
      .maybeSingle();

    // ---- First action for this match: deal the cards ----
    if (!state) {
      const hakem = seats[0];
      const teams = { A: [seats[0], seats[2]], B: [seats[1], seats[3]] };
      const deck = freshShuffledDeck();
      const hands: Record<string, Card[]> = {};
      seats.forEach((uid, i) => {
        hands[uid] = deck.slice(i * 13, i * 13 + 13);
      });

      const handRows = seats.map((uid) => ({ match_id, user_id: uid, cards: hands[uid] }));
      const { error: handsErr } = await db.from("hokm_hands").insert(handRows);
      if (handsErr) return json({ error: handsErr.message }, 500);

      const inserted = await db
        .from("hokm_games")
        .insert({
          match_id,
          phase: "bidding",
          teams,
          turn_order: seats,
          hakem,
          current_turn: hakem,
        })
        .select("*")
        .single();
      if (inserted.error) return json({ error: inserted.error.message }, 500);
      state = inserted.data;
    }

    // ============================================================
    // ACTION: choose_trump
    // ============================================================
    if (action === "choose_trump") {
      const { trump } = body;
      if (!SUITS.includes(trump)) return json({ error: "Invalid trump suit" }, 400);
      if (state.phase !== "bidding") return json({ error: "Trump already chosen" }, 409);
      if (state.hakem !== user.id) return json({ error: "Only the hakem chooses trump" }, 403);

      const { data: updated, error } = await db
        .from("hokm_games")
        .update({
          phase: "playing",
          trump,
          current_turn: state.hakem, // hakem leads the first trick
          current_trick: [],
          lead_suit: null,
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();

      if (error) return json({ error: error.message }, 500);
      return json(updated);
    }

    // ============================================================
    // ACTION: play_card
    // ============================================================
    if (action === "play_card") {
      const { card } = body;
      if (state.phase !== "playing") return json({ error: "Not in the playing phase" }, 409);
      if (state.current_turn !== user.id) return json({ error: "Not your turn" }, 409);

      const { data: handRow, error: handErr } = await db
        .from("hokm_hands")
        .select("cards")
        .eq("match_id", match_id)
        .eq("user_id", user.id)
        .single();
      if (handErr || !handRow) return json({ error: "Hand not found" }, 500);

      const hand: Card[] = handRow.cards;
      if (!hand.includes(card)) return json({ error: "That card is not in your hand" }, 400);

      const trick: { user_id: string; card: Card }[] = state.current_trick ?? [];
      let leadSuit: Suit | null = state.lead_suit;

      if (trick.length === 0) {
        leadSuit = suitOf(card);
      } else if (suitOf(card) !== leadSuit) {
        const hasLeadSuit = hand.some((c) => suitOf(c) === leadSuit);
        if (hasLeadSuit) {
          return json({ error: `You must follow suit (${leadSuit})` }, 400);
        }
      }

      // Remove the card from the player's hand.
      const newHand = hand.filter((c) => c !== card);
      const { error: updHandErr } = await db
        .from("hokm_hands")
        .update({ cards: newHand, updated_at: new Date().toISOString() })
        .eq("match_id", match_id)
        .eq("user_id", user.id);
      if (updHandErr) return json({ error: updHandErr.message }, 500);

      const newTrick = [...trick, { user_id: user.id, card }];

      // ---- Trick still in progress: just advance the turn ----
      if (newTrick.length < 4) {
        const turnOrder: string[] = state.turn_order;
        const nextIdx = (turnOrder.indexOf(user.id) + 1) % turnOrder.length;
        const { data: updated, error } = await db
          .from("hokm_games")
          .update({
            current_trick: newTrick,
            lead_suit: leadSuit,
            current_turn: turnOrder[nextIdx],
            updated_at: new Date().toISOString(),
          })
          .eq("match_id", match_id)
          .select("*")
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(updated);
      }

      // ---- Trick complete: resolve the winner ----
      const trump: Suit = state.trump;
      const trumpPlays = newTrick.filter((p) => suitOf(p.card) === trump);
      const contenders = trumpPlays.length > 0 ? trumpPlays : newTrick.filter((p) => suitOf(p.card) === leadSuit);
      const trickWinner = contenders.reduce((best, p) => (rankValue(p.card) > rankValue(best.card) ? p : best));

      const teams: { A: string[]; B: string[] } = state.teams;
      const winnerTeam: "A" | "B" = teams.A.includes(trickWinner.user_id) ? "A" : "B";
      const tricksWon = { ...state.tricks_won };
      tricksWon[winnerTeam] = (tricksWon[winnerTeam] ?? 0) + 1;

      const handFinished = tricksWon.A >= 7 || tricksWon.B >= 7;
      const winningTeam: "A" | "B" | null = handFinished ? (tricksWon.A >= 7 ? "A" : "B") : null;

      const { data: updated, error } = await db
        .from("hokm_games")
        .update({
          current_trick: [],
          lead_suit: null,
          current_turn: trickWinner.user_id,
          tricks_won: tricksWon,
          phase: handFinished ? "finished" : "playing",
          result: handFinished ? { winner: winningTeam } : null,
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);

      if (handFinished) {
        await db
          .from("matches")
          .update({ status: "finished", result: { winner_team: winningTeam, tricks_won: tricksWon } })
          .eq("id", match_id);

        if (match.stake > 0 && winningTeam) {
          for (const uid of teams[winningTeam]) {
            const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", uid).single();
            await db
              .from("wallets")
              .update({ balance: (wallet?.balance ?? 0) + match.stake, updated_at: new Date().toISOString() })
              .eq("user_id", uid);
            await db.from("transactions").insert({
              user_id: uid,
              type: "game_win",
              amount: match.stake,
              meta: { match_id, game_type: "hokm", team: winningTeam },
            });
          }
        }
      }

      return json(updated);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
