// app/page.tsx — the app's own internal root.
// Nothing should link here anymore (the nav logo points to www.knowdly.com
// directly), but if anyone hits knowdly-app.vercel.app with no path, send
// them to the real marketing site instead of showing stale draft content.
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('https://www.knowdly.com/')
}