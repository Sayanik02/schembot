// ============================================================
//   SCHEMATIC READER — .schem (Sponge v2/v3), .nbt (structure), .litematic
//   Everything is converted to one layout:
//     data[x + z*W + y*W*L] = palette index
//     palette[0] = air, palette[1] = KEEP (leave the world alone), palette[2..] = block states
// ============================================================

const nbt = require('prismarine-nbt');
const crypto = require('crypto');

const AIR  = 0;
const KEEP = 1;
const AIR_NAMES  = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const KEEP_NAMES = new Set(['minecraft:structure_void', 'minecraft:jigsaw']);

const withNs = (n) => (n.includes(':') ? n : 'minecraft:' + n);
const baseOf = (s) => s.split('[')[0];

function stateKey(name, props) {
  name = withNs(name);
  if (!props || !Object.keys(props).length) return name;
  const inner = Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',');
  return `${name}[${inner}]`;
}

class PaletteBuilder {
  constructor() { this.list = ['minecraft:air', null]; this.map = new Map(); }
  id(state) {
    state = withNs(state);
    const base = baseOf(state);
    if (AIR_NAMES.has(base))  return AIR;
    if (KEEP_NAMES.has(base)) return KEEP;
    let i = this.map.get(state);
    if (i === undefined) { i = this.list.length; this.list.push(state); this.map.set(state, i); }
    return i;
  }
}

function checkVolume(w, h, l, maxVolume) {
  const vol = w * h * l;
  if (!(w > 0 && h > 0 && l > 0)) throw new Error('Schematic has an invalid size');
  if (vol > maxVolume) throw new Error(`Schematic is too big (${w}x${h}x${l} = ${vol.toLocaleString()} blocks, limit ${maxVolume.toLocaleString()})`);
  return vol;
}

