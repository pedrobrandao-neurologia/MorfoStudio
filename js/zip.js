// zip.js — ZIP "store" (sem compressão) com CRC32. Suficiente para empacotar exportações.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(u8) {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}
/** entries: [{ name: 'a.csv', data: Uint8Array }] → Uint8Array */
export function writeZip(entries) {
  const enc = new TextEncoder()
  const locals = [], centrals = []
  let offset = 0
  const { time, date } = dosDateTime()
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
    const crc = crc32(data)
    const lh = new Uint8Array(30 + name.length)
    const v = new DataView(lh.buffer)
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true) // utf-8 flag
    v.setUint16(8, 0, true); v.setUint16(10, time, true); v.setUint16(12, date, true)
    v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true)
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true)
    lh.set(name, 30)
    const ch = new Uint8Array(46 + name.length)
    const c = new DataView(ch.buffer)
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true)
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true)
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true)
    c.setUint16(28, name.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true)
    c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true)
    ch.set(name, 46)
    locals.push(lh, data); centrals.push(ch)
    offset += lh.length + data.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true)
  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let o = 0
  for (const p of [...locals, ...centrals, eocd]) { out.set(p, o); o += p.length }
  return out
}
