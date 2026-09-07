import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Game Arena",
  description: "Multiplayer board and card games with a shared wallet."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg text-text-1 min-h-screen font-sans">
        <header className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <Link href="/" className="font-display text-lg font-semibold text-gold">
            Arena
          </Link>
          <nav className="flex gap-5 text-sm text-text-2">
            <Link href="/">Home</Link>
            <Link href="/games/rps">Play RPS</Link>
            <Link href="/wallet">Wallet</Link>
            <Link href="/profile">Profile</Link>
            <Link href="/login">Log in</Link>
          </nav>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
