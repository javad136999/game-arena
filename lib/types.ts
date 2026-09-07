export type Profile = {
  id: string;
  username: string;
  created_at: string;
};

export type Wallet = {
  user_id: string;
  balance: number;
  updated_at: string;
};

export type MatchStatus = "waiting" | "active" | "finished";

export type Match = {
  id: string;
  game_type: "rps" | "chess" | "poker" | "ludo" | "snake_ladder" | "hokm" | "shelem";
  status: MatchStatus;
  stake: number;
  result: Record<string, unknown> | null;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  match_id: string;
  user_id: string;
  body: string;
  created_at: string;
};
