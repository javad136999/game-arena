// supabase/functions/shelem-action/index.ts
//
// Deploy with:  supabase functions deploy shelem-action
//
// Actions:
//   { action: "place_bid",    match_id, bid: number|null }  // null = pass
//   { action: "choose_trump", match_id, trump: "S"|"H"|"D"|"C" }
//   { action: "play_card",    match_id, card: "AS" }
//
// Same trick-taking engine as hokm-action, plus a bidding phase up front.
// Win condition differs from hokm: all 13 tricks are always played, then
// the bid winner's team must have taken at least `highest_bid` tricks to
// win the hand — otherwise the other team wins even though they may have
// taken fewer tricks overall.

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
type Card = string;
type Suit = (typeof SUITS)[number];
function suitOf(c: Card): Suit {
  return c[c.length - 1] as Suit;
}
function rankValue(c: Card): number {
  return RANKS.indexOf(c.slice(0, -1) as (typeof RANKS)[number]);
}
function freshShuffledDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
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
    if (match.game_type !== "shelem") return json({ error: "Not a shelem match" }, 400);
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

    let { data: state } = await db.from("shelem_games").select("*").eq("match_id", match_id).maybeSingle();

    // ---- First action for this match: deal + start bidding ----
    if (!state) {
      const teams = { A: [seats[0], seats[2]], B: [seats[1], seats[3]] };
      const deck = freshShuffledDeck();
      const hands: Record<string, Card[]> = {};
      seats.forEach((uid, i) => {
        hands[uid] = deck.slice(i * 13, i * 13 + 13);
      });
      const handRows = seats.map((uid) => ({ match_id, user_id: uid, cards: hands[uid] }));
      const { error: handsErr } = await db.from("shelem_hands").insert(handRows);
      if (handsErr) return json({ error: handsErr.message }, 500);

      const inserted = await db
        .from("shelem_games")
        .insert({
          match_id,
          phase: "bidding",
          teams,
          turn_order: seats,
          bids: {},
          current_turn: seats[0],
        })
        .select("*")
        .single();
      if (inserted.error) return json({ error: inserted.error.message }, 500);
      state = inserted.data;
    }

    // ============================================================
    // ACTION: place_bid
    // ============================================================
    if (action === "place_bid") {
      const { bid } = body; // number 7-13, or null for pass
      if (state.phase !== "bidding") return json({ error: "Bidding is over" }, 409);
      if (state.current_turn !== user.id) return json({ error: "Not your turn to bid" }, 409);
      if (bid !== null) {
        if (typeof bid !== "number" || bid < 7 || bid > 13) {
          return json({ error: "Bid must be between 7 and 13" }, 400);
        }
        if (state.highest_bid !== null && bid <= (state.highest_bid ?? 0)) {
          return json({ error: `Bid must beat the current highest (${state.highest_bid})` }, 400);
        }
      }

      const bids = { ...state.bids, [user.id]: bid };
      const highestBid = bid !== null && (state.highest_bid === null || bid > state.highest_bid) ? bid : state.highest_bid;
      const bidWinner = bid !== null && highestBid === bid ? user.id : state.bid_winner;

      const turnOrder: string[] = state.turn_order;
      const bidsPlaced = Object.keys(bids).length;

      if (bidsPlaced < 4) {
        const nextIdx = (turnOrder.indexOf(user.id) + 1) % turnOrder.length;
        const { data: updated, error } = await db
          .from("shelem_games")
          .update({
            bids,
            highest_bid: highestBid,
            bid_winner: bidWinner,
            current_turn: turnOrder[nextIdx],
            updated_at: new Date().toISOString(),
          })
          .eq("match_id", match_id)
          .select("*")
          .single();
        if (error) return json({ error: error.message }, 500);
        return json(updated);
      }

      // All 4 have bid. If everyone passed, default: first seat, bid 7.
      const finalWinner = bidWinner ?? turnOrder[0];
      const finalBid = highestBid ?? 7;

      const { data: updated, error } = await db
        .from("shelem_games")
        .update({
          bids,
          highest_bid: finalBid,
          bid_winner: finalWinner,
          phase: "choosing_trump",
          current_turn: finalWinner,
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(updated);
    }

    // ============================================================
    // ACTION: choose_trump
    // ============================================================
    if (action === "choose_trump") {
      const { trump } = body;
      if (!SUITS.includes(trump)) return json({ error: "Invalid trump suit" }, 400);
      if (state.phase !== "choosing_trump") return json({ error: "Not the trump-choosing phase" }, 409);
      if (state.bid_winner !== user.id) return json({ error: "Only the bid winner chooses trump" }, 403);

      const { data: updated, error } = await db
        .from("shelem_games")
        .update({
          phase: "playing",
          trump,
          current_turn: state.bid_winner,
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
        .from("shelem_hands")
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
        if (hasLeadSuit) return json({ error: `You must follow suit (${leadSuit})` }, 400);
      }

      const newHand = hand.filter((c) => c !== card);
      const { error: updHandErr } = await db
        .from("shelem_hands")
        .update({ cards: newHand, updated_at: new Date().toISOString() })
        .eq("match_id", match_id)
        .eq("user_id", user.id);
      if (updHandErr) return json({ error: updHandErr.message }, 500);

      const newTrick = [...trick, { user_id: user.id, card }];

      if (newTrick.length < 4) {
        const turnOrder: string[] = state.turn_order;
        const nextIdx = (turnOrder.indexOf(user.id) + 1) % turnOrder.length;
        const { data: updated, error } = await db
          .from("shelem_games")
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

      // ---- Trick complete: resolve winner ----
      const trump: Suit = state.trump;
      const trumpPlays = newTrick.filter((p) => suitOf(p.card) === trump);
      const contenders = trumpPlays.length > 0 ? trumpPlays : newTrick.filter((p) => suitOf(p.card) === leadSuit);
      const trickWinner = contenders.reduce((best, p) => (rankValue(p.card) > rankValue(best.card) ? p : best));

      const teams: { A: string[]; B: string[] } = state.teams;
      const winnerTeam: "A" | "B" = teams.A.includes(trickWinner.user_id) ? "A" : "B";
      const tricksWon = { ...state.tricks_won };
      tricksWon[winnerTeam] = (tricksWon[winnerTeam] ?? 0) + 1;

      const totalPlayed = tricksWon.A + tricksWon.B;
      const allTricksPlayed = totalPlayed >= 13;

      let result = null;
      let phase: "playing" | "finished" = "playing";
      let winningTeam: "A" | "B" | null = null;

      if (allTricksPlayed) {
        const bidWinnerTeam: "A" | "B" = teams.A.includes(state.bid_winner) ? "A" : "B";
        const madeContract = tricksWon[bidWinnerTeam] >= state.highest_bid;
        winningTeam = madeContract ? bidWinnerTeam : (bidWinnerTeam === "A" ? "B" : "A");
        result = { winner: winningTeam, bid: state.highest_bid, made: madeContract };
        phase = "finished";
      }

      const { data: updated, error } = await db
        .from("shelem_games")
        .update({
          current_trick: [],
          lead_suit: null,
          current_turn: allTricksPlayed ? null : trickWinner.user_id,
          tricks_won: tricksWon,
          phase,
          result,
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);

      if (allTricksPlayed) {
        await db
          .from("matches")
          .update({ status: "finished", result: { winner_team: winningTeam, tricks_won: tricksWon, bid: state.highest_bid } })
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
              meta: { match_id, game_type: "shelem", team: winningTeam },
            });
          }
        }
      }

      // Not the end of the hand yet: still need to advance turn to trickWinner if not already set above
      if (!allTricksPlayed) {
        // (current_turn already set to trickWinner.user_id above)
      }

      return json(updated);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
