"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function ProfilePage() {
  const [username, setUsername] = useState<string | null>(null);
  const [played, setPlayed] = useState(0);
  const [won, setWon] = useState(0);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return;

    const { data: profile } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", userData.user.id)
      .single();
    setUsername(profile?.username ?? userData.user.email ?? "Player");

    const { data: matches } = await supabase
      .from("matches")
      .select("id, result")
      .eq("status", "finished");
    // In a real build, filter server-side by a match_players join for this user.
    setPlayed(matches?.length ?? 0);
    setWon(
      matches?.filter((m) => (m.result as { winner?: string })?.winner === userData.user!.id)
        .length ?? 0
    );
  }

  const winRate = played > 0 ? Math.round((won / played) * 100) : 0;

  return (
    <div>
      <div className="flex flex-col items-center mb-8">
        <div className="w-16 h-16 rounded-full bg-surface-alt border-2 border-gold-dim flex items-center justify-center font-display text-xl text-gold mb-2">
          {(username ?? "P").slice(0, 2).toUpperCase()}
        </div>
        <p className="font-display text-lg font-semibold">{username ?? "…"}</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-surface border border-white/5 rounded-xl p-3 text-center">
          <p className="font-display text-lg font-semibold">{played}</p>
          <p className="text-[10px] text-text-3">Games played</p>
        </div>
        <div className="bg-surface border border-white/5 rounded-xl p-3 text-center">
          <p className="font-display text-lg font-semibold">{winRate}%</p>
          <p className="text-[10px] text-text-3">Win rate</p>
        </div>
        <div className="bg-surface border border-white/5 rounded-xl p-3 text-center">
          <p className="font-display text-lg font-semibold">{won}</p>
          <p className="text-[10px] text-text-3">Wins</p>
        </div>
      </div>
    </div>
  );
}
