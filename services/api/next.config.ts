import type { NextConfig } from 'next';

const config: NextConfig = {
  // Auth0's proxy runs before uploads. Keep its body buffer above MAX_GLB_BYTES
  // (100 MiB, src/lib/api/scans.ts) plus multipart overhead; route handlers enforce their own limits.
  experimental: { proxyClientMaxBodySize: '102mb' },
};

export default config;
