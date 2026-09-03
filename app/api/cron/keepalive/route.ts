// app/api/cron/keepalive/route.ts
// Trivial read against Supabase, solely to register activity and prevent
// the project from auto-pausing due to inactivity. Triggered daily by the
// Vercel Cron entry in vercel.json — does nothing else.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')
  return createClient(url, key)
}

export async function GET(request: Request) {
  // Vercel automatically sends this header when its own Cron scheduler
  // triggers the route, if CRON_SECRET is set in the project's env vars.
  // This route is exempted from the app's password gate (Vercel Cron has
  // no login cookie), so this is what actually secures it instead.
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabase()
    const { count, error } = await supabase
      .from('books')
      .select('*', { count: 'exact', head: true })

    if (error) throw error

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: count ?? 0,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Keepalive failed' },
      { status: 500 }
    )
  }
}