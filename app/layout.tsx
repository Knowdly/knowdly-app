// layout.tsx — the root layout that wraps every page in the app
// anything placed here appears on ALL pages (navbar, footer, fonts)

import type { Metadata } from 'next'
import './globals.css'

// Connect Stellar (Freighter Wallet)
import WalletConnect from './components/WalletConnect'

export const metadata: Metadata = {
  title: 'Knowdly — Own the digital books you read. Forever.',
  description: 'The first truly decentralised digital book platform. Buy, read, and resell digital books with permanent on-chain ownership.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen" suppressHydrationWarning>

        {/* navbar */}
        <nav className="border-b border-gray-800 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between">

            {/* logo */}
            <a href="/" className="text-xl font-bold text-white tracking-tight">
              Knowdly
            </a>

            {/* navigation links */}
            <div className="flex items-center gap-6 text-sm text-gray-400">
              <a href="/library" className="hover:text-white transition-colors">
                Library
              </a>
              <a href="/marketplace" className="hover:text-white transition-colors">
                Marketplace
              </a>
              <a href="/mylibrary" className="hover:text-white transition-colors">
                My Books
              </a>
              <a href="/upload" className="hover:text-white transition-colors">
                For Creators
              </a>
              <a
                href="/upload"
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors"
              >
                Upload
              </a>

              <WalletConnect />
            </div>
          </div>
        </nav>

        <main className="max-w-6xl mx-auto px-6 py-12">
          {children}
        </main>

        <footer className="border-t border-gray-800 px-6 py-8 mt-20">
          <div className="max-w-6xl mx-auto flex items-center justify-between text-sm text-gray-500">
            <span>© 2026 Knowdly. All rights reserved.</span>
            <span>Own the digital books you read. Forever.</span>
          </div>
        </footer>

      </body>
    </html>
  )
}