export interface Project {
  id: string
  name: string
  path: string
  color: string
  category?: string
}

const C = {
  cyan: '#22d3ee',
  emerald: '#34d399',
  magenta: '#e879f9',
  amber: '#fbbf24',
  violet: '#a78bfa',
  rose: '#fb7185'
}

export const defaultProjects: Project[] = [
  { id: 'websta', name: 'Websta', path: '/Users/martinnisu/WEBSTA/websta.ai', category: 'web', color: C.cyan },
  { id: 'kiska-property', name: 'Villa Zelda', path: '/Users/martinnisu/QuantumCoders/kiska-property', category: 'web', color: C.cyan },
  { id: 'kiska-properties', name: 'Kiska Properties', path: '/Users/martinnisu/QuantumCoders/kiska-properties', category: 'web', color: C.cyan },
  { id: 'botox', name: 'Botox Planner', path: '/Users/martinnisu/Aesthetica', category: 'tools', color: C.magenta },
  { id: 'fashionista-mirror', name: 'Fashionista Mirror', path: '/Users/martinnisu/Fashionista Mirror', category: 'mobile', color: C.violet },
  { id: 'fashionista-pivot', name: 'Fashionista Pivot', path: '/Users/martinnisu/FASHIONISTA', category: 'mobile', color: C.violet },
  { id: 'arabella', name: 'Arabella Bot', path: '/Users/martinnisu/whatsapp-github-bot', category: 'bots', color: C.amber },
  { id: 'alphacod', name: 'Alphacod', path: '/Users/martinnisu/SimpleClaude', category: 'tools', color: C.emerald }
]
