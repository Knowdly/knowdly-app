import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
const VALID_TOKEN = 'a8073f7ba99a2b14302e9e80467a6038f658065575a0e30331c1418f8ee035d5'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow the gate endpoint through
  if (pathname === '/api/gate') return NextResponse.next()

  // Check if token is in URL — set cookie and redirect cleanly
  const urlToken = request.nextUrl.searchParams.get('token')
  if (urlToken === VALID_TOKEN) {
    const url = request.nextUrl.clone()
    url.searchParams.delete('token')
    const res = NextResponse.redirect(url)
    res.cookies.set(COOKIE_NAME, VALID_TOKEN, {
      httpOnly: true,
      maxAge: 86400,
      path: '/',
      sameSite: 'lax'
    })
    return res
  }

  // Check for valid access cookie
  const cookie = request.cookies.get(COOKIE_NAME)
  if (cookie?.value === VALID_TOKEN) return NextResponse.next()

  // API calls get a 401 — not a redirect
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Session expired. Please log in again.' },
      { status: 401 }
    )
  }

  // Page requests get redirected to gate
  return NextResponse.redirect('https://knowdly.com/demo')
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/gate).*)'],
}