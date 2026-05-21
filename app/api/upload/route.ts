// app/api/upload/route.ts
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// This is the main book upload API route. It runs server-side on Vercel
// and handles uploading the encrypted book file to Arweave mainnet.
//
// ── WHY SERVER-SIDE? ──────────────────────────────────────────────────────────
// The Arweave wallet's private key (JWK) must never be exposed to the browser.
// We keep it in a Vercel environment variable and only access it server-side.
// The browser sends the encrypted file to this route, which signs and
// uploads it to Arweave using the platform's funded wallet.
//
// ── DUAL INDEXING ─────────────────────────────────────────────────────────────
// After every upload, book metadata is written to TWO places:
//
//   ┌─────────────────────────────────────────────────────┐
//   │  DECENTRALISED INDEX — Arweave tags                 │
//   │  Permanent, censorship-resistant, always available  │
//   │  Queryable via GraphQL (10-30min indexing delay)    │
//   │  Source of truth — lives forever on Arweave         │
//   └─────────────────────────────────────────────────────┘
//
//   ┌─────────────────────────────────────────────────────┐
//   │  CENTRALISED INDEX — Supabase books table           │
//   │  Fast, instant, queryable immediately after upload  │
//   │  Cache only — if deleted, Arweave GraphQL is used   │
//   └─────────────────────────────────────────────────────┘
//
// The library queries Supabase first (fast), falls back to Arweave GraphQL
// if Supabase is unavailable or missing a book.
//
// ── COVER IMAGE HANDLING ──────────────────────────────────────────────────────
// If a cover TX ID was provided (from the /api/upload/cover route), it is:
//   1. Stored as a 'Cover-Tx-Id' Arweave tag on this transaction
//   2. Stored in Supabase books.cover_tx_id column
//
// This means the cover association is permanently stored on Arweave
// and queryable from both the decentralised and centralised indexes.

import { NextRequest, NextResponse } from 'next/server'
import Arweave from 'arweave'
import { createClient } from '@supabase/supabase-js'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60  // large files can take time — 60s Vercel limit

// ── Arweave config ────────────────────────────────────────────────────────────
// These are read from Vercel environment variables.
// ARWEAVE_HOST     = 'arweave.net'   (production)
// ARWEAVE_PORT     = 443             (production)
// ARWEAVE_PROTOCOL = 'https'         (production)
const ARWEAVE_HOST     = process.env.ARWEAVE_HOST     ?? 'localhost'
const ARWEAVE_PORT     = parseInt(process.env.ARWEAVE_PORT ?? '1984')
const ARWEAVE_PROTOCOL = process.env.ARWEAVE_PROTOCOL ?? 'http'
const ARWEAVE_GATEWAY  = `${ARWEAVE_PROTOCOL}://${ARWEAVE_HOST}${ARWEAVE_PORT !== 443 && ARWEAVE_PORT !== 80 ? ':' + ARWEAVE_PORT : ''}`
const IS_LOCAL         = ARWEAVE_HOST === 'localhost'

// ── Supabase client factory ───────────────────────────────────────────────────
// Creates a Supabase client using the service role key.
// The service role key bypasses Row Level Security — only use server-side.
// Never expose the service role key to the browser.
function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

