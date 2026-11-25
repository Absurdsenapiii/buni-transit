# Deploying BUNI Transit-INT v1.1

The site is **static files only**: no server, database, keys or paid services. Hosting it costs nothing beyond whatever host you already pay for.

## Option A · alignmentlab.com/busapp (the original target)

1. Unzip `buni-transit-v1.1.0-web.zip`.
2. Upload **everything inside it** (`index.html`, `assets/`, `data/`, `favicon.svg`, `og.png`, `site.webmanifest`, `robots.txt`) into the `/busapp/` folder of the web root.
3. Open `https://alignmentlab.com/busapp/` and run the checklist below.

All paths are relative, so any folder name works. The social-card tags already point to `https://alignmentlab.com/busapp/`. For a different address, rebuild:

```sh
SITE_URL=https://example.com/somewhere/ npm run build      # PowerShell: $env:SITE_URL='https://example.com/somewhere/'; npm run build
```

## Live now · GitHub Pages

- **Site:** https://absurdsenapiii.github.io/buni-transit/
- **Repo:** https://github.com/Absurdsenapiii/buni-transit (public; it holds only the built site, not the source)
- **First deployed:** 26 Nov 2026, v1.1.0.

To redeploy after changes (this PC has no git, so publishing goes through the signed-in `gh` CLI):

```powershell
$env:SITE_URL='https://absurdsenapiii.github.io/buni-transit/'; npm run build; Remove-Item Env:SITE_URL
# copy dist\* (plus .nojekyll and the repo README) into out\gh-pages, then:
node scripts/publish-pages.mjs out/gh-pages Absurdsenapiii/buni-transit main "BUNI Transit-INT vX.Y.Z" Absurdsenapiii 246578115+Absurdsenapiii@users.noreply.github.com
```

The script uploads every file as one commit and authors it with the GitHub no-reply address, so no personal email lands in the public repo. GitHub Pages rebuilds in about 30 seconds.

## Option B · any static host

GitHub Pages, Netlify, Cloudflare Pages, Vercel or S3 all work: point the host at `dist/` (build command `npm run build`). No rewrites are needed; routes live in the `#` part of the URL.

## Recommended server headers (optional)

```
/assets/*      Cache-Control: public, max-age=31536000, immutable
/index.html    Cache-Control: no-cache
/data/*        Cache-Control: public, max-age=86400
```

The Content-Security-Policy is already in `index.html`. If your host sends its own CSP header, it must allow `connect-src https://api-open.data.gov.sg https://api.data.gov.sg https://tiles.openfreemap.org`, `img-src https://images.data.gov.sg data: blob:` and `worker-src blob:`, or the map and feeds will be blocked.

## After-deploy checklist

- [ ] The boot terminal lists six feeds as `[ OK ]`, then the globe dives into Singapore.
- [ ] The top bar shows `FEEDS 6/6` and a status (NOMINAL, WATCH or ALERT); the ticker scrolls signals.
- [ ] Search `01012`: the dossier opens with link analysis, and arcs appear on the map.
- [ ] `#/stop/01012` and `#/area/Bedok` open straight to those assets (test each in a new tab).
- [ ] The area matrix sorts by clicking headers; the camera wall shows live stills.
- [ ] Rain replay plays; **LIVE** returns to now.
- [ ] Phone check: map first, tabs at the bottom switch panels.
- [ ] Paste the URL into a chat app: the social card shows the console.
- [ ] The browser console shows no errors.

## Keep it fresh

- Bus stops: LTA updates the dataset roughly quarterly. Run `npm run data`, then `npm run build`, and re-upload `data/stops.json` (or the whole build).
- Nothing else needs maintenance: every live figure is fetched by each visitor's browser.

## DataMall key (kept off the site)

The LTA DataMall AccountKey must never go in the code, the repo, the built site or a chat. DataMall also refuses browser calls (its CORS preflight returns 403), so the key can only be used from a server you control.

**Store it locally (you type it; nobody else sees it).** In PowerShell, run:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\BUNI-Transit" | Out-Null; Read-Host 'Paste your LTA DataMall AccountKey (hidden)' -AsSecureString | ConvertFrom-SecureString | Set-Content "$env:LOCALAPPDATA\BUNI-Transit\datamall.key"; 'Saved, encrypted to your Windows account.'
```

The file sits outside OneDrive and outside the project. It is encrypted with Windows DPAPI, so only your Windows account on this PC can read it. Check it works, without ever printing it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-datamall-key.ps1
```

To replace the key, run the store command again. To remove it, delete `%LOCALAPPDATA%\BUNI-Transit\datamall.key`.

## v1.2 · live arrivals via Cloudflare Workers

The code is ready: `worker/` holds the proxy (`worker/src/index.js`; it answers `/arrivals?stop=01012` and `/health`, only for the site's own origins, cached 20 s). In the console, the feature switches on when the site is built with `VITE_ARRIVALS_URL`.

1. **Owner:** store the right DataMall key with the command above (DataMall keys are normally 24 characters ending in `==`), then check it with `scripts\check-datamall-key.ps1`.
2. **Owner:** sign in to Cloudflare once from the worker folder; this opens your browser to approve:
   ```powershell
   cd worker; npx wrangler login
   ```
3. Deploy the Worker (code only, no key): `cd worker; npx wrangler deploy`. Note the `https://buni-transit-arrivals.<your-subdomain>.workers.dev` address.
4. **Owner:** load the key into the Worker's secret store straight from the encrypted file, so it never appears on screen:
   ```powershell
   cd worker; $s = Get-Content "$env:LOCALAPPDATA\BUNI-Transit\datamall.key" | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) | npx wrangler secret put DATAMALL_KEY
   ```
5. Check `https://<worker>/health` shows `"keyConfigured": true`, then build the site with both addresses and republish:
   ```powershell
   $env:SITE_URL='https://absurdsenapiii.github.io/buni-transit/'; $env:VITE_ARRIVALS_URL='https://buni-transit-arrivals.<your-subdomain>.workers.dev'; npm run build
   ```

## Background: why arrivals need the Worker

Live arrivals need an **LTA DataMall AccountKey** (free, but it is an account application, so it is the founder's call). Unlike the open data.gov.sg feeds, DataMall does not allow browser calls and its key must stay secret, so v1.2 also needs a tiny server-side proxy (a single serverless function). That is the only part of the roadmap that adds hosting beyond static files.
