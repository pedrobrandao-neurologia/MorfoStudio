// nifti-writer.js — escreve um volume 3D como NIfTI-1 (.nii) em ArrayBuffer.
// Suporta uint8 (2), int16 (4), int32 (8), float32 (16), uint16 (512).

const DT = { uint8: 2, int16: 4, int32: 8, float32: 16, uint16: 512 }
const BITS = { 2: 8, 4: 16, 8: 32, 16: 32, 512: 16 }

/**
 * @param {object} o
 * @param {number[]} o.dims  [nx, ny, nz]
 * @param {number[]} o.pixdims [dx, dy, dz]
 * @param {number[]} o.affine 16 números (row-major 4x4) voxel->mm
 * @param {string} o.dtype 'uint8' | 'int16' | 'int32' | 'float32' | 'uint16'
 * @param {TypedArray} o.data
 * @param {string} [o.description]
 * @param {number} [o.intent] intent_code (1002 = NIFTI_INTENT_LABEL)
 * @param {number} [o.sclSlope]
 * @param {number} [o.sclInter]
 */
export function writeNifti(o) {
  const code = DT[o.dtype]
  if (!code) throw new Error('dtype não suportado: ' + o.dtype)
  const [nx, ny, nz] = o.dims
  const nvox = nx * ny * nz
  if (o.data.length !== nvox) throw new Error(`dados (${o.data.length}) ≠ dims (${nvox})`)
  const bytesPerVox = BITS[code] / 8
  const buf = new ArrayBuffer(352 + nvox * bytesPerVox)
  const v = new DataView(buf)
  const le = true
  v.setInt32(0, 348, le) // sizeof_hdr
  v.setInt16(40, 3, le) // dim[0]
  v.setInt16(42, nx, le); v.setInt16(44, ny, le); v.setInt16(46, nz, le)
  v.setInt16(48, 1, le); v.setInt16(50, 1, le); v.setInt16(52, 1, le); v.setInt16(54, 1, le)
  v.setInt16(68, o.intent || 0, le) // intent_code
  v.setInt16(70, code, le) // datatype
  v.setInt16(72, BITS[code], le) // bitpix
  v.setFloat32(76, 1, le) // pixdim[0] (qfac)
  v.setFloat32(80, o.pixdims[0], le); v.setFloat32(84, o.pixdims[1], le); v.setFloat32(88, o.pixdims[2], le)
  v.setFloat32(92, 1, le); v.setFloat32(96, 1, le); v.setFloat32(100, 1, le); v.setFloat32(104, 1, le)
  v.setFloat32(108, 352, le) // vox_offset
  v.setFloat32(112, o.sclSlope ?? 1, le) // scl_slope
  v.setFloat32(116, o.sclInter ?? 0, le) // scl_inter
  v.setInt8(123, 2) // xyzt_units: mm
  // descrip (80 bytes @148)
  const desc = (o.description || 'Morfo Studio').slice(0, 79)
  for (let i = 0; i < desc.length; i++) v.setUint8(148 + i, desc.charCodeAt(i) & 0x7f)
  v.setInt16(252, 0, le) // qform_code
  v.setInt16(254, 1, le) // sform_code = SCANNER_ANAT
  const a = o.affine
  for (let i = 0; i < 12; i++) v.setFloat32(280 + i * 4, a[i], le) // srow_x, srow_y, srow_z
  // magic "n+1\0"
  v.setUint8(344, 0x6e); v.setUint8(345, 0x2b); v.setUint8(346, 0x31); v.setUint8(347, 0)
  // dados
  const out = new Uint8Array(buf, 352)
  out.set(new Uint8Array(o.data.buffer, o.data.byteOffset, o.data.byteLength))
  return buf
}

/** gzip via CompressionStream (navegadores modernos). Retorna Blob. */
export async function gzipBlob(arrayBuffer) {
  if (typeof CompressionStream === 'undefined') return new Blob([arrayBuffer])
  const cs = new CompressionStream('gzip')
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(cs)
  return await new Response(stream).blob()
}
