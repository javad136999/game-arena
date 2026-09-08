// supabase/functions/poker-action/index.ts
//
// Deploy with:  supabase functions deploy poker-action
//
// Action:  { action: "act", match_id, type: "check"|"bet"|"call"|"fold" }
//
// Works for 2, 3, or 4 players (whatever the table was created for).
// All 7 cards (2 hole + 5 community) are dealt up front; there is one
// betting round (no raising once a bet is opened — everyone left just
// calls or folds), then a showdown among whoever hasn't folded.

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

// ---------------- deck / hand evaluation ----------------
const SUITS = ["S", "H", "D", "C"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
type Card = string;

function suitOf(c: Card) {
  return c[c.length - 1];
}
function rankValue(c: Card) {
  return RANKS.indexOf(c.slice(0, -1) as (typeof RANKS)[number]) + 2; // 2..14
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

type Eval = { category: number; tiebreak: number[] };

function evaluate5(cards: Card[]): Eval {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const distinct = new Set(values);
  let isStraight = false;
  let straightHigh = 0;
  if (distinct.size === 5) {
    if (values[0] - values[4] === 4) {
      isStraight = true;
      straightHigh = values[0];
    } else if (values.join(",") === "14,5,4,3,2") {
      isStraight = true;
      straightHigh = 5; // wheel: A-2-3-4-5, Ace plays low
    }
  }

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const groupCounts = groups.map((g) => g[1]);

  if (isStraight && isFlush) return { category: 8, tiebreak: [straightHigh] };
  if (groupCounts[0] === 4) return { category: 7, tiebreak: groups.map((g) => g[0]) };
  if (groupCounts[0] === 3 && groupCounts[1] === 2) return { category: 6, tiebreak: groups.map((g) => g[0]) };
  if (isFlush) return { category: 5, tiebreak: values };
  if (isStraight) return { category: 4, tiebreak: [straightHigh] };
  if (groupCounts[0] === 3) return { category: 3, tiebreak: groups.map((g) => g[0]) };
  if (groupCounts[0] === 2 && groupCounts[1] === 2) return { category: 2, tiebreak: groups.map((g) => g[0]) };
  if (groupCounts[0] === 2) return { category: 1, tiebreak: groups.map((g) => g[0]) };
  return { category: 0, tiebreak: values };
}

function compareEval(a: Eval, b: Eval): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations5(cards: Card[]): Card[][] {
  const result: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) result.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return result;
}

function bestOf7(cards7: Card[]): Eval {
  let best: Eval | null = null;
  for (const combo of combinations5(cards7)) {
    const ev = evaluate5(combo);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best!;
}

const CATEGORY_NAME = [
  "High Card",
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
];

// ---------------- handler ----------------
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
    const { action, match_id, type } = body;
    if (action !== "act" || !match_id || !type) {
      return json({ error: "action must be 'act', with match_id and type" }, 400);
    }
    if (!["check", "bet", "call", "fold"].includes(type)) {
      return json({ error: "type must be check, bet, call, or fold" }, 400);
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: match, error: matchErr } = await db
      .from("matches")
      .select("id, status, stake, game_type, max_players")
      .eq("id", match_id)
      .single();
    if (matchErr || !match) return json({ error: "Match not found" }, 404);
    if (match.game_type !== "poker") return json({ error: "Not a poker match" }, 400);
    if (match.status !== "active") return json({ error: "Waiting for the table to fill" }, 409);

    const { data: players, error: playersErr } = await db
      .from("match_players")
      .select("user_id, joined_at")
      .eq("match_id", match_id)
      .order("joined_at", { ascending: true });
    if (playersErr || !players || players.length < match.max_players) {
      return json({ error: "Waiting for the table to fill" }, 409);
    }
    const seats = players.map((p) => p.user_id as string).slice(0, match.max_players);
    if (!seats.includes(user.id)) return json({ error: "You are not in this match" }, 403);

    let { data: state } = await db.from("poker_games").select("*").eq("match_id", match_id).maybeSingle();

    // ---- First action: deal hole cards + community cards ----
    if (!state) {
      const deck = freshShuffledDeck();
      let cursor = 0;
      const handRows = seats.map((uid) => {
        const cards = deck.slice(cursor, cursor + 2);
        cursor += 2;
        return { match_id, user_id: uid, cards };
      });
      const community = deck.slice(cursor, cursor + 5);

      const { error: handsErr } = await db.from("poker_hands").insert(handRows);
      if (handsErr) return json({ error: handsErr.message }, 500);

      const inserted = await db
        .from("poker_games")
        .insert({
          match_id,
          community_cards: community,
          turn_order: seats,
          active_players: seats,
          to_act: seats,
          bet_state: "none",
          current_turn: seats[0],
        })
        .select("*")
        .single();
      if (inserted.error) return json({ error: inserted.error.message }, 500);
      state = inserted.data;
    }

    if (state.phase !== "betting") return json({ error: "Hand is already finished" }, 409);
    if (state.current_turn !== user.id) return json({ error: "Not your turn" }, 409);

    const active: string[] = state.active_players;
    const turnOrder: string[] = state.turn_order;
    let toAct: string[] = state.to_act;
    let betState: "none" | "opened" = state.bet_state;
    let bettor: string | null = state.bettor;

    const nextInOrder = (from: string[], exclude: string) =>
      turnOrder.filter((u) => from.includes(u) && u !== exclude);

    // ---- FOLD ----
    if (type === "fold") {
      const newActive = active.filter((u) => u !== user.id);
      toAct = toAct.filter((u) => u !== user.id);

      if (newActive.length === 1) {
        // everyone else folded: sole remaining player wins without a showdown
        const winner = newActive[0];
        await settleAndFinish(db, match_id, match.stake, [winner], "fold", null);
        const { data: updated } = await db.from("poker_games").select("*").eq("match_id", match_id).single();
        return json(updated);
      }

      const { data: updated, error } = await db
        .from("poker_games")
        .update({
          active_players: newActive,
          to_act: toAct,
          current_turn: toAct[0] ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);

      if (toAct.length === 0) {
        return json(await resolveShowdown(db, match_id, match.stake, newActive));
      }
      return json(updated);
    }

    // ---- CHECK ----
    if (type === "check") {
      if (betState !== "none") return json({ error: "You can't check — there's a bet to respond to" }, 400);
      toAct = toAct.filter((u) => u !== user.id);

      if (toAct.length === 0) {
        return json(await resolveShowdown(db, match_id, match.stake, active));
      }
      const { data: updated, error } = await db
        .from("poker_games")
        .update({ to_act: toAct, current_turn: toAct[0], updated_at: new Date().toISOString() })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(updated);
    }

    // ---- BET ----
    if (type === "bet") {
      if (betState !== "none") return json({ error: "There's already a bet — call or fold" }, 400);
      const newToAct = nextInOrder(active, user.id);
      const { data: updated, error } = await db
        .from("poker_games")
        .update({
          bet_state: "opened",
          bettor: user.id,
          to_act: newToAct,
          current_turn: newToAct[0],
          updated_at: new Date().toISOString(),
        })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(updated);
    }

    // ---- CALL ----
    if (type === "call") {
      if (betState !== "opened") return json({ error: "There's no bet to call" }, 400);
      toAct = toAct.filter((u) => u !== user.id);

      if (toAct.length === 0) {
        return json(await resolveShowdown(db, match_id, match.stake, active));
      }
      const { data: updated, error } = await db
        .from("poker_games")
        .update({ to_act: toAct, current_turn: toAct[0], updated_at: new Date().toISOString() })
        .eq("match_id", match_id)
        .select("*")
        .single();
      if (error) return json({ error: error.message }, 500);
      return json(updated);
    }

    return json({ error: "Unhandled action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }

  // ---------------- helpers that need db/match in scope ----------------
  async function resolveShowdown(db: any, matchId: string, stake: number, activePlayers: string[]) {
    const { data: gameRow } = await db.from("poker_games").select("community_cards").eq("match_id", matchId).single();
    const community: Card[] = gameRow.community_cards;

    const { data: handRows } = await db.from("poker_hands").select("user_id, cards").eq("match_id", matchId);
    const evals = (handRows as { user_id: string; cards: Card[] }[])
      .filter((h) => activePlayers.includes(h.user_id))
      .map((h) => ({ user_id: h.user_id, eval: bestOf7([...h.cards, ...community]) }));

    let best = evals[0].eval;
    for (const e of evals) if (compareEval(e.eval, best) > 0) best = e.eval;
    const winners = evals.filter((e) => compareEval(e.eval, best) === 0).map((e) => e.user_id);

    await settleAndFinish(db, matchId, stake, winners, "showdown", CATEGORY_NAME[best.category]);
    const { data: updated } = await db.from("poker_games").select("*").eq("match_id", matchId).single();
    return updated;
  }

  async function settleAndFinish(
    db: any,
    matchId: string,
    stake: number,
    winners: string[],
    reason: "fold" | "showdown",
    handName: string | null
  ) {
    await db
      .from("poker_games")
      .update({ phase: "finished", current_turn: null, result: { winners, reason, hand: handName }, updated_at: new Date().toISOString() })
      .eq("match_id", matchId);

    await db.from("matches").update({ status: "finished", result: { winners, reason } }).eq("id", matchId);

    if (stake > 0 && winners.length > 0) {
      const share = stake / winners.length;
      for (const uid of winners) {
        const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", uid).single();
        await db
          .from("wallets")
          .update({ balance: (wallet?.balance ?? 0) + share, updated_at: new Date().toISOString() })
          .eq("user_id", uid);
        await db.from("transactions").insert({
          user_id: uid,
          type: "game_win",
          amount: share,
          meta: { match_id: matchId, game_type: "poker", reason },
        });
      }
    }
  }
});
