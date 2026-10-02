// ============================================================
//   BOX PLANNER — turns a schematic into as few /fill commands as possible
//   Work is split into square "tiles" (forceloaded one at a time).
//   Per tile, commands run in 4 passes so nothing pops off:
//     0 air (clear)  ->  1 solid blocks  ->  2 fragile blocks (torches, doors, rails...)  ->  3 water/lava
// ============================================================

const { AIR, KEEP, baseOf } = require('./schematic');

const MAX_FILL = 32768;
const FRAGILE = /(torch|lantern|ladder|_door$|_sign$|hanging_sign|rail$|_button$|lever|pressure_plate|carpet|banner|_bed$|flower|sapling|tall_grass|short_grass|^minecraft:grass$|fern|vine|redstone_wire|repeater|comparator|tripwire|_head$|_skull$|candle|coral|sea_pickle|kelp|seagrass|pointed_dripstone|sugar_cane|cactus|bamboo|flower_pot|frogspawn|^minecraft:snow$|pink_petals|amethyst_cluster|glow_lichen|sculk_vein|bell$|dripleaf|cocoa|wheat|carrots|potatoes|beetroots|sweet_berry_bush|nether_wart|fire$|lily_pad|chorus|turtle_egg|torchflower|pitcher|dead_bush|mushroom$|roots|spore_blossom|hanging_roots|leaf_litter|bush$)/;
const FLUID   = /(^minecraft:(water|lava)$|bubble_column)/;

function passOf(state) {
  const base = baseOf(state);
  if (FLUID.test(base))   return 3;
  if (FRAGILE.test(base)) return 2;
  return 1;
}

function makeTiles(W, L, tileSize) {
  const tiles = [];
  for (let z = 0; z < L; z += tileSize)
    for (let x = 0; x < W; x += tileSize)
      tiles.push({ x0: x, x1: Math.min(x + tileSize, W) - 1, z0: z, z1: Math.min(z + tileSize, L) - 1 });
  return tiles;
}

// Greedy 2D rectangles per layer, then merge identical rectangles on consecutive layers into 3D boxes.
function computeTileBoxes(schem, remap, tile, pasteAir) {
  const { width: W, height: H, length: L, data } = schem;
  const tw = tile.x1 - tile.x0 + 1, td = tile.z1 - tile.z0 + 1;
  const cur = new Uint16Array(tw * td);
  const seen = new Uint8Array(tw * td);
  const boxes = [];
  let active = new Map();

  for (let y = 0; y < H; y++) {
    for (let z = 0; z < td; z++) {
      const rowBase = (tile.z0 + z) * W + y * W * L + tile.x0;
      for (let x = 0; x < tw; x++) cur[z * tw + x] = remap[data[rowBase + x]];
    }
    seen.fill(0);
    const next = new Map();
    for (let z = 0; z < td; z++) {
      for (let x = 0; x < tw; x++) {
        const s = cur[z * tw + x];
        if (seen[z * tw + x] || s === KEEP || (s === AIR && !pasteAir)) continue;
        let w = 1;
        while (x + w < tw && cur[z * tw + x + w] === s && !seen[z * tw + x + w]) w++;
        let d = 1;
        grow:
        while (z + d < td) {
          for (let xx = x; xx < x + w; xx++) {
            if (cur[(z + d) * tw + xx] !== s || seen[(z + d) * tw + xx]) break grow;
          }
          d++;
        }
        for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) seen[zz * tw + xx] = 1;

        const key = `${s}|${x}|${z}|${w}|${d}`;
        let box = active.get(key);
        if (box && box.y2 === y - 1) box.y2 = y;
        else { box = { s, x: tile.x0 + x, z: tile.z0 + z, w, d, y1: y, y2: y }; boxes.push(box); }
        next.set(key, box);
      }
    }
    active = next;
  }
  return boxes;
}

function* splitBox(x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1 + 1, dy = y2 - y1 + 1;
  const xStep = Math.max(1, Math.min(dx, Math.floor(MAX_FILL / dy)));
  const zStep = Math.max(1, Math.floor(MAX_FILL / (xStep * dy)));
  for (let z = z1; z <= z2; z += zStep)
    for (let x = x1; x <= x2; x += xStep)
      yield [x, y1, z, Math.min(x + xStep - 1, x2), y2, Math.min(z + zStep - 1, z2)];
}

// All commands for one tile, in build order. origin = world position of the schematic's min corner.
function tileCommands(schem, remap, tile, origin, pasteAir) {
  const boxes = computeTileBoxes(schem, remap, tile, pasteAir);
  const passByIdx = schem.palette.map((s, i) => (i === AIR ? 0 : i === KEEP ? -1 : passOf(s)));
  const buckets = [[], [], [], []];
  let blocks = 0;
  for (const b of boxes) {
    const p = passByIdx[b.s];
    if (p < 0) continue;
    buckets[p].push(b);
    if (p > 0) blocks += b.w * b.d * (b.y2 - b.y1 + 1);
  }
  const cmds = [];
  for (const bucket of buckets) {
    bucket.sort((a, b) => a.y1 - b.y1 || a.z - b.z || a.x - b.x);
    for (const b of bucket) {
      const state = schem.palette[b.s];
      const ox = origin.x + b.x, oy = origin.y + b.y1, oz = origin.z + b.z;
      for (const [x1, y1, z1, x2, y2, z2] of splitBox(ox, oy, oz, ox + b.w - 1, origin.y + b.y2, oz + b.d - 1)) {
        cmds.push(x1 === x2 && y1 === y2 && z1 === z2
          ? `/setblock ${x1} ${y1} ${z1} ${state}`
          : `/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${state}`);
      }
    }
  }
  return { cmds, blocks };
}

module.exports = { makeTiles, tileCommands, computeTileBoxes, splitBox, passOf, MAX_FILL };
