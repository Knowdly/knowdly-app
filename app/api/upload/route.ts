// app/api/upload/route.ts
// Same as before but now writes confirmed: false on every new upload.
// The library page checks confirmation status and flips to true at 50+ confirms.

import { NextRequest, NextResponse } from 'next/server'
import Arweave from 'arweave'
import { createClient } from '@supabase/supabase-js'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const ARWEAVE_HOST     = process.env.ARWEAVE_HOST     ?? 'localhost'
const ARWEAVE_PORT     = parseInt(process.env.ARWEAVE_PORT ?? '1984')
const ARWEAVE_PROTOCOL = process.env.ARWEAVE_PROTOCOL ?? 'http'
const ARWEAVE_GATEWAY  = `${ARWEAVE_PROTOCOL}://${ARWEAVE_HOST}${ARWEAVE_PORT !== 443 && ARWEAVE_PORT !== 80 ? ':' + ARWEAVE_PORT : ''}`
const IS_LOCAL         = ARWEAVE_HOST === 'localhost'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()

    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    console.log('Received file:', file.name, '— size:', file.size, 'bytes')

    const title         = formData.get('title')         as string || ''
    const author        = formData.get('author')        as string || ''
    const isbn          = formData.get('isbn')          as string || ''
    const edition       = formData.get('edition')       as string || ''
    const description   = formData.get('description')   as string || ''
    const price         = formData.get('price')         as string || '0'
    const royalty       = formData.get('royalty')       as string || '5'
    const category      = formData.get('category')      as string || ''
    const contentFormat = formData.get('contentFormat') as string || 'PDF'
    const contentMime   = formData.get('contentMime')   as string || 'application/pdf'
    const coverTxId     = formData.get('coverTxId')     as string || ''

    if (!title || !author) {
      return NextResponse.json({ error: 'Title and author are required' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const fileBuffer  = Buffer.from(arrayBuffer)

    const arweave = Arweave.init({ host: ARWEAVE_HOST, port: ARWEAVE_PORT, protocol: ARWEAVE_PROTOCOL })

    let jwk: any
    if (IS_LOCAL) {
      jwk           = await arweave.wallets.generate()
      const address = await arweave.wallets.getAddress(jwk)
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

    const transaction = await arweave.createTransaction({ data: fileBuffer }, jwk)

    transaction.addTag('Content-Type',   'application/octet-stream')
    transaction.addTag('App-Name',       'Knowdly')
    transaction.addTag('Content-Format', contentFormat)
    transaction.addTag('Content-Mime',   contentMime)
    transaction.addTag('Title',          title)
    transaction.addTag('Author',         author)
    transaction.addTag('Category',       category)
    transaction.addTag('ISBN',           isbn)
    transaction.addTag('Edition',        edition)
    transaction.addTag('Description',    description)
    transaction.addTag('Price',          price)
    transaction.addTag('Royalty',        royalty)
    transaction.addTag('File-Name',      file.name)
    if (coverTxId) transaction.addTag('Cover-Tx-Id', coverTxId)

    await arweave.transactions.sign(transaction, jwk)

    const uploader = await arweave.transactions.getUploader(transaction)
    while (!uploader.isComplete) {
      await uploader.uploadChunk()
      console.log(`Upload progress: ${uploader.pctComplete}%`)
    }

    if (IS_LOCAL) await fetch(`${ARWEAVE_GATEWAY}/mine`)

    console.log('Arweave upload complete. TX ID:', transaction.id)

    try {
      const supabase = getSupabase()
      const { error: dbError } = await supabase
        .from('books')
        .upsert(
          {
            arweave_tx_id:  transaction.id,
            title,
            author,
            category,
            content_format: contentFormat,
            content_mime:   contentMime,
            price,
            royalty,
            isbn,
            edition,
            description,
            file_name:      file.name,
            cover_tx_id:    coverTxId || null,
            // ── NEW: confirmed starts as false ────────────────────────────
            // The library page checks Arweave confirmation count and flips
            // this to true once the transaction reaches 50+ confirmations.
            // Until then the book is hidden from the library.
            confirmed:      IS_LOCAL, // local dev = auto-confirmed; mainnet = pending
          },
          { onConflict: 'arweave_tx_id' }
        )

      if (dbError) {
        console.error('Supabase write failed (non-fatal):', dbError.message)
      } else {
        console.log('Supabase cache updated for TX:', transaction.id)
      }
    } catch (dbErr) {
      console.error('Supabase error (non-fatal):', dbErr)
    }

    return NextResponse.json({ txId: transaction.id })

  } catch (err) {
    console.error('Arweave upload error:', err)
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}