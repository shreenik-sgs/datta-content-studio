import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  basePath: "/distribution",
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".js"] };
    return config;
  },
  distDir: process.env.NEXT_DIST_DIR ?? ".next-distribution",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: [
    "@satsang/distribution-assets",
    "@satsang/distribution-contracts",
    "@satsang/distribution-domain",
    "@satsang/distribution-db",
    "@satsang/distribution-links",
  ],
  async redirects() {
    return [{ source: "/", destination: "/distribution", basePath: false, permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          ...(process.env.NODE_ENV === "production"
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default config;
