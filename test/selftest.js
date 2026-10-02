// Offline self-test: builds sample schematics in all 3 formats, "runs" the generated
// commands on a fake server and checks every block ends up exactly where it should.
const nbt = require('prismarine-nbt');
const zlib = require('zlib');
const EventEmitter = require('events');
const assert = require('assert');

const config = require('../config');
config.build.opDelay = 0; config.build.forceloadWait = 0; config.build.tileSize = 20;
const { parseSchematic, applySwaps, countStates } = require('../schematic');
const { probeStates, makeRemap, makePlan, buildSchematic } = require('../builder');

const norm = (s) => String(s).replace(/\[(.*)\]/, (_, p) => '[' + p.split(',').sort().join(',') + ']');
const gz = (tag) => zlib.gzipSync(nbt.writeUncompressed(tag, 'big'));

// A 37 x 9 x 25 test building: stone floor, glass wall, a door, torch, water, stairs, one unknown block
const W = 37, H = 9, L = 25;
function expectedBlock(x, y, z) {
  if (y === 0) return 'minecraft:stone';
  if (y >= 1 && y <= 4 && (x === 0 || x === W - 1 || z === 0 || z === L - 1)) return 'minecraft:glass';
  if (x === 5 && z === 5 && y === 1) return 'minecraft:oak_door[half=lower,facing=north]';
  if (x === 5 && z === 5 && y === 2) return 'minecraft:oak_door[half=upper,facing=north]';
  if (x === 10 && z === 10 && y === 1) return 'minecraft:torch';
  if (x >= 20 && x < 24 && z >= 3 && z < 6 && y === 1) return 'minecraft:water';
  if (x === 12 && z === 12 && y === 1) return 'minecraft:oak_stairs[facing=east,half=bottom]';
  if (x === 14 && z === 14 && y === 1) return 'minecraft:alien_block';       // server does not know this one
  if (x === 16 && z === 16 && y === 1) return 'minecraft:structure_void';     // must be left alone
  return 'minecraft:air';
}

// --- build the 3 file formats ---
function makeSponge() {
  const names = [...new Set(allStates())]; const id = Object.fromEntries(names.map((n, i) => [n, i]));
  const bytes = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    let v = id[expectedBlock(x, y, z)]; while (v > 127) { bytes.push((v & 127) | 128); v >>= 7; } bytes.push(v);
  }
  const pal = {}; names.forEach((n, i) => pal[n] = nbt.int(i));
  return gz(nbt.comp({ Version: nbt.int(2), Width: nbt.short(W), Height: nbt.short(H), Length: nbt.short(L),
    Palette: nbt.comp(pal), BlockData: nbt.byteArray(bytes.map(b => (b > 127 ? b - 256 : b))) }, 'Schematic'));
}
function allStates() { const s = new Set(); for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) s.add(expectedBlock(x, y, z)); return [...s]; }
function toNbtState(s) {
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(s); const o = { Name: nbt.string(m[1]) };
  if (m[2]) { const p = {}; m[2].split(',').forEach(kv => { const [k, v] = kv.split('='); p[k] = nbt.string(v); }); o.Properties = nbt.comp(p); }
  return o;
}
function makeStructure() {
  const names = allStates(); const id = Object.fromEntries(names.map((n, i) => [n, i])); const blocks = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const b = expectedBlock(x, y, z); if (b !== 'minecraft:air') blocks.push({ pos: nbt.list(nbt.int([x, y, z])), state: nbt.int(id[b]) });
  }
  return gz(nbt.comp({ size: nbt.list(nbt.int([W, H, L])), palette: nbt.list(nbt.comp(names.map(toNbtState))),
    blocks: nbt.list(nbt.comp(blocks.map(b => ({ pos: b.pos, state: b.state })))), DataVersion: nbt.int(3700) }));
}
function makeLitematic() {
  const names = allStates(); const id = Object.fromEntries(names.map((n, i) => [n, i]));
  const bits = Math.max(2, Math.ceil(Math.log2(names.length))); const total = W * H * L;
  const longs = new Array(Math.ceil(total * bits / 64)).fill(0n);
  let i = 0;
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++, i++) {
    const v = BigInt(id[expectedBlock(x, y, z)]); const bp = i * bits, w = Math.floor(bp / 64), off = bp % 64;
    longs[w] |= (v << BigInt(off)) & 0xFFFFFFFFFFFFFFFFn;
    if (off + bits > 64) longs[w + 1] |= v >> BigInt(64 - off);
  }
  const pairs = longs.map(l => [Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, l & 0xFFFFFFFFn))]);
  return gz(nbt.comp({ Version: nbt.int(6), Regions: nbt.comp({ Main: nbt.comp({
    Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }), Size: nbt.comp({ x: nbt.int(W), y: nbt.int(H), z: nbt.int(L) }),
    BlockStatePalette: nbt.list(nbt.comp(names.map(toNbtState))), BlockStates: nbt.longArray(pairs) }) }) }));
}

