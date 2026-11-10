// The demo shop's identity: shown on every page and as the brand name in the PayPal checkout.
// No server imports, so client components can use it too.
export const SHOP = {
  name: "Larkspur & Co.",
  tagline: "An independent shop for gear that lasts",
  city: "Portland, OR",
} as const;
