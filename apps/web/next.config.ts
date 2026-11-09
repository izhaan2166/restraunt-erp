import type { NextConfig } from 'next';

/**
 * The browser talks only to this app's own origin: `/api/*` and `/realtime/*` are proxied to the
 * API, so the refresh-token cookie (path /api/v1/auth, SameSite=Strict) works without CORS.
 * API_ORIGIN is read at build/start time on the server and never shipped to the browser.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // socket.io asks for `/realtime/?EIO=…`; the default slash-stripping redirect would break it.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/realtime/', destination: `${API_ORIGIN}/realtime/` },
      { source: '/realtime/:path*', destination: `${API_ORIGIN}/realtime/:path*` },
      { source: '/uploads/:path*', destination: `${API_ORIGIN}/uploads/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
