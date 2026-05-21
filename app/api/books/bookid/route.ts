import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const arweaveTxId = searchParams.get('arweaveTxId')
  if (!arweaveTxId) return NextResponse.json({ error: 'Missing arweaveTxId' }, { status: 400 })

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  )

  const { data, error } = await supabase
    .from('books')
    .select('soroban_book_id')
    .eq('arweave_tx_id', arweaveTxId)
    .single()

  if (error || !data || data.soroban_book_id === null) {
    return NextResponse.json({ error: 'Book ID not found' }, { status: 404 })
  }

  return NextResponse.json({ bookId: data.soroban_book_id })
}
