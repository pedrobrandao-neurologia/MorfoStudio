// helpers.mjs — utilidades dos testes (Node ≥ 18, sem dependências).
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const js = (f) => pathToFileURL(resolve(ROOT, 'js', f)).href

let failures = 0
export function check(cond, msg) {
  if (cond) console.log('  ok  ', msg)
  else { console.log('  FALHA', msg); failures++ }
}
export function done(name) {
  console.log(failures ? `${name}: ${failures} FALHA(S)` : `${name}: OK`)
  process.exit(failures ? 1 : 0)
}

/**
 * Carrega um Web Worker de módulo no Node com um `self` falso e devolve run(data) → Promise da
 * mensagem final ('done' resolve; 'error'/'fatal' rejeita). Um worker por processo de teste.
 */
export async function loadWorker(file) {
  let pending = null
  globalThis.self = {
    postMessage(m) {
      if (!pending) return
      if (m.cmd === 'done') { const p = pending; pending = null; p.resolve(m) }
      else if (m.cmd === 'error' || m.cmd === 'fatal') { const p = pending; pending = null; p.reject(new Error(m.message)) }
    }
  }
  await import(js(file))
  return (data) => new Promise((res, rej) => { pending = { resolve: res, reject: rej }; globalThis.self.onmessage({ data }) })
}

/** gerador pseudoaleatório determinístico (testes reprodutíveis) */
export function rng(seed = 1) {
  let s = seed
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}
