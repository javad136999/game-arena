import Link from "next/link";
const games = [
  { slug: "rps", name: "Rock, paper, scissors", players: "Best of 5", ready: true },
  { slug: "chess", name: "Chess", players: "1v1 ranked", ready: true },
  { slug: "poker", name: "Poker", players: "2-4 players", ready: true },
  { slug: "hokm", name: "Hokm", players: "4 players", ready: true },
  { slug: "shelem", name: "Shelem", players: "4 players", ready: true },
  { slug: "ludo", name: "Ludo", players: "2-4 players", ready: true },
  { slug: "snake_ladder", name: "Snakes & ladders", players: "2-4 players", ready: true }
];
export default function HomePage() {
  return (
    <div>
      <div className="rounded-2xl border border-white/5 bg-surface-alt p-5 mb-8">
        <p className="text-xs text-gold font-semibold mb-1">Game Arena</p>
        <h1 className="font-display text-xl font-semibold mb-2">Seven games, all wired up to real Supabase Auth and realtime</h1>
        <p className="text-sm text-text-2 leading-relaxed">
          Every game below uses live matchmaking, a Postgres-backed match table, and server-side
          logic that resolves moves so no player can see hidden information (an opponent&apos;s
          move, hand, or dice roll) before it&apos;s revealed. Wallet payouts are wired to a fixed
          per-match stake — real-money deposits/withdrawals are intentionally not connected yet.
        </p>
      </div>
      <p className="text-sm font-semibold mb-3">Games</p>
      <div className="grid grid-cols-2 gap-3">
        {games.map((g) => (
          <Link
            key={g.slug}
            href={g.ready ? `/games/${g.slug}` : "#"}
            className={`rounded-xl border border-white/5 bg-surface p-4 ${
              g.ready ? "hover:border-gold-dim" : "opacity-50 cursor-not-allowed"
            }`}
          >
            <p className="text-sm font-semibold mb-1">{g.name}</p>
            <p className="text-xs text-text-3">{g.players}</p>
            {!g.ready && <p className="text-[10px] text-coral mt-2">Schema ready, UI not built yet</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
