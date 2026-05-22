// app/reader/[txId]/page.tsx
//
// ── LAST-PAGE MEMORY ──────────────────────────────────────────────────────────
// Remembers where each reader left off, per book, per wallet.
// Stored in localStorage keyed by txId + walletAddress.
//
// EPUB:  saves the CFI (Canonical Fragment Identifier) string — exact position
// PDF:   saves the page number
// TXT:   saves the scroll percentage
//
// Storage key format: knowdly_bookmark_<txId>_<walletAddress>
// Value format:       { cfi?: string, page?: number, pct?: number }
//
// On open:  reads the bookmark and restores position
// On read:  saves position every time the reader moves

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { importKey, decryptFile } from '../../lib/crypto'

type ContentFormat = 'PDF' | 'EPUB' | 'TXT'

type BookMeta = {
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
  contentFormat: ContentFormat
  contentMime:   string
  category:      string
}

type ReaderStatus = 'loading' | 'ready' | 'error'

// ── Bookmark type ─────────────────────────────────────────────────────────────
type Bookmark = {
  cfi?:  string   // EPUB: epubjs CFI string for exact position
  page?: number   // PDF: page number
  pct?:  number   // TXT: scroll percentage 0-100
}

// ── Arweave gateway ───────────────────────────────────────────────────────────
const ARWEAVE_GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? 'http://localhost:1984'

// ── EPUB theme ────────────────────────────────────────────────────────────────
const EPUB_THEME = {
  body: {
    background:    '#fafaf8',
    color:         '#1a1a1a',
    'font-family': 'Georgia, "Times New Roman", serif',
    'font-size':   '1.05rem',
    'line-height': '1.75',
    padding:       '1rem 2rem',
    margin:        '0',
  },
  p:   { margin: '0 0 1em 0' },
  a:   { color: '#4f46e5' },
  h1:  { color: '#111', 'font-size': '1.6rem',  margin: '1.5rem 0 1rem' },
  h2:  { color: '#111', 'font-size': '1.3rem',  margin: '1.25rem 0 0.75rem' },
  h3:  { color: '#111', 'font-size': '1.1rem',  margin: '1rem 0 0.5rem' },
  img: { 'max-width': '100%', height: 'auto' },
}

// ── Bookmark helpers ──────────────────────────────────────────────────────────

// Returns the localStorage key for a bookmark
function bookmarkKey(txId: string, walletAddress: string): string {
  return `knowdly_bookmark_${txId}_${walletAddress}`
}

// Saves a bookmark to localStorage
function saveBookmark(txId: string, walletAddress: string, bookmark: Bookmark) {
  try {
    localStorage.setItem(bookmarkKey(txId, walletAddress), JSON.stringify(bookmark))
  } catch { /* localStorage may be unavailable */ }
}

