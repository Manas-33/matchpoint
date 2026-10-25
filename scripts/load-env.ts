// Load .env files the way `next dev` does, for scripts run outside Next.js. Import this first.
// Variables already set in the shell (e.g. DEMO_MODE=true) take precedence over the files.
import nextEnv from "@next/env"; // CommonJS: no named ESM exports

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", { info: () => {}, error: console.error });
