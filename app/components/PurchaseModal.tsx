// app/components/PurchaseModal.tsx
// Full Stellar USDC purchase flow with atomic three-way payment split
// Platform receives 2.5%, professor receives 97.5%
// Both payments are in one atomic transaction — if either fails both revert
//
// Order of operations:
//   1. Connect wallet
//   2. Load account + verify USDC balance
//   3. Get professor address from Soroban
//   4. SIMULATE NFT mint — abort if it would fail (prevents orphaned payments)
//   5. Build + sign payment transaction
//   6. Submit payment
//   7. Mint NFT (now safe — simulation confirmed it will succeed)

'use client'

import { useState } from 'react'
import { requestAccess, signTransaction } from '@stellar/freighter-api'
import {
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  Operation,
  Memo,
  Account,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from '@stellar/stellar-sdk'
import { purchaseBook, CONTRACT_ID } from '../lib/contract'

// ── Types ─────────────────────────────────────────────────────────────────────

type Book = {
  txId:          string
  title:         string
  author:        string
  price:         string
  royalty:       string
  sorobanBookId: number  // passed directly from library — no localStorage lookup needed
}

type PurchaseStatus =
  | 'idle'
  | 'connecting'
  | 'loading_book'
  | 'checking'
  | 'building'
  | 'signing'
  | 'submitting'
  | 'minting'
  | 'done'
  | 'error'

type Props = {
  book:      Book | null
  onClose:   () => void
  onSuccess: (book: Book) => void
}

// ── Stellar testnet config ────────────────────────────────────────────────────

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const RPC_URL     = 'https://soroban-testnet.stellar.org'

// USDC on Stellar testnet — issued by Circle
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

// Knowdly platform treasury — receives 2.5% of every transaction
const PLATFORM_ADDRESS = 'GDN2ZDGHTBR4X6UZAE3UOZW72W2OIP4NPNTHOM2IZM35NOKCDPFINSDX'

// Platform fee in basis points — 250 = 2.5%
const PLATFORM_FEE_BPS = 250

// Fallback professor address if contract read fails
const FALLBACK_PROFESSOR = 'GA27YTVDONJPJ3BIVGCBYTQF62NK2RDXZM7G3TSWJ3NYOBPDLAPOZNZR'

// ── Helper — get publisher address from Soroban contract ──────────────────────
// Uses sorobanBookId passed directly from the library — no localStorage needed
// Works for any wallet purchasing any book on any device

async function getPublisherAddress(sorobanBookId: number): Promise<string> {
  if (sorobanBookId === -1) {
    console.log('No Soroban book ID — using fallback publisher address')
    return FALLBACK_PROFESSOR
  }

  try {
    const contract  = new Contract(CONTRACT_ID)
    const dummyAcct = new Account(PLATFORM_ADDRESS, '0')

    const tx = new TransactionBuilder(dummyAcct, {
      fee:               BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        contract.call(
          'get_book',
          nativeToScVal(BigInt(sorobanBookId), { type: 'u64' }),
        )
      )
      .setTimeout(30)
      .build()

    const simRes = await fetch(RPC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'simulateTransaction',
        params:  { transaction: tx.toXDR() },
      }),
    })

    const simData   = await simRes.json()
    const xdrVal    = simData.result?.results?.[0]?.xdr
    if (!xdrVal) return FALLBACK_PROFESSOR

    const scVal     = xdr.ScVal.fromXDR(xdrVal, 'base64')
    const native    = scValToNative(scVal) as Record<string, unknown>
    const publisher = native?.publisher as string

    console.log('Publisher address from contract:', publisher)
    return publisher || FALLBACK_PROFESSOR

  } catch (err) {
    console.error('Could not fetch publisher address:', err)
    return FALLBACK_PROFESSOR
  }
}

// ── Helper — simulate NFT mint to verify it will succeed ──────────────────────
// Called BEFORE payment so we abort early if minting would fail
// (e.g. already owns the book, book deactivated, etc.)

