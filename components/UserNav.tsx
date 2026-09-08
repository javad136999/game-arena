"use client";

// components/UserNav.tsx
// Drop-in replacement for the static "Log in" link in app/layout.tsx.
// Shows the user's email + a Log out button when signed in, or a Log in
// link when signed out. Updates automatically on sign-in/sign-out.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

export default function UserNav() {
  const [email, setEmail] = useState<string | null | undefined>(undefined); // undefined = loading
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const logOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  if (email === undefined) return null; // avoid a flash of "Log in" while loading
  if (email === null) {
    return (
      <Link href="/login" className="hover:text-gold">
        Log in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-text-3 text-xs">{email}</span>
      <button onClick={logOut} className="hover:text-gold">
        Log out
      </button>
    </div>
  );
}
