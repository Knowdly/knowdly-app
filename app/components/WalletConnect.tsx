// app/components/WalletConnect.tsx
// Wallet connection button for Freighter (Stellar browser extension)
// This is a client component because it interacts with the browser extension

'use client'

import { useState, useEffect } from 'react'

// import Freighter's browser API
// isConnected checks if Freighter is installed and connected
// getPublicKey returns the user's Stellar wallet address
// requestAccess asks the user to approve the connection
import {
  isConnected,
  requestAccess,
} from '@stellar/freighter-api'

// TypeScript type for the connection state
type WalletState = 'disconnected' | 'connecting' | 'connected' | 'not_installed'

// localStorage key tracking that the user explicitly disconnected — Freighter
// itself stays "allowed" at the extension level even after our disconnect
// button runs, so without this flag checkConnection() silently reconnects
// on every remount (page navigation), which looks like a bug where
// disconnect "doesn't stick."
const DISCONNECT_FLAG = 'knowdly_wallet_disconnected'

// Props — optional callback so parent components know when wallet connects
type Props = {
  onConnect?: (publicKey: string) => void
}

export default function WalletConnect({ onConnect }: Props) {

  // tracks the current wallet connection state
  const [walletState, setWalletState] = useState<WalletState>('disconnected')

  // stores the connected wallet's public key (Stellar address)
  const [publicKey, setPublicKey] = useState<string | null>(null)

  // check on mount whether Freighter is already connected
  useEffect(() => {
    checkConnection()
  }, [])

  // checkConnection checks if Freighter is installed and already approved
  async function checkConnection() {
    try {
      const connected = await isConnected()

      // check the isConnected property — not the object itself
      if (!connected.isConnected) {
        setWalletState('not_installed')
        return
      }

      // respect an explicit prior disconnect — don't silently reconnect
      // just because Freighter still has this site allowed
      if (localStorage.getItem(DISCONNECT_FLAG) === 'true') {
        setWalletState('disconnected')
        return
      }

      // use isAllowed to check if user previously approved — no popup
      const { isAllowed } = await import('@stellar/freighter-api')
      const allowed = await isAllowed()
      if (!allowed.isAllowed) {
        // not yet approved — wait for user to click connect
        setWalletState('disconnected')
        return
      }

      // already approved — get address without popup
      const key = (await requestAccess()).address
      if (key) {
        setPublicKey(key)
        setWalletState('connected')
        onConnect?.(key)
      }
    } catch {
      setWalletState('disconnected')
    }
  }

  // handleConnect is called when the user clicks the Connect Wallet button
  async function handleConnect() {
    setWalletState('connecting')

    // user is explicitly connecting — clear any prior disconnect flag
    localStorage.removeItem(DISCONNECT_FLAG)

    try {
      // requestAccess opens the Freighter popup asking the user to approve
      const accessResult = await requestAccess()

      if (accessResult.error) {
        // user rejected the connection request
        setWalletState('disconnected')
        return
      }

      // get the public key after approval
      // get the public key from the access result
      const key = accessResult.address

      if (key) {
        setPublicKey(key)
        setWalletState('connected')
        // notify parent component that wallet is now connected
        onConnect?.(key)
      }
    } catch (err) {
      console.error('Wallet connection failed:', err)
      setWalletState('disconnected')
    }
  }

  // shorten the public key for display — show first 4 and last 4 characters
  // e.g. GABC...WXYZ instead of the full 56 character address
  function shortenKey(key: string) {
    return key.slice(0, 4) + '...' + key.slice(-4)
  }

  // render different UI based on wallet state

  // Freighter is not installed
  if (walletState === 'not_installed') {
    return (
      <a
        href="https://www.freighter.app"
        target="_blank"
        rel="noreferrer"
        className="text-sm text-yellow-400 hover:text-yellow-300 transition-colors"
      >
        Install Freighter →
      </a>
    )
  }

  // wallet is connected — show the shortened address
  if (walletState === 'connected' && publicKey) {
    return (
      <div className="flex items-center gap-2">
        {/* green dot */}
        <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />

        {/* shortened address */}
        <span className="text-sm text-gray-300 font-mono">
          {shortenKey(publicKey)}
        </span>

        {/* disconnect button */}
        <button
          onClick={() => {
            // set the flag so checkConnection() won't silently reconnect
            // on the next page load or navigation — Freighter itself
            // stays "allowed", but our app now remembers to ignore that
            localStorage.setItem(DISCONNECT_FLAG, 'true')
            setPublicKey(null)
            setWalletState('disconnected')
          }}
          className="text-gray-600 hover:text-red-400 transition-colors text-xs ml-1"
          title="Disconnect wallet"
        >
          ✕
        </button>
      </div>
    )
  }

  // connecting — show a loading state
  if (walletState === 'connecting') {
    return (
      <button
        disabled
        className="text-sm text-gray-500 px-4 py-2 rounded-lg border border-gray-700"
      >
        Connecting...
      </button>
    )
  }

  // default — not connected, show the connect button
  return (
    <button
      onClick={handleConnect}
      className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors"
    >
      Connect Wallet
    </button>
  )
}