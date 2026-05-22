'use client'

// ONE-TIME USE — initialises the Knowdly Soroban contract
// Visit http://localhost:3000/admin/init with the platform wallet connected
// Delete this file after successful initialisation

import { useState } from 'react'
import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  Account,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { signTransaction, requestAccess } from '@stellar/freighter-api'

const CONTRACT_ID  = 'CBSEVXLOG72CW6L77J6HGRSMKI3IXKLKQTPPMLQS65NNHGGNXGOXMXAA'
const RPC_URL      = 'https://soroban-testnet.stellar.org'
const HORIZON_URL  = 'https://horizon-testnet.stellar.org'
const NETWORK      = Networks.TESTNET
const PLATFORM     = 'GDN2ZDGHTBR4X6UZAE3UOZW72W2OIP4NPNTHOM2IZM35NOKCDPFINSDX'
const FEE_BPS      = 250  // 2.5%

export default function InitPage() {
  const [status,  setStatus]  = useState('')
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState('')

  async function handleInit() {
    setStatus('Connecting wallet...')
    setError('')

    try {
      const access = await requestAccess()
      if (access.error) throw new Error('Wallet connection failed: ' + access.error)
      if (access.address !== PLATFORM) {
        throw new Error(
          'Wrong wallet connected. Please connect the platform wallet:\n' + PLATFORM
        )
      }

      setStatus('Loading account...')
      const res     = await fetch(`${HORIZON_URL}/accounts/${PLATFORM}`)
      const data    = await res.json()
      const account = new Account(PLATFORM, data.sequence)

      setStatus('Building transaction...')
      const contract = new Contract(CONTRACT_ID)

      const tx = new TransactionBuilder(account, {
        fee:               BASE_FEE,
        networkPassphrase: NETWORK,
      })
        .addOperation(
          contract.call(
            'initialise',
            nativeToScVal(PLATFORM, { type: 'address' }),
            nativeToScVal(FEE_BPS,  { type: 'u32' }),
          )
        )
        .setTimeout(30)
        .build()

      setStatus('Simulating...')
      const server    = new rpc.Server(RPC_URL)
      const assembled = await server.prepareTransaction(tx)

      setStatus('Please sign in Freighter...')
      const signed = await signTransaction(assembled.toXDR(), {
        networkPassphrase: NETWORK,
      })
      if (signed.error) throw new Error('Signing failed: ' + signed.error)

      setStatus('Submitting...')
      const submitRes  = await fetch(RPC_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'sendTransaction',
          params:  { transaction: signed.signedTxXdr },
        }),
      })
      const submitData = await submitRes.json()
      if (submitData.result?.status === 'ERROR') {
        throw new Error('Submission failed: ' + JSON.stringify(submitData.result))
      }

      const hash = submitData.result?.hash
      setStatus('Confirming... (hash: ' + hash + ')')

      // poll for confirmation
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const pollRes  = await fetch(RPC_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id:      1,
            method:  'getTransaction',
            params:  { hash },
          }),
        })
        const pollData = await pollRes.json()
        if (pollData.result?.status === 'SUCCESS') {
          setStatus('✅ Contract initialised successfully!')
          setDone(true)
          return
        }
        if (pollData.result?.status === 'FAILED') {
          throw new Error('Transaction failed: ' + JSON.stringify(pollData.result))
        }
      }

      throw new Error('Confirmation timeout — check Stellar Expert for tx: ' + hash)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setStatus('')
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-20 p-8 bg-gray-900 border border-gray-800 rounded-2xl">
      <h1 className="text-2xl font-bold text-white mb-2">Contract Initialisation</h1>
      <p className="text-gray-400 text-sm mb-6">
        One-time setup for the new Knowdly contract. Connect the platform wallet before proceeding.
      </p>

      <div className="space-y-3 text-sm mb-8">
        <div className="flex justify-between">
          <span className="text-gray-500">Contract</span>
          <code className="text-indigo-400 text-xs">CATP…R4YX</code>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Platform wallet</span>
          <code className="text-indigo-400 text-xs">GDN2…NSDX</code>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Platform fee</span>
          <span className="text-white">2.5%</span>
        </div>
      </div>

      {!done && (
        <button
          onClick={handleInit}
          disabled={!!status}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-lg font-medium transition-colors"
        >
          {status || 'Initialise Contract'}
        </button>
      )}

      {done && (
        <div className="bg-green-950 border border-green-800 rounded-xl p-4 text-green-400 text-sm">
          ✅ Done! You can now delete <code>app/admin/init/page.tsx</code> and start uploading books.
        </div>
      )}

      {error && (
        <div className="mt-4 bg-red-950 border border-red-800 rounded-xl p-4">
          <div className="text-red-400 font-medium mb-1">Error</div>
          <pre className="text-red-300 text-xs whitespace-pre-wrap">{error}</pre>
        </div>
      )}
    </div>
  )
}