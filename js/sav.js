// sav.js — escreve arquivos SPSS (.sav, "system file") sem dependências.
// Formato: cabeçalho $FL2, registros de variável (tipo 2), registros tipo 7
// (subtipos 3, 4, 13, 20), terminador 999 e dados não comprimidos (doubles LE).
// Referência: PSPP "System File Format".

const SYSMIS = -Number.MAX_VALUE
const enc = new TextEncoder()

function sanitizeLong(name) {
  let n = String(name).replace(/[^A-Za-z0-9_.$#@]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!/^[A-Za-z]/.test(n)) n = 'V_' + n
  return n.slice(0, 64) || 'V'
}

function makeShortNames(longNames) {
  const used = new Set()
  return longNames.map((ln) => {
    let base = ln.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8)
    if (!/^[A-Z]/.test(base)) base = 'V' + base
    let cand = base
    let k = 1
    while (used.has(cand)) {
      const suf = String(k++)
      cand = base.slice(0, 8 - suf.length) + suf
    }
    used.add(cand)
    return cand
  })
}

function padBytes(bytes, len, fill = 0x20) {
  const out = new Uint8Array(len).fill(fill)
  out.set(bytes.subarray(0, len))
  return out
}

class ByteWriter {
  constructor() { this.chunks = []; this.size = 0 }
  push(u8) { this.chunks.push(u8); this.size += u8.length }
  i32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); this.push(b) }
  f64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, true); this.push(b) }
  str(s, len, fill) { this.push(padBytes(enc.encode(s), len, fill)) }
  bytes(u8) { this.push(u8) }
  result() {
    const out = new Uint8Array(this.size)
    let o = 0
    for (const c of this.chunks) { out.set(c, o); o += c.length }
    return out
  }
}

/**
 * @param {object} opts
 * @param {Array<{name:string,label?:string,type:'numeric'|'string',width?:number,decimals?:number}>} opts.variables
 * @param {Array<Array<number|string|null>>} opts.rows  valores na mesma ordem de variables
 * @param {string} [opts.fileLabel]
 * @returns {Uint8Array}
 */
export function writeSav({ variables, rows, fileLabel = 'Morfo Studio' }) {
  const longNames = variables.map((v) => sanitizeLong(v.name))
  const shortNames = makeShortNames(longNames)
  const vars = variables.map((v, i) => {
    const isStr = v.type === 'string'
    const width = isStr ? Math.min(Math.max(v.width || 64, 1), 255) : 0
    const slots = isStr ? Math.ceil(width / 8) : 1
    const decimals = isStr ? 0 : (v.decimals ?? 3)
    const fmtWidth = isStr ? width : 12
    const fmt = ((isStr ? 1 : 5) << 16) | (fmtWidth << 8) | decimals
    return { ...v, isStr, width, slots, fmt, short: shortNames[i], long: longNames[i] }
  })
  const nominalCaseSize = vars.reduce((s, v) => s + v.slots, 0)

  const w = new ByteWriter()
  // --- cabeçalho (176 bytes)
  w.str('$FL2', 4)
  w.str('@(#) SPSS DATA FILE - Morfo Studio (JS)', 60)
  w.i32(2) // layout_code
  w.i32(nominalCaseSize)
  w.i32(0) // compression
  w.i32(0) // weight_index
  w.i32(rows.length)
  w.f64(100) // bias
  const d = new Date()
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  w.str(`${String(d.getDate()).padStart(2, '0')} ${mon} ${String(d.getFullYear()).slice(2)}`, 9)
  w.str(d.toTimeString().slice(0, 8), 8)
  w.str(fileLabel, 64)
  w.str('', 3)

  // --- registros de variável
  for (const v of vars) {
    w.i32(2)
    w.i32(v.isStr ? v.width : 0)
    const label = v.label ? enc.encode(String(v.label).slice(0, 200)) : null
    w.i32(label ? 1 : 0)
    w.i32(0) // n_missing_values
    w.i32(v.fmt) // print
    w.i32(v.fmt) // write
    w.str(v.short, 8)
    if (label) {
      w.i32(label.length)
      const padded = Math.ceil(label.length / 4) * 4
      w.bytes(padBytes(label, padded, 0x20))
    }
    for (let k = 1; k < v.slots; k++) { // continuações de string longa
      w.i32(2); w.i32(-1); w.i32(0); w.i32(0); w.i32(0); w.i32(0); w.str('', 8)
    }
  }

  // --- tipo 7 / subtipo 3: integer info
  w.i32(7); w.i32(3); w.i32(4); w.i32(8)
  ;[1, 0, 0, -1, 1, 1, 2, 65001].forEach((n) => w.i32(n))
  // --- tipo 7 / subtipo 4: float info
  w.i32(7); w.i32(4); w.i32(8); w.i32(3)
  w.f64(SYSMIS); w.f64(Number.MAX_VALUE); w.f64(SYSMIS)
  // --- tipo 7 / subtipo 13: nomes longos
  const lnBytes = enc.encode(vars.map((v) => `${v.short}=${v.long}`).join('\t'))
  w.i32(7); w.i32(13); w.i32(1); w.i32(lnBytes.length); w.bytes(lnBytes)
  // --- tipo 7 / subtipo 20: codificação
  const encBytes = enc.encode('UTF-8')
  w.i32(7); w.i32(20); w.i32(1); w.i32(encBytes.length); w.bytes(encBytes)
  // --- terminador
  w.i32(999); w.i32(0)

  // --- dados
  for (const row of rows) {
    vars.forEach((v, i) => {
      const val = row[i]
      if (v.isStr) {
        const b = enc.encode(val == null ? '' : String(val))
        w.bytes(padBytes(b, v.slots * 8, 0x20))
      } else {
        const n = (val == null || val === '' || Number.isNaN(Number(val))) ? SYSMIS : Number(val)
        w.f64(n)
      }
    })
  }
  return w.result()
}
