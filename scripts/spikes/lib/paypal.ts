import { Client, Environment, LogLevel } from "@paypal/paypal-server-sdk";
import { requireEnv } from "./env.js";

export const PAYPAL_API = "https://api-m.sandbox.paypal.com";

export function paypalClient() {
  const env = requireEnv("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET");
  return new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: env.PAYPAL_CLIENT_ID,
      oAuthClientSecret: env.PAYPAL_CLIENT_SECRET,
    },
    environment: Environment.Sandbox, // sandbox only
    timeout: 30_000,
    logging: { logLevel: LogLevel.Warn },
  });
}
