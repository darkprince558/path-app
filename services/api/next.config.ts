import type { NextConfig } from 'next';

const config: NextConfig = {
  // Auth0's proxy runs before uploads. Keep its body buffer above the 32 MiB
  // file limit plus multipart overhead; route handlers enforce their own limits.
  experimental: { proxyClientMaxBodySize: '34mb' },
};

export default config;
