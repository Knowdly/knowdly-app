// app/marketplace/page.tsx
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// Public marketplace page showing all digital books listed for resale.
// Anyone can browse — only connected wallet holders can purchase.
//
// ── RESALE FLOW ───────────────────────────────────────────────────────────────
// 1. Buyer clicks "Buy" on a listing
// 2. ResaleModal opens showing price breakdown
// 3. Buyer confirms — USDC payment sent to seller, creator, platform
// 4. transfer_token called on Soroban — NFT moves to buyer's wallet
// 5. Listing removed from Supabase
// 6. Seller loses access, buyer gains access immediately

'use client'

import { useState, useEffect } from 'react'
import ResaleModal from '../components/ResaleModal'

// ── Types ─────────────────────────────────────────────────────────────────────

type Listing = {
  id:             string
  token_id:       number
  book_id:        number
  arweave_tx_id:  string
  seller_address: string
  asking_price:   number
  created_at:     string
  books: {
    title:          string
    author:         string
    category:       string
    content_format: string
    description:    string
    cover_tx_id:    string
    royalty:        string
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ARWEAVE_GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? 'https://arweave.net'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlaceholderGradient(title: string): string {
  const gradients = [
    'from-indigo-900 to-purple-900',
    'from-blue-900 to-indigo-900',
    'from-purple-900 to-pink-900',
    'from-emerald-900 to-teal-900',
    'from-orange-900 to-red-900',
  ]
  let hash = 0
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i)
    hash |= 0
  }
  return gradients[Math.abs(hash) % gradients.length]
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MarketplacePage() {

  const [listings,       setListings]       = useState<Listing[]>([])
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null)

  // ── Load listings ─────────────────────────────────────────────────────────

  async function fetchListings() {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/listings')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load listings')
      setListings(data.listings || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load listings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchListings() }, [])

  // ── After successful purchase ─────────────────────────────────────────────
  // Remove the listing from the UI and close the modal

  function handlePurchaseSuccess(tokenId: number) {
    setListings(prev => prev.filter(l => l.token_id !== tokenId))
    setSelectedListing(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">

        {/* ── HEADER ── */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-2">Marketplace</h1>
          <p className="text-gray-400">
            Buy digital books from other readers. Ownership transfers on-chain instantly.
            Creators earn royalties on every resale — automatically, forever.
          </p>
        </div>

        {/* ── LOADING ── */}
        {loading && (
          <div className="text-center py-20">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <div className="text-gray-500 text-sm animate-pulse">Loading marketplace...</div>
          </div>
        )}

        {/* ── ERROR ── */}
        {error && !loading && (
          <div className="bg-red-950 border border-red-800 rounded-xl p-4 mb-6">
            <div className="text-red-400 font-medium mb-1">Failed to load marketplace</div>
            <button onClick={fetchListings} className="text-indigo-400 text-sm hover:text-indigo-300">
              Try again
            </button>
          </div>
        )}

        {/* ── EMPTY ── */}
        {!loading && !error && listings.length === 0 && (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">🏪</div>
            <div className="text-gray-400 text-lg mb-2">No books listed yet</div>
            <div className="text-gray-600 text-sm mb-6">
              Be the first to list a digital book for resale from your library
            </div>
            <a
              href="/mylibrary"
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              Go to My Library
            </a>
          </div>
        )}

        {/* ── LISTINGS GRID ── */}
        {!loading && !error && listings.length > 0 && (
          <>
            <div className="text-gray-500 text-sm mb-6">
              {listings.length} {listings.length === 1 ? 'book' : 'books'} available for resale
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {listings.map(listing => {
                const book     = listing.books
                const gradient = getPlaceholderGradient(book?.title || '')
                const royalty  = parseFloat(book?.royalty || '5')
                const youPay   = listing.asking_price
                const creatorGets = (youPay * royalty / 100).toFixed(2)

                return (
                  <div
                    key={listing.id}
                    className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4 hover:border-gray-700 transition-colors"
                  >

                    {/* ── COVER ── */}
                    <div className="relative w-full h-48 rounded-xl overflow-hidden">
                      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} flex flex-col items-center justify-center p-4`}>
                        <div className="text-4xl font-bold text-white/20 mb-2 select-none">
                          {(book?.title || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="text-white/70 text-xs font-semibold text-center line-clamp-2 px-2">
                          {book?.title}
                        </div>
                      </div>
                      {book?.cover_tx_id && (
                        <img
                          src={`${ARWEAVE_GATEWAY}/${book.cover_tx_id}`}
                          alt={book.title}
                          className="absolute inset-0 w-full h-full object-cover"
                          onError={e => (e.currentTarget.style.display = 'none')}
                        />
                      )}
                      {/* resale badge */}
                      <div className="absolute top-2 left-2 bg-green-700 text-white text-xs font-bold px-2 py-0.5 rounded">
                        Resale
                      </div>
                      {/* format badge */}
                      <span className="absolute top-2 right-2 text-xs font-semibold px-2 py-0.5 rounded bg-purple-900 text-purple-300">
                        {book?.content_format}
                      </span>
                    </div>

                    {/* ── METADATA ── */}
                    <div className="flex-1">
                      <h2 className="text-white font-semibold leading-snug mb-1 line-clamp-2">
                        {book?.title}
                      </h2>
                      <p className="text-gray-400 text-sm mb-1">{book?.author}</p>
                      {book?.category && (
                        <span className="text-xs text-indigo-400 capitalize bg-indigo-950 px-2 py-0.5 rounded">
                          {book.category}
                        </span>
                      )}
                      <p className="text-gray-600 text-xs mt-2">
                        {royalty}% royalty goes to creator on this sale
                      </p>
                    </div>

                    {/* ── PRICE + ACTION ── */}
                    <div className="flex items-center justify-between pt-2 border-t border-gray-800">
                      <div>
                        <div className="text-white font-bold text-lg">
                          ${listing.asking_price}
                        </div>
                        <div className="text-gray-600 text-xs">
                          Creator gets ${creatorGets}
                        </div>
                      </div>
                      <button
                        onClick={() => setSelectedListing(listing)}
                        className="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                      >
                        Buy →
                      </button>
                    </div>

                    {/* arweave link */}
                    <a
                      href={`https://arweave.net/${listing.arweave_tx_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gray-700 hover:text-gray-500 text-xs transition-colors truncate"
                    >
                      ar://{listing.arweave_tx_id}
                    </a>

                  </div>
                )
              })}
            </div>
          </>
        )}

      </div>

      {/* ── RESALE PURCHASE MODAL ── */}
      {selectedListing && (
        <ResaleModal
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
          onSuccess={() => handlePurchaseSuccess(selectedListing.token_id)}
        />
      )}

    </div>
  )
}