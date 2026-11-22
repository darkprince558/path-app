import type { NextConfig } from 'next';

const config: NextConfig = {
  // Auth0's proxy runs before uploads. Keep its body buffer above MAX_GLB_BYTES
  // (400 MiB, src/lib/api/scans.ts) plus multipart overhead; route handlers enforce their own limits.
  experimental: { proxyClientMaxBodySize: '402mb' },
};

export default config;
