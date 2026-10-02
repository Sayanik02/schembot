// ============================================================
//   PREVIEW — draws the schematic from above (or one layer) as a PNG
//   so you can see the whole thing without a 10-chunk view distance.
// ============================================================

const Jimp = require('jimp');
const { AIR, KEEP } = require('./schematic');

const COLORS = [
  [/water|bubble_column/, [50, 90, 210]], [/lava|magma/, [230, 100, 20]],
  [/grass_block|moss|azalea_leaves|^minecraft:grass|fern|leaves/, [80, 150, 55]],
  [/snow|powder_snow|white_|quartz|calcite|birch_planks/, [235, 235, 240]],
  [/sand|end_stone|sandstone|birch/, [220, 205, 150]], [/gravel|andesite|stone_brick|cobble|^minecraft:stone|smooth_stone|deepslate|tuff/, [125, 125, 125]],
  [/dirt|mud|podzol|coarse|rooted|farmland|path/, [120, 85, 55]], [/spruce|dark_oak|brown|chest|barrel|crafting|bookshelf/, [85, 60, 35]],
  [/oak|log|wood|plank|fence|door|stair|slab|jungle|acacia|mangrove|cherry|bamboo/, [160, 125, 75]],
  [/red|brick|nether|crimson|terracotta/, [160, 70, 55]], [/orange|copper|pumpkin|honey/, [215, 120, 40]],
  [/yellow|gold|glowstone|lantern|torch|hay/, [235, 200, 60]], [/blue|lapis|prismarine|ice|cyan/, [60, 140, 190]],
  [/purple|magenta|amethyst|purpur|pink/, [160, 80, 170]], [/green|lime|cactus|slime|kelp|vine|lily/, [70, 140, 60]],
  [/black|coal|obsidian|blackstone|basalt|bedrock/, [35, 35, 40]], [/gray|iron|anvil|chain|smooth|concrete|glass/, [150, 150, 155]],
];

function colorOf(state) {
  for (const [re, c] of COLORS) if (re.test(state)) return c;
  let h = 0; for (const ch of state) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [80 + (h & 127), 80 + ((h >> 7) & 127), 80 + ((h >> 14) & 127)];
}

// layer = null -> top-down view, number -> that horizontal slice (0 = bottom)
async function renderPreview(schem, remap, layer = null) {
  const { width: W, height: H, length: L, data, palette } = schem;
  const scale = Math.max(1, Math.min(8, Math.floor(1200 / Math.max(W, L))));
  const cols = palette.map((s, i) => (i < 2 ? null : colorOf(s)));
  const img = new Jimp(W * scale, L * scale, 0x1b1d23ff);
  const px = img.bitmap.data;

  for (let z = 0; z < L; z++) {
    for (let x = 0; x < W; x++) {
      let idx = AIR, yTop = 0;
      if (layer === null) {
        for (let y = H - 1; y >= 0; y--) {
          const v = remap[data[x + z * W + y * W * L]];
          if (v !== AIR && v !== KEEP) { idx = v; yTop = y; break; }
        }
      } else {
        const v = remap[data[x + z * W + Math.min(layer, H - 1) * W * L]];
        if (v !== AIR && v !== KEEP) { idx = v; yTop = layer; }
      }
      if (idx === AIR) continue;
      const c = cols[idx], shade = layer === null ? 0.6 + 0.4 * (yTop / Math.max(1, H - 1)) : 1;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const o = (((z * scale + dy) * W * scale) + (x * scale + dx)) * 4;
        px[o] = c[0] * shade; px[o + 1] = c[1] * shade; px[o + 2] = c[2] * shade; px[o + 3] = 255;
      }
    }
  }
  return img.getBufferAsync(Jimp.MIME_PNG);
}

module.exports = { renderPreview };
