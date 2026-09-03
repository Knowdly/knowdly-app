import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
// Token now lives in the environment, not in source — set KNOWDLY_GATE_TOKEN
// in .env.local and in Vercel (Production + Preview). Never hardcode it here.
const VALID_TOKEN = process.env.KNOWDLY_GATE_TOKEN

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow the gate endpoint through
  if (pathname === '/api/gate') return NextResponse.next()

  // Vercel's Cron scheduler has no login cookie and never will — this route
  // is verified separately via CRON_SECRET inside its own handler instead.
  if (pathname === '/api/cron/keepalive') return NextResponse.next()

  // Fail closed: if the token isn't configured, deny everything rather than
  // silently letting requests through. Better a broken deploy than an open one.
  if (!VALID_TOKEN) {
    console.error('KNOWDLY_GATE_TOKEN is not set — denying all access.')
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 })
    }
    return NextResponse.redirect('https://www.knowdly.com/demo')
  }

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
  return NextResponse.redirect('https://www.knowdly.com/demo')
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/gate).*)'],
}