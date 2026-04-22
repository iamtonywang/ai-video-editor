'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function Home() {
  const router = useRouter()
  const [projectId, setProjectId] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = projectId.trim()
    if (!id) return
    router.push(`/projects/${id}`)
  }

  return (
    <main
      className="font-latin min-h-screen bg-[#f5f5f5] px-4 py-10 sm:py-16"
      lang="en"
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <header className="flex flex-col gap-1.5 sm:gap-2">
          <h1 className="text-5xl font-semibold leading-[1.1] tracking-[0.02em] text-[#111827] sm:text-6xl">
            SHAWWANG
          </h1>
          <p className="text-lg font-medium text-[#4b5563] sm:text-xl">
            AI Video Engine
          </p>
        </header>
        <p className="text-sm text-[#4b5563]">
          Enter your project ID to continue
        </p>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <input
            type="text"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="Paste your project ID here"
            className="w-full rounded-[14px] border border-[#d1d1d1] bg-transparent px-4 py-3 text-sm text-[#111827] outline-none transition-[border-color,background-color] placeholder:text-[#6b7280]"
          />
          <button
            type="submit"
            className="w-full rounded-[14px] border border-[#d1d1d1] bg-transparent px-4 py-3 text-sm font-medium text-[#111827] transition-[border-color,background-color] hover:border-[#b8b8b8] hover:bg-[#ebebeb]/60"
          >
            Open Project
          </button>
        </form>
      </div>
    </main>
  )
}
