// app/api/books/confirm/route.ts
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// Called by the library page on load to check and confirm pending books.
// Queries Arweave for confirmation count on any unconfirmed books.
// If a book has 50+ confirmations, flips confirmed = true in Supabase.
// Returns the list of newly confirmed TX IDs so the library can refresh.
//
// This route is called once per library page load — lightweight since
// most books will already be confirmed and the query returns quickly.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIN_CONFIRMATIONS = 50

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function GET() {
  try {
    const supabase = getSupabase()

    // find all unconfirmed books
    const { data: pending, error } = await supabase
      .from('books')
      .select('arweave_tx_id, title')
      .eq('confirmed', false)

    if (error || !pending || pending.length === 0) {
      return NextResponse.json({ confirmed: [] })
    }

    console.log(`Checking ${pending.length} unconfirmed books...`)

    const newlyConfirmed: string[] = []

    // check each unconfirmed book's confirmation count
    await Promise.all(pending.map(async (book) => {
      try {
        const res = await fetch(
          `https://arweave.net/tx/${book.arweave_tx_id}/status`,
          { signal: AbortSignal.timeout(5000) }
        )

        if (!res.ok) return // pending or not found yet

        const data = await res.json()
        const confirmations = data?.number_of_confirmations ?? 0

        console.log(`${book.title}: ${confirmations} confirmations`)

        if (confirmations >= MIN_CONFIRMATIONS) {
          // flip to confirmed in Supabase
          await supabase
            .from('books')
            .update({ confirmed: true })
            .eq('arweave_tx_id', book.arweave_tx_id)

          newlyConfirmed.push(book.arweave_tx_id)
          console.log(`✓ Confirmed: ${book.title} (${book.arweave_tx_id})`)
        }
      } catch (err) {
        // non-fatal — will be checked again on next library load
        console.error(`Could not check confirmation for ${book.arweave_tx_id}:`, err)
      }
    }))

    return NextResponse.json({ confirmed: newlyConfirmed })

  } catch (err) {
    console.error('Confirmation check error:', err)
    return NextResponse.json({ confirmed: [] })
  }
}