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
    <main className="min-h-screen bg-[#f5f5f5] px-4 py-10 sm:py-16">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <h1 className="text-4xl font-semibold leading-tight text-[#111827]">
          AI Video Engine
        </h1>
        <p className="text-sm text-[#4b5563]">Quality-controlled rendering pipeline</p>

        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <input
            type="text"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="Enter project_id"
            className="w-full rounded-[14px] border border-[#d1d1d1] bg-transparent px-4 py-3 text-sm text-[#111827] outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-[14px] border border-[#d1d1d1] bg-transparent px-4 py-3 text-sm font-medium text-[#111827]"
          >
            Open Project
          </button>
        </form>
      </div>
    </main>
  )
}
