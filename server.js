const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const os = require('os');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3000;

// PowerPoint control via PowerShell COM automation.
//
// Important: DocumentWindow.View (the normal editing view) exposes GotoSlide but
// NOT Next/Previous — those live only on SlideShowView, reached via SlideShowWindows.
// And while a show is running, ActiveWindow still points at the editing window, so
// driving it would move the wrong thing. Every command below branches accordingly.
const PPT = "$ErrorActionPreference='Stop'; $a=Get-PPT; ";
const IN_SHOW = "$a.SlideShowWindows.Count -gt 0";

// Spawning a fresh PowerShell per command costs 550-1100ms — measured. That made
// every slide advance visibly laggy and, with execSync, froze Node's event loop.
// Instead we keep ONE PowerShell alive and pipe scripts to its stdin, reading back
// until a sentinel line. Cost per command drops to ~20ms.
//
// Calls are still serialized through a promise chain: one interpreter means one
// outstanding script at a time, and it stops concurrent COM calls interleaving.
const SENTINEL = '<<<PPTX_END>>>';

// Cache the Application object in the session, but probe it for liveness first —
// a cached handle goes stale if PowerPoint is closed and reopened.
// Written as one line: the interpreter reads stdin line-by-line, so a multi-line
// definition is fragile here.
//
// SetProcessDPIAware matters. Without it the process sees virtualised coordinates
// (1536x864 on this 1920x1080 display at 125% scaling) and cursor writes land in the
// wrong place — measured: set (400,300) read back (414,343). With it, exact.
const PS_PRELUDE = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -Name U -Namespace Win -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);\'',
  '$null = [Win.U]::SetProcessDPIAware()',
  '$global:SW = [Win.U]::GetSystemMetrics(0)',
  '$global:SH = [Win.U]::GetSystemMetrics(1)',
  // A closed PowerPoint leaves the cached handle as a ZOMBIE: it keeps answering
  // calls instead of throwing, but .Name comes back empty and it reports 0 slides.
  // A simple try/catch probe never trips on it, so the server stayed bound to the
  // dead instance and never saw a newly opened deck. Verified by killing and
  // reopening PowerPoint. Hence: require a non-empty Name AND a readable
  // Presentations.Count, then release the corpse before re-acquiring.
  'function Get-PPT { ' +
    'if ($global:ppt) { ' +
      '$ok = $false; ' +
      'try { $n = $global:ppt.Name; $null = $global:ppt.Presentations.Count; if ($n) { $ok = $true } } catch { $ok = $false }; ' +
      'if ($ok) { return $global:ppt }; ' +
      'try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($global:ppt) } catch { }; ' +
      '$global:ppt = $null ' +
    '}; ' +
    // GetActiveObject only sees instances registered in the Running Object Table, and
    // a user-launched PowerPoint often never registers — measured: PowerPoint open with
    // a deck, yet GetActiveObject threw MK_E_UNAVAILABLE indefinitely. CoCreateInstance
    // attaches to it fine (PowerPoint is single-instance, so no second process spawns).
    // Guarded by a process check so we never silently LAUNCH PowerPoint ourselves.
    "try { $global:ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } " +
    'catch { ' +
      'if (Get-Process POWERPNT -ErrorAction SilentlyContinue) { $global:ppt = New-Object -ComObject PowerPoint.Application } ' +
      'else { throw } ' +
    '}; ' +
    'return $global:ppt }',
].join('; ');

let ps = null;
let psBuf = '';
let lastPsError = null;
let psResolve = null;
let psChain = Promise.resolve();
let psPending = 0;

function startPS() {
  ps = spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', chunk => {
    psBuf += chunk;
    let idx;
    while ((idx = psBuf.indexOf(SENTINEL)) !== -1) {
      const out = psBuf.slice(0, idx).trim();
      psBuf = psBuf.slice(idx + SENTINEL.length);
      const r = psResolve;
      psResolve = null;
      if (r) r(out);
    }
  });
  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', d => {
    // Surface failures instead of swallowing them — a silent catch is exactly what
    // hid the Next/Previous bug for hours. But de-duplicate: with PowerPoint closed
    // the poller would otherwise print the same error every second.
    const m = d.trim();
    if (!m) return;
    const line = m.split('\n')[0];
    if (line === lastPsError) return;
    lastPsError = line;
    console.error('[powerpoint]', line);
  });
  ps.on('exit', () => { ps = null; });
  ps.stdin.write(PS_PRELUDE + '\n');
}

