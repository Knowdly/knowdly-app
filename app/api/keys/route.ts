// app/api/keys/route.ts
// Server-side key management — stores and releases AES-256 encryption keys
// Keys are only released to wallets that own the corresponding Soroban NFT
// Keys persist to Supabase PostgreSQL — survives server restarts and deployments
//
// Requires in .env.local:
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_SERVICE_KEY=your_service_role_key

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Account,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Supabase client (server-side only) ───────────────────────────────────────
// Uses the service role key which bypasses RLS
// NEVER expose this key in the browser

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment')
  }

  return createClient(url, key)
}

// ── Stellar RPC config ────────────────────────────────────────────────────────

const RPC_URL     = 'https://soroban-testnet.stellar.org'
const NETWORK     = Networks.TESTNET
const CONTRACT_ID = 'CAHXGGN2SCRT5ULEXCMEJMSSVXBA4KF3K4Z2XMZPWFU3NFQDGSYKDQ73'

// ── Verify ownership on-chain ─────────────────────────────────────────────────
// calls owns_book() on the Soroban contract
// returns true only if the wallet holds the NFT for this book

async function verifyOwnership(
  walletAddress: string,
  bookId:        number
): Promise<boolean> {
  console.log('verifyOwnership called for wallet:', walletAddress, 'bookId:', bookId)
  try {
    const contract = new Contract(CONTRACT_ID)
    const account  = new Account(walletAddress, '0')

    // get all token IDs owned by this wallet
    const getTokensTransaction = new TransactionBuilder(account, {
      fee:               BASE_FEE,
      networkPassphrase: NETWORK,
    })
      .addOperation(
        contract.call(
          'get_tokens_by_owner',
          nativeToScVal(walletAddress, { type: 'address' }),
        )
      )
      .setTimeout(30)
      .build()

    const tokensResponse = await fetch(RPC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'simulateTransaction',
        params:  { transaction: getTokensTransaction.toXDR() },
      }),
    })

    const tokensData = await tokensResponse.json()
    console.log('getTokensByOwner raw response:', JSON.stringify(tokensData?.result?.error || tokensData?.result?.results?.[0]?.xdr ? 'has XDR' : 'no XDR'))
    const tokensXdr  = tokensData.result?.results?.[0]?.xdr
    if (!tokensXdr) return false

    const tokenIds = scValToNative(xdr.ScVal.fromXDR(tokensXdr, 'base64')) as any[]
    if (!tokenIds || tokenIds.length === 0) return false

    console.log(`Wallet ${walletAddress} owns token IDs:`, tokenIds.map(Number))

    // for each token check if it matches the requested bookId
    for (const rawTokenId of tokenIds) {
      const tokenId = Number(rawTokenId)

      const getTokenTransaction = new TransactionBuilder(account, {
        fee:               BASE_FEE,
        networkPassphrase: NETWORK,
      })
        .addOperation(
          contract.call(
            'get_token',
            nativeToScVal(BigInt(tokenId), { type: 'u64' }),
          )
        )
        .setTimeout(30)
        .build()

      const tokenResponse = await fetch(RPC_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'simulateTransaction',
          params:  { transaction: getTokenTransaction.toXDR() },
        }),
      })

      const tokenData = await tokenResponse.json()
      const tokenXdr  = tokenData.result?.results?.[0]?.xdr
      if (!tokenXdr) continue

      const token  = scValToNative(xdr.ScVal.fromXDR(tokenXdr, 'base64')) as any
      const tBookId = Number(token?.book_id)
      console.log(`Token ${tokenId} → bookId ${tBookId}`)

      if (tBookId === bookId) {
        console.log(`Ownership confirmed: wallet owns token ${tokenId} for book ${bookId}`)
        return true
      }
    }

    return false

  } catch (err) {
    console.error('Ownership verification failed:', err)
    return false
  }
}

// ── POST /api/keys ────────────────────────────────────────────────────────────
// Called by the upload page after successful Arweave upload + book registration
// Stores the AES key tied to the Soroban book ID in Supabase
// Body: { arweaveTxId, bookId, key, iv }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { arweaveTxId, bookId, key, iv } = body

    if (!arweaveTxId || bookId === undefined || !key || !iv) {
      return NextResponse.json(
        { error: 'Missing required fields: arweaveTxId, bookId, key, iv' },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // upsert — if a key already exists for this txId, update it
    // handles re-uploads cleanly
    const { error } = await supabase
      .from('keys')
      .upsert(
        { arweave_tx_id: arweaveTxId, book_id: bookId, key, iv },
        { onConflict: 'arweave_tx_id' }
      )

    if (error) {
      console.error('Supabase key storage error:', error)
      return NextResponse.json(
        { error: 'Failed to store key: ' + error.message },
        { status: 500 }
      )
    }

    console.log(`Key stored for book ID ${bookId}, Arweave TX: ${arweaveTxId}`)

    return NextResponse.json({ success: true })

  } catch (err) {
    console.error('Key storage error:', err)
    return NextResponse.json(
      { error: 'Failed to store key' },
      { status: 500 }
    )
  }
}

// ── GET /api/keys ─────────────────────────────────────────────────────────────
// Called by the reader page when a user opens a book
// Verifies on-chain ownership before releasing the decryption key
// Params: ?arweaveTxId=xxx&wallet=Gxxx

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const arweaveTxId   = searchParams.get('arweaveTxId')
    const walletAddress = searchParams.get('wallet')

    if (!arweaveTxId || !walletAddress) {
      return NextResponse.json(
        { error: 'Missing required params: arweaveTxId, wallet' },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // look up the key from Supabase
    const { data, error } = await supabase
      .from('keys')
      .select('book_id, key, iv')
      .eq('arweave_tx_id', arweaveTxId)
      .single()

    if (error || !data) {
      return NextResponse.json(
        { error: 'Key not found for this book' },
        { status: 404 }
      )
    }

    // verify the wallet owns this book on-chain via Soroban
    console.log(
      `Checking ownership: wallet ${walletAddress} for book ID ${data.book_id}`
    )
    const owns = await verifyOwnership(walletAddress, data.book_id)

    if (!owns) {
      return NextResponse.json(
        { error: 'Access denied — you do not own this book' },
        { status: 403 }
      )
    }

    // ownership confirmed — release the decryption key
    console.log(
      `Key released for book ID ${data.book_id} to wallet ${walletAddress}`
    )

    return NextResponse.json({
      key: data.key,
      iv:  data.iv,
    })

  } catch (err) {
    console.error('Key retrieval error:', err)
    return NextResponse.json(
      { error: 'Failed to retrieve key' },
      { status: 500 }
    )
  }
}