// --- fake server ---
function fakeBot(world) {
  const bot = new EventEmitter(); const known = /^(stone|glass|oak_door|torch|water|oak_stairs)$/;
  bot.cmds = 0; bot.forceloaded = 0;
  bot.chat = (c) => {
    bot.cmds++;
    let m;
    if ((m = /^\/fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(c))) {
      const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number); assert((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1) <= 32768, 'fill too big');
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) world.set(`${x},${y},${z}`, m[7]);
    } else if ((m = /^\/setblock (-?\d+) (-?\d+) (-?\d+) (\S+)$/.exec(c))) world.set(`${m[1]},${m[2]},${m[3]}`, m[4]);
    else if (c.startsWith('/gamerule')) setImmediate(() => bot.emit('messagestr', 'Gamerule doDaylightCycle is currently set to: true'));
    else if ((m = /^\/execute if block ~ ~ ~ (\S+)/.exec(c))) {
      const base = m[1].split('[')[0].replace('minecraft:', '');
      setImmediate(() => bot.emit('messagestr', known.test(base) ? 'Test passed' : `Unknown block type '${m[1]}'`));
    } else if (c.startsWith('/forceload add')) bot.forceloaded++;
  };
  return bot;
}

async function check(label, buffer) {
  const schem0 = await parseSchematic(buffer);
  assert.deepStrictEqual([schem0.width, schem0.height, schem0.length], [W, H, L], label + ' size');
  const schem = applySwaps(schem0, {});
  // every block must be read back correctly
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const got = schem.palette[schem.data[x + z * W + y * W * L]] ?? 'minecraft:structure_void';
    const want = expectedBlock(x, y, z);
    assert.strictEqual(norm(got), norm(want), `${label}: parse mismatch at ${x},${y},${z}`);
  }
  // probe -> unknown block detected
  const world = new Map(); const bot = fakeBot(world);
  const states = schem.palette.filter((s, i) => i >= 2);
  const probe = await probeStates(bot, states, { isRunning: () => true });
  assert.deepStrictEqual(probe.invalid, ['minecraft:alien_block'], label + ' probe');
  // build
  const remap = makeRemap(schem, probe.invalid);
  const origin = { x: -50, y: 64, z: 100 };
  const plan = makePlan(schem, remap, origin);
  const progress = { origin, plan, tileIndex: 0, cmdIndex: 0, doneCmds: 0 };
  // simulate pre-existing terrain inside the box, to prove air clears it
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) world.set(`${origin.x + x},${origin.y + y},${origin.z + z}`, 'minecraft:dirt');
  world.set(`${origin.x + 16},${origin.y + 1},${origin.z + 16}`, 'minecraft:gold_block');   // structure_void spot must survive
  bot.cmds = 0;
  const res = await buildSchematic(bot, { schem, remap, progress, save() {} }, { isRunning: () => true });
  assert.strictEqual(res, 'done');
  let bad = 0;
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    let want = expectedBlock(x, y, z);
    if (want === 'minecraft:alien_block') want = 'minecraft:air';          // skipped -> air
    if (want === 'minecraft:structure_void') want = 'minecraft:gold_block'; // left alone
    const got = world.get(`${origin.x + x},${origin.y + y},${origin.z + z}`);
    if (norm(got) !== norm(want)) { if (bad++ < 3) console.log('  mismatch', x, y, z, 'got', got, 'want', want); }
  }
  assert.strictEqual(bad, 0, `${label}: ${bad} wrong blocks in world`);
  assert.strictEqual(progress.doneCmds, plan.totalCmds);
  console.log(`✔ ${label}: ${W * H * L} positions -> ${bot.cmds} commands over ${plan.tiles.length} tiles, ${bot.forceloaded} forceloads, world matches`);
}

(async () => {
  await check('sponge .schem', makeSponge());
  await check('structure .nbt', makeStructure());
  await check('litematic', makeLitematic());
  // resume test: stop halfway then continue
  const schem = applySwaps(await parseSchematic(makeSponge()), {});
  const remap = makeRemap(schem, []); const origin = { x: 0, y: 0, z: 0 };
  const plan = makePlan(schem, remap, origin);
  const progress = { origin, plan, tileIndex: 0, cmdIndex: 0, doneCmds: 0 };
  const w1 = new Map(); const b1 = fakeBot(w1); let n = 0;
  const r1 = await buildSchematic(b1, { schem, remap, progress, save() {} }, { isRunning: () => n++ < 30 });
  assert.strictEqual(r1, 'paused');
  const r2 = await buildSchematic(b1, { schem, remap, progress: JSON.parse(JSON.stringify(progress)), save() {} }, { isRunning: () => true });
  assert.strictEqual(r2, 'done'); console.log('✔ pause + resume works');
  console.log('ALL TESTS PASSED');
})().catch(e => { console.error('✘', e.message); process.exit(1); });
