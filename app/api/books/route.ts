// app/api/books/route.ts
// Queries the book catalogue using dual indexing strategy:
//
//   ┌─────────────────────────────────────────────────────┐
//   │  PRIMARY — Supabase centralised index               │
//   │  Instant response, no indexing delay                │
//   │  Written to on every upload                         │
//   │  Queried first on every library load                │
//   └─────────────────────────────────────────────────────┘
//        ↓ if Supabase fails or returns empty
//   ┌─────────────────────────────────────────────────────┐
//   │  FALLBACK — Arweave GraphQL decentralised index     │
//   │  Permanent, censorship-resistant                    │
//   │  10-30min indexing delay on mainnet                 │
//   │  Used when Supabase is unavailable                  │
//   └─────────────────────────────────────────────────────┘
//
// Results from both sources are merged and deduplicated by arweave_tx_id.
//
// ── COVER IMAGES ──────────────────────────────────────────────────────────────
// Cover images are stored as separate Arweave transactions.
// The book transaction has a 'Cover-Tx-Id' tag pointing to the cover TX.
// The Supabase books table has a cover_tx_id column as a fast cache.
//
// Cover TX IDs are included in the Book object returned by this route.
// The library uses them to fetch covers via:
//   https://arweave.net/<coverTxId>
//
// If no cover exists, the library shows a styled placeholder with
// the book title and author.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Arweave GraphQL endpoint ──────────────────────────────────────────────────
// Dev:        ARWEAVE_GRAPHQL=http://localhost:1984/graphql
// Production: ARWEAVE_GRAPHQL=https://arweave.net/graphql
const ARWEAVE_GRAPHQL = process.env.ARWEAVE_GRAPHQL ?? 'https://arweave.net/graphql'

// ── Supabase client factory ───────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Tag = { name: string; value: string }
type Node = { id: string; tags: Tag[] }

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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Finds a tag value by name from an array of Arweave tags
function tag(tags: Tag[], name: string): string {
  return tags.find(t => t.name === name)?.value || ''
}

// Converts an Arweave GraphQL node to a Book object.
// Supports both old tag schema (Book-Title) and new schema (Title)
// for backwards compatibility with early test uploads.
function nodeToBook(node: Node): Book {
  const tags = node.tags
  return {
    txId:          node.id,
    title:         tag(tags, 'Title')          || tag(tags, 'Book-Title'),
    author:        tag(tags, 'Author')         || tag(tags, 'Book-Author'),
    isbn:          tag(tags, 'ISBN')           || tag(tags, 'Book-ISBN'),
    edition:       tag(tags, 'Edition')        || tag(tags, 'Book-Edition'),
    description:   tag(tags, 'Description'),
    price:         tag(tags, 'Price')          || tag(tags, 'Book-Price'),
    royalty:       tag(tags, 'Royalty')        || tag(tags, 'Book-Royalty'),
    fileName:      tag(tags, 'File-Name'),
    contentType:   tag(tags, 'Content-Type'),
    contentFormat: tag(tags, 'Content-Format') || 'PDF',
    contentMime:   tag(tags, 'Content-Mime')   || 'application/pdf',
    category:      tag(tags, 'Category'),
    coverTxId:     tag(tags, 'Cover-Tx-Id'),   // empty string if no cover tag
  }
}

// Converts a Supabase row to a Book object.
// The cover_tx_id column was added to the books table to cache the cover TX ID.
function rowToBook(row: any): Book {
  return {
    txId:          row.arweave_tx_id,
    title:         row.title          || '',
    author:        row.author         || '',
    isbn:          row.isbn           || '',
    edition:       row.edition        || '',
    description:   row.description    || '',
    price:         row.price          || '0',
    royalty:       row.royalty        || '0',
    fileName:      row.file_name      || '',
    contentType:   'application/octet-stream',
    contentFormat: row.content_format || 'PDF',
    contentMime:   row.content_mime   || 'application/pdf',
    category:      row.category       || '',
    coverTxId:     row.cover_tx_id    || '',   // null → empty string
  }
}

// ── CENTRALISED INDEX — query Supabase ────────────────────────────────────────
// Fast primary source — written to on every upload.
// Returns books instantly with no GraphQL indexing delay.
// Includes cover_tx_id from the books table.

async function querySupabase(
  search:   string,
  category: string,
  format:   string,
): Promise<Book[]> {
  const supabase = getSupabase()

  // select all columns — this includes cover_tx_id now that the column exists
  let query = supabase
    .from('books')
    .select('*')
    .order('created_at', { ascending: false })

  // filter by category (case-insensitive)
  if (category.trim()) {
    query = query.ilike('category', category.trim())
  }

  // filter by content format (PDF, EPUB, TXT)
  if (format.trim()) {
    query = query.ilike('content_format', format.trim())
  }

  const { data, error } = await query

  if (error) {
    console.error('Supabase query error:', error.message)
    return []
  }

  let books = (data || []).map(rowToBook)

  // search is applied client-side here — fast enough for current catalogue size
  // upgrade to Supabase full-text search when catalogue grows
  if (search.trim()) {
    const term = search.toLowerCase()
    books = books.filter(b =>
      b.title.toLowerCase().includes(term)    ||
      b.author.toLowerCase().includes(term)   ||
      b.category.toLowerCase().includes(term) ||
      b.isbn.toLowerCase().includes(term)
    )
  }

  console.log(`Supabase index returned ${books.length} books`)
  return books
}

