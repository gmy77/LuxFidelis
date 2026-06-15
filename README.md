# LuxFidelis v3 — MICA Edition

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Tuya-Cloud_API-FF6B00?logo=tuya&logoColor=white" alt="Tuya Cloud API">
  <img src="https://img.shields.io/badge/runtime-edge-000000?logo=vercel&logoColor=white" alt="Edge runtime">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero dependencies">
</p>

<p align="center">
  <strong>Dashboard completa per lampadine smart Tuya — zero dipendenze, zero PC acceso, zero abbonamenti.</strong><br>
  Gira sull'edge di Cloudflare, 24/7, gratis.
</p>

---

## Il problema (che probabilmente conosci già)

Hai comprato una lampadina smart. Sulla scatola: Wi-Fi, RGB, dimmerabile, temperatura colore regolabile.
Poi hai scoperto la realtà:

| Problema | Dettaglio |
|---|---|
| **App cinese** | Tutto dipende da server in Cina. Se l'azienda chiude o cambia le regole, la lampadina diventa stupida |
| **App di terze parti** | Non funzionano bene, costano ogni mese, o richiedono un PC sempre acceso come bridge |
| **Automazione locale** | Richiede hub Zigbee, hardware aggiuntivo, configurazione complessa |
| **Nessuna API locale** | La lampadina parla solo col cloud Tuya — senza flashare il firmware non c'è alternativa |
| **Aggiornamenti forzati** | L'app smette di supportare il tuo dispositivo nel giro di anni |

**Il risultato**: hai speso €20–50 su una lampadina e sei ostaggio di un ecosistema che non ti considera.

---

## La soluzione: LuxFidelis

LuxFidelis v3 si connette **direttamente alla stessa API cloud Tuya** che usa la loro app ufficiale,
e la espone come dashboard moderna servita dall'edge di Cloudflare — senza alcun server, PC o bridge fisico.

```
Browser → luce.tuo-dominio.com
               ↓
   Cloudflare Worker (edge globale)
               ↓
   Tuya Open API  (openapi.tuyaeu.com)
               ↓
         Lampadina
```

**Niente tunnel. Niente server a casa. Niente PC sempre acceso.**
Il Worker costa $0 fino a 100.000 richieste al giorno (piano gratuito Cloudflare).

---

## Funzionalità

### Dashboard interattiva

| Feature | Dettaglio |
|---|---|
| **Sfera luminosa** | Visualizzazione in tempo reale del colore e dell'intensità della lampadina |
| **On / Off** | Pulsanti dedicati + tap sulla sfera |
| **Luminosità** | Slider 1–100%, step precisi ±1 e ±10 |
| **Temperatura colore** | Slider da caldo (arancio) a freddo (bianco-blu), con etichetta contestuale |
| **Color wheel** | Ruota colori interattiva con handle draggable, precisione hue + saturation |
| **Swatch rapide** | 12 colori predefiniti applicabili con un tap |
| **Preferiti** | Salva colori personalizzati in localStorage; rimuovi con doppio tap |
| **Scene** | 5 preset: Sveglia · Giorno · Sera · Relax · Notte |
| **Programmazioni** | Imposta orari automatici (accendi / spegni / luminosità) salvati su KV |
| **Fenomeni** | 6 effetti cinematici: Terremoto · Tramonto · Temporale · Aurora · Onda · Battito |
| **Sismografo** | Widget live dati INGV: mostra gli ultimi terremoti in area FVG/Italia |
| **Battito sismico** | Simula il battito cardiaco della terra in base alla magnitudo reale |

### Automazione circadiana

Il Worker gira su cron ogni 2 minuti e controlla un calendario built-in:

| Ora (Roma) | Azione |
|---|---|
| 09:00 | Accensione graduale (fade in) |
| 09:20 | Caldo basso (lettura mattina) |
| 19:01 | Caldo medio (sera) |
| 23:01 | Caldo fioco (pre-notte) |
| 01:00 | Spegni se ancora accesa |

Le **programmazioni utente** aggiunte dalla dashboard sovrascrivono o si aggiungono a questo calendario.

### Alert sismici automatici

Ogni 2 minuti il cron controlla i terremoti recenti (ultimi 30 min, area centro-nord Italia via INGV).
Se rileva un evento significativo, la lampadina risponde visivamente:

| Magnitudo | Effetto |
|---|---|
| M 2.0 – 2.9 | 3 lampeggi lenti arancioni |
| M 3.0 – 3.9 | 5 lampeggi veloci rossi |
| M 4.0 – 4.9 | Rosso fisso 30 secondi |
| M ≥ 5.0 | Emergenza: strobo bianco 10× poi luce fissa |

---

## Architettura tecnica

### Stack

- **Runtime**: Cloudflare Workers (V8 isolate, edge globale)
- **Storage**: Cloudflare KV (programmazioni utente persistenti)
- **API**: Tuya Open API v1.0, data center EU (`openapi.tuyaeu.com`)
- **Auth dashboard**: cookie `luce_auth=SHA256("luce-token:"+password)`, Max-Age 1 anno
- **Frontend**: vanilla JS, zero framework, zero build step

