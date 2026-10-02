// ============================================================
//   MINECRAFT SCHEMATIC BUILDER BOT v1.0
//   Builds .schem / .litematic / .nbt files with fast /fill commands.
//   Needs: bot is OP on the server. Blocks the server doesn't know are skipped.
//
//   Control from the status page (your Railway URL) or from the Aternos console
//   (prefix with "say "):
//     say schem list                 - show uploaded files
//     say schem load house.schem     - pick a file
//     say schem origin 100 64 -200   - where the build's lowest corner goes
//     say schem here                 - use the bot's current position as origin
//     say schem analyze              - ask the server which blocks it knows
//     say schem start | stop | resume | status | reset
// ============================================================

process.on('uncaughtException',  (err) => console.error('[UNCAUGHT]', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[REJECTION]', err?.message ?? err));

const fs = require('fs');
const path = require('path');
const express = require('express');
const mineflayer = require('mineflayer');
const config = require('./config');
const { parseSchematic, applySwaps, countStates, baseOf, AIR, KEEP } = require('./schematic');
const { checkOp, probeStates, makeRemap, makePlan, buildSchematic } = require('./builder');
const { loadProgress, saveProgress, resetBuild, listSchematics, SCHEM_DIR } = require('./progress');
const { renderPreview } = require('./preview');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── State ─────────────────────────────────────────────────────
let bot = null;
let progress = loadProgress();
let schem = null, remap = null, counts = null;
let task = null;            // null | 'analyzing' | 'building'
let running = false;        // false = pause/stop requested
let message = 'Idle. Upload a schematic on this page, set the origin, press Start.';
let opOk = null;
let reconnecting = false;
let currentUsername = null;
let sessionStart = null, sessionStartCmds = 0;

const save = () => saveProgress(progress);
const setMsg = (m) => { message = m; console.log('[Bot] ' + m); };

// ── Schematic loading ─────────────────────────────────────────
async function loadSchematic(name) {
  name = path.basename(name || '');
  const file = path.join(SCHEM_DIR, name);
  if (!name || !fs.existsSync(file)) throw new Error('File not found: ' + name + '. Use: schem list');
  const parsed = await parseSchematic(fs.readFileSync(file), config.schematic.maxVolume);
  const swapSig = JSON.stringify(config.schematic.swaps || {}) + config.schematic.pasteAir + config.schematic.skippedBecomeAir;
  const s = applySwaps(parsed, config.schematic.swaps);
  const hash = parsed.hash + ':' + swapSig.length + ':' + require('crypto').createHash('sha1').update(swapSig).digest('hex').slice(0, 8);

  if (progress.file !== name || progress.hash !== hash) {
    if (progress.doneCmds > 0 && progress.state === 'building') throw new Error('A build is in progress. Use "schem reset" first.');
    resetBuild(progress);
    progress.file = name; progress.hash = hash;
  }
  schem = s; counts = countStates(s);
  remap = makeRemap(schem, progress.invalid);
  save();
  setMsg(`Loaded ${name}: ${s.width}x${s.height}x${s.length} (${s.format}), ${s.palette.length - 2} block types`);
}

function requireSchem() { if (!schem) throw new Error('No schematic loaded. Upload one and choose it first.'); }
function requireBot() { if (!bot || !bot.entity) throw new Error('Bot is not connected to the server yet.'); }

function setOrigin(x, y, z) {
  requireSchem();
  [x, y, z] = [x, y, z].map(n => Math.floor(Number(n)));
  if ([x, y, z].some(Number.isNaN)) throw new Error('Origin needs three numbers: x y z');
  if (y < config.limits.minY || y + schem.height - 1 > config.limits.maxY)
    throw new Error(`Height doesn't fit: the build is ${schem.height} tall, so y must be between ${config.limits.minY} and ${config.limits.maxY - schem.height + 1}`);
  if (progress.doneCmds > 0 && progress.state !== 'done') throw new Error('Build already started. "schem reset" first to move it.');
  progress.origin = { x, y, z };
  progress.plan = null; progress.tileIndex = 0; progress.cmdIndex = 0; progress.doneCmds = 0;
  save();
  setMsg(`Origin set to ${x} ${y} ${z} (build covers x ${x}..${x + schem.width - 1}, z ${z}..${z + schem.length - 1})`);
}

function setOriginHere() {
  requireBot();
  const p = bot.entity.position;
  setOrigin(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

// ── Analyze: which blocks does the SERVER know? ───────────────
async function analyze() {
  requireSchem(); requireBot();
  if (task) throw new Error('Busy (' + task + ')');
  task = 'analyzing'; running = true;
  try {
    if (!(await checkOp(bot))) { opOk = false; throw new Error(`Bot is not OP. In the server console run: op ${currentUsername}`); }
    opOk = true;
    const states = schem.palette.filter((s, i) => i >= 2 && counts[i] > 0);
    setMsg(`Checking ${states.length} block types with the server...`);
    const r = await probeStates(bot, states, { isRunning: () => running }, (i, n) => { message = `Checking block types with the server... ${i}/${n}`; });
    if (r.aborted) { setMsg('Analyze stopped'); return; }
    progress.invalid = r.invalid; progress.analyzed = true;
    remap = makeRemap(schem, progress.invalid);
    progress.plan = null;
    save();
    const skipped = r.invalid.reduce((a, s) => a + counts[schem.palette.indexOf(s)], 0);
    setMsg(`Analyze done: ${r.invalid.length} unknown block types will be skipped (${skipped.toLocaleString()} blocks).` +
      (r.uncertain ? ` ⚠ ${r.uncertain} checks got no reply from the server (command feedback may be off), those were assumed OK.` : ''));
  } finally { task = null; running = false; }
}

// ── Start / resume ────────────────────────────────────────────
async function start() {
  requireSchem(); requireBot();
  if (task) throw new Error('Busy (' + task + ')');
  if (!progress.origin) throw new Error('Set the origin first (schem origin x y z, or schem here)');
  if (progress.state === 'done') throw new Error('Already finished. "schem reset" to build again.');

  if (!progress.analyzed) await analyze();
  if (!progress.analyzed) return;

  if (!progress.plan) {
    setMsg('Planning the build...');
    remap = makeRemap(schem, progress.invalid);
    progress.plan = makePlan(schem, remap, progress.origin);
    progress.tileIndex = 0; progress.cmdIndex = 0; progress.doneCmds = 0;
    save();
  }

  task = 'building'; running = true;
  progress.state = 'building'; save();
  sessionStart = Date.now(); sessionStartCmds = progress.doneCmds;
  setMsg(`Building ${progress.file}: ${progress.plan.totalCmds.toLocaleString()} commands in ${progress.plan.tiles.length} work area(s)`);

  (async () => {
    try {
      const res = await buildSchematic(bot, { schem, remap, progress, save }, { isRunning: () => running && !!bot });
      if (res === 'noop')   { opOk = false; progress.state = 'paused'; setMsg(`Bot is not OP. In the server console run: op ${currentUsername}`); }
      else if (res === 'done') { progress.state = 'done'; setMsg('✅ Build finished!'); }
      else { progress.state = 'paused'; setMsg(`Paused at ${percent().toFixed(1)}%`); }
    } catch (e) {
      progress.state = 'paused';
      setMsg('Build error: ' + e.message);
    }
    task = null; running = false; save();
  })();
}

function pause() { running = false; return 'Stopping after the current command...'; }

function reset() {
  running = false;
  resetBuild(progress); progress.state = 'idle';
  if (schem) remap = makeRemap(schem, []);
  save();
  setMsg('Progress reset (file and origin kept).');
}

const percent = () => (progress.plan && progress.plan.totalCmds) ? Math.min(100, progress.doneCmds / progress.plan.totalCmds * 100) : 0;

// ── Status ────────────────────────────────────────────────────
function status() {
  const p = progress, plan = p.plan;
  let rate = 0, eta = null;
  if (task === 'building' && sessionStart) {
    rate = (p.doneCmds - sessionStartCmds) / Math.max(1, (Date.now() - sessionStart) / 1000);
    if (rate > 0 && plan) eta = Math.round((plan.totalCmds - p.doneCmds) / rate);
  }
  let top = [], skipped = [];
  if (schem && counts) {
    const rows = schem.palette.map((s, i) => ({ state: s, n: counts[i], i })).filter(r => r.i >= 2 && r.n > 0);
    top = rows.slice().sort((a, b) => b.n - a.n).slice(0, 12).map(r => ({ block: baseOf(r.state).replace('minecraft:', ''), n: r.n }));
    skipped = p.invalid.map(s => ({ state: s, n: counts[schem.palette.indexOf(s)] || 0 })).sort((a, b) => b.n - a.n);
  }
  return {
    state: task || p.state, message, connected: !!(bot && bot.entity), username: currentUsername, op: opOk,
    file: p.file, files: listSchematics(), dir: SCHEM_DIR, volume: !!process.env.RAILWAY_VOLUME_MOUNT_PATH, origin: p.origin,
    schematic: schem ? { w: schem.width, h: schem.height, l: schem.length, format: schem.format, types: schem.palette.length - 2 } : null,
    analyzed: p.analyzed, skipped, top, failures: p.failures || 0,
    percent: percent(), doneCmds: p.doneCmds, totalCmds: plan ? plan.totalCmds : 0,
    tile: plan ? Math.min(p.tileIndex + 1, plan.tiles.length) : 0, tiles: plan ? plan.tiles.length : 0,
    rate: Math.round(rate), eta,
  };
}

// ── Web server ────────────────────────────────────────────────
const app = express();
const TOKEN = process.env.ADMIN_TOKEN || null;
app.use((req, res, next) => {
  if (TOKEN && req.query.token !== TOKEN) return res.status(401).send('Add ?token=YOUR_ADMIN_TOKEN to the URL');
  next();
});

const act = (fn) => async (req, res) => {
  try { const r = await fn(req); res.json({ ok: true, message: (typeof r === 'string' ? r : message) }); }
  catch (e) { message = 'Error: ' + e.message; console.log('[Web] ' + message); res.json({ ok: false, message }); }
};

app.get('/api/status',  (req, res) => res.json(status()));
app.get('/api/load',    act(async (q) => { await loadSchematic(q.query.name); }));
app.get('/api/origin',  act(async (q) => setOrigin(q.query.x, q.query.y, q.query.z)));
app.get('/api/here',    act(async () => setOriginHere()));
app.get('/api/analyze', act(async () => { analyze().catch(e => setMsg('Analyze error: ' + e.message)); return 'Analyzing...'; }));
app.get('/api/start',   act(async () => { await start(); }));
app.get('/api/pause',   act(async () => pause()));
app.get('/api/reset',   act(async () => reset()));
app.post('/api/upload', express.raw({ type: () => true, limit: '200mb' }), act(async (q) => {
  const name = path.basename(String(q.query.name || ''));
  if (!/\.(schem|litematic|nbt)$/i.test(name)) throw new Error('File must end in .schem, .litematic or .nbt');
  if (!q.body || !q.body.length) throw new Error('Empty upload');
  fs.writeFileSync(path.join(SCHEM_DIR, name), q.body);
  console.log(`[Upload] Saved ${name} (${q.body.length} bytes) to ${SCHEM_DIR}`);
  try { await loadSchematic(name); }
  catch (e) { try { fs.unlinkSync(path.join(SCHEM_DIR, name)); } catch (x) {} throw e; }   // don't keep broken files
}));

app.get('/preview.png', async (req, res) => {
  if (!schem) return res.status(404).send('Load a schematic first');
  try {
    const layer = req.query.layer !== undefined ? parseInt(req.query.layer, 10) : null;
    res.type('png').send(await renderPreview(schem, remap, Number.isNaN(layer) ? null : layer));
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/', (req, res) => res.type('html').send(PAGE));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schematic Builder Bot</title><style>
body{font:15px system-ui,sans-serif;background:#14161b;color:#e6e6e6;margin:0;padding:16px;max-width:820px;margin:auto}
.card{background:#1d2027;border-radius:10px;padding:14px;margin:12px 0}h1{font-size:20px}h3{margin:0 0 8px;font-size:15px;color:#9ab}
button,input{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#262a33;color:#eee}
button{cursor:pointer}button:hover{background:#30353f}input{width:80px}.bar{height:16px;background:#2b2f38;border-radius:8px;overflow:hidden}
.bar>div{height:100%;background:#4caf50;width:0}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
small,.dim{color:#8a93a3}img{max-width:100%;image-rendering:pixelated;border-radius:6px;margin-top:8px}
table{width:100%;border-collapse:collapse}td{padding:3px 6px;border-bottom:1px solid #2a2e37;font-size:13px;word-break:break-all}.warn{color:#f0b429}.bad{color:#ef5350}</style></head><body>
<h1>🧱 Schematic Builder Bot</h1>
<div class="card"><div id="msg">...</div><div class="bar" style="margin-top:10px"><div id="fill"></div></div>
<div id="stats" class="dim" style="margin-top:6px"></div></div>
<div class="card"><h3>1. Schematic</h3><div class="row"><select id="files" style="padding:8px;background:#262a33;color:#eee;border-radius:6px"></select>
<button onclick="call('load',{name:files.value})">Load</button><input type="file" id="up" style="width:auto" accept=".schem,.litematic,.nbt"><button onclick="upload()">Upload</button></div>
<div id="info" class="dim"></div><div id="store" class="dim" style="margin-top:4px"></div></div>
<div class="card"><h3>2. Where to build (lowest corner of the build)</h3><div class="row">
X <input id="x" type="number"> Y <input id="y" type="number"> Z <input id="z" type="number">
<button onclick="call('origin',{x:x.value,y:y.value,z:z.value})">Set</button><button onclick="call('here')">Use bot position</button></div></div>
<div class="card"><h3>3. Build</h3><div class="row"><button onclick="call('analyze')">Check blocks</button>
<button onclick="call('start')">▶ Start / Resume</button><button onclick="call('pause')">⏸ Pause</button><button onclick="if(confirm('Wipe progress?'))call('reset')">Reset</button></div>
<small>OP is required: run <code>op BOTNAME</code> in the server console.</small></div>
<div class="card" id="skipcard" style="display:none"><h3>Skipped blocks (unknown to the server)</h3><table id="skip"></table></div>
<div class="card"><h3>Most used blocks</h3><table id="top"></table></div>
<div class="card"><h3>Preview</h3><div class="row"><button onclick="prev(null)">Top view</button>
Layer <input id="layer" type="number" value="0"><button onclick="prev(layer.value)">Show</button></div><img id="pv" alt=""></div>
<script>
const T=new URLSearchParams(location.search).get('token'),q=o=>new URLSearchParams({...o,...(T?{token:T}:{})}).toString();
const $=id=>document.getElementById(id);let last='',flash=0;
async function call(a,o={}){const r=await(await fetch('/api/'+a+'?'+q(o))).json();$('msg').textContent=r.message;flash=Date.now();refresh();if(a==='load'&&r.ok)prev(null)}
async function upload(){const f=$('up').files[0];if(!f){$('msg').textContent='Choose a file first';return}$('msg').textContent='Uploading '+f.name+' ('+(f.size/1024).toFixed(0)+' KB)...';flash=Date.now();
 let r;try{r=await(await fetch('/api/upload?'+q({name:f.name}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:f})).json()}catch(e){r={ok:false,message:'Upload failed: '+e.message+' (file too big for the proxy, or server restarting)'}}$('msg').textContent=r.message;flash=Date.now();refresh();if(r.ok)prev(null)}
function prev(l){$('pv').src='/preview.png?'+q(l===null?{t:Date.now()}:{layer:l,t:Date.now()})}
async function refresh(){const s=await(await fetch('/api/status?'+q({}))).json();
 if(Date.now()-flash>10000)$('msg').textContent=s.message;$('fill').style.width=s.percent+'%';
 $('stats').textContent=[s.state.toUpperCase(),s.connected?'bot online ('+s.username+')':'bot offline',s.op===false?'NOT OP':'',
  s.totalCmds?s.percent.toFixed(1)+'% - area '+s.tile+'/'+s.tiles:'',s.rate?s.rate+' cmd/s':'',s.eta?'ETA '+Math.ceil(s.eta/60)+' min':'',s.failures?s.failures+' server errors':''].filter(Boolean).join('  |  ');
 const f=$('files');if(f.dataset.k!==s.files.join()+s.file){f.innerHTML=s.files.map(n=>'<option'+(n===s.file?' selected':'')+'>'+n+'</option>').join('');f.dataset.k=s.files.join()+s.file}
 $('info').textContent=s.schematic?s.schematic.w+' x '+s.schematic.h+' x '+s.schematic.l+' ('+s.schematic.format+'), '+s.schematic.types+' block types':'No schematic loaded';

 $('store').innerHTML=s.volume?'Saved in '+s.dir+' (volume attached, files survive redeploys)':'<span class=warn>No volume attached: uploads will be DELETED on every redeploy/restart ('+s.dir+')</span>';
 if(s.origin&&document.activeElement.tagName!=='INPUT'){x.value=s.origin.x;y.value=s.origin.y;z.value=s.origin.z}
 $('skipcard').style.display=s.skipped.length?'block':'none';
 $('skip').innerHTML=s.skipped.map(r=>'<tr><td class=bad>'+r.state+'</td><td>'+r.n+'</td></tr>').join('');
 $('top').innerHTML=s.top.map(r=>'<tr><td>'+r.block+'</td><td>'+r.n.toLocaleString()+'</td></tr>').join('');
 if(last!==s.file){last=s.file;if(s.file)prev(null)}}
refresh();setInterval(refresh,3000);
</script></body></html>`;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[Web] Status page on port ' + PORT));

// ── Anti-AFK: look around, walk a step and back, jump, swing ──
let afkTimer = null;
function stopAntiAfk() { if (afkTimer) clearInterval(afkTimer); afkTimer = null; }
function startAntiAfk() {
  stopAntiAfk();
  const cfg = config.bot.antiAfk;
  if (!cfg || !cfg.enabled) return;
  let busy = false;
  afkTimer = setInterval(async () => {
    const b = bot;
    if (busy || !b || !b.entity) return;
    busy = true;
    try {
      await b.look(b.entity.yaw + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 0.6, true);
      const r = Math.random();
      if (r < 0.45) {                       // one step forward, then the same step back
        const d = 300 + Math.random() * 400;
        b.setControlState('forward', true); await sleep(d); b.setControlState('forward', false);
        await sleep(150);
        b.setControlState('back', true);    await sleep(d); b.setControlState('back', false);
      } else if (r < 0.75) {                // jump
        b.setControlState('jump', true); await sleep(250); b.setControlState('jump', false);
      } else b.swingArm();                  // wave
    } catch (e) { /* bot may have disconnected mid-move */ }
    try { b.clearControlStates(); } catch (e) {}
    busy = false;
  }, cfg.intervalMs || 20000);
}

// ── Minecraft connection ──────────────────────────────────────
function nextUsername() {
  const list = config.bot.usernames;
  return list[(progress.usernameIndex || 0) % list.length];
}

function createBot() {
  reconnecting = false;
  currentUsername = nextUsername();
  console.log(`[Bot] Connecting as "${currentUsername}" to ${config.server.host}:${config.server.port} (protocol ${config.server.version})`);
  bot = mineflayer.createBot({
    host: config.server.host, port: config.server.port, username: currentUsername,
    version: config.server.version, auth: 'offline', checkTimeoutInterval: 60000,
  });
  bot.once('spawn', onSpawn);
  bot.on('chat', onChat);
  bot.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
    console.log('[Bot] Kicked: ' + r);
    if (/ban/i.test(r)) { progress.usernameIndex = (progress.usernameIndex || 0) + 1; save(); }
  });
  bot.on('error', (e) => { console.error('[Bot] Error:', e.message); scheduleReconnect(); });
  bot.on('end', (r) => { console.log('[Bot] Disconnected:', r); scheduleReconnect(); });
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true; running = false; opOk = null;
  stopAntiAfk();
  const wasBuilding = progress.state === 'building';
  if (wasBuilding) { progress.state = 'paused'; progress.resumeOnSpawn = true; save(); }
  bot = null;
  setTimeout(createBot, config.bot.reconnectDelay);
}

async function onSpawn() {
  console.log(`[Bot] ✅ Spawned as "${currentUsername}"`);
  await sleep(3000);
  startAntiAfk();
  if (progress.resumeOnSpawn && schem && !task) {
    progress.resumeOnSpawn = false; save();
    console.log('[Bot] Auto-resuming the build');
    start().catch(e => setMsg('Resume failed: ' + e.message));
  } else setMsg(message.startsWith('Idle') ? 'Bot online. ' + message : message);
}

async function onChat(username, text) {
  const m = /schem\s+(\w+)\s*(.*)$/i.exec(text);
  if (!m) return;
  if (config.bot.allowedUsers && !config.bot.allowedUsers.includes(username)) return;
  const cmd = m[1].toLowerCase(), arg = m[2].trim();
  console.log(`[Console] schem ${cmd} ${arg}`);
  try {
    if (cmd === 'list')         setMsg('Files: ' + (listSchematics().join(', ') || '(none uploaded)'));
    else if (cmd === 'load')    await loadSchematic(arg);
    else if (cmd === 'origin')  setOrigin(...arg.split(/[\s,]+/));
    else if (cmd === 'here')    setOriginHere();
    else if (cmd === 'analyze') await analyze();
    else if (cmd === 'start' || cmd === 'resume') await start();
    else if (cmd === 'stop' || cmd === 'pause')   setMsg(pause());
    else if (cmd === 'reset')   reset();
    else if (cmd === 'status')  { const s = status(); setMsg(`${s.state} ${s.percent.toFixed(1)}% (${s.doneCmds}/${s.totalCmds}) ${s.file || ''}`); }
    else setMsg('Unknown command. Try: list, load, origin, here, analyze, start, stop, reset, status');
    if (bot) bot.chat(message.slice(0, 200));
  } catch (e) { setMsg('Error: ' + e.message); }
}

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  if (progress.file) {
    try { await loadSchematic(progress.file); }
    catch (e) { console.log('[Boot] Could not reload ' + progress.file + ': ' + e.message); }
  }
  if (progress.state === 'building') { progress.resumeOnSpawn = true; progress.state = 'paused'; save(); }
  createBot();
})();