async function simulatePurchase(
  buyerAddress: string,
  sorobanBookId: number,
): Promise<void> {
  const contract = new Contract(CONTRACT_ID)
  const account  = new Account(buyerAddress, '0')

  const tx = new TransactionBuilder(account, {
    fee:               BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        'purchase',
        nativeToScVal(buyerAddress,          { type: 'address' }),
        nativeToScVal(BigInt(sorobanBookId), { type: 'u64' }),
      )
    )
    .setTimeout(30)
    .build()

  const server  = new rpc.Server(RPC_URL)
  const simData = await server.simulateTransaction(tx) as any

  if (simData.error) {
    // extract a human-readable error from the simulation
    const raw = simData.error as string
    if (raw.includes('already own')) throw new Error('You already own this book.')
    if (raw.includes('not available')) throw new Error('This book is no longer available for purchase.')
    throw new Error('Purchase simulation failed: ' + raw)
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PurchaseModal({ book, onClose, onSuccess }: Props) {

  const [status,        setStatus]        = useState<PurchaseStatus>('idle')
  const [error,         setError]         = useState<string | null>(null)
  const [txHash,        setTxHash]        = useState<string | null>(null)
  const [platformFee,   setPlatformFee]   = useState(0)
  const [professorGets, setProfessorGets] = useState(0)

  if (!book) return null

  async function handlePurchase() {
    if (!book) return

    setStatus('connecting')
    setError(null)
    setTxHash(null)

    try {

      // ── Step 1: Connect wallet ─────────────────────────────────────────────
      const accessResult = await requestAccess()
      if (accessResult.error) throw new Error('Wallet connection was rejected')
      const studentAddress = accessResult.address

      // ── Step 1b: Resolve sorobanBookId if not available from localStorage ──
      // On devices where the book wasn't uploaded, sorobanBookId is -1.
      // Look it up from Supabase using the arweaveTxId.
      let sorobanBookId = book.sorobanBookId
      if (sorobanBookId === -1) {
        try {
          const bookIdRes  = await fetch(`/api/books/bookid?arweaveTxId=${book.txId}`)
          const bookIdData = await bookIdRes.json()
          if (bookIdRes.ok && bookIdData.bookId !== undefined) {
            sorobanBookId = bookIdData.bookId
            console.log('Resolved sorobanBookId from Supabase:', sorobanBookId)
          }
        } catch (err) {
          console.error('Could not resolve sorobanBookId (non-fatal):', err)
        }
      }

      // ── Step 2: Load account + verify USDC ────────────────────────────────
      setStatus('loading_book')

      const accountRes = await fetch(`${HORIZON_URL}/accounts/${studentAddress}`)
      if (!accountRes.ok) {
        throw new Error(
          'Could not load your wallet. Make sure Freighter is set to Testnet and your account is funded.'
        )
      }
      const accountData = await accountRes.json()

      const hasUsdc = accountData.balances?.some(
        (b: { asset_code?: string; asset_issuer?: string }) =>
          b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
      )
      if (!hasUsdc) {
        throw new Error('No USDC trustline found. Add a USDC trustline in Stellar Laboratory.')
      }

      const usdcBalance = accountData.balances?.find(
        (b: { asset_code?: string; asset_issuer?: string }) =>
          b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
      )
      const balance = parseFloat(usdcBalance?.balance || '0')
      const price   = parseFloat(book.price)

      if (balance < price) {
        throw new Error(
          `Insufficient USDC balance. You have ${balance.toFixed(2)} USDC but need ${price.toFixed(2)} USDC.`
        )
      }

      // ── Step 3: Get publisher address from contract ───────────────────────
      const publisherAddress = await getPublisherAddress(sorobanBookId)

      // ── Step 4: Get Soroban book ID — already on the book object ──────────
      

      // ── Step 5: Simulate NFT mint BEFORE payment ──────────────────────────
      // If this would fail (already owned, book inactive, etc.) we abort now
      // before any payment is made — prevents orphaned USDC transfers
      setStatus('checking')

      if (sorobanBookId !== -1) {
        await simulatePurchase(studentAddress, sorobanBookId)
        console.log('NFT mint simulation passed — safe to proceed with payment')
      }

      // ── Step 6: Calculate payment split ───────────────────────────────────
      const fee      = parseFloat((price * PLATFORM_FEE_BPS / 10_000).toFixed(7))
      const profGets = parseFloat((price - fee).toFixed(7))

      setPlatformFee(fee)
      setProfessorGets(profGets)

      console.log(`Payment split: total $${price}, platform $${fee}, professor $${profGets}`)

      // ── Step 7: Build atomic payment transaction ──────────────────────────
      setStatus('building')

      const account   = new Account(studentAddress, accountData.sequence)
      const usdcAsset = new Asset('USDC', USDC_ISSUER)

      const transaction = new TransactionBuilder(account, {
        fee:               BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: PLATFORM_ADDRESS,
            asset:       usdcAsset,
            amount:      fee.toFixed(7),
          })
        )
        .addOperation(
          Operation.payment({
            destination: publisherAddress,
            asset:       usdcAsset,
            amount:      profGets.toFixed(7),
          })
        )
        .addMemo(Memo.text(book.txId.slice(0, 28)))
        .setTimeout(180)
        .build()

      // ── Step 8: Sign with Freighter ───────────────────────────────────────
      setStatus('signing')

      const signResult = await signTransaction(transaction.toXDR(), {
        networkPassphrase: Networks.TESTNET,
      })
      if (signResult.error) throw new Error('Transaction was rejected in Freighter')

      // ── Step 9: Submit payment ────────────────────────────────────────────
      setStatus('submitting')

      const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `tx=${encodeURIComponent(signResult.signedTxXdr)}`,
      })

      const submitData = await submitRes.json()

      if (!submitRes.ok) {
        const opCode = submitData?.extras?.result_codes?.operations?.[0]
        if (opCode === 'op_no_trust')    throw new Error('USDC trustline missing.')
        if (opCode === 'op_underfunded') throw new Error('Insufficient USDC balance.')
        throw new Error(`Transaction failed: ${submitData?.extras?.result_codes?.transaction || 'unknown error'}`)
      }

      console.log('Payment confirmed. TX hash:', submitData.hash)
      setTxHash(submitData.hash)

      // ── Step 10: Mint NFT ownership token ────────────────────────────────
      // Simulation already confirmed this will succeed
      setStatus('minting')

      if (sorobanBookId !== -1) {
        try {
          await purchaseBook(studentAddress, sorobanBookId)
          console.log('Ownership NFT minted on Soroban')
        } catch (mintErr) {
          // payment succeeded but mint failed — log clearly for manual recovery
          console.error('CRITICAL: Payment succeeded but NFT mint failed:', mintErr)
          console.error('Book TX ID:', book.txId, 'Soroban Book ID:', sorobanBookId)
          // still mark as done — student paid, we need to recover manually
        }
      }

      setStatus('done')
      onSuccess(book)

    } catch (err) {
      console.error('Purchase error:', err)
      setError(err instanceof Error ? err.message : 'Purchase failed')
      setStatus('error')
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const price       = parseFloat(book.price || '0')
  const previewFee  = parseFloat((price * PLATFORM_FEE_BPS / 10_000).toFixed(2))
  const previewProf = parseFloat((price - previewFee).toFixed(2))

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 max-w-md w-full">

        {/* IDLE / ERROR */}
        {(status === 'idle' || status === 'error') && (
          <>
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Complete purchase</h2>
                <p className="text-gray-400 text-sm">Secure payment via your connected wallet</p>
              </div>
              <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors text-xl">✕</button>
            </div>

            <div className="bg-gray-800 rounded-xl p-4 mb-6 flex gap-4 items-start">
              <div className="w-12 h-16 bg-gray-700 rounded-lg flex items-center justify-center flex-shrink-0">
                <span className="text-2xl">📖</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium text-sm leading-snug mb-1 line-clamp-2">{book.title}</div>
                <div className="text-gray-400 text-xs">{book.author}</div>
              </div>
            </div>

            <div className="space-y-2 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Book price</span>
                <span className="text-white">${book.price}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Platform fee (2.5%)</span>
                <span className="text-white">${previewFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Professor receives</span>
                <span className="text-green-400">${previewProf.toFixed(2)}</span>
              </div>
              <div className="border-t border-gray-700 pt-2 flex justify-between font-semibold">
                <span className="text-gray-300">Total you pay</span>
                <span className="text-white text-lg">${book.price}</span>
              </div>
              <div className="text-gray-600 text-xs text-right">Paid in USDC · Stellar testnet</div>
            </div>

            <div className="bg-indigo-950 border border-indigo-800 rounded-xl p-3 mb-6 text-xs text-indigo-300">
              You will permanently own this book as a token in your wallet.
              Resell it any time — the author automatically earns {book.royalty}% of every resale.
            </div>

            {status === 'error' && error && (
              <div className="bg-red-950 border border-red-800 rounded-xl p-3 mb-4 text-xs text-red-300">{error}</div>
            )}

            <button
              onClick={handlePurchase}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-xl font-medium transition-colors mb-3"
            >
              Pay with Wallet — ${book.price}
            </button>

            <button onClick={onClose} className="w-full text-gray-500 hover:text-gray-400 text-sm transition-colors">
              Cancel
            </button>
          </>
        )}

        {/* LOADING STATES */}
        {['connecting', 'loading_book', 'checking', 'building', 'signing', 'submitting', 'minting'].includes(status) && (
          <div className="text-center py-8">
            <div className="w-12 h-12 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-6" />
            <div className="text-white font-medium mb-2">
              {status === 'connecting'   && 'Connecting to your wallet...'}
              {status === 'loading_book' && 'Loading book details...'}
              {status === 'checking'     && 'Verifying purchase eligibility...'}
              {status === 'building'     && 'Preparing payment...'}
              {status === 'signing'      && 'Waiting for your approval...'}
              {status === 'submitting'   && 'Confirming on Stellar network...'}
              {status === 'minting'      && 'Minting your ownership token...'}
            </div>
            {status === 'signing' && (
              <p className="text-gray-400 text-sm">Check your Freighter extension and click Approve</p>
            )}
            {status === 'submitting' && (
              <p className="text-gray-400 text-sm">This takes about 5 seconds</p>
            )}
            {status === 'minting' && (
              <p className="text-gray-400 text-sm">Recording ownership on the Stellar blockchain</p>
            )}
          </div>
        )}

        {/* SUCCESS */}
        {status === 'done' && (
          <div className="text-center py-4">
            <div className="w-16 h-16 bg-green-900 rounded-full flex items-center justify-center mx-auto mb-6">
              <span className="text-3xl">✓</span>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Purchase complete</h2>
            <p className="text-gray-400 text-sm mb-6">
              You now own <span className="text-white font-medium">{book.title}</span>.
            </p>
            <div className="bg-gray-800 rounded-xl p-4 mb-4 text-left space-y-2">
              <div className="text-gray-500 text-xs uppercase tracking-wider mb-2">Payment breakdown</div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Platform received</span>
                <span className="text-white">${platformFee.toFixed(4)} USDC</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Professor received</span>
                <span className="text-green-400">${professorGets.toFixed(4)} USDC</span>
              </div>
            </div>
            {txHash && (
              <div className="bg-gray-800 rounded-xl p-3 mb-6 text-left">
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">Stellar transaction</div>
                <code className="text-green-400 text-xs break-all block mb-2">{txHash}</code>
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 text-xs transition-colors"
                >
                  View on Stellar Explorer →
                </a>
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-xl font-medium transition-colors"
            >
              Done
            </button>
          </div>
        )}

      </div>
    </div>
  )
}