import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Don't write AGENTS.md into the repo on `next dev`.
  agentRules: false,
  // Demo mode reads recorded responses from fixtures/ at runtime, so ship them with every route.
  outputFileTracingIncludes: {
    "/*": ["./fixtures/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
