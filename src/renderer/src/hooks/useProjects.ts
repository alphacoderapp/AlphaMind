import { useCallback, useEffect, useState } from 'react'
import { defaultProjects, type Project } from '../data/mockProjects'

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const stored = await window.api.projects.list()
      if (cancelled) return
      if (stored && stored.length > 0) {
        setProjects(stored)
      } else {
        setProjects(defaultProjects)
        await window.api.projects.save(defaultProjects)
      }
      setLoaded(true)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const addProject = useCallback(async (project: Project) => {
    setProjects((prev) => {
      const next = [...prev, project]
      window.api.projects.save(next).catch((e) => console.error(e))
      return next
    })
  }, [])

  const removeProject = useCallback(async (id: string) => {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id)
      window.api.projects.save(next).catch((e) => console.error(e))
      return next
    })
  }, [])

  const updateProject = useCallback(async (id: string, patch: Partial<Project>) => {
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
      window.api.projects.save(next).catch((e) => console.error(e))
      return next
    })
  }, [])

  return { projects, loaded, addProject, removeProject, updateProject }
}
