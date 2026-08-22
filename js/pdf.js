// pdf.js — gerador PDF 1.4 mínimo: texto Helvetica (WinAnsi), retângulos, linhas e imagens JPEG.
// Sem dependências. Suficiente para o relatório de volumetria.

const W_ASCII = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]
// mapeamento de caracteres fora do ASCII para largura aproximada (letra base)
const BASE = { 'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','ç':'c','è':'e','é':'e','ê':'e','ë':'e','ì':'i','í':'i','î':'i','ï':'i','ñ':'n','ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ù':'u','ú':'u','û':'u','ü':'u','ý':'y','À':'A','Á':'A','Â':'A','Ã':'A','Ä':'A','Ç':'C','È':'E','É':'E','Ê':'E','Ë':'E','Í':'I','Ì':'I','Î':'I','Ï':'I','Ñ':'N','Ó':'O','Ò':'O','Ô':'O','Õ':'O','Ö':'O','Ú':'U','Ù':'U','Û':'U','Ü':'U','°':'o','²':'2','³':'3','µ':'u','–':'-','—':'-','•':'o','’':"'",'“':'"','”':'"','…':'.' }

// UTF-16 → byte WinAnsi (cp1252)
const CP1252_EXTRA = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F }
function toWinAnsi(str) {
  const out = []
  for (const ch of String(str)) {
    const c = ch.codePointAt(0)
    if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) out.push(c)
    else if (CP1252_EXTRA[c] !== undefined) out.push(CP1252_EXTRA[c])
    else if (c === 0x2192) out.push(0x2D) // → vira '-'
    else if (c === 0x2264) out.push(0x3C) // ≤ vira '<'
    else if (c === 0x2265) out.push(0x3E)
    else if (c === 0x2248) out.push(0x7E) // ≈ vira '~'
    else if (c === 0x03C3) out.push(...[0x73,0x69,0x67,0x6D,0x61]) // σ vira 'sigma'
    else if (c === 0x2212) out.push(0x2D)
    else out.push(0x3F)
  }
  return out
}

export function textWidth(str, size, bold = false) {
  const tbl = bold ? W_BOLD : W_ASCII
  let w = 0
  for (let ch of String(str)) {
    ch = BASE[ch] || ch
    const c = ch.charCodeAt(0)
    w += (c >= 32 && c <= 126) ? tbl[c - 32] : 556
  }
  return (w / 1000) * size
}