// ── DECENTRALISED INDEX — query Arweave GraphQL ───────────────────────────────
// Permanent fallback — always available as long as Arweave exists.
// Note: new transactions take 10-30 minutes to appear after upload on mainnet.
// Cover TX IDs are read from the Cover-Tx-Id tag on each book transaction.

async function queryArweave(
  search:   string,
  category: string,
  format:   string,
): Promise<Book[]> {
  // query all transactions tagged with App-Name: Knowdly
  // sorted by block height descending (most recent first)
  const query = `
    query {
      transactions(
        first: 100
        sort: HEIGHT_DESC
        tags: [{ name: "App-Name", values: ["Knowdly"] }]
      ) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `

  const response = await fetch(ARWEAVE_GRAPHQL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ query }),
  })

  if (!response.ok) {
    throw new Error('Arweave GraphQL request failed: ' + response.status)
  }

  const json  = await response.json()
  const edges = json?.data?.transactions?.edges || []

  let books: Book[] = []

  for (const edge of edges) {
    const node: Node = edge.node

    // double-check App-Name tag — GraphQL filter should handle this but be safe
    if (tag(node.tags, 'App-Name') !== 'Knowdly') continue

    // skip cover image transactions — they have Type: Book-Cover
    // we only want the encrypted book transactions here
    if (tag(node.tags, 'Type') === 'Book-Cover') continue

    const title = tag(node.tags, 'Title') || tag(node.tags, 'Book-Title')
    if (!title) continue

    // nodeToBook reads the Cover-Tx-Id tag if present
    books.push(nodeToBook(node))
  }

  // apply filters
  if (search.trim()) {
    const term = search.toLowerCase()
    books = books.filter(b =>
      b.title.toLowerCase().includes(term)    ||
      b.author.toLowerCase().includes(term)   ||
      b.category.toLowerCase().includes(term) ||
      b.isbn.toLowerCase().includes(term)
    )
  }
  if (category.trim()) {
    books = books.filter(b => b.category.toLowerCase() === category.toLowerCase())
  }
  if (format.trim()) {
    books = books.filter(b => b.contentFormat.toLowerCase() === format.toLowerCase())
  }

  console.log(`Arweave GraphQL index returned ${books.length} books`)
  return books
}

// ── GET /api/books ────────────────────────────────────────────────────────────
// Dual indexing strategy:
//   1. Query Supabase first (fast, centralised, includes cover_tx_id)
//   2. Query Arweave GraphQL as fallback (slow, decentralised, reads Cover-Tx-Id tag)
//   3. Filter both against Supabase blocklist
//   4. Merge and deduplicate results by txId
//   5. Return merged list including coverTxId for each book

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const search   = searchParams.get('search')   || ''
    const category = searchParams.get('category') || ''
    const format   = searchParams.get('format')   || ''

    // ── Fetch blocklist ───────────────────────────────────────────────────────
    // Blocks specific Arweave TX IDs from appearing in the library.
    // Used to hide test uploads, unavailable books, or flagged content.
    // Permanently stored on Arweave but hidden from discovery via this list.
    let blockedIds = new Set<string>()
    try {
      const supabase = getSupabase()
      const { data: blocked } = await supabase
        .from('blocklist')
        .select('arweave_tx_id')
      blockedIds = new Set(blocked?.map((b: any) => b.arweave_tx_id) ?? [])
      if (blockedIds.size > 0) {
        console.log(`Blocklist active: ${blockedIds.size} TX IDs blocked`)
      }
    } catch (err) {
      console.error('Could not fetch blocklist (non-fatal):', err)
    }

    // ── Step 1: Query Supabase (primary) ──────────────────────────────────────
    let supabaseBooks: Book[] = []
    try {
      supabaseBooks = (await querySupabase(search, category, format))
        .filter(b => !blockedIds.has(b.txId))
    } catch (err) {
      console.error('Supabase query failed, falling back to Arweave:', err)
    }

    // ── Step 2: Query Arweave GraphQL (fallback) ──────────────────────────────
    let arweaveBooks: Book[] = []
    try {
      arweaveBooks = (await queryArweave(search, category, format))
        .filter(b => !blockedIds.has(b.txId))
    } catch (err) {
      console.error('Arweave GraphQL query failed:', err)
    }

    // ── Step 3: Merge and deduplicate ─────────────────────────────────────────
    // Supabase results take priority — they have cover_tx_id populated.
    // Arweave results are added only if not already in Supabase results.
    const seen  = new Set<string>()
    const books: Book[] = []

    for (const book of supabaseBooks) {
      if (!seen.has(book.txId)) {
        seen.add(book.txId)
        books.push(book)
      }
    }

    for (const book of arweaveBooks) {
      if (!seen.has(book.txId)) {
        seen.add(book.txId)
        books.push(book)
      }
    }

    console.log(`Total books after merge: ${books.length} (${supabaseBooks.length} from Supabase, ${arweaveBooks.length} from Arweave, ${blockedIds.size} blocked)`)

    return NextResponse.json({ books })

  } catch (err) {
    console.error('Books query error:', err)
    const message = err instanceof Error ? err.message : 'Query failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}