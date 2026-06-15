// ============================================================
// LuxFidelis v3 — Cloudflare Worker · MICA Edition
// Dashboard completa + Automazione circadiana + Alert sismici
// ============================================================
// ENV SECRETS (wrangler secret put <NAME>):
//   TUYA_CLIENT_ID     → Access ID dal progetto Tuya IoT
//   TUYA_CLIENT_SECRET → Access Secret dal progetto Tuya IoT
//   TUYA_DEVICE_ID     → Device ID dalla Smart Life / Tuya app
//   LUCE_PASSWORD      → Password di accesso alla dashboard
// KV Namespace:
//   LUCE_KV            → Programmazioni utente (crea con wrangler)
// ============================================================

const TUYA_BASE_URL = 'https://openapi.tuyaeu.com'; // EU data center
// Per altri data center: openapi.tuyaus.com (US) / openapi.tuyacn.com (CN)

const SCHEDULE = [
  { hour: 9,  minute: 0,  action: 'fade_on'    },
  { hour: 9,  minute: 20, action: 'warm_low'   },
  { hour: 19, minute: 1,  action: 'warm_medium'},
  { hour: 23, minute: 1,  action: 'warm_dim'   },
  { hour: 1,  minute: 0,  action: 'off_if_on'  },
];

const SEISMIC_RESPONSES = [
  { min: 2.0, max: 2.9, pattern: 'slow_orange'  },
  { min: 3.0, max: 3.9, pattern: 'fast_red'     },
  { min: 4.0, max: 4.9, pattern: 'solid_red_30s'},
  { min: 5.0, max: 99,  pattern: 'emergency'    },
];

// ── TUYA AUTH ─────────────────────────────────────────────────