export class MiniPDF {
  constructor({ width = 595.28, height = 841.89 } = {}) {
    this.width = width; this.height = height
    this.pages = []  // cada página: { ops: [], images: [] }
    this.images = [] // { bytes, w, h, name }
    this.cur = null
  }
  addPage() {
    this.cur = { ops: [], imageNames: new Set() }
    this.pages.push(this.cur)
    return this
  }
  // coordenadas: origem no canto superior esquerdo (y cresce para baixo) — convertido internamente
  _y(y) { return this.height - y }
  setColor(ops, rgb, stroke = false) {
    const [r, g, b] = rgb.map((v) => (v / 255).toFixed(3))
    ops.push(`${r} ${g} ${b} ${stroke ? 'RG' : 'rg'}`)
  }
  text(x, y, str, { size = 10, bold = false, color = [20, 20, 20], align = 'left', maxWidth = null } = {}) {
    let s = String(str)
    if (maxWidth) {
      while (s.length > 1 && textWidth(s, size, bold) > maxWidth) s = s.slice(0, -1)
      if (s !== String(str)) s = s.slice(0, -1) + '…'
    }
    let tx = x
    const tw = textWidth(s, size, bold)
    if (align === 'right') tx = x - tw
    else if (align === 'center') tx = x - tw / 2
    const bytes = toWinAnsi(s)
    let esc = ''
    for (const b of bytes) {
      if (b === 0x28 || b === 0x29 || b === 0x5C) esc += '\\' + String.fromCharCode(b)
      else if (b < 32 || b > 126) esc += '\\' + b.toString(8).padStart(3, '0')
      else esc += String.fromCharCode(b)
    }
    const ops = this.cur.ops
    ops.push('BT')
    this.setColor(ops, color)
    ops.push(`/${bold ? 'F2' : 'F1'} ${size} Tf`)
    ops.push(`${tx.toFixed(2)} ${this._y(y).toFixed(2)} Td`)
    ops.push(`(${esc}) Tj`)
    ops.push('ET')
    return tw
  }
  // texto com quebra de linha automática; retorna y final
  paragraph(x, y, str, { size = 10, bold = false, color = [20, 20, 20], width = 400, lineHeight = 1.35 } = {}) {
    const words = String(str).split(/\s+/)
    let line = ''
    const lh = size * lineHeight
    for (const w of words) {
      const test = line ? line + ' ' + w : w
      if (textWidth(test, size, bold) > width && line) {
        this.text(x, y, line, { size, bold, color }); y += lh; line = w
      } else line = test
    }
    if (line) { this.text(x, y, line, { size, bold, color }); y += lh }
    return y
  }
  rect(x, y, w, h, fill = [230, 230, 230], stroke = null) {
    const ops = this.cur.ops
    if (fill) this.setColor(ops, fill)
    if (stroke) this.setColor(ops, stroke, true)
    ops.push(`${x.toFixed(2)} ${(this._y(y) - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`)
  }
  line(x1, y1, x2, y2, color = [180, 180, 180], width = 0.5) {
    const ops = this.cur.ops
    this.setColor(ops, color, true)
    ops.push(`${width} w ${x1.toFixed(2)} ${this._y(y1).toFixed(2)} m ${x2.toFixed(2)} ${this._y(y2).toFixed(2)} l S`)
  }
  /** bytes: Uint8Array JPEG; w,h: dimensões em px do JPEG; dw,dh: tamanho no papel (pt) */
  image(bytes, w, h, x, y, dw, dh) {
    const name = `Im${this.images.length + 1}`
    this.images.push({ bytes, w, h, name })
    this.cur.imageNames.add(name)
    this.cur.ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${(this._y(y) - dh).toFixed(2)} cm /${name} Do Q`)
  }
  build() {
    const enc = new TextEncoder()
    const parts = []
    const offsets = []
    let pos = 0
    const push = (u8) => { parts.push(u8); pos += u8.length }
    const pushStr = (s) => push(enc.encode(s))
    pushStr('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
    const objs = [] // funções que escrevem cada objeto
    // 1 catalog, 2 pages, 3 F1, 4 F2, depois imagens, depois páginas (page, content)
    const nImg = this.images.length
    const imgIds = this.images.map((_, i) => 5 + i)
    const firstPageId = 5 + nImg
    const pageIds = this.pages.map((_, i) => firstPageId + i * 2)
    objs.push(() => `<< /Type /Catalog /Pages 2 0 R >>`)
    objs.push(() => `<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`)
    objs.push(() => `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`)
    objs.push(() => `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`)
    for (const im of this.images) {
      objs.push({ bin: im.bytes, dict: `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>` })
    }
    this.pages.forEach((p, i) => {
      const pid = pageIds[i]
      const xobj = [...p.imageNames].map((n) => `/${n} ${imgIds[this.images.findIndex((im) => im.name === n)]} 0 R`).join(' ')
      objs.push(() => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobj} >> >> /Contents ${pid + 1} 0 R >>`)
      const content = enc.encode(p.ops.join('\n'))
      objs.push({ bin: content, dict: `<< /Length ${content.length} >>` })
    })
    objs.forEach((o, i) => {
      offsets.push(pos)
      const id = i + 1
      if (typeof o === 'function') pushStr(`${id} 0 obj\n${o()}\nendobj\n`)
      else { pushStr(`${id} 0 obj\n${o.dict}\nstream\n`); push(o.bin); pushStr('\nendstream\nendobj\n') }
    })
    const xref = pos
    pushStr(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`)
    for (const off of offsets) pushStr(`${String(off).padStart(10, '0')} 00000 n \n`)
    pushStr(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    const out = new Uint8Array(pos)
    let o = 0
    for (const p of parts) { out.set(p, o); o += p.length }
    return out
  }
}
