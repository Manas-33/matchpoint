import { Channel3, Channel3Error } from "@channel3/sdk";
import { requireEnv } from "./env.js";

export function channel3Client() {
  const { CHANNEL3_API_KEY } = requireEnv("CHANNEL3_API_KEY");
  return new Channel3({ apiKey: CHANNEL3_API_KEY, country: "US", currency: "USD" });
}

export function reportChannel3Error(err: unknown): never {
  if (err instanceof Channel3Error) {
    console.error(`Channel3 error ${err.statusCode}: ${err.message}`, err.body ?? "");
  } else {
    console.error(err);
  }
  process.exit(1);
}
