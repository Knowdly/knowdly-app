import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'knowdly_access'
const VALID_TOKEN = '7a47b8a3baf9d324b0423f01d81a3a34dbb4bb6425dc6a89b806f7a10ac7c3bb'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')

  if (token !== VALID_TOKEN) {
    return NextResponse.redirect('https://knowdly.com/demo')
  }

  const response = NextResponse.redirect(new URL('/library', request.url))
  response.cookies.set(COOKIE_NAME, VALID_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })
  return response
}