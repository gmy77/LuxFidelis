# LuxFidelis v3 — MICA EDITION

> **"Control your smart bulb. Forever. From anywhere. Without Chinese apps."**

A self-hosted smart-bulb dashboard running entirely on **Cloudflare Workers** — no PC, no server, no monthly subscription. Built for Tuya-compatible bulbs.

---

## The Problem with Chinese Smart Bulbs

You bought a smart bulb. It looked great on the box: Wi-Fi, RGB, dimmable, color temperature. Then you discovered the catch:

- The **official app** requires an account on Chinese servers. If the company shuts down (or changes business model), your bulb becomes dumb.
- **Third-party apps** either don't work reliably, cost money monthly, or require leaving a PC on 24/7 as a bridge.
- Local-only solutions (e.g. Home Assistant via Zigbee) need a hub, extra hardware, and significant setup.
- The bulb itself only talks **Tuya cloud** — no direct LAN API without proprietary firmware flashing.

**The result**: you spent €20–50 on a bulb and you're dependent on an ecosystem that doesn't care about you.

---

## The Solution: LuxFidelis

LuxFidelis v3 connects **directly to the official Tuya Cloud API** (the same one the app uses), and wraps it in a clean dashboard served from Cloudflare's edge — globally, for free.

### What you get

| Feature | Details |
|---|---|
| **Always on** | Cloudflare Workers run 24/7 globally, no PC needed |
| **Free tier** | 100k requests/day free on Cloudflare Workers |
| **Circadian schedule** | Cron runs every 2 min, adjusts brightness/color based on time of day |
| **Full dashboard** | On/off, brightness, color temperature, color picker, presets, effects |
| **INGV Seismic widget** | Italian earthquake monitor (bonus feature) |
| **Cookie auth** | Simple password-protected dashboard |
| **Programmazioni** | Configurable per-hour scene schedule stored in Cloudflare KV |

---

## Architecture

```
Browser → luce.your-domain.com
              ↓
    Cloudflare Worker (edge)
              ↓
    Tuya Cloud API (openapi.tuyaeu.com)
              ↓
         Your Bulb
```

No tunnels. No home server. No always-on PC.

---

## Setup

### 1. Tuya credentials

1. Go to [iot.tuya.com](https://iot.tuya.com) → **Cloud** → **Create project** (choose "Smart Home" + "Western Europe" datacenter)
2. Note your **Client ID** and **Client Secret**
3. Link your device: go to **Devices** → **Link Tuya App Account** → scan QR with the Tuya/Smart Life app
4. Note your **Device ID** from the device list

### 2. Deploy to Cloudflare

```bash
npm install -g wrangler
wrangler login

# Clone this repo
git clone https://github.com/gmy77/LuxFidelis
cd LuxFidelis

# Create KV namespace (copy the id into wrangler.toml)
npx wrangler kv namespace create LUCE_KV

# Edit wrangler.toml: set your account_id, KV id, and route domain
# Then deploy
npx wrangler deploy
```

### 3. Set secrets

```bash
npx wrangler secret put TUYA_CLIENT_ID
npx wrangler secret put TUYA_CLIENT_SECRET
npx wrangler secret put TUYA_DEVICE_ID
npx wrangler secret put LUCE_PASSWORD     # dashboard login password
```

### 4. Done

Visit `https://your-domain.com` — log in with your password — control your bulb.

---

## Tuya API Notes

- Uses **Tuya Open API v1.0** with **HMAC-SHA256 comprehensive signing** (v2 format)
- DPS codes: `bright_value_v2` (10–1000), `temp_value_v2` (0–1000 cold→warm), `colour_data_v2` (JSON string `{h,s,v}`)
- Token endpoint: `GET /v1.0/token?grant_type=1` — token lasts ~2 hours, cached in memory
- Datacenter: `openapi.tuyaeu.com` (EU); change to `openapi.tuyaus.com` for US devices

---

## License

MIT — do whatever you want, just don't blame me if your bulb catches fire.

---

*Built with Cloudflare Workers · Tuya Cloud API · vanilla JS · zero dependencies*  
*Powered by [Claude Code](https://claude.ai/code) (Anthropic) — Fable 5 model*
