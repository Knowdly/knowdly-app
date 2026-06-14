// app/mybooks/page.tsx
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// Private page showing all digital books owned by the connected wallet.
// Ownership is proven purely from on-chain NFT tokens — no localStorage needed.
//
// From this page the owner can:
//   - Read any owned book (links to reader)
//   - List a book for resale on the marketplace
//   - Cancel an active listing
//   - See which books are currently listed for resale

'use client'

import { useState, useEffect } from 'react'
import { getTokensByOwner, getToken, getBookArweaveTxId } from '../lib/contract'

// ── Types ─────────────────────────────────────────────────────────────────────

type OwnedBook = {
  tokenId:      number   // NFT token ID on Soroban
  bookId:       number   // book ID on Soroban
  arweaveTxId:  string   // Arweave TX ID of the encrypted book
  purchasePrice: number  // original purchase price in stroops
  // book metadata from Supabase
  title:        string
  author:       string
  category:     string
  contentFormat: string
  coverTxId:    string
  royalty:      string
  // listing state
  isListed:     boolean
  listingPrice: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ARWEAVE_GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? 'https://arweave.net'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPrice(stroops: number): string {
  return (stroops / 10_000_000).toFixed(2)
}

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

export default function MyBooksPage() {

  const [walletAddress, setWalletAddress]   = useState<string | null>(null)
  const [ownedBooks,    setOwnedBooks]       = useState<OwnedBook[]>([])
  const [loading,       setLoading]          = useState(true)
  const [error,         setError]            = useState<string | null>(null)

  // listing modal state
  const [listingBook,   setListingBook]      = useState<OwnedBook | null>(null)
  const [listingPrice,  setListingPrice]     = useState('')
  const [listingStatus, setListingStatus]    = useState<'idle' | 'listing' | 'done' | 'error'>('idle')
  const [listingError,  setListingError]     = useState<string | null>(null)

  // cancellation state
  const [cancellingId, setCancellingId]      = useState<number | null>(null)

  // ── Connect wallet and load owned books ───────────────────────────────────

  useEffect(() => {
    async function init() {
      try {
        const { requestAccess } = await import('@stellar/freighter-api')
        const result = await requestAccess()
        if (result.error || !result.address) {
          setError('Please connect your Freighter wallet to view your library')
          setLoading(false)
          return
        }
        setWalletAddress(result.address)
        await loadOwnedBooks(result.address)
      } catch (err) {
        setError('Could not connect wallet')
        setLoading(false)
      }
    }
    init()
  }, [])

  async function loadOwnedBooks(wallet: string) {
    setLoading(true)
    setError(null)

    try {
      // step 1: get all NFT token IDs from the chain
      const tokenIds = await getTokensByOwner(wallet)
      if (tokenIds.length === 0) {
        setOwnedBooks([])
        setLoading(false)
        return
      }

      // step 2: get active listings so we know which books are listed
      const listingsRes = await fetch('/api/listings')
      const listingsData = await listingsRes.json()
      const listingsByToken = new Map<number, number>()
      for (const listing of listingsData.listings || []) {
        listingsByToken.set(listing.token_id, listing.asking_price)
      }

      // step 3: get book metadata from Supabase
      const booksRes  = await fetch('/api/books')
      const booksData = await booksRes.json()
      const booksByTxId = new Map<string, any>()
      for (const book of booksData.books || []) {
        booksByTxId.set(book.txId, book)
      }

      // step 4: for each token get bookId and arweaveTxId from chain
      const owned: OwnedBook[] = []

      for (const rawId of tokenIds) {
        const tokenId = Number(rawId)
        try {
          const token = await getToken(wallet, tokenId)
          if (!token) continue

          const arweaveTxId = await getBookArweaveTxId(wallet, Number(token.bookId))
          if (!arweaveTxId) continue

          const bookMeta = booksByTxId.get(arweaveTxId)
          const isListed = listingsByToken.has(tokenId)

          owned.push({
            tokenId,
            bookId:        Number(token.bookId),
            arweaveTxId,
            purchasePrice: Number(token.purchasePrice),
            title:         bookMeta?.title        || 'Unknown Title',
            author:        bookMeta?.author       || '',
            category:      bookMeta?.category     || '',
            contentFormat: bookMeta?.contentFormat || 'EPUB',
            coverTxId:     bookMeta?.coverTxId    || '',
            royalty:       bookMeta?.royalty      || '5',
            isListed,
            listingPrice:  isListed ? String(listingsByToken.get(tokenId)) : '',
          })
        } catch (err) {
          console.error('Error loading token:', tokenId, err)
        }
      }

      setOwnedBooks(owned)
    } catch (err) {
      console.error('Error loading owned books:', err)
      setError('Failed to load your library')
    } finally {
      setLoading(false)
    }
  }

  // ── List a book for resale ────────────────────────────────────────────────

  async function handleList() {
  if (!listingBook || !listingPrice || !walletAddress) return
  const price = parseFloat(listingPrice)
  if (isNaN(price) || price <= 0) {
    setListingError('Please enter a valid price')
    return
  }

  setListingStatus('listing')
  setListingError(null)

  try {
    // ── Step 1: List on Soroban contract ──────────────────────────────
    // This is the on-chain listing — buy_listing requires this to exist
    setListingError(null)
    const { listForSale } = await import('../lib/contract')
    const askingPriceStroops = Math.round(price * 10_000_000)
    await listForSale(walletAddress, listingBook.tokenId, askingPriceStroops)
    console.log('Token listed on-chain:', listingBook.tokenId)

    // ── Step 2: Save listing to Supabase (fast index) ─────────────────
    const res = await fetch('/api/listings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tokenId:       listingBook.tokenId,
        bookId:        listingBook.bookId,
        arweaveTxId:   listingBook.arweaveTxId,
        sellerAddress: walletAddress,
        askingPrice:   price,
      }),
    })

    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error || 'Failed to create listing')
    }

    setListingStatus('done')
    setOwnedBooks(prev => prev.map(b =>
      b.tokenId === listingBook.tokenId
        ? { ...b, isListed: true, listingPrice: String(price) }
        : b
    ))

    setTimeout(() => {
      setListingBook(null)
      setListingPrice('')
      setListingStatus('idle')
    }, 1500)

  } catch (err) {
    setListingError(err instanceof Error ? err.message : 'Failed to list book')
    setListingStatus('error')
  }
}

  // ── Cancel a listing ──────────────────────────────────────────────────────

  async function handleCancel(tokenId: number) {
  setCancellingId(tokenId)
  try {
    // ── Step 1: Cancel on Soroban contract ────────────────────────────
    const { cancelListing } = await import('../lib/contract')
    await cancelListing(walletAddress!, tokenId)
    console.log('Listing cancelled on-chain:', tokenId)

    // ── Step 2: Remove from Supabase ──────────────────────────────────
    const res = await fetch(`/api/listings?tokenId=${tokenId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('Failed to cancel listing')

    setOwnedBooks(prev => prev.map(b =>
      b.tokenId === tokenId
        ? { ...b, isListed: false, listingPrice: '' }
        : b
    ))
  } catch (err) {
    console.error('Cancel listing error:', err)
  } finally {
    setCancellingId(null)
  }
}

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">

        {/* ── HEADER ── */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-2">My Books</h1>
          <p className="text-gray-400">
            Digital books you own on-chain. List them for resale when you're done.
          </p>
          {walletAddress && (
            <p className="text-gray-600 text-xs mt-2 font-mono truncate">
              {walletAddress}
            </p>
          )}
        </div>

        {/* ── LOADING ── */}
        {loading && (
          <div className="text-center py-20">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <div className="text-gray-500 text-sm animate-pulse">
              Loading your on-chain library...
            </div>
          </div>
        )}

        {/* ── ERROR ── */}
        {error && !loading && (
          <div className="bg-red-950 border border-red-800 rounded-xl p-4 mb-6">
            <div className="text-red-400">{error}</div>
          </div>
        )}

        {/* ── EMPTY ── */}
        {!loading && !error && ownedBooks.length === 0 && (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">📚</div>
            <div className="text-gray-400 text-lg mb-2">Your library is empty</div>
            <div className="text-gray-600 text-sm mb-6">
              Purchase digital books from the library to start your collection
            </div>
            <a
              href="/library"
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
            >
              Browse library
            </a>
          </div>
        )}

        {/* ── BOOK GRID ── */}
        {!loading && !error && ownedBooks.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {ownedBooks.map(book => {
              const gradient = getPlaceholderGradient(book.title)
              return (
                <div
                  key={book.tokenId}
                  className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4 hover:border-gray-700 transition-colors"
                >

                  {/* ── COVER ── */}
                  <div className="relative w-full h-48 rounded-xl overflow-hidden">
                    <div className={`absolute inset-0 bg-gradient-to-br ${gradient} flex flex-col items-center justify-center p-4`}>
                      <div className="text-4xl font-bold text-white/20 mb-2 select-none">
                        {book.title.charAt(0).toUpperCase()}
                      </div>
                      <div className="text-white/70 text-xs font-semibold text-center line-clamp-2 px-2">
                        {book.title}
                      </div>
                    </div>
                    {book.coverTxId && (
                      <img
                        src={`${ARWEAVE_GATEWAY}/${book.coverTxId}`}
                        alt={book.title}
                        className="absolute inset-0 w-full h-full object-cover"
                        onError={e => (e.currentTarget.style.display = 'none')}
                      />
                    )}
                    {/* listed badge */}
                    {book.isListed && (
                      <div className="absolute top-2 left-2 bg-green-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                        Listed ${book.listingPrice}
                      </div>
                    )}
                    {/* format badge */}
                    <span className="absolute top-2 right-2 text-xs font-semibold px-2 py-0.5 rounded bg-purple-900 text-purple-300">
                      {book.contentFormat}
                    </span>
                  </div>

                  {/* ── METADATA ── */}
                  <div className="flex-1">
                    <h2 className="text-white font-semibold leading-snug mb-1 line-clamp-2">
                      {book.title}
                    </h2>
                    <p className="text-gray-400 text-sm mb-1">{book.author}</p>
                    <p className="text-gray-600 text-xs">
                      Token #{book.tokenId} · Paid ${formatPrice(book.purchasePrice)}
                    </p>
                  </div>

                  {/* ── ACTIONS ── */}
                  <div className="flex gap-2 pt-2 border-t border-gray-800">
                    {/* read button */}
                    <a
                      href={`/reader/${book.arweaveTxId}`}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors text-center"
                    >
                      Read
                    </a>

                    {book.isListed ? (
                      // cancel listing button
                      <button
                        onClick={() => handleCancel(book.tokenId)}
                        disabled={cancellingId === book.tokenId}
                        className="flex-1 bg-gray-800 hover:bg-red-900 hover:text-red-300 text-gray-400 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {cancellingId === book.tokenId ? 'Cancelling...' : 'Cancel listing'}
                      </button>
                    ) : (
                      // list for resale button
                      <button
                        onClick={() => { setListingBook(book); setListingPrice('') }}
                        className="flex-1 bg-gray-800 hover:bg-green-900 hover:text-green-300 text-gray-400 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                      >
                        List for resale
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </div>

      {/* ── LIST FOR RESALE MODAL ── */}
      {listingBook && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-md">

            <h2 className="text-xl font-bold mb-1">List for resale</h2>
            <p className="text-gray-400 text-sm mb-6">
              {listingBook.title} by {listingBook.author}
            </p>

            <div className="bg-gray-800 rounded-xl p-4 mb-6 text-sm space-y-2">
              <div className="flex justify-between text-gray-400">
                <span>Creator royalty</span>
                <span>{listingBook.royalty}%</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Platform fee</span>
                <span>2.5%</span>
              </div>
              <div className="flex justify-between text-white font-medium border-t border-gray-700 pt-2">
                <span>You receive</span>
                <span>
                  {listingPrice
                    ? `$${(parseFloat(listingPrice) * (1 - parseFloat(listingBook.royalty) / 100 - 0.025)).toFixed(2)}`
                    : '—'
                  }
                </span>
              </div>
            </div>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Asking price (USDC)
              </label>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-gray-500">$</span>
                <input
                  type="number"
                  value={listingPrice}
                  onChange={e => setListingPrice(e.target.value)}
                  placeholder="5.00"
                  min="0.01"
                  step="0.01"
                  disabled={listingStatus === 'listing' || listingStatus === 'done'}
                  className="w-full bg-gray-800 border border-gray-700 text-white placeholder-gray-600 pl-8 pr-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>

            {listingError && (
              <div className="bg-red-950 border border-red-800 rounded-lg p-3 mb-4 text-red-400 text-sm">
                {listingError}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setListingBook(null); setListingStatus('idle'); setListingError(null) }}
                disabled={listingStatus === 'listing'}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 py-3 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleList}
                disabled={!listingPrice || listingStatus === 'listing' || listingStatus === 'done'}
                className="flex-1 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-lg text-sm font-medium transition-colors"
              >
                {listingStatus === 'listing' && 'Listing...'}
                {listingStatus === 'done'    && 'Listed ✓'}
                {listingStatus === 'idle'    && 'List for resale'}
                {listingStatus === 'error'   && 'Try again'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  )
}