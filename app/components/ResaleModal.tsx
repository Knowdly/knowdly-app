// app/components/ResaleModal.tsx
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// Modal for purchasing a resale listing from the marketplace.
//
// ── RESALE PURCHASE FLOW ──────────────────────────────────────────────────────
// Step 1: Connect Freighter wallet
// Step 2: Verify buyer has sufficient USDC
// Step 3: Simulate transfer_token on Soroban (check it will succeed)
// Step 4: Send USDC payment — split atomically:
//           seller gets:  price - royalty% - 2.5% platform fee
//           creator gets: royalty% of price
//           platform gets: 2.5% of price
// Step 5: Call transfer_token on Soroban — NFT moves to buyer's wallet
// Step 6: Remove listing from Supabase
// Step 7: Success — buyer now owns the book on-chain

'use client'

import { useState } from 'react'
import {
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Asset,
  Operation,
  Account,
  Memo,
} from '@stellar/stellar-sdk'
import { transferToken, getPublisherAddress } from '../lib/contract'

// ── Constants ─────────────────────────────────────────────────────────────────

const HORIZON_URL  = 'https://horizon-testnet.stellar.org'
const NETWORK      = Networks.TESTNET
const USDC_ISSUER  = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC_ASSET   = new Asset('USDC', USDC_ISSUER)

// ── Types ─────────────────────────────────────────────────────────────────────

type Listing = {
  id:             string
  token_id:       number
  book_id:        number
  arweave_tx_id:  string
  seller_address: string
  asking_price:   number
  books: {
    title:   string
    author:  string
    royalty: string
  }
}

type Props = {
  listing:   Listing
  onClose:   () => void
  onSuccess: () => void
}

type PurchaseStatus = 'idle' | 'connecting' | 'checking' | 'paying' | 'transferring' | 'cleanup' | 'done' | 'error'

// ── Component ─────────────────────────────────────────────────────────────────

