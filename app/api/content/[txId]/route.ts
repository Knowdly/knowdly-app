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

    const gateway = process.env.ARWEAVE_HOST
  ? `https://${process.env.ARWEAVE_HOST}`
  : 'https://arweave.net'

    // fetch from ArLocal on the server side — no CORS issues here
    // ArLocal requires /data suffix to get raw file content
    // on mainnet arweave.net/<txId> returns the data directly
    const response = await fetch(`${gateway}/${txId}`, {
      redirect: 'follow',
      headers: {
        'Accept': 'application/octet-stream, */*',
      }
    })

    console.log('Fetching from:', `${gateway}/${txId}`)
    console.log('Final URL after redirect:', response.url)
    console.log('Response status:', response.status)

    //console.log('ArLocal response status:', response.status)
    //console.log('ArLocal content type:', response.headers.get('content-type'))

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
        'Cache-Control': 'public, max-age=31536000',
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