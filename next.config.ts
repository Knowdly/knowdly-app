import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      // reader route — needs ArLocal + Stellar + epub script permissions
      {
        source: '/reader/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self' blob: data:",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
              "script-src-elem 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
              "script-src-attr 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' blob:",
              "style-src-elem 'self' 'unsafe-inline' blob:",
              "style-src-attr 'self' 'unsafe-inline'",
              "img-src 'self' blob: data: http://localhost:1984 https://arweave.net https://*.arweave.net",
              "frame-src 'self' blob: data: about:",
              "worker-src 'self' blob:",
              "connect-src 'self' http://localhost:1984 https://arweave.net https://*.arweave.net https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org ws://localhost:3000",
            ].join('; '),
          },
        ],
      },
      // all other routes — allow Stellar endpoints + Arweave cover images
      {
        source: '/((?!reader).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self' blob: data:",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data: http://localhost:1984 https://arweave.net https://*.arweave.net",
              "connect-src 'self' http://localhost:1984 https://arweave.net https://*.arweave.net https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org ws://localhost:3000 wss://localhost:3000",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;