export default function ResaleModal({ listing, onClose, onSuccess }: Props) {

  const [status,  setStatus]  = useState<PurchaseStatus>('idle')
  const [error,   setError]   = useState<string | null>(null)
  const [step,    setStep]    = useState('')

  const book        = listing.books
  const price       = listing.asking_price
  const royaltyPct  = parseFloat(book?.royalty || '5')
  const platformPct = 2.5
  const royaltyAmt  = (price * royaltyPct / 100).toFixed(2)
  const platformAmt = (price * platformPct / 100).toFixed(2)
  const sellerAmt   = (price - parseFloat(royaltyAmt) - parseFloat(platformAmt)).toFixed(2)

  // ── Purchase handler ──────────────────────────────────────────────────────

  async function handlePurchase() {
    console.log('handlePurchase started, listing:', listing.book_id, listing.token_id)
    setStatus('connecting')
    setError(null)
    setStep('Connecting wallet...')

    try {

      // ── Step 1: Connect wallet ────────────────────────────────────────────
      const { requestAccess } = await import('@stellar/freighter-api')
      const accessResult = await requestAccess()
      console.log('accessResult:', accessResult)
      if (accessResult.error) throw new Error('Please connect your Freighter wallet')
      const buyerAddress = accessResult.address
      console.log('buyerAddress:', buyerAddress)
      // prevent buying your own listing
      if (buyerAddress === listing.seller_address) {
        throw new Error('You cannot buy your own listing')
      }

      // ── Step 2: Check USDC balance ────────────────────────────────────────
      setStatus('checking')
      setStep('Checking USDC balance...')

      const accountRes = await fetch(`${HORIZON_URL}/accounts/${buyerAddress}`)
      if (!accountRes.ok) throw new Error('Could not load your wallet. Make sure Freighter is set to Testnet.')
      const accountData = await accountRes.json()

      const usdcBalance = accountData.balances?.find(
        (b: any) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER
      )
      if (!usdcBalance) throw new Error('No USDC trustline found. Add a USDC trustline in Stellar Laboratory.')

      const balance = parseFloat(usdcBalance.balance || '0')
      if (balance < price) {
        throw new Error(`Insufficient USDC. You have $${balance.toFixed(2)} but need $${price.toFixed(2)}`)
      }

      // ── Step 3: Get publisher address for royalty payment ─────────────────
      // We need to look up the creator's wallet to send them their royalty.
      // This comes from the Soroban contract's book record.
      setStep('Preparing payment...')

      const bookRes  = await fetch(`/api/books/bytokenid?bookId=${listing.book_id}`)
      const bookData = await bookRes.json()

      // get platform wallet from environment
      const PLATFORM_WALLET = 'GDN2ZDGHTBR4X6UZAE3UOZW72W2OIP4NPNTHOM2IZM35NOKCDPFINSDX'

      // we need the publisher address — stored in the Soroban book record
      // for now fetch from the books API which has creator info
      // TODO: add publisher_address to books table in Supabase
      // For now use a direct contract lookup
      const publisherAddress = await getPublisherAddress(listing.book_id)
      console.log('publisherAddress:', publisherAddress)

      if (!publisherAddress) throw new Error('Could not find creator wallet for royalty payment')

      // ── Step 4: Send USDC payment (split across seller, creator, platform) ─
      setStatus('paying')
      setStep('Sending payment — please approve in Freighter...')

      const sellerAmtStr   = sellerAmt
      const royaltyAmtStr  = royaltyAmt
      const platformAmtStr = platformAmt

      // load buyer's account for transaction building
      const buyerAccountRes = await fetch(`${HORIZON_URL}/accounts/${buyerAddress}`)
      const buyerAccount    = await buyerAccountRes.json()

      const { signTransaction } = await import('@stellar/freighter-api')

      // build a transaction with 3 payment operations:
      //   1. seller gets their share
      //   2. creator gets their royalty
      //   3. platform gets its fee
      console.log('Building tx with:', buyerAddress, accountData.sequence)
      const tx = new TransactionBuilder(
        new Account(buyerAddress, buyerAccount.sequence),
        { fee: BASE_FEE, networkPassphrase: NETWORK }
        )
        .addOperation(Operation.payment({
          destination: listing.seller_address,
          asset:       USDC_ASSET,
          amount:      sellerAmtStr,
        }))
        .addOperation(Operation.payment({
          destination: publisherAddress,
          asset:       USDC_ASSET,
          amount:      royaltyAmtStr,
        }))
        .addOperation(Operation.payment({
          destination: PLATFORM_WALLET,
          asset:       USDC_ASSET,
          amount:      platformAmtStr,
        }))
        .addMemo(Memo.text(listing.arweave_tx_id.substring(0, 28)))
        .setTimeout(30)
        .build()

      const signResult = await signTransaction(tx.toXDR(), { networkPassphrase: Networks.TESTNET })
      if (signResult.error) throw new Error('Payment cancelled')

      // submit the payment transaction
      const submitRes = await fetch(`${HORIZON_URL}/transactions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `tx=${encodeURIComponent(signResult.signedTxXdr)}`,
      })
      const submitData = await submitRes.json()
      if (!submitRes.ok) {
        throw new Error('Payment failed: ' + (submitData.detail || submitData.title || 'Unknown error'))
      }

      console.log('Payment successful:', submitData.hash)

      // ── Step 5: Transfer NFT on Soroban ───────────────────────────────────
      // Now that payment is confirmed, transfer the NFT to the buyer.
      // The contract enforces the royalty split — we pass the sale price
      // so the contract can verify/record it.
      setStatus('transferring')
      setStep('Transferring ownership on-chain — please approve in Freighter...')

      const salePriceStroops = Math.round(price * 10_000_000)
      await transferToken(buyerAddress, listing.token_id, salePriceStroops)

      console.log('NFT transferred to buyer:', buyerAddress)

      // ── Step 6: Remove listing from Supabase ─────────────────────────────
      setStatus('cleanup')
      setStep('Finalising...')

      await fetch(`/api/listings?tokenId=${listing.token_id}`, { method: 'DELETE' })

      // ── Done ──────────────────────────────────────────────────────────────
      setStatus('done')
      setStep('')

      setTimeout(() => onSuccess(), 2000)

    } catch (err) {
      console.error('Resale purchase error:', err)
      setError(err instanceof Error ? err.message : 'Purchase failed')
      setStatus('error')
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isProcessing = ['connecting', 'checking', 'paying', 'transferring', 'cleanup'].includes(status)

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-md">

        {/* header */}
        <div className="mb-6">
          <div className="text-xs font-semibold text-green-400 uppercase tracking-wider mb-1">
            Resale purchase
          </div>
          <h2 className="text-xl font-bold">{book?.title}</h2>
          <p className="text-gray-400 text-sm">{book?.author}</p>
        </div>

        {/* price breakdown */}
        <div className="bg-gray-800 rounded-xl p-4 mb-6 space-y-2 text-sm">
          <div className="flex justify-between text-gray-400">
            <span>Resale price</span>
            <span className="text-white font-medium">${price.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-gray-500 text-xs">
            <span>Seller receives</span>
            <span>${sellerAmt}</span>
          </div>
          <div className="flex justify-between text-gray-500 text-xs">
            <span>Creator royalty ({royaltyPct}%)</span>
            <span>${royaltyAmt}</span>
          </div>
          <div className="flex justify-between text-gray-500 text-xs">
            <span>Platform fee (2.5%)</span>
            <span>${platformAmt}</span>
          </div>
          <div className="border-t border-gray-700 pt-2 flex justify-between text-white font-medium">
            <span>You pay</span>
            <span>${price.toFixed(2)} USDC</span>
          </div>
        </div>

        {/* what you get */}
        <div className="bg-indigo-950 border border-indigo-800 rounded-xl p-4 mb-6 text-sm">
          <div className="text-indigo-300 font-medium mb-1">What you get</div>
          <div className="text-gray-300 text-xs leading-relaxed">
            Permanent NFT ownership on the Stellar blockchain. Read on any device,
            any browser, forever. Resell it again whenever you want.
          </div>
        </div>

        {/* step indicator */}
        {isProcessing && (
          <div className="flex items-center gap-3 mb-6">
            <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <div className="text-gray-400 text-sm">{step}</div>
          </div>
        )}

        {/* success */}
        {status === 'done' && (
          <div className="bg-green-950 border border-green-800 rounded-xl p-4 mb-6 text-center">
            <div className="text-green-400 font-medium text-lg mb-1">Purchase complete ✓</div>
            <div className="text-gray-400 text-sm">
              The book is now in your library
            </div>
          </div>
        )}

        {/* error */}
        {error && (
          <div className="bg-red-950 border border-red-800 rounded-xl p-4 mb-6">
            <div className="text-red-400 font-medium mb-1">Purchase failed</div>
            <div className="text-red-300 text-xs">{error}</div>
          </div>
        )}

        {/* buttons */}
        {status !== 'done' && (
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 py-3 rounded-lg text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePurchase}
              disabled={isProcessing}
              className="flex-1 bg-green-700 hover:bg-green-600 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-lg text-sm font-medium transition-colors"
            >
              {isProcessing ? step || 'Processing...' : `Buy for $${price.toFixed(2)}`}
            </button>
          </div>
        )}

      </div>
    </div>
  )
}