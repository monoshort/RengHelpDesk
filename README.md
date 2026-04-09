# RengHelpDesk (Toddie helpdesk)

Express-dashboard voor Shopify-orders, DPD-tracking, mail en optioneel OpenAI. Beveiligd met een dashboardwachtwoord (zie `.env.example`).

## Vereisten

- Node.js 18+

## Lokaal starten

```bash
npm install
cp .env.example .env
# Vul .env in (Shopify, SMTP, enz.)
npm start
```

Open [http://localhost:3000](http://localhost:3000) en log in met het ingestelde dashboardwachtwoord.

## Ontwikkeling

```bash
npm run dev
```

## Online hosten (gratis tier)

GitHub draait deze app niet zelf; je hebt een **Node-host** nodig. Snelste optie: **Render**.

1. Account op [render.com](https://render.com) (inloggen met GitHub).
2. **New → Blueprint** en kies repo **`monoshort/RengHelpDesk`**, of **Web Service** → Connect repository → dezelfde repo. Render gebruikt `render.yaml` (Node, `npm ci`, `npm start`).
3. **Environment**: kopieer inhoud uit je lokale `.env` als key/value (geen bestand uploaden). Minimaal o.a.:
   - `NODE_ENV=production`, `TRUST_PROXY=true`, `DASHBOARD_COOKIE_SECURE=true`
   - `DASHBOARD_PASSWORD`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
   - `SHOPIFY_REDIRECT_URI=https://<jouw-service>.onrender.com/api/auth/callback` (en **exact hetzelfde** in de Shopify-app bij redirect-URL’s).
4. **Deploy** afwachten; open de **`.onrender.com`‑URL** die Render toont.

**Alternatief:** [Railway](https://railway.app) of [Fly.io](https://fly.io) — zet **Root/Start** op `npm start` of gebruik de meegeleverde **`Dockerfile`**.

### Vercel (serverless Express)

Geschikt om een klant een **https-URL** te geven. Het project bevat `vercel.json` (alle routes → `api/index.js`) en **`api/index.js`** die de Express-app exporteert.

1. [vercel.com](https://vercel.com) → **Add New… → Project** → importeer deze GitHub-repo.
2. **Environment Variables** (zelfde als bij Render, uit je `.env`): o.a. `DASHBOARD_PASSWORD`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SCOPES` (indien afwijkend), SMTP/OpenAI/DPD naar behoefte.
3. Zet **`SHOPIFY_REDIRECT_URI`** op `https://<jouw-project>.vercel.app/api/auth/callback` en **exact dezelfde URL** in de Shopify-app bij *Allowed redirection URL(s)*.
4. **`TRUST_PROXY=true`** en **`DASHBOARD_COOKIE_SECURE=true`** aanbevolen op productie.
5. **`VERCEL=1`** hoef je niet zelf te zetten; Vercel injecteert dat. Daardoor start de server niet dubbel met `listen`. Statische bestanden staan in **`static/`** (niet `public/`, anders serveert Vercel die map rechtstreeks zonder Express en valt het dashboardwachtwoord weg).
6. **Timeout:** `vercel.json` vraagt **60s** `maxDuration` voor het overzicht. Op het **gratis Hobby-plan** is de function-limiet **kort** (vaak 10s) — een zware `/api/overview` kan dan **504** geven. **Vercel Pro** (of minder orders / lagere `SHOPIFY_ORDERS_MAX`) lost dat op.
7. **Shopify-token:** zet bij voorkeur **`SHOPIFY_ACCESS_TOKEN`** (Custom App / Admin API-token) in Vercel. Sessies op schijf wonen op serverless in `/tmp` en zijn **niet gedeeld tussen instances**; zonder env-token kan de volgende pagina weer “niet gekoppeld” lijken.

Lokaal test je Vercel-gedrag met `VERCEL=1` (geen `listen`) en eventueel `npx vercel dev`.

**Windows / pad met haakjes:** `npx vercel deploy` kan dan stil falen. Gebruik **`npm run deploy:vercel`** (kopieert naar `%TEMP%` en deployt daar). Eerste keer: eenmalig `npx vercel login` en lokaal `npx vercel link` (of zet `VERCEL_PROJECT_NAME` als de link anders heet). Alternatief: koppel **GitHub** in Vercel zodat de build op hun servers draait.

## Belangrijk

- Commit **nooit** `.env`, `.env.local`, `.env.production` of `.shopify_token.json` (staan in `.gitignore`; alleen `.env.example` is bedoeld voor Git).
- Zie `.env.example` voor alle variabelen.

### Geheimen en GitHub

- **`.env` hoort niet op GitHub.** Iedereen met leesrechten op de repo zou mee kunnen liften op API-keys als je die ooit wél commit. Blijf `git status` checken vóór elke commit.
- **Private repository:** zet je repo op *private* als alleen jij/jouw team de code mag zien. Met GitHub CLI: `gh repo edit RengHelpDesk --visibility private` (of op github.com onder *Settings → General → Danger zone*).
- **Per ongeluk `.env` gepusht?** Verwijder het bestand uit de repo, **draai direct alle secrets in dat bestand om** (Shopify token, SMTP, OpenAI, dashboardwachtwoord, enz.), en overweeg geschiedenis te schonen (`git filter-repo` / GitHub-support) — alleen verwijderen in een nieuwe commit is niet genoeg als de oude commits nog zichtbaar zijn.

## CI op GitHub

Bij elke push naar `main` draait [GitHub Actions](.github/workflows/ci.yml): `npm ci`, syntax-check en een korte rooktest van `npm start`. Dat is **geen hosting** van de site; alleen een automatische controle.

**GitHub Pages (helpdesk in beeld):** Pages kan **geen** Node/Express draaien. De echte app blijft op **Vercel of Render**; **`docs/index.html`** is een statische shell die die **https-URL** in een iframe laadt.

1. Repo → **Settings** → **Pages** → **Build and deployment** → bron: **GitHub Actions** (niet “Deploy from branch”).
2. (Optioneel) **Settings** → **Secrets and variables** → **Actions** → tab **Variables** → **New repository variable** → naam **`LIVE_APP_URL`**, waarde bijv. `https://reng-help-desk.vercel.app` — dan opent de Pages-site direct die host (wordt in `live-default.json` gezet bij elke deploy).
3. Push naar `main` triggert **Deploy GitHub Pages** (`.github/workflows/pages.yml`).
4. Site: `https://<github-gebruiker>.github.io/RengHelpDesk/`. Zonder variable: URL één keer in het formulier plakken, of `?url=https%3A%2F%2F…` gebruiken.

Als je host **embedding blokkeert** (`X-Frame-Options` / CSP), blijft het iframe leeg — open dan de Vercel/Render-URL rechtstreeks.

## Op GitHub zetten

GitHub CLI is aan te raden (`winget install GitHub.cli`).

1. Eenmalig inloggen: `gh auth login` (kies GitHub.com, HTTPS, browser).
2. Nieuwe repo: `gh repo create RengHelpDesk --private --source=. --remote=origin --push` (aanbevolen: **private**). Voor een publieke repo: `--public` i.p.v. `--private`.

Als de repository al op github.com bestaat: `git remote add origin https://github.com/JOUW-USER/RengHelpDesk.git` en daarna `git push -u origin main`.

Windows: je kunt ook `powershell -ExecutionPolicy Bypass -File scripts/publish-github.ps1` uitvoeren (die script vraagt om login indien nodig).

## Online zetten (Render.com + GitHub-repo)

GitHub **Pages** draait geen Node/Express; dit project gebruikt **Render** (gratis tier, koppelt aan je GitHub-repo).

1. Push deze repo naar GitHub (private mag).
2. Ga naar [render.com](https://render.com), log in met GitHub, **New → Blueprint** (of **Web Service**) en kies repo **`monoshort/RengHelpDesk`** (of jouw fork). Render leest `render.yaml`.
3. Onder **Environment** voeg je minimaal toe (kopieer waarden uit je lokale `.env`, niet committen):
   - `NODE_ENV=production`
   - `TRUST_PROXY=true`
   - `DASHBOARD_COOKIE_SECURE=true`
   - `DASHBOARD_PASSWORD=` (sterk wachtwoord; dit is het inlogscherm)
   - Optioneel: `DASHBOARD_SESSION_SECRET=` (lange random string)
   - Alle **Shopify**- en overige variabelen uit `.env.example` die je lokaal gebruikt  
   **Let op:** op Render is het bestand `.shopify_token.json` niet persistent. Gebruik bij voorkeur **`SHOPIFY_ACCESS_TOKEN`** (+ `SHOPIFY_SHOP_DOMAIN`) in de environment, of koppel een **persistent disk** (betaald/ingewikkelder).
4. Zet in de **Shopify-app** bij *Allowed redirection URL(s)* je productie-URL, bv. `https://<jouw-service>.onrender.com/api/auth/callback`, gelijk aan `SHOPIFY_REDIRECT_URI` op Render.
5. Na deploy: open de Render-URL, log in met `DASHBOARD_PASSWORD`. Deel die URL + wachtwoord veilig met kijkers (bijv. **reng@webston.nl**).

### Iemand toegang tot de **GitHub-repo** (code bekijken)

Repo is private: alleen **collaborators** zien de code.

1. Ga naar `https://github.com/monoshort/RengHelpDesk/settings/access` (of jouw org/repo).
2. **Add people** → typ **`reng@webston.nl`** (GitHub koppelt dit aan een account als die bestaat) of de **GitHub-gebruikersnaam** van Reng → rol *Read* is genoeg om mee te lezen.

*(De live website is los van GitHub: daarvoor is de Render-URL + dashboardwachtwoord nodig.)*