let _tok = { v: null, exp: 0 };

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function getTuyaToken(clientId, clientSecret) {
  if (_tok.v && Date.now() < _tok.exp) return _tok.v;
  const t = Date.now().toString();
  const path = '/v1.0/token?grant_type=1';
  const bodyHash = await sha256hex('');
  const strToSign = ['GET', bodyHash, '', path].join('\n');
  const sign = await hmacSign(clientSecret, clientId + t + strToSign);
  const res = await fetch(`${TUYA_BASE_URL}${path}`, {
    headers: { client_id: clientId, sign, sign_method: 'HMAC-SHA256', t }
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Token error: ${JSON.stringify(data)}`);
  _tok = { v: data.result.access_token, exp: Date.now() + 6900_000 };
  return _tok.v;
}

async function tuyaReq(method, token, clientId, clientSecret, path, body = null) {
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const bodyHash = await sha256hex(bodyStr);
  const strToSign = [method, bodyHash, '', path].join('\n');
  const sign = await hmacSign(clientSecret, clientId + token + t + strToSign);
  const res = await fetch(`${TUYA_BASE_URL}${path}`, {
    method,
    headers: {
      client_id: clientId, access_token: token,
      sign, sign_method: 'HMAC-SHA256', t,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: bodyStr } : {})
  });
  return res.json();
}

const tuyaCmd  = (tok, cId, cSec, devId, cmds) =>
  tuyaReq('POST', tok, cId, cSec, `/v1.0/devices/${devId}/commands`, { commands: cmds });
const tuyaStat = (tok, cId, cSec, devId) =>
  tuyaReq('GET',  tok, cId, cSec, `/v1.0/devices/${devId}/status`);

// ── COMMAND BUILDERS ─────────────────────────────────────────
// Uses v2 DPS codes — required by most bulbs manufactured after 2022

const cmdOn     = ()      => ({ code: 'switch_led',       value: true });
const cmdOff    = ()      => ({ code: 'switch_led',       value: false });
const cmdBright = v       => ({ code: 'bright_value_v2',  value: Math.round(Math.max(10, Math.min(1000, v))) });
const cmdTemp   = v       => ({ code: 'temp_value_v2',    value: Math.round(Math.max(0,  Math.min(1000, v))) });
const cmdMode   = m       => ({ code: 'work_mode',         value: m });
const cmdColor  = (h,s,v) => ({ code: 'colour_data_v2',   value: JSON.stringify({ h, s, v }) });

// ── COLOR HELPERS ─────────────────────────────────────────────

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g-b)/d + 6) % 6;
    else if (max === g) h = (b-r)/d + 2;
    else h = (r-g)/d + 4;
    h = Math.round(h * 60);
  }
  return { h, s: max ? Math.round(d/max*1000) : 0, v: Math.round(max*1000) };
}

function hsvToHex(h, s, v) {
  const sv = s/1000, vv = v/1000;
  const f = (n, k=(n+h/60)%6) => vv - vv*sv*Math.max(Math.min(k,4-k,1),0);
  return '#' + [Math.round(f(5)*255), Math.round(f(3)*255), Math.round(f(1)*255)]
    .map(x => x.toString(16).padStart(2,'0')).join('');
}

function whiteHex(tempPct) {
  const t = Math.max(0, Math.min(100, tempPct)) / 100;
  const warm = [255,168,92], cool = [205,228,255];
  return '#' + warm.map((w,i) => Math.round(w+(cool[i]-w)*t).toString(16).padStart(2,'0')).join('');
}

// ── SCENE PRESETS ─────────────────────────────────────────────

const SCENE_CMDS = {
  sveglia:     [cmdOn(), cmdMode('white'), cmdTemp(1000), cmdBright(900)],
  giorno:      [cmdOn(), cmdMode('white'), cmdTemp(600),  cmdBright(1000)],
  sera:        [cmdOn(), cmdMode('white'), cmdTemp(400),  cmdBright(800)],
  relax:       [cmdOn(), cmdMode('white'), cmdTemp(150),  cmdBright(550)],
  notte:       [cmdOn(), cmdMode('white'), cmdTemp(0),    cmdBright(250)],
  fade_on:     [cmdOn(), cmdMode('white'), cmdTemp(0),    cmdBright(50)],
  warm_low:    [cmdOn(), cmdMode('white'), cmdTemp(0),    cmdBright(200)],
  warm_medium: [cmdOn(), cmdMode('white'), cmdTemp(0),    cmdBright(700)],
  warm_dim:    [         cmdMode('white'), cmdTemp(0),    cmdBright(300)],
  off_if_on:   [cmdOff()],
};

async function applyAction(action, tok, cId, cSec, devId) {
  const cmds = SCENE_CMDS[action];
  if (cmds) await tuyaCmd(tok, cId, cSec, devId, cmds);
}

// ── FENOMENI ─────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

async function runPhenom(name, mag, tok, cId, cSec, devId) {
  mag = parseFloat(mag) || 3.0;
  const intensity = Math.min(1, Math.max(0, (mag - 1) / 5));

  switch (name) {
    case 'battito': {
      const bpm = 60 + Math.round(mag * 15);
      const beat = Math.round(60000 / bpm);
      const beats = Math.max(6, Math.round(mag * 4));
      const bright = Math.round(600 + intensity * 400);
      for (let i = 0; i < beats; i++) {
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(bright)]);
        await delay(Math.round(beat * 0.15));
        await tuyaCmd(tok,cId,cSec,devId,[cmdBright(Math.round(200 + intensity*200))]);
        await delay(Math.round(beat * 0.10));
        await tuyaCmd(tok,cId,cSec,devId,[cmdBright(bright)]);
        await delay(Math.round(beat * 0.15));
        await tuyaCmd(tok,cId,cSec,devId,[cmdBright(50)]);
        await delay(Math.round(beat * 0.60));
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    }
    case 'terremoto': {
      const flashes = Math.max(4, Math.round(mag * 3));
      for (let i = 0; i < flashes; i++) {
        const v = Math.round(400 + intensity * 600);
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('colour'),cmdColor(0,1000,v)]);
        await delay(Math.round(80 + (1-intensity) * 200));
        await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
        await delay(Math.round(80 + Math.round(Math.random() * 200)));
      }
      await delay(400);
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    }
    case 'tramonto': {
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        await tuyaCmd(tok,cId,cSec,devId,[
          cmdOn(), cmdMode('white'),
          cmdTemp(Math.round((1-t) * 600)),
          cmdBright(Math.round(1000 - t * 750))
        ]);
        await delay(3000);
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
      break;
    }
    case 'temporale': {
      const strikes = Math.max(5, Math.round(mag * 3));
      for (let i = 0; i < strikes; i++) {
        const v = Math.round(600 + Math.round(Math.random() * 400));
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(1000),cmdBright(v)]);
        await delay(Math.round(30 + Math.round(Math.random() * 80)));
        await tuyaCmd(tok,cId,cSec,devId,[cmdBright(50)]);
        await delay(Math.round(50 + Math.round(Math.random() * 100)));
        if (Math.round(Math.random() * 10) > 6) {
          await tuyaCmd(tok,cId,cSec,devId,[cmdBright(v)]);
          await delay(40);
          await tuyaCmd(tok,cId,cSec,devId,[cmdBright(50)]);
        }
        await delay(Math.round(300 + Math.round(Math.random() * 700)));
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    }
    case 'aurora': {
      const colors = [[120,800,600],[160,700,650],[210,700,700],[260,800,600],[300,600,550],[180,500,600]];
      for (const [h,s,v] of colors) {
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('colour'),cmdColor(h,s,v)]);
        await delay(3000);
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    }
    case 'onda': {
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let step = 0; step <= 16; step++) {
          const v = Math.round(150 + Math.sin(step/16 * Math.PI) * 650);
          await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(v)]);
          await delay(250);
        }
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(400)]);
      break;
    }
  }
}

// ── ALERT SISMICI ─────────────────────────────────────────────

async function applySeismicPattern(pattern, tok, cId, cSec, devId) {
  switch (pattern) {
    case 'slow_orange':
      for (let i = 0; i < 3; i++) {
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('colour'),cmdColor(30,1000,800)]);
        await delay(1000);
        await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
        await delay(1000);
      }
      await delay(500);
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    case 'fast_red':
      for (let i = 0; i < 5; i++) {
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('colour'),cmdColor(0,1000,1000)]);
        await delay(400);
        await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
        await delay(400);
      }
      await delay(500);
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(0),cmdBright(300)]);
      break;
    case 'solid_red_30s':
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('colour'),cmdColor(0,1000,1000)]);
      await delay(30000);
      await tuyaCmd(tok,cId,cSec,devId,[cmdMode('white'),cmdTemp(0),cmdBright(700)]);
      break;
    case 'emergency':
      for (let i = 0; i < 10; i++) {
        await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(500),cmdBright(1000)]);
        await delay(300);
        await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
        await delay(300);
      }
      await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdTemp(500),cmdBright(1000)]);
      break;
  }
}

// ── QUAKE DATA ───────────────────────────────────────────────

async function fetchQuakes(hoursBack = 24) {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const url = `https://webservices.ingv.it/fdsnws/event/1/query?format=text&limit=20&orderby=time`
    + `&minmag=2.0&minlat=44.0&maxlat=47.5&minlon=12.0&maxlon=14.5&starttime=${since}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const lines = (await res.text()).trim().split('\n').filter(l => !l.startsWith('#') && l.trim());
    if (!lines.length) return { count: 0 };
    const events = lines.map(line => {
      const p = line.split('|');
      if (p.length < 13) return null;
      const mag = parseFloat(p[10]);
      if (isNaN(mag) || mag < 2) return null;
      return { mag, place: (p[12] || 'FVG').trim(), depth: parseFloat(p[4]) || 0, time: p[1] };
    }).filter(Boolean);
    if (!events.length) return { count: 0 };
    const strongest = events.reduce((a,b) => a.mag > b.mag ? a : b);
    return { count: events.length, strongest, latest: events[0] };
  } catch { return null; }
}

async function checkSeismic(tok, cId, cSec, devId) {
  const q = await fetchQuakes(0.5);
  if (!q || !q.strongest) return null;
  const resp = SEISMIC_RESPONSES.find(r => q.strongest.mag >= r.min && q.strongest.mag <= r.max);
  if (!resp) return null;
  console.log(`[SISMO] M${q.strongest.mag} ${q.strongest.place} → ${resp.pattern}`);
  await applySeismicPattern(resp.pattern, tok, cId, cSec, devId);
  return { ...q.strongest, pattern: resp.pattern };
}

// ── TIMEZONE ─────────────────────────────────────────────────

function getRomeTime() {
  const fmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  return {
    hour:   parseInt(parts.find(p => p.type === 'hour').value),
    minute: parseInt(parts.find(p => p.type === 'minute').value),
  };
}

// ── AUTH ─────────────────────────────────────────────────────

async function getExpectedToken(env) {
  return sha256hex('luce-token:' + (env.LUCE_PASSWORD || 'changeme'));
}

function isAuthed(request, expectedToken) {
  return (request.headers.get('Cookie') || '').includes(`luce_auth=${expectedToken}`);
}

// ── DEVICE STATUS ─────────────────────────────────────────────

async function getDeviceStatus(tok, cId, cSec, devId) {
  try {
    const data = await tuyaStat(tok, cId, cSec, devId);
    if (!data.success || !data.result) return { error: 'Tuya error' };
    const dps = Object.fromEntries(data.result.map(x => [x.code, x.value]));
    const power  = dps.switch_led === true;
    const mode   = dps.work_mode || 'white';
    const bright = Math.round((dps.bright_value_v2 || 100) / 10);
    const temp   = Math.round((dps.temp_value_v2   || 0)   / 10);
    let hex;
    if (mode === 'colour' && dps.colour_data_v2) {
      const cd = typeof dps.colour_data_v2 === 'string' ? JSON.parse(dps.colour_data_v2) : dps.colour_data_v2;
      hex = hsvToHex(cd.h || 0, cd.s || 1000, cd.v || 1000);
    } else {
      hex = whiteHex(temp);
    }
    return { power, mode, bright, temp, hex };
  } catch (e) { return { error: e.message }; }
}

// ── PROGRAMMAZIONI KV ────────────────────────────────────────

async function getSchedules(env) {
  try {
    if (!env.LUCE_KV) return [];
    const raw = await env.LUCE_KV.get('schedules');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function putSchedules(env, lst) {
  if (!env.LUCE_KV) return;
  await env.LUCE_KV.put('schedules', JSON.stringify(lst));
}

// ── HTML ──────────────────────────────────────────────────────

const LOGIN_PAGE = `<!DOCTYPE html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>LuxFidelis</title><meta name="theme-color" content="#0b0e16">
<style>
*{box-sizing:border-box;margin:0;font-family:'Segoe UI',system-ui,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;color:#eef2fb;
background:radial-gradient(800px 500px at 50% 0%,#16203a,transparent 60%),#070a12}
.box{text-align:center;padding:34px 26px;width:min(340px,90vw)}
.orb{width:96px;height:96px;border-radius:50%;margin:0 auto 18px;
background:radial-gradient(circle at 38% 32%,#fff5 0 26%,transparent 27%),
radial-gradient(circle,#ff9d4d,#7a3d12 75%);box-shadow:0 0 50px #ff9d4d88,0 0 110px #ff9d4d44}
h1{font-size:30px;letter-spacing:5px;margin-bottom:24px;font-weight:800;
background:linear-gradient(90deg,#ffe0a8,#ff9d4d);-webkit-background-clip:text;background-clip:text;color:transparent}
input{width:100%;padding:15px;border-radius:13px;border:1px solid rgba(255,255,255,.14);
background:rgba(255,255,255,.06);color:#fff;font-size:16px;outline:none;text-align:center}
input:focus{border-color:#ff9d4d}
button{width:100%;margin-top:12px;padding:15px;border:none;border-radius:13px;cursor:pointer;
font-size:16px;font-weight:700;color:#fff;background:linear-gradient(135deg,#ffb347,#ff7e29)}
button:active{transform:scale(.97)}
#err{color:#ff6b6b;font-size:14px;margin-top:14px;min-height:18px}
</style></head><body>
<div class="box">
<div class="orb"></div><h1>LUCE</h1>
<input id="p" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button onclick="go()">Entra</button>
<div id="err"></div>
</div>
<script>
document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
async function go(){
try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
const j=await r.json();
if(j.ok){location.href='/'}else{document.getElementById('err').textContent='Password errata';document.getElementById('p').value='';document.getElementById('p').focus();}
}catch(e){document.getElementById('err').textContent='Errore di connessione'}}
</script></body></html>`;

const DASHBOARD_HTML = `<!DOCTYPE html><html lang="it"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>LUCE</title>
<meta name="theme-color" content="#0b0e16">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="LUCE">
<style>
:root{
 --txt:#eef1fa;--mut:#9aa3b8;--orb:#ff9d4d;--b:.6;--glow:46px;
 --panel:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.025));
 --stroke:rgba(255,255,255,.12);--blur:saturate(180%) blur(30px);
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}
html,body{height:100%;width:100%;max-width:100%;overflow:hidden;position:fixed;inset:0;touch-action:none}
body{font-family:'Segoe UI Variable','Segoe UI',system-ui,sans-serif;color:var(--txt);background:#0b0e16}
.bg{position:fixed;inset:0;z-index:-3;background:
 radial-gradient(1000px 720px at 14% -5%,#26305e 0%,transparent 55%),
 radial-gradient(900px 820px at 92% 12%,#4a2563 0%,transparent 52%),
 radial-gradient(1100px 900px at 55% 112%,#163a58 0%,transparent 55%),#0b0e16;
 animation:drift 26s ease-in-out infinite alternate}
@keyframes drift{to{filter:hue-rotate(22deg) brightness(1.1);transform:scale(1.06)}}
.glowtint{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.4;
 background:radial-gradient(700px 500px at 50% 8%,color-mix(in srgb,var(--orb) 50%,transparent),transparent 70%);
 transition:opacity .8s}
.grain{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.045;mix-blend-mode:overlay;
 background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")}
.app{height:100%;overflow-y:auto;overflow-x:hidden;touch-action:pan-y;overscroll-behavior:contain;
 -webkit-overflow-scrolling:touch;max-width:600px;margin:0 auto;padding:20px 16px 56px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:4px 2px}
.brand{display:flex;align-items:baseline;gap:11px}
.brand h1{font-size:34px;font-weight:300;letter-spacing:11px;padding-left:6px;
 background:linear-gradient(95deg,#fff,#ffd9a8 40%,#ff9d4d 70%,#cfe0ff);
 -webkit-background-clip:text;background-clip:text;color:transparent}
.brand .v{font-size:11px;color:var(--mut);letter-spacing:3px}
.pill{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut);
 background:var(--panel);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
 border:1px solid var(--stroke);padding:8px 13px;border-radius:100px;box-shadow:0 4px 18px rgba(0,0,0,.25)}
.dot{width:8px;height:8px;border-radius:50%;background:#46d98a;box-shadow:0 0 10px #46d98a;animation:bp 2.4s infinite}
.dot.off{background:#5b6578;box-shadow:none;animation:none}
@keyframes bp{50%{transform:scale(1.5);opacity:.6}}
.hero{display:flex;flex-direction:column;align-items:center;padding:18px 0 6px}
.orbwrap{position:relative;width:210px;height:210px;display:flex;align-items:center;justify-content:center}
.orb{width:184px;height:184px;border-radius:50%;cursor:pointer;position:relative;z-index:2;
 transform:scale(var(--b));transition:transform .9s cubic-bezier(.2,.9,.2,1);
 background:radial-gradient(circle at 36% 30%,rgba(255,255,255,.55) 0%,transparent 26%),
  radial-gradient(circle at 50% 52%,var(--orb) 0%,color-mix(in srgb,var(--orb) 50%,#000) 74%,transparent 100%);
 box-shadow:0 0 var(--glow) color-mix(in srgb,var(--orb) 75%,transparent),
  0 0 calc(var(--glow)*2.6) color-mix(in srgb,var(--orb) 42%,transparent),
  inset 0 0 46px rgba(255,255,255,.2),inset 0 -10px 40px rgba(0,0,0,.35);
 animation:breathe 5s ease-in-out infinite}
@keyframes breathe{50%{filter:brightness(1.12)}}
.orb.off{animation:none;filter:grayscale(.65) brightness(.38)}
.ring{position:absolute;inset:8px;border-radius:50%;border:1px solid color-mix(in srgb,var(--orb) 30%,transparent);
 animation:halo 5s ease-in-out infinite}
@keyframes halo{50%{transform:scale(1.09);opacity:.35}}
.reading{margin-top:20px;text-align:center}
.reading .n{font-size:54px;font-weight:200;line-height:1;letter-spacing:-2px}
.reading .n small{font-size:22px;font-weight:300;color:var(--mut)}
.reading .m{font-size:12px;color:var(--mut);letter-spacing:3px;text-transform:uppercase;margin-top:4px}
.panel{position:relative;background:var(--panel);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);
 border:1px solid var(--stroke);border-radius:24px;padding:18px;margin-bottom:14px;
 box-shadow:0 10px 40px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.16)}
.lbl{font-size:11px;color:var(--mut);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:14px;font-weight:600}
.pwr{display:flex;gap:12px}
.pbtn{flex:1;border:none;border-radius:16px;padding:16px;font-size:14px;font-weight:600;letter-spacing:1px;
 cursor:pointer;color:#fff;position:relative;overflow:hidden;transition:transform .12s}
.pbtn:active{transform:scale(.96)}
.b-on{background:linear-gradient(135deg,#ffc46b,#ff7e29);box-shadow:0 10px 26px rgba(255,126,41,.32)}
.b-off{background:linear-gradient(135deg,rgba(255,255,255,.12),rgba(255,255,255,.05));border:1px solid var(--stroke);color:#c3cce0}
.sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.sh .lbl{margin:0}.val{font-weight:600;color:var(--orb);font-size:15px}
input[type=range]{-webkit-appearance:none;width:100%;height:40px;background:transparent;outline:none;touch-action:none}
input[type=range]::-webkit-slider-runnable-track{height:14px;border-radius:10px;border:1px solid rgba(255,255,255,.1)}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:34px;height:34px;border-radius:50%;margin-top:-11px;
 background:radial-gradient(circle at 36% 32%,#fff,#e6ecf8);cursor:pointer;
 box-shadow:0 4px 14px rgba(0,0,0,.5),0 0 0 5px color-mix(in srgb,var(--orb) 50%,transparent)}
.bsl::-webkit-slider-runnable-track{background:linear-gradient(90deg,rgba(255,179,71,.18),#ffb347)}
.tsl::-webkit-slider-runnable-track{background:linear-gradient(90deg,#ff9a3c,#fff,#7cc7ff)}
.steps{display:flex;gap:9px;margin-top:14px}
.steps button{flex:1;border:1px solid var(--stroke);color:var(--txt);border-radius:13px;padding:11px;font-size:15px;
 cursor:pointer;background:rgba(255,255,255,.05);transition:.12s}
.steps button:active{transform:scale(.93);background:rgba(255,255,255,.13)}
.studio{display:flex;gap:18px;align-items:center}
.wheel{width:150px;height:150px;flex:none;border-radius:50%;cursor:crosshair;position:relative;
 background:conic-gradient(red,#ff0,lime,cyan,blue,magenta,red);
 box-shadow:inset 0 0 32px rgba(0,0,0,.55),0 8px 22px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.12)}
.wheel::before{content:"";position:absolute;inset:32%;border-radius:50%;pointer-events:none;
 background:radial-gradient(circle,rgba(255,255,255,.85),rgba(255,255,255,.2) 60%,transparent 72%)}
.whandle{position:absolute;width:20px;height:20px;border-radius:50%;border:3px solid #fff;left:50%;top:50%;
 transform:translate(-50%,-50%);box-shadow:0 0 10px rgba(0,0,0,.7);pointer-events:none}
.sw{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:9px}
.swatch{aspect-ratio:1;border-radius:13px;border:1px solid rgba(255,255,255,.16);cursor:pointer;transition:.12s;
 box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
.swatch:active{transform:scale(.86)}
.favhead{display:flex;justify-content:space-between;align-items:center;margin:16px 0 10px}
.favhead .lbl{margin:0}
.mini{background:rgba(255,255,255,.08);border:1px solid var(--stroke);color:var(--txt);border-radius:11px;
 padding:6px 12px;font-size:12px;cursor:pointer}
.favs{display:flex;gap:9px;flex-wrap:wrap;min-height:32px}
.fav{width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,.22);cursor:pointer}
.fav:active{transform:scale(.85)}
.empty{color:var(--mut);font-size:12px;align-self:center}
.scenes{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.scene{border-radius:16px;padding:13px 4px;cursor:pointer;border:1px solid var(--stroke);
 background:rgba(255,255,255,.05);display:flex;flex-direction:column;align-items:center;gap:7px;transition:.14s}
.scene:active{transform:scale(.92)}
.scene .e{font-size:21px}.scene .t{font-size:10px;color:var(--mut)}
.schedrow{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.schinput{background:rgba(255,255,255,.07);border:1px solid var(--stroke);color:var(--txt);
 border-radius:12px;padding:11px;font-size:15px;outline:none}
.schinput:focus{border-color:var(--orb)}
.schval{width:86px}
.schadd{background:linear-gradient(135deg,#46d98a,#1c9c5c);border:none;color:#fff;font-weight:600;
 border-radius:12px;padding:11px 15px;cursor:pointer;font-size:14px}
.schadd:active{transform:scale(.95)}
.schedlist{margin-top:14px;display:flex;flex-direction:column;gap:8px}
.scheditem{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);
 border:1px solid var(--stroke);border-radius:13px;padding:11px 14px}
.scheditem .t{font-weight:700;font-size:16px;font-variant-numeric:tabular-nums}
.scheditem .a{flex:1;color:var(--mut);font-size:13px}
.delx{background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.3);color:#ff8b8b;
 width:30px;height:30px;border-radius:9px;cursor:pointer;font-size:13px}
.delx:active{transform:scale(.88)}
.quake{display:flex;align-items:center;gap:16px}
.qmag{width:88px;height:88px;border-radius:50%;flex:none;display:flex;flex-direction:column;align-items:center;
 justify-content:center;font-weight:700;position:relative;background:rgba(255,255,255,.04);border:1px solid var(--stroke)}
.qmag .mg{font-size:28px;line-height:1}.qmag .u{font-size:9px;opacity:.7;letter-spacing:1px}
.qmag::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px solid currentColor;opacity:.4;
 animation:qp 2s ease-out infinite;pointer-events:none}
@keyframes qp{0%{transform:scale(.86);opacity:.6}100%{transform:scale(1.32);opacity:0}}
.qi{flex:1;min-width:0}.qi .p{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qi .s{font-size:11px;color:var(--mut);margin-top:3px}
.qline{display:flex;gap:11px;align-items:center;margin-top:15px}
.qline input[type=range]::-webkit-slider-runnable-track{height:10px;background:linear-gradient(90deg,#0a84ff,#34c759,#ffd60a,#ff9500,#ff3b30)}
.qval{font-weight:700;min-width:46px;text-align:center}
.qplay{background:linear-gradient(135deg,#ff6a6a,#c40d0d);border:none;color:#fff;font-weight:600;border-radius:13px;
 padding:11px 15px;cursor:pointer;font-size:13px;white-space:nowrap}
.qplay:active{transform:scale(.94)}
.phen{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.phen button{background:rgba(255,255,255,.05);border:1px solid var(--stroke);color:var(--txt);border-radius:16px;
 padding:15px 6px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:7px;font-size:12px;transition:.14s}
.phen button .e{font-size:23px}
.phen button:active{transform:scale(.92);background:rgba(255,255,255,.12)}
.foot{text-align:center;color:var(--mut);font-size:11px;margin-top:18px;letter-spacing:3px;opacity:.7}
.rip{position:absolute;border-radius:50%;background:rgba(255,255,255,.4);transform:scale(0);animation:rp .55s ease-out;pointer-events:none}
@keyframes rp{to{transform:scale(4);opacity:0}}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(90px);z-index:20;
 background:rgba(20,24,38,.85);backdrop-filter:var(--blur);border:1px solid var(--stroke);
 padding:12px 20px;border-radius:14px;font-size:13px;opacity:0;transition:.35s;box-shadow:0 8px 30px rgba(0,0,0,.4)}
#toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.busy{position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;flex-direction:column;gap:18px;
 background:rgba(8,11,18,.7);backdrop-filter:blur(10px)}
.busy.show{display:flex}
.busy .rg{width:62px;height:62px;border:4px solid rgba(255,255,255,.12);border-top-color:var(--orb);border-radius:50%;animation:spin 1s linear infinite}
.busy .bn{letter-spacing:1px;color:var(--mut)}
@keyframes spin{to{transform:rotate(360deg)}}
.mobile .bg{animation:none}.mobile .grain{display:none}
.mobile input[type=range]{height:48px}
.mobile input[type=range]::-webkit-slider-thumb{width:38px;height:38px;margin-top:-13px}
</style></head><body>
<div class="bg"></div><div class="glowtint" id="tint"></div><div class="grain"></div>
<div class="app">
 <header>
  <div class="brand"><h1>LUCE</h1><span class="v">MICA</span></div>
  <div class="pill"><span id="dot" class="dot off"></span><span id="stext">connessione…</span></div>
 </header>

 <div class="hero">
  <div class="orbwrap"><div class="ring"></div>
   <div id="orb" class="orb off" onclick="ripple(event);cmd({action:'toggle'})"></div></div>
  <div class="reading"><div class="n"><span id="bn">—</span><small>%</small></div>
   <div class="m" id="modetxt">—</div></div>
 </div>

 <div class="panel"><div class="lbl">Alimentazione</div>
  <div class="pwr">
   <button class="pbtn b-on"  onclick="ripple(event);cmd({action:'on'})">ACCENDI</button>
   <button class="pbtn b-off" onclick="ripple(event);cmd({action:'off'})">SPEGNI</button>
  </div></div>

 <div class="panel">
  <div class="sh"><span class="lbl">Luminosità</span><span class="val"><span id="bv">—</span>%</span></div>
  <input id="bsl" type="range" min="1" max="100" value="50" class="bsl"
   oninput="bv.textContent=this.value" onchange="cmd({action:'bright',value:+this.value})">
  <div class="steps">
   <button onclick="ripple(event);cmd({action:'bright_delta',delta:-10})">−10</button>
   <button onclick="ripple(event);cmd({action:'bright_delta',delta:-1})">−</button>
   <button onclick="ripple(event);cmd({action:'bright_delta',delta:1})">+</button>
   <button onclick="ripple(event);cmd({action:'bright_delta',delta:10})">+10</button>
  </div></div>

 <div class="panel">
  <div class="sh"><span class="lbl">Temperatura</span><span class="val" id="tv">—</span></div>
  <input id="tsl" type="range" min="0" max="100" value="50" class="tsl"
   oninput="tv.textContent=this.value+(+this.value<34?'° caldo':+this.value>66?'° freddo':'° neutro')"
   onchange="cmd({action:'temp',value:+this.value})">
 </div>

 <div class="panel"><div class="lbl">Studio colore</div>
  <div class="studio">
   <div class="wheel" id="wheel"><div class="whandle" id="wh"></div></div>
   <div class="sw" id="sw"></div>
  </div>
  <div class="favhead"><span class="lbl">Preferiti</span><button class="mini" onclick="saveFav()">★ salva</button></div>
  <div class="favs" id="favs"></div>
 </div>

 <div class="panel"><div class="lbl">Scene</div>
  <div class="scenes">
   <div class="scene" onclick="ripple(event);cmd({action:'scene',name:'sveglia'})"><span class="e">🌅</span><span class="t">Sveglia</span></div>
   <div class="scene" onclick="ripple(event);cmd({action:'scene',name:'giorno'})"><span class="e">☀️</span><span class="t">Giorno</span></div>
   <div class="scene" onclick="ripple(event);cmd({action:'scene',name:'sera'})"><span class="e">🏗️</span><span class="t">Sera</span></div>
   <div class="scene" onclick="ripple(event);cmd({action:'scene',name:'relax'})"><span class="e">🛋️</span><span class="t">Relax</span></div>
   <div class="scene" onclick="ripple(event);cmd({action:'scene',name:'notte'})"><span class="e">🌙</span><span class="t">Notte</span></div>
  </div></div>

 <div class="panel"><div class="lbl">Programmazioni</div>
  <div class="schedrow">
   <input id="schTime" type="time" value="21:00" class="schinput">
   <select id="schAct" class="schinput" onchange="schToggleVal()">
    <option value="bright">Luminosità %</option>
    <option value="on">Accendi</option>
    <option value="off">Spegni</option>
   </select>
   <input id="schVal" type="number" min="1" max="100" value="10" class="schinput schval">
   <button class="schadd" onclick="addSched()">+ Aggiungi</button>
  </div>
  <div id="schedList" class="schedlist"></div>
 </div>

 <div class="panel"><div class="lbl">Sismografo · FVG/Italia · 24h (INGV)</div>
  <div class="quake">
   <div class="qmag" id="qmag" style="color:#0a84ff"><div class="mg" id="qm">—</div><div class="u">MAG</div></div>
   <div class="qi"><div class="p" id="qp">in ascolto…</div><div class="s" id="qs"></div></div>
  </div>
  <div class="qline">
   <input id="qsl" type="range" min="1" max="7" step="0.1" value="4.0" class="qsl"
    oninput="qval.textContent='M'+(+this.value).toFixed(1)">
   <span class="qval" id="qval">M4.0</span>
   <button class="qplay" onclick="ripple(event);phen('battito',+document.getElementById('qsl').value)">🫀 Battito</button>
  </div>
  <div style="margin-top:10px"><button class="mini" style="width:100%;padding:11px" id="qreal" onclick="playReal()">▶ Ri-vivi il terremoto reale più forte</button></div>
 </div>

 <div class="panel"><div class="lbl">Fenomeni</div>
  <div class="phen">
   <button onclick="ripple(event);phen('terremoto')"><span class="e">🌋</span>Terremoto</button>
   <button onclick="ripple(event);phen('tramonto')"><span class="e">🏗️</span>Tramonto</button>
   <button onclick="ripple(event);phen('temporale')"><span class="e">⛈️</span>Temporale</button>
   <button onclick="ripple(event);phen('aurora')"><span class="e">🌌</span>Aurora</button>
   <button onclick="ripple(event);phen('onda')"><span class="e">🌊</span>Onda</button>
   <button onclick="ripple(event);phen('battito')"><span class="e">🫀</span>Battito reale</button>
  </div></div>

 <div class="foot">LuxFidelis v3 · MICA EDITION · ☁️ cloudflare</div>
</div>

<div id="toast"></div>
<div class="busy" id="busy"><div class="rg"></div><div class="bn" id="bname">…</div></div>

<script>
const $=id=>document.getElementById(id);
let realMag=4.0,curHex='#ff9d4d';

if(/android|iphone|ipad|mobile/i.test(navigator.userAgent))document.body.classList.add('mobile');

function ripple(e){const t=e.currentTarget,r=document.createElement('span');r.className='rip';
 const b=t.getBoundingClientRect(),s=Math.max(b.width,b.height);
 r.style.width=r.style.height=s+'px';r.style.left=(e.clientX-b.left-s/2)+'px';r.style.top=(e.clientY-b.top-s/2)+'px';
 t.appendChild(r);setTimeout(()=>r.remove(),550)}
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._);t._=setTimeout(()=>t.classList.remove('show'),1700)}

const SW=[['#ff3b30','255,59,48'],['#ff9500','255,149,0'],['#ffd60a','255,214,10'],['#34c759','52,199,89'],
['#00c7be','0,199,190'],['#0a84ff','10,132,255'],['#5e5ce6','94,92,230'],['#bf5af2','191,90,242'],
['#ff2d92','255,45,146'],['#ffffff','255,255,255'],['#ff7e29','255,126,41'],['#7cc7ff','124,199,255']];
SW.forEach(([hex,rgb])=>{const d=document.createElement('div');d.className='swatch';d.style.background=hex;
 d.onclick=()=>{const[r,g,b]=rgb.split(',');cmd({action:'color',r:+r,g:+g,b:+b});toast('colore impostato')};$('sw').appendChild(d)});

function hsv2rgb(h,s,v){let f=(n,k=(n+h/60)%6)=>v-v*s*Math.max(Math.min(k,4-k,1),0);
 return[Math.round(f(5)*255),Math.round(f(3)*255),Math.round(f(1)*255)]}
const wheel=$('wheel');let wd=false;
function pick(e){const b=wheel.getBoundingClientRect(),cx=b.left+b.width/2,cy=b.top+b.height/2;
 const px=(e.touches?e.touches[0].clientX:e.clientX),py=(e.touches?e.touches[0].clientY:e.clientY);
 let ang=Math.atan2(py-cy,px-cx)*180/Math.PI;if(ang<0)ang+=360;
 const dist=Math.min(1,Math.hypot(px-cx,py-cy)/(b.width/2)),[r,g,bl]=hsv2rgb(ang,Math.max(.25,dist),1);
 const rad=b.width/2*Math.min(dist,.88),a=ang*Math.PI/180;
 $('wh').style.left=(50+Math.cos(a)*rad/b.width*100)+'%';$('wh').style.top=(50+Math.sin(a)*rad/b.width*100)+'%';
 cmd({action:'color',r,g,b:bl})}
wheel.addEventListener('pointerdown',e=>{wd=true;pick(e)});
wheel.addEventListener('pointermove',e=>{if(wd)pick(e)});
addEventListener('pointerup',()=>wd=false);

function favs(){try{return JSON.parse(localStorage.getItem('luce_favs')||'[]')}catch{return[]}}
function renderFavs(){const c=$('favs'),f=favs();c.innerHTML='';
 if(!f.length){c.innerHTML='<span class="empty">nessun preferito — salva il colore attuale ★</span>';return}
 f.forEach((hex,i)=>{const d=document.createElement('div');d.className='fav';d.style.background=hex;
  d.title='clic: applica · doppio: rimuovi';
  d.onclick=()=>{const r=parseInt(hex.substr(1,2),16),g=parseInt(hex.substr(3,2),16),b=parseInt(hex.substr(5,2),16);cmd({action:'color',r,g,b});toast('preferito applicato')};
  d.ondblclick=()=>{const a=favs();a.splice(i,1);localStorage.setItem('luce_favs',JSON.stringify(a));renderFavs();toast('rimosso')};
  c.appendChild(d)})}
function saveFav(){const a=favs();if(!a.includes(curHex)){a.push(curHex);localStorage.setItem('luce_favs',JSON.stringify(a));renderFavs();toast('colore salvato ★')}else toast('già nei preferiti')}

function magColor(m){if(m<2)return'#0a84ff';if(m<3)return'#34c759';if(m<4)return'#ffd60a';if(m<5)return'#ff9500';return'#ff3b30'}

async function cmd(o){
 lastCmd=Date.now();
 try{const r=await fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
  if(r.status===401){location.reload();return}
  const s=await r.json();if(s&&s.power!==undefined)apply(s);}catch(e){}}

async function phen(n,mag){
 $('bname').textContent='in esecuzione: '+n;$('busy').classList.add('show');
 try{await fetch('/api/phenom',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,mag:mag})})}catch(e){}
 $('busy').classList.remove('show');setTimeout(poll,800);}
function playReal(){phen('battito',realMag);toast('battito M'+realMag.toFixed(1))}

let drag=false,lastCmd=0;
['bsl','tsl'].forEach(id=>{const el=$(id);
 el.addEventListener('pointerdown',()=>drag=true);el.addEventListener('pointerup',()=>setTimeout(()=>drag=false,400))});

function apply(s){
 if(!s||s.error){$('stext').textContent='errore';$('dot').className='dot off';return}
 const on=s.power;
 $('dot').className='dot'+(on?'':' off');$('stext').textContent=on?'accesa':'spenta';
 $('modetxt').textContent=on?(s.mode==='colour'?'colore':'bianco'):'spenta';
 $('orb').className='orb'+(on?'':' off');
 if(s.hex){curHex=s.hex;document.documentElement.style.setProperty('--orb',s.hex)}
 $('tint').style.opacity=on?.4:.08;
 $('bn').textContent=on?s.bright:0;
 document.documentElement.style.setProperty('--b',(on?(.52+s.bright/100*.48):.5).toFixed(2));
 document.documentElement.style.setProperty('--glow',(on?(22+s.bright*.75):6)+'px');
 if(!drag&&Date.now()-lastCmd>2000){if(s.bright!=null){$('bsl').value=s.bright;$('bv').textContent=s.bright}
  if(s.temp!=null){$('tsl').value=s.temp;$('tv').textContent=s.temp+(s.temp<34?'° caldo':s.temp>66?'° freddo':'° neutro')}}}

async function pollQuake(){
 try{const r=await fetch('/api/quake');const q=await r.json();
  if(q&&q.strongest){const m=q.strongest.mag;realMag=m;const c=magColor(m);
   $('qmag').style.color=c;$('qm').textContent='M'+m.toFixed(1);$('qp').textContent=q.strongest.place;
   $('qs').textContent='prof '+Math.round(q.strongest.depth)+' km · '+q.strongest.time.slice(0,16).replace('T',' ')+' UTC · '+q.count+' eventi';
   $('qreal').textContent='▶ Ri-vivi il reale: M'+m.toFixed(1)+' '+q.strongest.place;}
  else if(q&&q.count===0){$('qp').textContent='nessun evento (24h)';$('qm').textContent='—';}}catch(e){}}

async function poll(){
 try{const r=await fetch('/api/status');if(r.status===401){location.reload();return}apply(await r.json())}
 catch(e){$('stext').textContent='offline';$('dot').className='dot off'}}

async function loadSched(){try{const r=await fetch('/api/schedules');renderSched(await r.json())}catch(e){}}
function schLabel(s){return s.act==='on'?'Accendi 💡':s.act==='off'?'Spegni 🌙':'Luminosità '+s.value+'%'}
function renderSched(l){const c=$('schedList');c.innerHTML='';
 if(!l||!l.length){c.innerHTML='<div class="empty">nessuna programmazione — aggiungine una sopra</div>';return}
 l.sort((a,b)=>(a.time||'').localeCompare(b.time||''));
 l.forEach(s=>{const d=document.createElement('div');d.className='scheditem';
  d.innerHTML='<span class="t">'+s.time+'</span><span class="a">'+schLabel(s)+'</span>';
  const x=document.createElement('button');x.className='delx';x.textContent='✕';
  x.onclick=()=>delSched(s.id);d.appendChild(x);c.appendChild(d)})}
async function addSched(){const item={time:$('schTime').value,act:$('schAct').value};
 if(!item.time){toast('imposta un orario');return}
 if(item.act==='bright')item.value=Math.max(1,Math.min(100,(+$('schVal').value)||10));
 const r=await fetch('/api/schedules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'add',item})});
 renderSched(await r.json());toast('programmazione aggiunta ✓')}
async function delSched(id){
 const r=await fetch('/api/schedules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'del',id})});
 renderSched(await r.json());toast('rimossa')}
function schToggleVal(){$('schVal').style.display=$('schAct').value==='bright'?'':'none'}

schToggleVal();renderFavs();loadSched();poll();pollQuake();
setInterval(poll,2500);setInterval(pollQuake,180000);
</script></body></html>`;

// ── CRON HANDLER ─────────────────────────────────────────────

async function handleScheduled(env) {
  const cId   = env.TUYA_CLIENT_ID;
  const cSec  = env.TUYA_CLIENT_SECRET;
  const devId = env.TUYA_DEVICE_ID;
  const { hour, minute } = getRomeTime();
  console.log(`[CRON] Roma ${hour}:${String(minute).padStart(2,'0')}`);

  let tok;

  const match = SCHEDULE.find(s => s.hour === hour && Math.abs(s.minute - minute) <= 1);
  if (match) {
    console.log(`[CIRCADIANO] ${match.action}`);
    tok = await getTuyaToken(cId, cSec);
    await applyAction(match.action, tok, cId, cSec, devId);
  }

  const userScheds = await getSchedules(env);
  const nowStr = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  for (const s of userScheds) {
    if (s.enabled !== false && s.time === nowStr) {
      if (!tok) tok = await getTuyaToken(cId, cSec);
      console.log(`[UTENTE] ${s.time} ${s.act}`);
      if (s.act === 'on')  await tuyaCmd(tok,cId,cSec,devId,[cmdOn()]);
      else if (s.act === 'off') await tuyaCmd(tok,cId,cSec,devId,[cmdOff()]);
      else if (s.act === 'bright') await tuyaCmd(tok,cId,cSec,devId,[cmdOn(),cmdMode('white'),cmdBright(s.value*10)]);
    }
  }

  if (!tok) tok = await getTuyaToken(cId, cSec);
  await checkSeismic(tok, cId, cSec, devId);
}

// ── FETCH HANDLER ─────────────────────────────────────────────

async function handleRequest(request, env, ctx) {
  const cId   = env.TUYA_CLIENT_ID;
  const cSec  = env.TUYA_CLIENT_SECRET;
  const devId = env.TUYA_DEVICE_ID;
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/login' && request.method === 'POST') {
    const { password } = await request.json().catch(() => ({}));
    const expected = env.LUCE_PASSWORD || 'changeme';
    if (password === expected) {
      const token = await getExpectedToken(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `luce_auth=${token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`,
        }
      });
    }
    return new Response(JSON.stringify({ ok: false }), { headers: { 'Content-Type': 'application/json' } });
  }

  const expectedToken = await getExpectedToken(env);
  if (!isAuthed(request, expectedToken)) {
    return new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  if (path === '/' || path === '') {
    return new Response(DASHBOARD_HTML, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/api/status') {
    try {
      const tok = await getTuyaToken(cId, cSec);
      return new Response(JSON.stringify(await getDeviceStatus(tok, cId, cSec, devId)), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path === '/api/cmd' && request.method === 'POST') {
    try {
      const data = await request.json();
      const tok  = await getTuyaToken(cId, cSec);
      const { action, value, name, delta } = data;
      let cmds = [];

      if (action === 'on')    cmds = [cmdOn()];
      else if (action === 'off')   cmds = [cmdOff()];
      else if (action === 'toggle') {
        const st = await getDeviceStatus(tok, cId, cSec, devId);
        cmds = st.power ? [cmdOff()] : [cmdOn()];
      }
      else if (action === 'bright') cmds = [cmdOn(), cmdMode('white'), cmdBright(value * 10)];
      else if (action === 'bright_delta') {
        const st = await getDeviceStatus(tok, cId, cSec, devId);
        const nb = Math.max(1, Math.min(100, (st.bright || 50) + parseInt(delta)));
        cmds = [cmdOn(), cmdMode('white'), cmdBright(nb * 10)];
      }
      else if (action === 'temp') cmds = [cmdOn(), cmdMode('white'), cmdTemp(value * 10)];
      else if (action === 'color') {
        const hsv = rgbToHsv(parseInt(data.r), parseInt(data.g), parseInt(data.b));
        cmds = [cmdOn(), cmdMode('colour'), cmdColor(hsv.h, hsv.s, hsv.v)];
      }
      else if (action === 'scene') {
        const sceneCmds = SCENE_CMDS[name];
        if (sceneCmds) await tuyaCmd(tok, cId, cSec, devId, sceneCmds);
        const status = await getDeviceStatus(tok, cId, cSec, devId);
        return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
      }

      if (cmds.length) await tuyaCmd(tok, cId, cSec, devId, cmds);
      await delay(200);
      const status = await getDeviceStatus(tok, cId, cSec, devId);
      return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path === '/api/phenom' && request.method === 'POST') {
    try {
      const { name, mag } = await request.json();
      const tok = await getTuyaToken(cId, cSec);
      ctx.waitUntil(runPhenom(name, mag, tok, cId, cSec, devId));
      return new Response(JSON.stringify({ started: name }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path === '/api/quake') {
    const q = await fetchQuakes(24);
    return new Response(JSON.stringify(q || { count: 0 }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120' }
    });
  }

  if (path === '/api/schedules') {
    if (request.method === 'GET') {
      const lst = await getSchedules(env);
      return new Response(JSON.stringify(lst), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'POST') {
      try {
        const data = await request.json();
        let lst = await getSchedules(env);
        const { op } = data;
        if (op === 'add') {
          const item = data.item || {};
          item.id = (Math.max(0, ...lst.map(x => x.id || 0)) + 1);
          item.enabled = true;
          lst.push(item);
        } else if (op === 'del') {
          lst = lst.filter(x => x.id !== data.id);
        } else if (op === 'toggle') {
          lst = lst.map(x => x.id === data.id ? { ...x, enabled: !x.enabled } : x);
        }
        await putSchedules(env, lst);
        return new Response(JSON.stringify(lst), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  return new Response('Not found', { status: 404 });
}

// ── EXPORT ────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
