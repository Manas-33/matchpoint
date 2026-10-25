// All money in Matchpoint is integer cents. These helpers are the only place amounts cross
// into or out of other representations (Channel3 floats, PayPal decimal strings, display text).

export type Cents = number;

// Channel3 prices are floats such as 279.00000000000006.
export function dollarsToCents(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new Error(`Not a finite amount: ${amount}`);
  return Math.round(amount * 100);
}

// PayPal amounts are decimal strings ("120.00"); parse them without going through a float.
export function paypalValueToCents(value: string): Cents {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Not a PayPal amount: ${value}`);
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return sign ? -cents : cents;
}

export function centsToPaypalValue(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatCents(cents: Cents, currency = "USD"): string {
  assertCents(cents);
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

// Basis points: 1500 bps = 15%. Rounds to the nearest cent.
export function applyBps(cents: Cents, bps: number): Cents {
  assertCents(cents);
  return Math.round((cents * bps) / 10_000);
}

export function assertCents(cents: Cents): void {
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount must be integer cents, got ${cents}`);
}
