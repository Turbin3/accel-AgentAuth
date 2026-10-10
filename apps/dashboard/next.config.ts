import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The demo package is TypeScript source; it is only imported by server route handlers.
  transpilePackages: ['@agentauth-sol/demo'],
  allowedDevOrigins: ['127.0.0.1'],
  agentRules: false,
  turbopack: {
    ignoreIssue: [
      // The SDK's optional `loadRegistry()` imports @agentauth-sol/registry by a computed specifier.
      // This app never calls it (the registry is loaded on the server and passed in as data).
      { path: /packages\/sdk\/dist\/index\.js$/, title: /Module not found/ },
    ],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default config
