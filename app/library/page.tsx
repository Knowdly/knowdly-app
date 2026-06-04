// app/library/page.tsx
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// The reader-facing library page. Shows all available books as a grid of cards.
// Each card shows a cover image (if one exists) or a styled placeholder.
//
// ── COVER IMAGE STRATEGY ──────────────────────────────────────────────────────
// Cover images are stored as separate public Arweave transactions.
// The book's coverTxId field points to the cover transaction.
//
// If coverTxId exists:
//   → Fetch image from https://arweave.net/<coverTxId>
//   → Display as the card's cover image
//   → While loading, show the styled placeholder
//   → If image fails to load, fall back to the styled placeholder
//
// If coverTxId is empty:
//   → Show a styled placeholder with title initial, title, and author
//   → Each book gets a consistent colour based on its title (not random)
//
// ── ON-CHAIN OWNERSHIP ────────────────────────────────────────────────────────
// Ownership is proven purely from the Soroban NFT — no localStorage dependency.
//
// Flow:
//   1. getTokensByOwner(wallet)  → all NFT token IDs owned by this wallet
//   2. getToken(tokenId)         → bookId from the token
//   3. getBookArweaveTxId(bookId) → arweaveTxId from the Soroban contract
//   4. Match arweaveTxId against library books → show Read button
//
// This works on any device, any browser, forever — as long as the wallet exists.

'use client'

import { useState, useEffect, useCallback } from 'react'
import PurchaseModal from '../components/PurchaseModal'
import { getTokensByOwner, getToken, getBookArweaveTxId } from '../lib/contract'

// ── Types ─────────────────────────────────────────────────────────────────────

type Book = {
  txId:          string
  title:         string
  author:        string
  isbn:          string
  edition:       string
  description:   string
  price:         string
  royalty:       string
  fileName:      string
  contentType:   string
  contentFormat: string   // PDF | EPUB | TXT
  contentMime:   string
  category:      string
  coverTxId:     string   // Arweave TX ID of cover image — empty string if none
  sorobanBookId: number   // on-chain book ID — passed to purchase modal
}

type SortOption = 'recent' | 'price-low' | 'price-high' | 'title'

// ── Constants ─────────────────────────────────────────────────────────────────

// Arweave gateway for fetching cover images
// Cover images are public so we fetch them directly (no proxy needed)
const ARWEAVE_GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? 'https://arweave.net'

// Placeholder gradient colours — assigned consistently by title hash
// so the same book always gets the same colour
const PLACEHOLDER_GRADIENTS = [
  'from-indigo-900 to-purple-900',
  'from-blue-900 to-indigo-900',
  'from-purple-900 to-pink-900',
  'from-emerald-900 to-teal-900',
  'from-orange-900 to-red-900',
  'from-teal-900 to-cyan-900',
  'from-rose-900 to-pink-900',
  'from-amber-900 to-orange-900',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns a consistent gradient class for a book based on its title.
// Uses a simple hash so the same book always gets the same colour.
function getPlaceholderGradient(title: string): string {
  let hash = 0
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i)
    hash |= 0  // convert to 32-bit integer
  }
  return PLACEHOLDER_GRADIENTS[Math.abs(hash) % PLACEHOLDER_GRADIENTS.length]
}

// Returns the first letter of the title for the placeholder monogram
function getTitleInitial(title: string): string {
  return title.trim().charAt(0).toUpperCase() || '?'
}

// Format badge colour — used on both cover images and placeholders
function formatBadge(fmt: string) {
  if (fmt === 'EPUB') return 'bg-purple-900 text-purple-300'
  if (fmt === 'PDF')  return 'bg-indigo-900 text-indigo-300'
  return 'bg-gray-800 text-gray-400'
}

// Sort books client-side
function sortBooks(books: Book[], sort: SortOption): Book[] {
  const copy = [...books]
  switch (sort) {
    case 'price-low':  return copy.sort((a,b) => parseFloat(a.price||'0') - parseFloat(b.price||'0'))
    case 'price-high': return copy.sort((a,b) => parseFloat(b.price||'0') - parseFloat(a.price||'0'))
    case 'title':      return copy.sort((a,b) => a.title.localeCompare(b.title))
    default:           return copy  // 'recent' = Arweave HEIGHT_DESC order
  }
}

