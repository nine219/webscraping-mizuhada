/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        // Server-side only (runs in Next's Node process, never bundled to the
        // client) — always the real API, regardless of what NEXT_PUBLIC_API_URL
        // the browser is using. Kept separate from that var on purpose: making
        // this depend on NEXT_PUBLIC_API_URL too would rewrite '/api/*' to
        // itself once that var is set to '' for relative-path/ngrok mode.
        //
        // API_INTERNAL_URL lets the Docker dashboard container reach the api
        // container by its compose service name (http://api:3001) — inside a
        // container "localhost" is the dashboard itself, not the API. Defaults
        // to localhost for the host/PM2 setup so behavior there is unchanged.
        destination: `${process.env.API_INTERNAL_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