### Signing Tuya API (v2 comprehensive)

Il token endpoint usa la firma completa richiesta da Tuya:

```
HMAC-SHA256(
  clientSecret,
  clientId + timestamp + "GET\n" + SHA256("") + "\n\n" + path
)
```

Le richieste autenticate aggiungono `access_token` e firmano anche il body:

```
HMAC-SHA256(
  clientSecret,
  clientId + accessToken + timestamp + METHOD + "\n" + SHA256(body) + "\n\n" + path
)
```

### DPS v2 codes

La lampadina usa i codici DPS v2 (standard post-2022):

| Azione | Codice DPS | Range |
|---|---|---|
| On/Off | `switch_led` | `true` / `false` |
| Luminosità | `bright_value_v2` | 10 – 1000 |
| Temperatura colore | `temp_value_v2` | 0 (caldo) – 1000 (freddo) |
| Colore | `colour_data_v2` | JSON string `{"h":0-360,"s":0-1000,"v":0-1000}` |
| Modalità | `work_mode` | `"white"` / `"colour"` |

> **Nota**: `colour_data_v2` è una **stringa JSON** (non un oggetto), sia in scrittura (`JSON.stringify`) che in lettura (`JSON.parse`). Questo è uno dei motivi più comuni per cui controlli colore non funzionano con implementazioni naive.

### API endpoints del Worker

| Endpoint | Metodo | Descrizione |
|---|---|---|
| `GET /` | GET | Dashboard HTML |
| `POST /login` | POST | Autenticazione, imposta cookie |
| `GET /api/status` | GET | Stato attuale della lampadina |
| `POST /api/cmd` | POST | Invia comando (on/off/bright/temp/color/scene/toggle) |
| `POST /api/phenom` | POST | Avvia fenomeno (`ctx.waitUntil`, risponde subito) |
| `GET /api/quake` | GET | Ultimi terremoti (24h) dall'INGV |
| `GET /api/schedules` | GET | Lista programmazioni utente |
| `POST /api/schedules` | POST | Aggiungi / rimuovi / toggle programmazione |

---

## Setup completo

### 1. Prerequisiti

