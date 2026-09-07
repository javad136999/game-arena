"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError("Enter an email and password.");
      return;
    }
    setLoading(true);
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    router.push("/");
  }

  return (
    <div className="max-w-sm mx-auto">
      <h1 className="font-display text-xl font-semibold mb-6">
        {mode === "signin" ? "Log in" : "Create account"}
      </h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="bg-surface border border-white/10 rounded-lg px-3 py-2 text-sm"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="bg-surface border border-white/10 rounded-lg px-3 py-2 text-sm"
        />
        {error && <p className="text-xs text-coral">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="bg-gold text-[#231A08] font-semibold rounded-lg px-3 py-2 text-sm"
        >
          {loading ? "Please wait…" : mode === "signin" ? "Log in" : "Sign up"}
        </button>
      </form>
      <button
        className="text-xs text-text-2 mt-4"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Log in"}
      </button>
    </div>
  );
}
