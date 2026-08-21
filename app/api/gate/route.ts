import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
// Same env var as middleware.ts — set KNOWDLY_GATE_TOKEN in .env.local and Vercel.
const VALID_TOKEN = process.env.KNOWDLY_GATE_TOKEN

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// This endpoint serves as a gatekeeper for protected content. It checks for a valid token in the query parameters, sets an access cookie if valid, and redirects to the library page. If the token is invalid, it redirects to a demo page.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')

  if (!VALID_TOKEN || token !== VALID_TOKEN) {
    return NextResponse.redirect('https://www.knowdly.com/demo')
  }

  const libraryUrl = new URL('/library', request.url)
  const response = NextResponse.redirect(libraryUrl)

  response.cookies.set(COOKIE_NAME, VALID_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 2,
    path: '/',
  })

  return response
}