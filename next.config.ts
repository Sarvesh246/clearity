import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Suppress Vercel Toolbar injection for end users (removes vercel.live console noise).
  // Team members can re-enable in Vercel project Settings → Vercel Toolbar.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "x-vercel-skip-toolbar", value: "1" }],
      },
    ];
  },
};

export default nextConfig;
