import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
const VALID_TOKEN = '123d3ee19f254eeccbac647c94b39b1b1ac7c960e3d4df524eb60736a7d1f9c7'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // always allow the gate endpoint through
  if (pathname === '/api/gate') return NextResponse.next()

  // check for valid access cookie
  const cookie = request.cookies.get(COOKIE_NAME)
  if (cookie?.value === VALID_TOKEN) return NextResponse.next()

  // API calls get a 401 — not a redirect
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Session expired. Please log in again.' },
      { status: 401 }
    )
  }

  // page requests get redirected to gate
  return NextResponse.redirect('https://knowdly.com/demo')
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/gate).*)'],
}