// ── POST /api/upload ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()

    // ── Extract and validate the uploaded file ────────────────────────────
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    console.log('Received file:', file.name, '— size:', file.size, 'bytes')

    // ── Extract book metadata from the form ───────────────────────────────
    // These are sent from the upload page alongside the encrypted file.
    // They are stored as Arweave tags (permanent) and in Supabase (cache).
    const title         = formData.get('title')         as string || ''
    const author        = formData.get('author')        as string || ''
    const isbn          = formData.get('isbn')          as string || ''
    const edition       = formData.get('edition')       as string || ''
    const description   = formData.get('description')   as string || ''
    const price         = formData.get('price')         as string || '0'
    const royalty       = formData.get('royalty')       as string || '5'
    const category      = formData.get('category')      as string || ''
    const contentFormat = formData.get('contentFormat') as string || 'PDF'   // PDF | EPUB | TXT
    const contentMime   = formData.get('contentMime')   as string || 'application/pdf'
    const coverTxId     = formData.get('coverTxId')     as string || ''      // optional cover TX ID

    if (!title || !author) {
      return NextResponse.json(
        { error: 'Title and author are required' },
        { status: 400 }
      )
    }

    // convert File to Buffer for the Arweave SDK
    const arrayBuffer = await file.arrayBuffer()
    const fileBuffer  = Buffer.from(arrayBuffer)

    // ── Initialise Arweave client ─────────────────────────────────────────
    const arweave = Arweave.init({
      host:     ARWEAVE_HOST,
      port:     ARWEAVE_PORT,
      protocol: ARWEAVE_PROTOCOL,
    })

    // ── Wallet setup ──────────────────────────────────────────────────────
    // Dev:  ArLocal throwaway wallet, auto-funded via mint endpoint
    // Prod: Funded wallet from ARWEAVE_JWK environment variable
    //
    // The JWK is the wallet's private key in JSON format.
    // It must have enough AR balance to cover Arweave storage fees.
    // Storage cost is proportional to file size (~0.0001 AR per KB on mainnet).
    let jwk: any

    if (IS_LOCAL) {
      jwk           = await arweave.wallets.generate()
      const address = await arweave.wallets.getAddress(jwk)
      // ArLocal faucet: mint 1,000,000 AR (in winston, the smallest unit)
      await fetch(`${ARWEAVE_GATEWAY}/mint/${address}/1000000000000`)
      await fetch(`${ARWEAVE_GATEWAY}/mine`)
      console.log('ArLocal: funded throwaway wallet', address)
    } else {
      const jwkStr = process.env.ARWEAVE_JWK
      if (!jwkStr) throw new Error('ARWEAVE_JWK environment variable is required for production')
      jwk = JSON.parse(jwkStr)
      const address = await arweave.wallets.getAddress(jwk)
      console.log('Mainnet: using funded wallet', address)
    }

    // ── Create the Arweave transaction ────────────────────────────────────
    // The transaction contains the encrypted file data and metadata tags.
    const transaction = await arweave.createTransaction({ data: fileBuffer }, jwk)

    // ── Add metadata tags ─────────────────────────────────────────────────
    // Tags are permanently attached to the Arweave transaction.
    // They can be queried via GraphQL at https://arweave.net/graphql
    //
    // Content-Type: application/octet-stream — signals encrypted binary data.
    //   Using the real MIME type (e.g. application/pdf) would be wrong here
    //   because the data is encrypted and not directly renderable.
    //
    // App-Name: Knowdly — used to filter our books in GraphQL:
    //   query { transactions(tags: [{ name: "App-Name", values: ["Knowdly"] }]) }
    //
    // Content-Format: PDF | EPUB | TXT — the original file format.
    //   Used by the reader to choose the right renderer (epubjs, pdf, text).
    //
    // Content-Mime: the original MIME type.
    //   Used when creating the decrypted Blob for rendering.
    //
    // Cover-Tx-Id: the Arweave TX ID of the cover image (if provided).
    //   This permanently links the cover to the book on Arweave.
    transaction.addTag('Content-Type',    'application/octet-stream')
    transaction.addTag('App-Name',        'Knowdly')
    transaction.addTag('Content-Format',  contentFormat)
    transaction.addTag('Content-Mime',    contentMime)
    transaction.addTag('Title',           title)
    transaction.addTag('Author',          author)
    transaction.addTag('Category',        category)
    transaction.addTag('ISBN',            isbn)
    transaction.addTag('Edition',         edition)
    transaction.addTag('Description',     description)
    transaction.addTag('Price',           price)
    transaction.addTag('Royalty',         royalty)
    transaction.addTag('File-Name',       file.name)
    if (coverTxId) {
      // only add this tag if a cover was uploaded — optional field
      transaction.addTag('Cover-Tx-Id',   coverTxId)
    }

    // ── Sign the transaction ──────────────────────────────────────────────
    // Signing authorises the transaction and computes the Arweave TX ID.
    // The TX ID is a SHA-256 hash of the transaction data.
    // After signing, transaction.id contains the final TX ID.
    await arweave.transactions.sign(transaction, jwk)

    // ── Chunked upload ────────────────────────────────────────────────────
    // Arweave requires chunked upload for files over 256KB.
    // The uploader splits the data into chunks and uploads them one by one.
    // Each chunk is verified by the Arweave network before the next is sent.
    // This is more reliable than a single POST for large files.
    const uploader = await arweave.transactions.getUploader(transaction)

    while (!uploader.isComplete) {
      await uploader.uploadChunk()
      console.log(
        `Upload progress: ${uploader.pctComplete}% ` +
        `(chunk ${uploader.uploadedChunks}/${uploader.totalChunks})`
      )
    }

    // in local dev, mine a block to make the transaction immediately available
    // on mainnet, blocks are mined automatically every ~2 minutes
    if (IS_LOCAL) {
      await fetch(`${ARWEAVE_GATEWAY}/mine`)
    }

    console.log('Arweave upload complete. TX ID:', transaction.id)

    // ── Write to Supabase (centralised cache) ─────────────────────────────
    // This write is wrapped in try/catch because it's non-fatal.
    // If Supabase is down or the write fails, the book is still on Arweave
    // and will eventually appear via the GraphQL fallback (after ~10-30 minutes).
    //
    // upsert with onConflict: 'arweave_tx_id' means:
    //   - if a row with this TX ID already exists → update it
    //   - if not → insert a new row
    // This prevents duplicates if the route is called twice for the same TX.
    try {
      const supabase = getSupabase()
      const { error: dbError } = await supabase
        .from('books')
        .upsert(
          {
            arweave_tx_id:  transaction.id,   // primary identifier
            title,
            author,
            category,
            content_format: contentFormat,    // PDF | EPUB | TXT
            content_mime:   contentMime,      // original MIME type
            price,
            royalty,
            isbn,
            edition,
            description,
            file_name:      file.name,
            cover_tx_id:    coverTxId || null, // null if no cover was uploaded
          },
          { onConflict: 'arweave_tx_id' }     // upsert key
        )

      if (dbError) {
        // log but don't fail — Arweave is the source of truth
        console.error('Supabase write failed (non-fatal):', dbError.message)
      } else {
        console.log('Supabase cache updated for TX:', transaction.id)
      }
    } catch (dbErr) {
      // Supabase failure is non-fatal — book is permanently on Arweave
      console.error('Supabase error (non-fatal):', dbErr)
    }

    // return the Arweave TX ID to the client
    // the client uses this to:
    //   1. Store it in state (displayed in the success panel)
    //   2. Store the encryption key against it (Step 6 in upload page)
    //   3. Update the on-chain TX ID (Step 8 in upload page)
    return NextResponse.json({ txId: transaction.id })

  } catch (err) {
    console.error('Arweave upload error:', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}