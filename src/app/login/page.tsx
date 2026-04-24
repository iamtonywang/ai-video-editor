import { redirect } from 'next/navigation'

type LoginPageProps = {
  searchParams: Promise<{ error?: string | string[] }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const raw = params.error
  const err = Array.isArray(raw) ? raw[0] : raw
  if (typeof err === 'string' && err.length > 0) {
    redirect(`/?error=${encodeURIComponent(err)}`)
  }
  redirect('/')
}
