"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type Tx = {
  id: string;
  type: string;
  amount: number;
  created_at: string;
};

export default function WalletPage() {
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setLoggedIn(false);
      return;
    }
    setLoggedIn(true);

    const { data: wallet } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", userData.user.id)
      .single();
    setBalance(wallet?.balance ?? 0);

    const { data: transactions } = await supabase
      .from("transactions")
      .select("id, type, amount, created_at")
      .eq("user_id", userData.user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    setTxs(transactions ?? []);
  }

  if (!loggedIn) {
    return <p className="text-sm text-text-2">Log in to see your wallet.</p>;
  }

  return (
    <div>
      <div className="rounded-2xl border border-gold-dim bg-surface-alt p-5 mb-6">
        <p className="text-xs text-text-2 mb-1">Available balance</p>
        <p className="font-display text-3xl font-semibold text-gold">
          {balance !== null ? balance.toLocaleString() : "…"}
        </p>
        <div className="flex gap-2 mt-4">
          <button className="flex-1 bg-gold text-[#231A08] font-semibold rounded-lg py-2 text-sm">
            Add funds
          </button>
          <button className="flex-1 border border-white/10 rounded-lg py-2 text-sm">
            Cash out
          </button>
        </div>
        <p className="text-[11px] text-text-3 mt-3">
          Deposit and cash-out are not wired to a real payment provider yet — see README for the
          payment gateway vs. crypto decision this depends on.
        </p>
      </div>

      <p className="text-sm font-semibold mb-3">Recent activity</p>
      <div className="divide-y divide-white/5">
        {txs.length === 0 && <p className="text-xs text-text-3">No transactions yet.</p>}
        {txs.map((t) => (
          <div key={t.id} className="flex justify-between py-3 text-sm">
            <div>
              <p>{t.type.replace("_", " ")}</p>
              <p className="text-[11px] text-text-3">{new Date(t.created_at).toLocaleString()}</p>
            </div>
            <p className={t.amount >= 0 ? "text-green" : "text-text-1"}>
              {t.amount >= 0 ? "+" : ""}
              {t.amount.toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
