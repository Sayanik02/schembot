// ============================================================
//   BUILDER — talks to the server (needs the bot to be OP)
//   - checkOp:       is the bot allowed to run /fill?
//   - probeStates:   asks the SERVER which block states it knows (unknown ones get skipped)
//   - buildSchematic: forceload a tile -> run its commands -> next tile (resumable)
// ============================================================

const config = require('./config');
const { makeTiles, tileCommands } = require('./boxes');
const { AIR, KEEP } = require('./schematic');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function checkOp(bot) {
  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (/currently set to/i.test(msg)) done(true);
      else if (/unknown or incomplete|permission|not allowed/i.test(msg)) done(false);
    };
    const timer = setTimeout(() => done(false), 4000);
    function done(v) { clearTimeout(timer); bot.removeListener('messagestr', onMsg); resolve(v); }
    bot.on('messagestr', onMsg);
    bot.chat('/gamerule doDaylightCycle');
  });
}

// Ask the server about every block state with /execute if block ~ ~ ~ <state>.
// "Test passed/failed" = the server understood the block. Anything else = unknown block / bad property.
async function probeStates(bot, states, ctl, onProgress) {
  const invalid = [];
  let uncertain = 0;
  for (let i = 0; i < states.length; i++) {
    if (!ctl.isRunning()) return { invalid, uncertain, aborted: true };
    const state = states[i];
    const verdict = await new Promise((resolve) => {
      const onMsg = (msg) => {
        if (/^test (passed|failed)/i.test(msg) || /^successfully/i.test(msg)) done('ok');
        else if (/unknown|does not accept|incorrect argument|expected|invalid|<--\[here\]/i.test(msg)) done('bad');
      };
      const timer = setTimeout(() => done('unsure'), 2500);
      function done(v) { clearTimeout(timer); bot.removeListener('messagestr', onMsg); resolve(v); }
      bot.on('messagestr', onMsg);
      bot.chat(`/execute if block ~ ~ ~ ${state}`);
    });
    if (verdict === 'bad') invalid.push(state);
    else if (verdict === 'unsure') uncertain++;
    if (onProgress && (i % 10 === 0 || i === states.length - 1)) onProgress(i + 1, states.length);
    await sleep(30);
  }
  return { invalid, uncertain, aborted: false };
}

// remap[paletteIndex] -> index actually built (invalid states become air or KEEP)
function makeRemap(schem, invalidStates) {
  const bad = new Set(invalidStates);
  const remap = new Uint16Array(schem.palette.length);
  for (let i = 0; i < remap.length; i++) {
    remap[i] = (i >= 2 && bad.has(schem.palette[i])) ? (config.schematic.skippedBecomeAir ? AIR : KEEP) : i;
  }
  return remap;
}

// Count commands/blocks per tile (no server needed) so the status page can show real progress.
function makePlan(schem, remap, origin) {
  const tiles = makeTiles(schem.width, schem.length, config.build.tileSize);
  let totalCmds = 0, totalBlocks = 0;
  for (const t of tiles) {
    const { cmds, blocks } = tileCommands(schem, remap, t, origin, config.schematic.pasteAir);
    t.cmds = cmds.length; t.blocks = blocks;
    totalCmds += cmds.length; totalBlocks += blocks;
  }
  return { tiles, totalCmds, totalBlocks };
}

// Returns 'done' | 'paused' | 'noop'
async function buildSchematic(bot, ctx, ctl) {
  const { schem, remap, progress, save } = ctx;
  const o = progress.origin;
  const plan = progress.plan;

  if (!(await checkOp(bot))) return 'noop';

  bot.chat(`/gamemode ${config.build.gamemode}`);
  let failures = 0;
  const onMsg = (m) => {
    if (/not loaded|outside the world|too many blocks|incorrect argument|unknown block|unknown or incomplete/i.test(m)) failures++;
  };
  bot.on('messagestr', onMsg);

  try {
    while (progress.tileIndex < plan.tiles.length) {
      const t = plan.tiles[progress.tileIndex];
      const { cmds } = tileCommands(schem, remap, t, o, config.schematic.pasteAir);
      const baseCmds = plan.tiles.slice(0, progress.tileIndex).reduce((a, x) => a + x.cmds, 0);
      const wx1 = o.x + t.x0, wx2 = o.x + t.x1, wz1 = o.z + t.z0, wz2 = o.z + t.z1;
      const chunks = (Math.ceil((wx2 - wx1 + 1) / 16) + 1) * (Math.ceil((wz2 - wz1 + 1) / 16) + 1);

      for (let attempt = 0; attempt <= config.build.retryTile; attempt++) {
        if (!ctl.isRunning()) { save(); return 'paused'; }
        const startAt = attempt === 0 ? progress.cmdIndex : 0;
        const cx = Math.floor((wx1 + wx2) / 2), cz = Math.floor((wz1 + wz2) / 2);
        const cy = Math.max(config.limits.minY + 2, Math.min(config.limits.maxY - 2, o.y + Math.floor(schem.height / 2)));

        bot.chat(`/forceload add ${wx1} ${wz1} ${wx2} ${wz2}`);
        bot.chat(`/tp @s ${cx} ${cy} ${cz}`);
        await sleep(config.build.forceloadWait + chunks * 20);
        failures = 0;

        for (let j = startAt; j < cmds.length; j++) {
          if (!ctl.isRunning()) { progress.cmdIndex = j; save(); return 'paused'; }
          bot.chat(cmds[j]);
          progress.cmdIndex = j + 1;
          progress.doneCmds = baseCmds + j + 1;
          if (progress.doneCmds % config.build.saveEvery === 0) save();
          await sleep(config.build.opDelay);
        }
        await sleep(1500);
        if (failures === 0) break;
        progress.failures = (progress.failures || 0) + failures;
        console.log(`[Build] Tile ${progress.tileIndex + 1}: server reported ${failures} errors (attempt ${attempt + 1})`);
      }

      bot.chat(`/forceload remove ${wx1} ${wz1} ${wx2} ${wz2}`);
      progress.tileIndex++;
      progress.cmdIndex = 0;
      progress.doneCmds = plan.tiles.slice(0, progress.tileIndex).reduce((a, x) => a + x.cmds, 0);
      save();
      console.log(`[Build] Tile ${progress.tileIndex}/${plan.tiles.length} done`);
    }
  } finally {
    bot.removeListener('messagestr', onMsg);
  }
  return 'done';
}

module.exports = { checkOp, probeStates, makeRemap, makePlan, buildSchematic };