function runPS(script) {
  psPending++;
  const job = () => new Promise(resolve => {
    if (!ps) startPS();
    let done = false;
    const finish = v => { if (!done) { done = true; psPending--; resolve(v); } };

    // Guard against a wedged interpreter. A blocked COM call does NOT recover on its
    // own — e.g. PowerPoint showing the Office Activation Wizard rejects automation
    // and hangs CoCreateInstance indefinitely. Resolving null isn't enough, because
    // the interpreter stays stuck and every later command queues behind it forever.
    // So kill it; the next call spawns a clean one.
    const timer = setTimeout(() => {
      psResolve = null;
      try { if (ps) ps.kill(); } catch { /* already gone */ }
      ps = null;
      psBuf = '';
      finish(null);
    }, 8000);
    psResolve = v => { clearTimeout(timer); finish(v); };

    // try/catch guarantees the sentinel still prints on a terminating error,
    // otherwise a thrown script would deadlock the reader.
    ps.stdin.write(`try { ${script} } catch { Write-Error $_.Exception.Message }; Write-Output '${SENTINEL}'\n`);
  });
  psChain = psChain.then(job, job);
  return psChain;
}

// Only Normal and Sorter are reachable through ViewType. Verified by probing every
// value against live PowerPoint: 10 and 12 are silently accepted but fall back to
// Normal, and 11/13+ raise "Invalid enumeration value".
const PP_VIEW = { normal: 9, sorter: 7 };
const VIEW_NAME = { 9: 'normal', 7: 'sorter' };

// Reading View is not a ViewType at all — it's a slideshow run in a window.
// Present is the same mechanism run full-screen.
const PP_SHOW_TYPE = { show: 1, reading: 2 };

// Physical screen size, filled in from the PowerShell session at startup.
let screenW = 1920;
let screenH = 1080;

async function initScreen() {
  const out = await runPS('$global:SW; $global:SH');
  if (!out) return;
  const [w, h] = out.split(/\s+/).map(n => parseInt(n, 10));
  if (w > 0 && h > 0) {
    screenW = w;
    screenH = h;
    console.log(`[powerpoint] screen ${screenW}x${screenH}`);
  }
}

// Fetch current + total + mode in one round trip; spawning PowerShell is slow and
// this runs on a 1s poll. Emits separate lines rather than a quoted string, because
// nested double quotes don't survive the cmd.exe -Command wrapper.
//
// Slide index is guarded: in Slide Sorter view there is no single "current slide"
// and View.Slide throws, so we fall back to the selection, then to 0 (unknown).
const OFFLINE = {
  status: 'nopowerpoint',
  current: 0, total: 0, mode: 'none', laser: false, name: '',
  pointer: { x: 0.5, y: 0.5 },
};

async function getState() {
  const out = await runPS(
    PPT +
    // Branch on whether a deck is open at all, so closing every presentation reports
    // a clean "no presentation" instead of throwing on ActivePresentation.
    `$has = $a.Presentations.Count -gt 0; ` +
    `if ($has) { ` +
      `if (${IN_SHOW}) { $w=$a.SlideShowWindows.Item(1); $v=$w.View; $p=$w.Presentation } ` +
      `else { $v=$a.ActiveWindow.View; $p=$a.ActivePresentation }; ` +
      `$i=0; try { $i=$v.Slide.SlideIndex } catch { ` +
      `try { $i=$a.ActiveWindow.Selection.SlideRange.SlideIndex } catch { $i=0 } }; ` +
      // [int] cast matters: a failed COM read can yield $null without throwing, which
      // printed an empty line and desynced the whole parse.
      `[int]$i; $p.Slides.Count; ` +
      `if (${IN_SHOW}) { ` +
      `if ($a.ActivePresentation.SlideShowSettings.ShowType -eq 2) { 'reading' } else { 'show' } ` +
      `} else { $a.ActiveWindow.ViewType }; ` +
      `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.LaserPointerEnabled } else { 'False' } ` +
    `} else { 0; 0; 'none'; 'False' }; ` +
    // Raw pixel ints, normalised in JS. Emitting a pre-divided decimal here would be
    // formatted with the machine's locale separator and could arrive as "0,5".
    `$c = [System.Windows.Forms.Cursor]::Position; $c.X; $c.Y; ` +
    `if ($has) { $p.Name } else { '' }`
  );

  // null means the COM call itself failed — PowerPoint isn't running.
  if (out === null) return { ...OFFLINE };

  // Split on lines, not whitespace: the last field is a filename and may contain spaces.
  const L = out.split(/\r?\n/).map(s => s.trim());
  const total = parseInt(L[1], 10) || 0;
  const raw = L[2];
  const cx = parseInt(L[4], 10);
  const cy = parseInt(L[5], 10);

  // Recovered — let the next genuine failure log again.
  if (total > 0) lastPsError = null;

  return {
    status: total > 0 ? 'ok' : 'nopresentation',
    current: parseInt(L[0], 10) || 0,
    total,
    mode: (raw === 'show' || raw === 'reading') ? raw : (VIEW_NAME[raw] || 'other'),
    laser: L[3] === 'True',
    name: L[6] || '',
    pointer: {
      x: Number.isFinite(cx) ? +(cx / screenW).toFixed(4) : 0.5,
      y: Number.isFinite(cy) ? +(cy / screenH).toFixed(4) : 0.5,
    },
  };
}