- Account [Cloudflare](https://dash.cloudflare.com) (gratuito)
- Dominio su Cloudflare (anche uno acquistato da Cloudflare)
- Account [Tuya IoT Platform](https://iot.tuya.com) (gratuito)
- App **Smart Life** o **Tuya Smart** sullo smartphone con la lampadina già configurata
- Node.js ≥ 18 (per Wrangler CLI)

---

### 2. Credenziali Tuya

1. Vai su [iot.tuya.com](https://iot.tuya.com) → **Cloud** → **Create Cloud Project**
2. Scegli:
   - Industry: **Smart Home**
   - Data Center: **Western Europe** (se sei in Europa)
   - Development Method: **Smart Home**
3. Nel progetto creato, vai su **Overview**: annota **Access ID** (= `TUYA_CLIENT_ID`) e **Access Secret** (= `TUYA_CLIENT_SECRET`)
4. Vai su **Devices** → **Link Tuya App Account** → scansiona il QR con l'app
5. In **Device List** trova la tua lampadina: annota il **Device ID** (= `TUYA_DEVICE_ID`)

> **Data center**: se i tuoi dispositivi non rispondono, prova `openapi.tuyaus.com` (US) o `openapi.tuyacn.com` (CN). Modifica `TUYA_BASE_URL` in `worker.js`.

---

### 3. Deploy su Cloudflare

```bash
# Installa Wrangler globalmente
npm install -g wrangler

# Login con il tuo account Cloudflare
wrangler login

# Clona il repo
git clone https://github.com/gmy77/LuxFidelis
cd LuxFidelis

# Crea il KV namespace (copia l'id stampato nell'output)
npx wrangler kv namespace create LUCE_KV
```

Modifica `wrangler.toml`:

```toml
name = "luxfidelis"
main = "worker.js"
compatibility_date = "2026-06-01"

account_id = "IL_TUO_CLOUDFLARE_ACCOUNT_ID"  # Sidebar del dashboard Cloudflare

[triggers]
crons = ["*/2 * * * *"]

[[kv_namespaces]]
binding = "LUCE_KV"
id = "L'ID_KV_CHE_HAI_APPENA_CREATO"

[[routes]]
pattern = "luce.tuo-dominio.com/*"
zone_name = "tuo-dominio.com"
```

Fai il deploy:

```bash
npx wrangler deploy
```

---

### 4. Imposta i segreti

```bash
npx wrangler secret put TUYA_CLIENT_ID
# → inserisci il tuo Access ID

npx wrangler secret put TUYA_CLIENT_SECRET
# → inserisci il tuo Access Secret

npx wrangler secret put TUYA_DEVICE_ID
# → inserisci il Device ID della lampadina

npx wrangler secret put LUCE_PASSWORD
# → scegli la password per la dashboard
```

> I segreti sono crittografati a riposo da Cloudflare e **non compaiono mai** nel codice o nei log.

---

### 5. Configurazione DNS

Nel dashboard Cloudflare, sezione DNS del tuo dominio, aggiungi un record:

```
Type: AAAA
Name: luce
Content: 100::
Proxy: ✅ (arancione — proxied)
```

Il record punta a un indirizzo placeholder: il traffico viene catturato dal Worker prima di raggiungerlo.

---

### 6. Fatto

Visita `https://luce.tuo-dominio.com`, inserisci la password e inizia a controllare la tua lampadina.

---

## Personalizzazione

### Cambio orari circadiani

Modifica l'array `SCHEDULE` in `worker.js`:

```js
const SCHEDULE = [
  { hour: 7,  minute: 30, action: 'sveglia'    }, // accendi forte al mattino
  { hour: 20, minute: 0,  action: 'sera'        }, // sera
  { hour: 23, minute: 30, action: 'warm_dim'    }, // pre-notte
  { hour: 1,  minute: 0,  action: 'off_if_on'  }, // spegni di notte
];
```

Le azioni disponibili sono le chiavi dell'oggetto `SCENE_CMDS`.

### Aggiunta nuove scene

```js
const SCENE_CMDS = {
  // ... esistenti ...
  studio: [cmdOn(), cmdMode('white'), cmdTemp(700), cmdBright(900)], // luce fredda per studiare
  cinema: [cmdOn(), cmdMode('white'), cmdTemp(0),   cmdBright(100)], // quasi buio
};
```

### Cambio area sismografo

Modifica le coordinate nel parametro `url` dentro `fetchQuakes()`:

```js
// Attuale: Friuli-Venezia Giulia e Nord-Est Italia
`&minlat=44.0&maxlat=47.5&minlon=12.0&maxlon=14.5`

// Esempio: tutta Italia
`&minlat=35.0&maxlat=48.0&minlon=6.0&maxlon=19.0`
```

### Data center Tuya

```js
const TUYA_BASE_URL = 'https://openapi.tuyaeu.com'; // Europa
// const TUYA_BASE_URL = 'https://openapi.tuyaus.com'; // USA
// const TUYA_BASE_URL = 'https://openapi.tuyacn.com'; // Cina
```

---

## Troubleshooting

### La lampadina non risponde ai comandi

1. Verifica che `TUYA_DEVICE_ID` sia corretto (dalla lista dispositivi su iot.tuya.com)
2. Controlla i log del Worker: `npx wrangler tail` — cerca errori `Token error` o `sign invalid`
3. Assicurati che il data center di `TUYA_BASE_URL` corrisponda al tuo progetto Tuya

### Errore `1004 sign invalid`

Il progetto Tuya è configurato con firma **comprehensive** (default post-2020). Questo worker usa già il formato corretto. Se l'errore persiste:
- Verifica che `TUYA_CLIENT_SECRET` sia incollato senza spazi iniziali/finali
- Controlla che l'orario del Worker non sia sfasato (i Worker Cloudflare usano NTP, non è un problema comune)

### Gli slider tornano alla posizione precedente

Il worker attende 200ms dopo ogni comando prima di leggere lo stato, e il client blocca l'aggiornamento degli slider per 2 secondi dopo ogni azione manuale. Se il problema persiste, significa che la lampadina impiega più di 200ms ad applicare il comando: aumenta il `delay(200)` nel handler `/api/cmd`.

### Il cron non parte

Ignora l'errore `API error: 10000` che appare durante `wrangler deploy` — è un problema di permessi token per la modifica degli schedule sul piano gratuito, non influenza il funzionamento del cron già registrato né il deploy del codice.

---

## Struttura del progetto

```
LuxFidelis/
├── worker.js        ← unico file, tutto il backend + frontend
├── wrangler.toml    ← configurazione deployment (personalizza questo)
├── .gitignore
└── README.md
```

Il Worker è un singolo file JavaScript senza dipendenze. La dashboard è HTML/CSS/JS inline.

---

## Sicurezza

- La password non è mai inviata in chiaro: il client invia il plaintext via HTTPS, il server verifica e imposta un cookie `HttpOnly; SameSite=Lax` con il digest SHA-256
- Le credenziali Tuya non sono mai esposte al browser
- Il KV namespace non è accessibile pubblicamente
- Non c'è nessun endpoint di debug abilitato in produzione

---

## Licenza

MIT — usa, modifica, ridistribuisci liberamente. Non garantito per lampadine che prendono fuoco da sole.

---

<p align="center">
  Costruito con Cloudflare Workers · Tuya Open API · JavaScript vanilla · zero dipendenze<br>
  Sviluppato con <a href="https://claude.ai/code">Claude Code</a> (Anthropic)
</p>