// ── Sponge .schem (v2 + v3) ───────────────────────────────────
function parseSponge(root, maxVolume) {
  const s = root.Schematic || root;
  const W = s.Width, H = s.Height, L = s.Length;
  const blocks = s.Blocks || s;
  const pal = blocks.Palette;
  const bytes = blocks.Data || s.BlockData;
  if (!pal || !bytes) throw new Error('Sponge schematic has no palette/block data');
  const vol = checkVolume(W, H, L, maxVolume);

  const pb = new PaletteBuilder();
  const idMap = [];
  for (const [key, v] of Object.entries(pal)) idMap[v] = pb.id(key);

  const data = new Uint16Array(vol);
  let i = 0, n = 0;
  while (i < bytes.length && n < vol) {
    let value = 0, shift = 0;
    for (;;) {
      const b = bytes[i++] & 0xff;
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    data[n++] = idMap[value] ?? AIR;
  }
  if (n !== vol) throw new Error(`Block data is shorter than expected (${n} of ${vol})`);
  return { width: W, height: H, length: L, palette: pb.list, data, format: 'sponge' };
}

// ── Vanilla structure .nbt ────────────────────────────────────
function parseStructure(root, maxVolume) {
  const [W, H, L] = root.size;
  const vol = checkVolume(W, H, L, maxVolume);
  const rawPal = root.palette || (root.palettes && root.palettes[0]);
  const pb = new PaletteBuilder();
  const idMap = rawPal.map(p => pb.id(stateKey(p.Name, p.Properties)));
  const data = new Uint16Array(vol);
  for (const b of root.blocks) {
    const [x, y, z] = b.pos;
    data[x + z * W + y * W * L] = idMap[b.state] ?? AIR;
  }
  return { width: W, height: H, length: L, palette: pb.list, data, format: 'structure-nbt' };
}

// ── Litematica .litematic ─────────────────────────────────────
// Blocks are bit-packed across 64-bit words (they may straddle two words).
function wordBits(hi, lo, w, off, n) {           // read n (<=31) bits at offset off (0..63) inside one 64-bit word
  const mask = (1 << n) - 1;
  if (off + n <= 32) return (lo[w] >>> off) & mask;
  if (off >= 32)     return (hi[w] >>> (off - 32)) & mask;
  return (((lo[w] >>> off) | (hi[w] << (32 - off))) >>> 0) & mask;
}

function parseLitematic(root, maxVolume) {
  const regions = Object.values(root.Regions || {});
  if (!regions.length) throw new Error('Litematic has no regions');

  const boxes = regions.map(r => {
    const { x: px, y: py, z: pz } = r.Position, { x: sx, y: sy, z: sz } = r.Size;
    return { r, ax: Math.abs(sx), ay: Math.abs(sy), az: Math.abs(sz),
             x0: px + (sx < 0 ? sx + 1 : 0), y0: py + (sy < 0 ? sy + 1 : 0), z0: pz + (sz < 0 ? sz + 1 : 0) };
  });
  const minX = Math.min(...boxes.map(b => b.x0)), minY = Math.min(...boxes.map(b => b.y0)), minZ = Math.min(...boxes.map(b => b.z0));
  const maxX = Math.max(...boxes.map(b => b.x0 + b.ax)), maxY = Math.max(...boxes.map(b => b.y0 + b.ay)), maxZ = Math.max(...boxes.map(b => b.z0 + b.az));
  const W = maxX - minX, H = maxY - minY, L = maxZ - minZ;
  const vol = checkVolume(W, H, L, maxVolume);

  const pb = new PaletteBuilder();
  const data = new Uint16Array(vol);

  for (const b of boxes) {
    const idMap = b.r.BlockStatePalette.map(p => pb.id(stateKey(p.Name, p.Properties)));
    const longs = b.r.BlockStates;
    const hi = new Int32Array(longs.length), lo = new Int32Array(longs.length);
    longs.forEach((pair, i) => { hi[i] = pair[0]; lo[i] = pair[1]; });
    const bits = Math.max(2, Math.ceil(Math.log2(idMap.length)));
    const total = b.ax * b.ay * b.az;
    let bitPos = 0;
    for (let i = 0; i < total; i++, bitPos += bits) {
      const w = Math.floor(bitPos / 64), off = bitPos % 64;
      let v;
      if (off + bits <= 64) v = wordBits(hi, lo, w, off, bits);
      else {
        const first = 64 - off;
        v = wordBits(hi, lo, w, off, first) | (wordBits(hi, lo, w + 1, 0, bits - first) << first);
      }
      const x = i % b.ax, z = Math.floor(i / b.ax) % b.az, y = Math.floor(i / (b.ax * b.az));
      const gx = b.x0 - minX + x, gy = b.y0 - minY + y, gz = b.z0 - minZ + z;
      data[gx + gz * W + gy * W * L] = idMap[v] ?? AIR;
    }
  }
  return { width: W, height: H, length: L, palette: pb.list, data, format: 'litematic' };
}

// ── Entry point ───────────────────────────────────────────────
async function parseSchematic(buffer, maxVolume = 60000000) {
  let parsed;
  try { ({ parsed } = await nbt.parse(buffer)); }
  catch (e) { throw new Error('Not a valid schematic file (could not read NBT): ' + e.message); }
  const root = nbt.simplify(parsed);

  let out;
  if (root.Regions)                                   out = parseLitematic(root, maxVolume);
  else if (root.size && root.blocks && (root.palette || root.palettes)) out = parseStructure(root, maxVolume);
  else if (root.Schematic || root.BlockData || (root.Palette && root.Width)) out = parseSponge(root, maxVolume);
  else if (root.Blocks && root.Materials !== undefined)
    throw new Error('Old MCEdit .schematic files are not supported. Convert it to .schem (e.g. with WorldEdit or an online converter).');
  else throw new Error('Unknown schematic format');

  out.hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  return out;
}

// Replace blocks using config swaps. Returns a new schematic (palette re-indexed, duplicates merged).
function applySwaps(schem, swaps) {
  if (!swaps || !Object.keys(swaps).length) return schem;
  const pb = new PaletteBuilder();
  const remap = new Uint16Array(schem.palette.length);
  remap[AIR] = AIR; remap[KEEP] = KEEP;
  for (let i = 2; i < schem.palette.length; i++) {
    const s = schem.palette[i];
    const base = baseOf(s), props = s.slice(base.length);
    let target = s;
    if (swaps[s] !== undefined) target = swaps[s];
    else if (swaps[base] !== undefined) target = swaps[base].includes('[') ? swaps[base] : withNs(swaps[base]) + props;
    remap[i] = (target === '' || target === null) ? KEEP : pb.id(target);
  }
  const data = new Uint16Array(schem.data.length);
  for (let i = 0; i < data.length; i++) data[i] = remap[schem.data[i]];
  return { ...schem, palette: pb.list, data };
}

function countStates(schem) {
  const counts = new Uint32Array(schem.palette.length);
  const d = schem.data;
  for (let i = 0; i < d.length; i++) counts[d[i]]++;
  return counts;
}

module.exports = { parseSchematic, applySwaps, countStates, stateKey, baseOf, AIR, KEEP };
