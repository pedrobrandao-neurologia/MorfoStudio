// serve.mjs — servidor estático mínimo para os testes E2E (sem dependências).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.txt': 'text/plain' }

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (p.endsWith('/')) p += 'index.html'
      const file = resolve(ROOT, '.' + p)
      if (!file.startsWith(ROOT)) throw new Error('fora da raiz')
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
      res.end(data)
    } catch { res.writeHead(404); res.end('not found') }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() }
}
