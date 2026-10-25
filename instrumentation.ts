// Runs once when the Next.js server starts: fail fast on a bad environment and say which mode is on.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("./lib/env");
  const env = getEnv();
  console.log(
    env.DEMO_MODE
      ? "Matchpoint: DEMO mode (Channel3, PayPal and Claude answered from fixtures/, email logged)"
      : "Matchpoint: LIVE mode (PayPal sandbox, Channel3 and Anthropic APIs)",
  );
}
