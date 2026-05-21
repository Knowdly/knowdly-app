import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
const VALID_TOKEN = '7a47b8a3baf9d324b0423f01d81a3a34dbb4bb6425dc6a89b806f7a10ac7c3bb'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // always allow the gate endpoint through
  if (pathname === '/api/gate') return NextResponse.next()

  // check for valid access cookie
  const cookie = request.cookies.get(COOKIE_NAME)
  if (cookie?.value === VALID_TOKEN) return NextResponse.next()

  // redirect to gate page on Namecheap
  return NextResponse.redirect('https://knowdly.com/demo')
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/gate).*)'],
}