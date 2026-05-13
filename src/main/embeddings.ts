// Local embedding generation via @xenova/transformers.
// Uses all-MiniLM-L6-v2 (384 dims). Model auto-downloads on first use to
// ~/.cache/huggingface/hub. ESM-only package, dynamic import to keep CJS bundle
// happy. Lazy-loaded so app startup isn't blocked by model load.

let extractorPromise: Promise<(text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>> | null = null

const MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIM = 384

async function getExtractor(): Promise<(text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const transformers = await import('@xenova/transformers')
      // Allow remote model downloads, disable in-package model lookup.
      const env = (transformers as { env: { allowLocalModels: boolean; allowRemoteModels: boolean } }).env
      env.allowLocalModels = false
      env.allowRemoteModels = true
      const pipe = await (transformers as { pipeline: (task: string, model: string) => Promise<unknown> }).pipeline(
        'feature-extraction',
        MODEL
      )
      return pipe as (text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>
    })()
  }
  return extractorPromise
}

export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return new Array(EMBEDDING_DIM).fill(0)
  const extractor = await getExtractor()
  // Cap input to avoid pathological cases. Model context is 256 tokens
  // anyway — anything beyond gets truncated by the tokenizer regardless.
  const capped = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed
  const output = await extractor(capped, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

// Cosine similarity. Both vectors must already be L2-normalized
// (transformers.js outputs normalized embeddings when normalize: true), so
// this reduces to a dot product.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!
  }
  return sum
}