// Loads a bookmark from localStorage — returns null if none exists
function loadBookmark(txId: string, walletAddress: string): Bookmark | null {
  try {
    const stored = localStorage.getItem(bookmarkKey(txId, walletAddress))
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

// ── Sandbox patch ─────────────────────────────────────────────────────────────

function patchEpubSandbox(container: HTMLDivElement | null) {
  if (!container) return
  const iframes = container.querySelectorAll('iframe')
  iframes.forEach(iframe => {
    const existing = iframe.getAttribute('sandbox') ?? ''
    if (!existing.includes('allow-scripts')) {
      iframe.setAttribute('sandbox', (existing + ' allow-scripts allow-same-origin').trim())
    }
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReaderPage() {
  const params = useParams()
  const router = useRouter()
  const txId   = params.txId as string

  const [status,     setStatus]     = useState<ReaderStatus>('loading')
  const [meta,       setMeta]       = useState<BookMeta | null>(null)
  const [error,      setError]      = useState<string | null>(null)
  const [loadingMsg, setLoadingMsg] = useState('Loading book...')

  const [pdfUrl,   setPdfUrl]   = useState<string | null>(null)
  const [textBody, setTextBody] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNum,  setPageNum]  = useState(1)

  const epubContainerRef = useRef<HTMLDivElement>(null)
  const epubBookRef      = useRef<any>(null)
  const epubRenditionRef = useRef<any>(null)
  const [epubReady,   setEpubReady]   = useState(false)
  const [epubChapter, setEpubChapter] = useState('')
  const [epubAtStart, setEpubAtStart] = useState(true)
  const [epubAtEnd,   setEpubAtEnd]   = useState(false)

  const [fontSize, setFontSize] = useState(18)
  const [darkMode, setDarkMode] = useState(true)
  const [progress, setProgress] = useState(0)

  // wallet address — needed for per-wallet bookmark keys
  const walletAddressRef = useRef<string>('')

  // ── TXT scroll progress tracking ──────────────────────────────────────────
  // Updates progress state as the user scrolls.
  // Also saves the bookmark for TXT format.
  useEffect(() => {
    function onScroll() {
      const el    = document.documentElement
      const total = el.scrollHeight - el.clientHeight
      const pct   = total > 0 ? Math.round((el.scrollTop / total) * 100) : 0
      setProgress(pct)

      // save TXT scroll position as bookmark
      if (walletAddressRef.current && txId) {
        saveBookmark(txId, walletAddressRef.current, { pct })
      }
    }
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [txId])

  // ── PDF page number tracking ───────────────────────────────────────────────
  // Saves bookmark whenever the PDF page changes
  useEffect(() => {
    if (walletAddressRef.current && txId && pageNum > 1) {
      saveBookmark(txId, walletAddressRef.current, { page: pageNum })
    }
  }, [pageNum, txId])

  useEffect(() => {
    return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl) }
  }, [pdfUrl])

  useEffect(() => {
    return () => {
      try { epubRenditionRef.current?.destroy() } catch {}
      try { epubBookRef.current?.destroy()      } catch {}
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!epubReady) return
      if (e.key === 'ArrowRight') epubRenditionRef.current?.next()
      if (e.key === 'ArrowLeft')  epubRenditionRef.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [epubReady])

  const fetchBook = useCallback(async () => {
    setStatus('loading')
    setError(null)
    setEpubReady(false)
    setPdfUrl(null)
    setTextBody(null)
    setEpubChapter('')

    try { epubRenditionRef.current?.destroy(); epubRenditionRef.current = null } catch {}
    try { epubBookRef.current?.destroy();      epubBookRef.current = null      } catch {}

    try {
      // Step 1: metadata
      setLoadingMsg('Fetching book metadata...')
      const metaRes  = await fetch('/api/books')
      const metaData = await metaRes.json()
      const found: BookMeta | null = metaData.books?.find((b: BookMeta) => b.txId === txId) ?? null
      setMeta(found)
      const format: ContentFormat = found?.contentFormat ?? 'PDF'
      const mime = found?.contentMime ?? 'application/pdf'

      // Step 2: fetch encrypted content
      setLoadingMsg('Downloading encrypted content...')
      const contentRes = await fetch(`/api/content/${txId}`)
      if (!contentRes.ok) throw new Error('Could not fetch content: ' + contentRes.status)
      const encryptedBuffer = await contentRes.arrayBuffer()
      console.log('Encrypted size:', encryptedBuffer.byteLength)

      // Step 3: connect wallet
      setLoadingMsg('Connecting wallet...')
      const { requestAccess } = await import('@stellar/freighter-api')
      const accessResult = await requestAccess()
      if (accessResult.error) throw new Error('Please connect your Freighter wallet')

      // store wallet address for bookmark keys
      walletAddressRef.current = accessResult.address

      // Step 4: verify ownership + get key
      setLoadingMsg('Verifying ownership...')
      const keyRes = await fetch(
        `/api/keys?arweaveTxId=${txId}&wallet=${accessResult.address}`
      )
      if (!keyRes.ok) {
        const e = await keyRes.json()
        throw new Error(e.error || 'Could not retrieve decryption key')
      }
      const { key: keyHex, iv } = await keyRes.json()

      // Step 5: decrypt in browser
      setLoadingMsg('Decrypting...')
      const aesKey        = await importKey(keyHex)
      const decryptedData = await decryptFile(encryptedBuffer, aesKey, iv)
      console.log('Decrypted size:', decryptedData.byteLength)

      // load any existing bookmark for this book + wallet
      const bookmark = loadBookmark(txId, accessResult.address)
      if (bookmark) {
        console.log('Bookmark found:', bookmark)
      }

      // Step 6: render
      const fmt = format as string

      if (fmt === 'EPUB') {
        setLoadingMsg('Opening e-reader...')
        setStatus('ready')
        await new Promise(r => setTimeout(r, 80))

        const ePub = (await import('epubjs')).default
        if (!epubContainerRef.current) throw new Error('EPUB container not ready')

        const book = ePub(decryptedData, { openAs: 'binary' })
        epubBookRef.current = book

        const rendition = book.renderTo(epubContainerRef.current, {
          width:                '100%',
          height:               '100%',
          flow:                 'paginated',
          spread:               'none',
          allowScriptedContent: true,
        })
        epubRenditionRef.current = rendition

        rendition.themes.default(EPUB_THEME)

        rendition.on('rendered', (section: any) => {
          setTimeout(() => patchEpubSandbox(epubContainerRef.current), 50)
          const item = book.navigation?.toc?.find(
            (t: any) => t.href && section?.href && t.href.includes(section.href.split('/').pop())
          )
          setEpubChapter(item?.label?.trim() ?? '')
        })

        rendition.on('relocated', (location: any) => {
          setEpubAtStart(!!location.atStart)
          setEpubAtEnd(!!location.atEnd)

          // save EPUB bookmark — CFI string is the exact position in the book
          // epubjs CFI looks like: epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)
          if (location?.start?.cfi && walletAddressRef.current) {
            saveBookmark(txId, walletAddressRef.current, { cfi: location.start.cfi })
          }
        })

        // restore EPUB bookmark if one exists — display at saved CFI position
        // otherwise start from the beginning
        if (bookmark?.cfi) {
          console.log('Restoring EPUB position:', bookmark.cfi)
          await rendition.display(bookmark.cfi)
        } else {
          await rendition.display()
        }

        setEpubReady(true)

      } else if (fmt === 'TXT') {
        setTextBody(new TextDecoder().decode(decryptedData))
        setStatus('ready')

        // restore TXT scroll position after content renders
        if (bookmark?.pct && bookmark.pct > 0) {
          console.log('Restoring TXT scroll position:', bookmark.pct + '%')
          setTimeout(() => {
            const el    = document.documentElement
            const total = el.scrollHeight - el.clientHeight
            el.scrollTop = Math.round((bookmark.pct! / 100) * total)
          }, 200) // wait for content to render before scrolling
        }

      } else {
        // PDF
        const blob = new Blob([decryptedData], { type: mime })
        setPdfUrl(URL.createObjectURL(blob))

        // restore PDF page number if bookmark exists
        if (bookmark?.page && bookmark.page > 1) {
          console.log('Restoring PDF page:', bookmark.page)
          setPageNum(bookmark.page)
        }

        setStatus('ready')
      }

    } catch (err) {
      console.error('Reader error:', err)
      setError(err instanceof Error ? err.message : 'Failed to load book')
      setStatus('error')
    }
  }, [txId])

  useEffect(() => { if (txId) fetchBook() }, [txId])

  const format    = meta?.contentFormat ?? 'PDF'
  const bg        = darkMode ? 'bg-gray-950'     : 'bg-amber-50'
  const tx        = darkMode ? 'text-gray-100'   : 'text-gray-900'
  const barBg     = darkMode ? 'bg-gray-900'     : 'bg-white'
  const barBorder = darkMode ? 'border-gray-800' : 'border-gray-200'

  return (
    <div className={`min-h-screen ${bg} ${tx} transition-colors duration-200`}>

      <div className={`fixed top-0 left-0 right-0 z-50 ${barBg} border-b ${barBorder}`}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-4">

          <button
            onClick={() => router.push('/library')}
            className="text-gray-400 hover:text-white transition-colors text-sm flex-shrink-0"
          >
            ← Library
          </button>

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{meta?.title || 'Loading...'}</div>
            {meta?.author && (
              <div className="text-xs text-gray-500 truncate">{meta.author}</div>
            )}
          </div>

          {format === 'EPUB' && epubChapter && (
            <div className="text-xs text-gray-500 truncate max-w-xs hidden md:block">
              {epubChapter}
            </div>
          )}

          {meta?.contentFormat && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded flex-shrink-0 ${
              format === 'EPUB' ? 'bg-purple-900 text-purple-300' :
              format === 'PDF'  ? 'bg-indigo-900 text-indigo-300' :
                                  'bg-gray-800 text-gray-400'
            }`}>
              {format}
            </span>
          )}

          {format === 'EPUB' && epubReady && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => epubRenditionRef.current?.prev()} disabled={epubAtStart} className="text-gray-400 hover:text-white disabled:opacity-30 w-7 h-7 border border-gray-700 rounded flex items-center justify-center transition-colors">‹</button>
              <button onClick={() => epubRenditionRef.current?.next()} disabled={epubAtEnd}   className="text-gray-400 hover:text-white disabled:opacity-30 w-7 h-7 border border-gray-700 rounded flex items-center justify-center transition-colors">›</button>
            </div>
          )}

          {status === 'ready' && format === 'PDF' && numPages > 0 && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => setPageNum(p => Math.max(1, p - 1))} disabled={pageNum <= 1} className="text-gray-400 hover:text-white disabled:opacity-30 w-7 h-7 border border-gray-700 rounded flex items-center justify-center">‹</button>
              <span className="text-gray-400 text-xs w-20 text-center">{pageNum} / {numPages}</span>
              <button onClick={() => setPageNum(p => Math.min(numPages, p + 1))} disabled={pageNum >= numPages} className="text-gray-400 hover:text-white disabled:opacity-30 w-7 h-7 border border-gray-700 rounded flex items-center justify-center">›</button>
            </div>
          )}

          {status === 'ready' && format === 'TXT' && (
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={() => setFontSize(s => Math.max(12, s - 2))} className="text-xs text-gray-400 hover:text-white w-7 h-7 border border-gray-700 rounded flex items-center justify-center">A-</button>
              <button onClick={() => setFontSize(s => Math.min(28, s + 2))} className="text-xs text-gray-400 hover:text-white w-7 h-7 border border-gray-700 rounded flex items-center justify-center">A+</button>
              <button onClick={() => setDarkMode(d => !d)} className="text-xs text-gray-400 hover:text-white w-7 h-7 border border-gray-700 rounded flex items-center justify-center">
                {darkMode ? '☀' : '☾'}
              </button>
              <span className="text-xs text-gray-500 w-10 text-right">{progress}%</span>
            </div>
          )}
        </div>

        {format === 'TXT' && (
          <div className="absolute bottom-0 left-0 h-0.5 bg-indigo-500 transition-all duration-150" style={{ width: progress + '%' }} />
        )}
      </div>

      <div className={format === 'EPUB' ? 'pt-14 h-screen' : 'pt-20 pb-20'}>

        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center py-40">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
            <div className="text-gray-400 text-sm">{loadingMsg}</div>
          </div>
        )}

        {status === 'error' && (
          <div className="max-w-2xl mx-auto px-6 text-center py-40">
            <div className="text-5xl mb-4">📕</div>
            <div className="text-red-400 font-medium mb-2">Could not load book</div>
            <div className="text-gray-500 text-sm mb-6">{error}</div>
            <button onClick={fetchBook} className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg text-sm transition-colors">
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && format === 'EPUB' && (
          <div className="relative w-full" style={{ height: 'calc(100vh - 56px)' }}>
            <div ref={epubContainerRef} className="w-full h-full bg-white" style={{ height: 'calc(100vh - 56px)' }} />
            <button onClick={() => epubRenditionRef.current?.prev()} disabled={epubAtStart} className="absolute left-0 top-0 h-full w-16 flex items-center justify-center text-gray-400 hover:text-gray-700 disabled:opacity-0 transition-colors z-10" aria-label="Previous page">
              <span className="text-4xl select-none">‹</span>
            </button>
            <button onClick={() => epubRenditionRef.current?.next()} disabled={epubAtEnd} className="absolute right-0 top-0 h-full w-16 flex items-center justify-center text-gray-400 hover:text-gray-700 disabled:opacity-0 transition-colors z-10" aria-label="Next page">
              <span className="text-4xl select-none">›</span>
            </button>
          </div>
        )}

        {status === 'ready' && format === 'PDF' && pdfUrl && (
          <div className="max-w-3xl mx-auto px-4">
            {meta && (
              <div className="mb-8 pb-6 border-b border-gray-800">
                <h1 className="text-2xl font-bold mb-1">{meta.title}</h1>
                <p className="text-gray-400">{meta.author}{meta.edition ? ' · ' + meta.edition + ' edition' : ''}</p>
                {meta.isbn && <p className="text-gray-600 text-xs mt-1">ISBN {meta.isbn}</p>}
              </div>
            )}
            <div className="w-full rounded-xl overflow-hidden border border-gray-800">
              <iframe src={pdfUrl} className="w-full" style={{ height: '80vh' }} title={meta?.title || 'Book'} />
            </div>
          </div>
        )}

        {status === 'ready' && format === 'TXT' && textBody && (
          <div className="max-w-2xl mx-auto px-6">
            {meta && (
              <div className="mb-10 pb-8 border-b border-gray-800">
                <h1 className="font-bold leading-tight mb-2" style={{ fontSize: fontSize + 8 + 'px' }}>{meta.title}</h1>
                <p className="text-gray-400">{meta.author}{meta.edition ? ' · ' + meta.edition + ' edition' : ''}</p>
                {meta.isbn && <p className="text-gray-600 text-xs mt-1">ISBN {meta.isbn}</p>}
              </div>
            )}
            <div className="leading-relaxed whitespace-pre-wrap font-serif" style={{ fontSize: fontSize + 'px' }}>
              {textBody}
            </div>
          </div>
        )}

      </div>

      {status === 'ready' && meta && format === 'TXT' && (
        <div className={`fixed bottom-0 left-0 right-0 ${barBg} border-t ${barBorder} px-4 py-2`}>
          <div className="max-w-4xl mx-auto flex justify-between text-xs text-gray-500">
            <span className="truncate">{meta.title}</span>
            <span className="flex-shrink-0 ml-4">{progress}% complete</span>
          </div>
        </div>
      )}

    </div>
  )
}