"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the server page every few seconds, for a bounded time, while it waits on something
// external (here: PayPal's webhook for a fresh capture).
export function AutoRefresh({ everyMs = 3000, forMs = 120_000 }: { everyMs?: number; forMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > forMs) clearInterval(timer);
      else router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs, forMs]);
  return null;
}
