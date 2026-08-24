// app/api/upload/cover/route.ts
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// This API route handles cover image uploads to Arweave mainnet.
//
// ── KEY DIFFERENCES FROM THE BOOK UPLOAD ROUTE ────────────────────────────────
// 1. Cover images are PUBLIC (not encrypted).
//    They are stored as plain image data on Arweave so that anyone browsing
//    the library can see them without needing to own the book.
//
// 2. Cover images can be up to 10MB so they don't need chunked upload.
//    The standard arweave.createTransaction + sign + post flow is sufficient.
//
// 3. The cover TX ID is returned to the client and then:
//    - Passed to the main upload route as the 'coverTxId' form field
//    - Stored as a 'Cover-Tx-Id' Arweave tag on the book transaction
//    - Stored in Supabase books.cover_tx_id as a fast cache
//
// ── ARWEAVE TAGS ──────────────────────────────────────────────────────────────
// Tags are permanently attached to the Arweave transaction and queryable
// via GraphQL at https://arweave.net/graphql
//
//   Content-Type  → actual image MIME type (image/jpeg, image/png, image/webp)
//                   This tells browsers how to display the image directly
//   App-Name      → 'Knowdly-Testnet' — used to filter our transactions in GraphQL
//   Type          → 'Book-Cover' — identifies this as a cover image
//   Title         → book title — for context in GraphQL queries
//   Author        → book author — for context in GraphQL queries
//
// ── CONTENT-TYPE NOTE ─────────────────────────────────────────────────────────
// Unlike the encrypted book file (which uses application/octet-stream),
// cover images use their real MIME type (image/jpeg etc.). This means
// browsers can render them directly from their Arweave URL without
// any additional processing.

import { NextRequest, NextResponse } from 'next/server'
import Arweave from 'arweave'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30  // covers are small — 30s is plenty

// ── Arweave config ────────────────────────────────────────────────────────────
// Reads from environment variables set in Vercel.
// Falls back to localhost ArLocal for local development.
const ARWEAVE_HOST     = process.env.ARWEAVE_HOST     ?? 'localhost'
const ARWEAVE_PORT     = parseInt(process.env.ARWEAVE_PORT ?? '1984')
const ARWEAVE_PROTOCOL = process.env.ARWEAVE_PROTOCOL ?? 'http'
const ARWEAVE_GATEWAY  = `${ARWEAVE_PROTOCOL}://${ARWEAVE_HOST}${ARWEAVE_PORT !== 443 && ARWEAVE_PORT !== 80 ? ':' + ARWEAVE_PORT : ''}`
const IS_LOCAL         = ARWEAVE_HOST === 'localhost'

// ── POST /api/upload/cover ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const cover    = formData.get('cover')  as File | null
    const title    = formData.get('title')  as string || ''
    const author   = formData.get('author') as string || ''

    // validate that a file was provided
    if (!cover) {
      return NextResponse.json({ error: 'No cover file provided' }, { status: 400 })
    }

    // validate that the file is actually an image
    // type starts with 'image/' covers jpeg, png, webp, gif etc.
    if (!cover.type.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image' }, { status: 400 })
    }

    // validate file size — 10MB limit accommodates AI-generated art
    // (MidJourney etc. commonly export 3-8MB) while still keeping
    // Arweave costs reasonable and library pages fast
    if (cover.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'Cover image must be under 10MB' }, { status: 400 })
    }

    // ── Initialise Arweave client ─────────────────────────────────────────
    const arweave = Arweave.init({
      host:     ARWEAVE_HOST,
      port:     ARWEAVE_PORT,
      protocol: ARWEAVE_PROTOCOL,
    })

    // ── Wallet setup ──────────────────────────────────────────────────────
    // Dev:  throwaway wallet auto-funded via ArLocal mint endpoint
    // Prod: funded wallet loaded from ARWEAVE_JWK environment variable
    //       The JWK (JSON Web Key) is the Arweave wallet's private key format.
    //       It must have enough AR to cover the transaction fee.
    let jwk: any

    if (IS_LOCAL) {
      // in local dev, generate a fresh wallet and fund it via ArLocal's
      // built-in mint endpoint (not available on mainnet)
      jwk           = await arweave.wallets.generate()
      const address = await arweave.wallets.getAddress(jwk)
      await fetch(`${ARWEAVE_GATEWAY}/mint/${address}/1000000000000`)
      await fetch(`${ARWEAVE_GATEWAY}/mine`)
    } else {
      // in production, use the funded wallet from the environment variable
      const jwkStr = process.env.ARWEAVE_JWK
      if (!jwkStr) throw new Error('ARWEAVE_JWK environment variable is required')
      jwk = JSON.parse(jwkStr)
    }

    // ── Create and tag the Arweave transaction ────────────────────────────
    // Convert the File to a Node.js Buffer for the Arweave SDK
    const buffer      = Buffer.from(await cover.arrayBuffer())
    const transaction = await arweave.createTransaction({ data: buffer }, jwk)

    // Content-Type is set to the actual image MIME type so browsers can
    // render the image directly from its Arweave URL
    transaction.addTag('Content-Type', cover.type)
    transaction.addTag('App-Name',     'Knowdly-Testnet')
    transaction.addTag('Type',         'Book-Cover')  // identifies this as a cover
    transaction.addTag('Title',        title)         // for GraphQL filtering
    transaction.addTag('Author',       author)        // for GraphQL filtering

    // ── Sign and upload ───────────────────────────────────────────────────
    // Sign the transaction with the wallet's private key.
    // This authorises the transaction and pays the Arweave storage fee.
    await arweave.transactions.sign(transaction, jwk)

    // For small files (< 256KB) we could use arweave.transactions.post()
    // directly. We use the uploader anyway for consistency and reliability.
    const uploader = await arweave.transactions.getUploader(transaction)
    while (!uploader.isComplete) {
      await uploader.uploadChunk()
    }

    // in local dev, mine a block so the transaction appears immediately
    if (IS_LOCAL) {
      await fetch(`${ARWEAVE_GATEWAY}/mine`)
    }

    console.log('Cover uploaded successfully. TX ID:', transaction.id)

    // return the TX ID to the client — this is stored on the book transaction
    return NextResponse.json({ txId: transaction.id })

  } catch (err) {
    console.error('Cover upload error:', err)
    const message = err instanceof Error ? err.message : 'Cover upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}