// The laser IS the mouse cursor — PowerPoint renders it as a dot while a show runs
// with LaserPointerEnabled. So moving the pointer is just moving the cursor.
function movePointer(nx, ny) {
  const x = Math.min(1, Math.max(0, Number(nx) || 0));
  const y = Math.min(1, Math.max(0, Number(ny) || 0));
  return runPS(
    `$null = [Win.U]::SetCursorPos([int](${x} * $global:SW), [int](${y} * $global:SH))`
  );
}

// Slideshow zoom is read-only in the COM model and no keystroke drives it, so the
// laser pointer stands in as the in-show control. This one is genuinely settable.
function setLaser(on) {
  return runPS(
    PPT +
    `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.LaserPointerEnabled = $${on ? 'true' : 'false'} }`
  );
}

// Any running show has to be exited first: ViewType targets the document window,
// which sits behind the show, and switching between Present and Reading means
// restarting the show under a different ShowType.
function setView(mode) {
  const exitFirst = `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.Exit(); Start-Sleep -Milliseconds 400 }; `;

  if (PP_VIEW[mode]) {
    return runPS(PPT + exitFirst + `$a.ActiveWindow.ViewType = ${PP_VIEW[mode]}`);
  }
  if (PP_SHOW_TYPE[mode]) {
    return runPS(
      PPT + exitFirst +
      `$a.ActivePresentation.SlideShowSettings.ShowType = ${PP_SHOW_TYPE[mode]}; ` +
      `$a.ActivePresentation.SlideShowSettings.Run()`
    );
  }
  return Promise.resolve(null);
}

function nextSlide() {
  return runPS(
    PPT +
    `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.Next() } ` +
    `else { $v=$a.ActiveWindow.View; $i=$v.Slide.SlideIndex; ` +
    `if ($i -lt $a.ActivePresentation.Slides.Count) { $v.GotoSlide($i+1) } }`
  );
}

function prevSlide() {
  return runPS(
    PPT +
    `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.Previous() } ` +
    `else { $v=$a.ActiveWindow.View; $i=$v.Slide.SlideIndex; ` +
    `if ($i -gt 1) { $v.GotoSlide($i-1) } }`
  );
}

function goToSlide(n) {
  return runPS(
    PPT +
    `if (${IN_SHOW}) { $a.SlideShowWindows.Item(1).View.GotoSlide(${n}) } ` +
    `else { $a.ActiveWindow.View.GotoSlide(${n}) }`
  );
}

// Broadcast state to all connected clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// Poll PowerPoint state and push updates. Skipped while a command is in flight so
// polls don't pile up behind it — the queue is serialized and each hop costs ~600ms.
let lastKey = null;
setInterval(async () => {
  if (psPending > 0) return;
  const s = await getState();
  if (!s) return;
  const key = `${s.status}/${s.name}/${s.current}/${s.total}/${s.mode}/${s.laser}/` +
              `${s.pointer.x.toFixed(3)}/${s.pointer.y.toFixed(3)}`;
  if (key !== lastKey) {
    lastKey = key;
    broadcast({ type: 'state', ...s });
  }
}, 1000);

const ACTIONS = {
  next: () => nextSlide(),
  prev: () => prevSlide(),
  goto: d => goToSlide(d.slide),
  view: d => setView(d.mode),
  laser: d => setLaser(d.on),
  pointer: d => movePointer(d.x, d.y),
};

// Pointer moves stream in during a drag; a read-back per move would double the queue
// for feedback the phone already draws locally.
const SILENT = new Set(['pointer']);

wss.on('connection', async (ws) => {
  // Send current state on connect
  const s = (await getState()) || { ...OFFLINE };
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'state', ...s }));
  }

  ws.on('message', async (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    const handler = ACTIONS[data.action];
    if (!handler) return;

    // Await the command, then read back — deterministic, and replaces the old
    // fixed 300ms guess that raced against slower COM calls.
    await handler(data);

    // On rapid input, skip the read-back: more commands are already queued, so
    // per-command reads would double the queue and delay the slides themselves.
    // The last one reports, and the 1s poller backstops it.
    if (psPending > 0 || SILENT.has(data.action)) return;

    const after = await getState();
    if (after) {
      lastKey = `${after.current}/${after.total}/${after.mode}/${after.laser}`;
      broadcast({ type: 'state', ...after });
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get local IP — skips APIPA (169.254.x.x) and prefers WiFi/hotspot addresses
function getLocalIP() {
  const nets = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // skip APIPA
      if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) return net.address;
      fallback = fallback || net.address;
    }
  }
  return fallback || 'localhost';
}

server.listen(PORT, '0.0.0.0', async () => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;

  console.log('\n========================================');
  console.log(`  PPTX Controller running at ${url}`);
  console.log('========================================\n');
  console.log('Scan the QR code below with your phone:\n');

  // Print QR to terminal
  const qr = await qrcode.toString(url, { type: 'terminal', small: true });
  console.log(qr);
  console.log(`\nOr open: ${url}\n`);
  console.log('Make sure PowerPoint is open with a presentation!\n');

  // Screen size backs the pointer mapping; read it once the interpreter is up.
  await initScreen();
});
