// app/api/listings/route.ts
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// Manages resale listings for the Knowdly marketplace.
//
// GET  /api/listings              — returns all active listings with book metadata
// POST /api/listings              — creates a new listing (seller lists a book)
// DELETE /api/listings?tokenId=X  — removes a listing (after sale or cancellation)
//
// ── DECENTRALISATION NOTE ─────────────────────────────────────────────────────
// Listings are stored in Supabase for fast querying — they are temporary records
// that exist only while a book is listed for sale. The completed transfer is
// permanently recorded on the Soroban contract via transfer_token, which emits
// a transfer event with token_id, old_owner, new_owner. That on-chain record
// is the permanent proof of every resale — Supabase is just the fast index.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

// ── GET /api/listings ─────────────────────────────────────────────────────────
// Returns all active listings joined with book metadata from the books table.
// Used by the marketplace page to display available resale books.

export async function GET() {
  try {
    const supabase = getSupabase()

    // join listings with books to get full book metadata
    const { data, error } = await supabase
      .from('listings')
      .select(`
        id,
        token_id,
        book_id,
        arweave_tx_id,
        seller_address,
        asking_price,
        created_at,
        books (
          title,
          author,
          category,
          content_format,
          description,
          cover_tx_id,
          royalty
        )
      `)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ listings: data || [] })

  } catch (err) {
    console.error('Listings fetch error:', err)
    return NextResponse.json({ error: 'Failed to fetch listings' }, { status: 500 })
  }
}

// ── POST /api/listings ────────────────────────────────────────────────────────
// Creates a new resale listing.
// Called when a seller lists a book from their My Library page.
// Body: { tokenId, bookId, arweaveTxId, sellerAddress, askingPrice }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tokenId, bookId, arweaveTxId, sellerAddress, askingPrice } = body

    if (!tokenId === undefined || !bookId === undefined || !arweaveTxId || !sellerAddress || !askingPrice) {
      return NextResponse.json(
        { error: 'Missing required fields: tokenId, bookId, arweaveTxId, sellerAddress, askingPrice' },
        { status: 400 }
      )
    }

    if (parseFloat(askingPrice) <= 0) {
      return NextResponse.json(
        { error: 'Asking price must be greater than 0' },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // upsert — if this token is already listed, update the price
    const { data, error } = await supabase
      .from('listings')
      .upsert(
        {
          token_id:       tokenId,
          book_id:        bookId,
          arweave_tx_id:  arweaveTxId,
          seller_address: sellerAddress,
          asking_price:   askingPrice,
        },
        { onConflict: 'token_id' }
      )
      .select()
      .single()

    if (error) throw error

    console.log(`Listing created: token ${tokenId} by ${sellerAddress} at $${askingPrice}`)
    return NextResponse.json({ listing: data })

  } catch (err) {
    console.error('Listing creation error:', err)
    return NextResponse.json({ error: 'Failed to create listing' }, { status: 500 })
  }
}

// ── DELETE /api/listings ──────────────────────────────────────────────────────
// Removes a listing after a successful resale or if the seller cancels.
// Params: ?tokenId=X

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const tokenId = searchParams.get('tokenId')

    if (!tokenId) {
      return NextResponse.json({ error: 'Missing tokenId' }, { status: 400 })
    }

    const supabase = getSupabase()

    const { error } = await supabase
      .from('listings')
      .delete()
      .eq('token_id', parseInt(tokenId))

    if (error) throw error

    console.log(`Listing removed for token ${tokenId}`)
    return NextResponse.json({ success: true })

  } catch (err) {
    console.error('Listing deletion error:', err)
    return NextResponse.json({ error: 'Failed to remove listing' }, { status: 500 })
  }
}