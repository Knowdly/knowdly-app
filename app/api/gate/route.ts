import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
const VALID_TOKEN = '7a47b8a3baf9d324b0423f01d81a3a34dbb4bb6425dc6a89b806f7a10ac7c3bb'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// This endpoint serves as a gatekeeper for protected content. It checks for a valid token in the query parameters, sets an access cookie if valid, and redirects to the library page. If the token is invalid, it redirects to a demo page.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')

  if (token !== VALID_TOKEN) {
    return NextResponse.redirect('https://knowdly.com/demo')
  }

  // Create a response that redirects to the library page
  const response = new NextResponse(
    `<html><head><meta http-equiv="refresh" content="0;url=/library"></head><body>Redirecting...</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  )

  //
  response.cookies.set(COOKIE_NAME, VALID_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 2, // 2 hours
    path: '/',
  })

  return response
}