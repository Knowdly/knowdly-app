// app/api/content/[txId]/route.ts
// Proxies content requests from the browser to ArLocal
// Avoids CORS issues — browser calls Next.js, Next.js fetches from ArLocal

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ txId: string }> }
) {
  try {
    // await params — required in Next.js 16
    const { txId } = await params

    console.log('Content proxy fetching txId:', txId)

    
//=====================================================================
    // fetch from ArLocal on the server side — no CORS issues here
    // ArLocal requires /data suffix to get raw file content
    // on mainnet arweave.net/<txId> returns the data directly

   const gateways = [
  'https://arweave.net',
  'https://ar-io.net',
  'https://permagate.io',
]

let response: Response | null = null

for (const gw of gateways) {
  try {
    console.log('Trying gateway:', gw)
    const res = await fetch(`${gw}/${txId}`, {
      redirect: 'follow',
      headers: { 'Accept': 'application/octet-stream, */*' },
    })
    console.log(`${gw} status:`, res.status)
    if (res.ok) {
      response = res
      break
    }
  } catch (err) {
    console.error(`${gw} failed:`, err)
  }
}

if (!response) {
  return NextResponse.json({ error: 'Content not found on any gateway' }, { status: 572 })
}

 //======================================================================   
    if (!response.ok) {
      return NextResponse.json(
        { error: 'Content not found', status: response.status },
        { status: response.status }
      )
    }

    // get the content type from ArLocal
    const contentType = response.headers.get('content-type') || 
      'application/octet-stream'

    // get the raw bytes
    const buffer = await response.arrayBuffer()

    console.log('Content buffer size:', buffer.byteLength, 'bytes')
    console.log('Returning content type:', contentType)

    // return the content with the correct content type
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, s-maxage=0',
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