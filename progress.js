// ============================================================
//   PROGRESS — saved to disk so a restart/crash resumes where it stopped
//   (uses the Railway volume automatically if one is attached)
// ============================================================

const fs   = require('fs');
const path = require('path');
const config = require('./config');

const VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const FILE = VOL ? path.join(VOL, 'progress.json') : './progress.json';
const SCHEM_DIR = VOL ? path.join(VOL, 'schematics') : config.schematic.dir;
fs.mkdirSync(SCHEM_DIR, { recursive: true });

function fresh() {
  return {
    file: null, hash: null,
    origin: null,                 // {x,y,z} world position of the schematic's min corner
    invalid: [], analyzed: false, // block states the server rejected
    plan: null,                   // {tiles:[{x0,x1,z0,z1,cmds,blocks}], totalCmds, totalBlocks}
    tileIndex: 0, cmdIndex: 0, doneCmds: 0,
    failures: 0,
    state: 'idle',                // idle | building | paused | done
    usernameIndex: 0,
  };
}

function loadProgress() {
  try {
    if (fs.existsSync(FILE)) return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) { console.log('[Progress] Corrupt progress file, starting fresh'); }
  return fresh();
}

function saveProgress(p) {
  try { fs.writeFileSync(FILE, JSON.stringify(p)); }
  catch (e) { console.error('[Progress] Save error:', e.message); }
}

// wipe build progress but keep which file + where it goes
function resetBuild(p) {
  p.invalid = []; p.analyzed = false; p.plan = null;
  p.tileIndex = 0; p.cmdIndex = 0; p.doneCmds = 0; p.failures = 0; p.state = 'idle';
  saveProgress(p);
}

function listSchematics() {
  return fs.readdirSync(SCHEM_DIR).filter(f => /\.(schem|litematic|nbt)$/i.test(f)).sort();
}

module.exports = { loadProgress, saveProgress, resetBuild, listSchematics, SCHEM_DIR };
