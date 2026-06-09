// app/api/content/[txId]/route.ts
// Proxies encrypted book content from Arweave to the browser.
// Uses /raw/ endpoint to get pure file data without metadata headers.

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Gateways in priority order — arweave.net is authoritative
// /raw/ endpoint returns pure file data without Arweave metadata wrapper
const GATEWAYS = [
  'https://arweave.net',
  'https://permagate.io',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ txId: string }> }
) {
  try {
    const { txId } = await params
    console.log('Content proxy fetching txId:', txId)

    let response: Response | null = null
    let successGateway = ''

    for (const gw of GATEWAYS) {
      try {
        console.log('Trying gateway:', gw)
        // /raw/ returns pure encrypted file data without Arweave metadata headers
        const res = await fetch(`${gw}/raw/${txId}`, {
          redirect: 'follow',
          headers: { 'Accept': 'application/octet-stream, */*' },
          cache: 'no-store',
        })
        console.log(`${gw} status:`, res.status)
        if (res.ok) {
          response = res
          successGateway = gw
          break
        }
      } catch (err) {
        console.error(`${gw} failed:`, err)
      }
    }

    if (!response) {
      return NextResponse.json(
        { error: 'Content not found on any gateway' },
        { status: 572 }
      )
    }

    const buffer = await response.arrayBuffer()
    console.log('Serving content from gateway:', successGateway)
    console.log('Content buffer size:', buffer.byteLength, 'bytes')

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })

  } catch (err) {
    console.error('Content proxy error:', err)
    return NextResponse.json(
      { error: 'Failed to fetch content' },
      { status: 500 }
    )
  }
}