// ── BookCover component ───────────────────────────────────────────────────────
// Renders either a real cover image or a styled placeholder.
// Handles loading state and image error fallback gracefully.

function BookCover({ book }: { book: Book }) {
  // track whether the cover image has loaded or failed
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError,  setImgError]  = useState(false)

  // determine whether to show the real image or placeholder
  const showImage = book.coverTxId && !imgError
  const gradient  = getPlaceholderGradient(book.title)
  const initial   = getTitleInitial(book.title)

  return (
    <div className="relative w-full h-48 rounded-xl overflow-hidden">

      {/* ── Styled placeholder ──────────────────────────────────────────────
           Always rendered — sits behind the image.
           Visible when: no coverTxId, image is loading, or image failed. */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} flex flex-col items-center justify-center p-4`}>
        {/* large letter monogram */}
        <div className="text-4xl font-bold text-white/20 mb-2 select-none">
          {initial}
        </div>
        {/* title — truncated to 2 lines */}
        <div className="text-white/70 text-xs font-semibold text-center leading-snug line-clamp-2 px-2">
          {book.title}
        </div>
        {/* author */}
        <div className="text-white/40 text-xs text-center mt-1 truncate w-full px-2">
          {book.author}
        </div>
      </div>

      {/* ── Real cover image ────────────────────────────────────────────────
           Only rendered if coverTxId exists.
           Hidden while loading (opacity-0) to avoid flash of broken image.
           Fades in once loaded. Falls back to placeholder on error. */}
      {showImage && (
        <img
          src={`${ARWEAVE_GATEWAY}/${book.coverTxId}`}
          alt={`Cover of ${book.title}`}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
            imgLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={()  => setImgLoaded(true)}
          onError={() => setImgError(true)}
        />
      )}

      {/* ── Format badge ────────────────────────────────────────────────────
           Shown in the top-right corner over the cover or placeholder. */}
      {book.contentFormat && (
        <span className={`absolute top-2 right-2 text-xs font-semibold px-2 py-0.5 rounded ${formatBadge(book.contentFormat)}`}>
          {book.contentFormat}
        </span>
      )}

    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LibraryPage() {

  // ── State ──────────────────────────────────────────────────────────────────
  const [books,          setBooks]          = useState<Book[]>([])
  const [search,         setSearch]         = useState('')
  const [category,       setCategory]       = useState('')
  const [format,         setFormat]         = useState('')
  const [sort,           setSort]           = useState<SortOption>('recent')
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [purchasingBook, setPurchasingBook] = useState<Book | null>(null)
  const [walletAddress,  setWalletAddress]  = useState<string | null>(null)

  // ownedBooks: Set of arweaveTxIds that the connected wallet owns.
  // Populated from on-chain NFT ownership check.
  // Also cached in localStorage for fast initial render.
  const [ownedBooks, setOwnedBooks] = useState<Set<string>>(new Set())

  // ── Fetch books ────────────────────────────────────────────────────────────
  // Calls /api/books which returns books from Supabase (primary) or
  // Arweave GraphQL (fallback), merged and deduplicated.
  // Each book now includes coverTxId if a cover was uploaded.

  const fetchBooks = useCallback(async (
    searchTerm: string,
    cat:        string,
    fmt:        string,
  ) => {

    // check and confirm any pending books on every library load
    try {
      await fetch('/api/books/confirm')
    } catch { /* non-fatal */ }

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (searchTerm.trim()) params.set('search',   searchTerm.trim())
      if (cat.trim())         params.set('category', cat.trim())
      if (fmt.trim())         params.set('format',   fmt.trim())

      const url      = '/api/books' + (params.toString() ? '?' + params.toString() : '')
      const response = await fetch(url)
      const data     = await response.json()

      if (!response.ok) throw new Error(data.error || 'Failed to load books')

      // enrich books with sorobanBookId from localStorage map.
      // This is a legacy fallback — books uploaded on this device will have
      // a bookId stored in localStorage. Books uploaded on other devices
      // will have sorobanBookId -1 until we resolve it from the chain.
      // The purchase modal handles the -1 case.
      const bookIdMap = JSON.parse(localStorage.getItem('knowdly_book_ids') || '{}')
      const enriched  = (data.books as Book[]).map(b => ({
        ...b,
        sorobanBookId: bookIdMap[b.txId] !== undefined ? Number(bookIdMap[b.txId]) : -1,
      }))
      setBooks(enriched)

      // load localStorage ownership cache for fast initial render
      // this gets replaced by on-chain data in checkOnChainOwnership
      const stored = localStorage.getItem('knowdly_owned_books')
      if (stored) setOwnedBooks(new Set(JSON.parse(stored)))

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load books')
    } finally {
      setLoading(false)
    }
  }, [])

  // initial load
  useEffect(() => { fetchBooks('', '', '') }, [fetchBooks])

  // re-fetch when category or format filter changes
  useEffect(() => { fetchBooks(search, category, format) }, [category, format])

  // ── Wallet connection ──────────────────────────────────────────────────────
  // Silently checks if Freighter is connected on page load.
  // If connected, loads the ownership cache and triggers on-chain ownership check.

 useEffect(() => {
  async function checkWallet() {
    try {
      const { requestAccess } = await import('@stellar/freighter-api')
      const result = await requestAccess()
      if (!result.error && result.address) {
        const newAddress = result.address
        
        // only clear cache if wallet changed since last visit
        const lastWallet = localStorage.getItem('knowdly_last_wallet')
        if (lastWallet !== newAddress) {
          // different wallet — clear stale cache
          localStorage.removeItem(`knowdly_owned_books_${newAddress}`)
          localStorage.setItem('knowdly_last_wallet', newAddress)
          setOwnedBooks(new Set())
        } else {
          // same wallet — load cache for fast initial render
          const stored = localStorage.getItem(`knowdly_owned_books_${newAddress}`)
          setOwnedBooks(stored ? new Set(JSON.parse(stored)) : new Set())
        }
        
        setWalletAddress(newAddress)
      }
    } catch { /* wallet not connected */ }
  }
  checkWallet()
// poll for wallet changes every 3 seconds
  const interval = setInterval(async () => {
    try {
      const { requestAccess } = await import('@stellar/freighter-api')
      const result = await requestAccess()
      if (!result.error && result.address) {
        setWalletAddress(prev => {
          if (prev !== null && prev !== result.address) {
            // wallet changed — reload page for clean state
            console.log('Wallet changed to:', result.address)
            localStorage.removeItem(`knowdly_owned_books_${result.address}`)
            localStorage.setItem('knowdly_last_wallet', result.address)
            window.location.reload()
          }
          return result.address
        })
      }
    } catch { /* ignore */ }
  }, 3000)

  return () => clearInterval(interval)
}, [])

  // trigger on-chain ownership check when wallet + books are both ready
  useEffect(() => {
    if (walletAddress && books.length > 0) checkOnChainOwnership(walletAddress, books)
  }, [walletAddress, books])

  // ── Search debounce ────────────────────────────────────────────────────────
  // Waits 500ms after the user stops typing before fetching.
  // Prevents a fetch on every keypress.

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const term = e.target.value
    setSearch(term)
    const timer = setTimeout(() => fetchBooks(term, category, format), 500)
    return () => clearTimeout(timer)
  }

  // ── On-chain ownership check ───────────────────────────────────────────────
  // Proves ownership purely from the Soroban NFT — no localStorage required.
  //
  // Full flow:
  //   getTokensByOwner(wallet)     → [tokenId, tokenId, ...]
  //   getToken(tokenId)            → { bookId, owner, purchasePrice, ... }
  //   getBookArweaveTxId(bookId)   → "trJ7zNW_..." (real Arweave TX ID)
  //   match against library books  → add to ownedBooks set → show Read button
  //
  // Results are also cached in localStorage for fast render on next page load.

  async function checkOnChainOwnership(walletAddr: string, bookList: Book[]) {
    try {
      // step 1: get all NFT token IDs owned by this wallet
      const tokenIds = await getTokensByOwner(walletAddr)
      console.log('Token IDs:', tokenIds, 'length:', tokenIds.length)
      if (!tokenIds || tokenIds.length === 0) return

      const onChainOwned = new Set<string>()

      // process tokens sequentially — easier to debug than Promise.all
      // and avoids hammering the Soroban RPC with parallel requests
      for (const rawId of tokenIds) {
        const id = Number(rawId)  // force convert BigInt → number
        console.log('Processing token ID:', id, 'type:', typeof id)
        try {
          // step 2: get the token to find the bookId
          const token = await getToken(walletAddr, id)
          console.log('Token:', token)
          if (!token) continue

          // step 3: get the arweaveTxId from the contract using the bookId
          // this returns the real TX ID (written by updateArweaveTx after upload)
          const arweaveTxId = await getBookArweaveTxId(walletAddr, Number(token.bookId))
          console.log('ArweaveTxId:', arweaveTxId)
          if (arweaveTxId) onChainOwned.add(arweaveTxId)
        } catch (err) {
          console.error('Token error:', id, err)
        }
      }

      console.log('Owned txIds:', Array.from(onChainOwned))

      // step 4: update ownedBooks state and cache in localStorage
      if (onChainOwned.size > 0 || tokenIds.length >= 0) {
        setOwnedBooks(() => {
          // use ONLY on-chain ownership — don't merge with localStorage
          // this ensures sold books are removed from the UI
          const key = `knowdly_owned_books_${walletAddr}`
          localStorage.setItem(key, JSON.stringify(Array.from(onChainOwned)))
          return onChainOwned
        })
      }
    } catch (err) {
      console.error('On-chain ownership check failed:', err)
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────

  const displayBooks = sortBooks(books, sort)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>

      {/* ── PAGE HEADER ── */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-white mb-3">Library</h1>
        <p className="text-gray-400">
          Every book encrypted, every purchase permanent. Ownership proven on-chain forever.
        </p>
      </div>

      {/* ── FILTERS ── */}
      <div className="flex flex-wrap gap-3 mb-8">

        {/* search */}
        <input
          type="text"
          value={search}
          onChange={handleSearch}
          placeholder="Search by title, author, ISBN..."
          className="flex-1 min-w-[200px] bg-gray-900 border border-gray-700 text-white placeholder-gray-500 px-4 py-2.5 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
        />

        {/* category filter */}
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="bg-gray-900 border border-gray-700 text-gray-300 px-4 py-2.5 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
        >
          <option value="">All categories</option>
          <option value="textbook">Textbook</option>
          <option value="novel">Novel</option>
          <option value="research paper">Research Paper</option>
          <option value="essay collection">Essay Collection</option>
          <option value="course notes">Course Notes</option>
          <option value="reference">Reference</option>
          <option value="other">Other</option>
        </select>

        {/* format filter */}
        <select
          value={format}
          onChange={e => setFormat(e.target.value)}
          className="bg-gray-900 border border-gray-700 text-gray-300 px-4 py-2.5 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
        >
          <option value="">All formats</option>
          <option value="PDF">PDF</option>
          <option value="EPUB">EPUB</option>
          <option value="TXT">TXT</option>
        </select>

        {/* sort */}
        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortOption)}
          className="bg-gray-900 border border-gray-700 text-gray-300 px-4 py-2.5 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
        >
          <option value="recent">Most recent</option>
          <option value="price-low">Price: low to high</option>
          <option value="price-high">Price: high to low</option>
          <option value="title">Title A–Z</option>
        </select>
      </div>

      {/* ── LOADING ── */}
      {loading && (
        <div className="text-center py-20">
          <div className="text-gray-500 text-sm animate-pulse">
            Querying Arweave network...
          </div>
        </div>
      )}

      {/* ── ERROR ── */}
      {error && !loading && (
        <div className="bg-red-950 border border-red-800 rounded-xl p-4 mb-6">
          <div className="text-red-400 font-medium mb-1">Failed to load books</div>
          <code className="text-red-300 text-xs">{error}</code>
          <button
            onClick={() => fetchBooks(search, category, format)}
            className="ml-4 text-indigo-400 hover:text-indigo-300 text-sm transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {/* ── RESULTS COUNT ── */}
      {!loading && !error && (
        <div className="text-gray-500 text-sm mb-6">
          {displayBooks.length} {displayBooks.length === 1 ? 'book' : 'books'} found
          {search   && ` for "${search}"`}
          {category && ` · ${category}`}
          {format   && ` · ${format}`}
        </div>
      )}

      {/* ── BOOK GRID ── */}
      {!loading && !error && displayBooks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {displayBooks.map(book => (
            <div
              key={book.txId}
              className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col gap-4 hover:border-gray-700 transition-colors"
            >

              {/* ── COVER IMAGE or PLACEHOLDER ──
                   BookCover handles loading state and error fallback.
                   Shows a styled gradient placeholder if no cover exists
                   or while the cover image is loading. */}
              <BookCover book={book} />

              {/* ── METADATA ── */}
              <div className="flex-1">
                <h2 className="text-white font-semibold leading-snug mb-1 line-clamp-2">
                  {book.title}
                </h2>
                <p className="text-gray-400 text-sm mb-1">{book.author}</p>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {book.category && (
                    <span className="text-xs text-indigo-400 capitalize bg-indigo-950 px-2 py-0.5 rounded">
                      {book.category}
                    </span>
                  )}
                  <p className="text-gray-600 text-xs">
                    {book.edition && book.edition + ' edition'}
                    {book.edition && book.isbn && ' · '}
                    {book.isbn && 'ISBN ' + book.isbn}
                  </p>
                </div>
                <p className="text-gray-500 text-sm leading-relaxed line-clamp-3">
                  {book.description}
                </p>
              </div>

              {/* ── PRICE + ACTION BUTTON ──
                   Shows Read button if the wallet owns this book (proven on-chain).
                   Shows Purchase button otherwise. */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-800">
                <div>
                  <div className="text-white font-bold text-lg">
                    {book.price ? '$' + book.price : 'Free'}
                  </div>
                  {book.royalty && (
                    <div className="text-gray-600 text-xs">
                      {book.royalty}% resale royalty
                    </div>
                  )}
                </div>

                {ownedBooks.has(book.txId) ? (
                  // owned — show Read button linking to the reader
                  <a
                    href={'/reader/' + book.txId}
                    className="bg-green-700 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Read →
                  </a>
                ) : (
                  // not owned — show Purchase button that opens the modal
                  <button
                    onClick={() => setPurchasingBook(book)}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Purchase
                  </button>
                )}
              </div>

              {/* ── ARWEAVE LINK ──
                   Links to the raw transaction on Arweave.
                   Proof that the book exists permanently on-chain. */}
              <a
                href={'https://arweave.net/' + book.txId}
                target="_blank"
                rel="noreferrer"
                className="text-gray-700 hover:text-gray-500 text-xs transition-colors truncate"
              >
                ar://{book.txId}
              </a>
            </div>
          ))}
        </div>
      )}

      {/* ── EMPTY STATE ── */}
      {!loading && !error && displayBooks.length === 0 && (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">📚</div>
          <div className="text-gray-400 text-lg mb-2">
            {search ? `No books found for "${search}"` : 'No books yet'}
          </div>
          <div className="text-gray-600 text-sm">
            {search ? 'Try a different search term' : 'Be the first to upload a book'}
          </div>
        </div>
      )}

      {/* ── CREATOR CTA ── */}
      <div className="border border-gray-800 rounded-2xl p-8 text-center mt-8">
        <h3 className="text-white font-semibold mb-2">Are you a creator?</h3>
        <p className="text-gray-400 text-sm mb-4">
          Upload your book and start earning fair royalties on every sale and resale.
        </p>
        <a
          href="/upload"
          className="inline-block bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          Upload your book
        </a>
      </div>

      {/* ── PURCHASE MODAL ──
           Opens when a user clicks Purchase on a book.
           On success, adds the book's txId to ownedBooks and caches it. */}
      <PurchaseModal
        book={purchasingBook}
        onClose={() => setPurchasingBook(null)}
        onSuccess={book => {
          setOwnedBooks(prev => {
            const updated = new Set(prev).add(book.txId)
            if (walletAddress) {
              const key = `knowdly_owned_books_${walletAddress}`
              localStorage.setItem(key, JSON.stringify(Array.from(updated)))
            }
            return updated
          })
          setTimeout(() => setPurchasingBook(null), 2000)
        }}
      />
    </div>
  )
}