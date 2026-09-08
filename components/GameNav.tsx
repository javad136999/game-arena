// components/GameNav.tsx
// Drop this near the top of every game page (right under the <h1>) so a
// player who's stuck waiting for opponents, or done with a finished game,
// always has a way back — instead of only the browser's back button.

import Link from "next/link";

export default function GameNav() {
  return (
    <Link href="/" className="text-xs text-text-3 hover:text-gold self-start">
      ← بازگشت به خانه
    </Link>
  );
}
