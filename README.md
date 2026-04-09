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

## Belangrijk

- Commit **nooit** `.env`, `.env.local`, `.env.production` of `.shopify_token.json` (staan in `.gitignore`; alleen `.env.example` is bedoeld voor Git).
- Zie `.env.example` voor alle variabelen.

### Geheimen en GitHub

- **`.env` hoort niet op GitHub.** Iedereen met leesrechten op de repo zou mee kunnen liften op API-keys als je die ooit wél commit. Blijf `git status` checken vóór elke commit.
- **Private repository:** zet je repo op *private* als alleen jij/jouw team de code mag zien. Met GitHub CLI: `gh repo edit RengHelpDesk --visibility private` (of op github.com onder *Settings → General → Danger zone*).
- **Per ongeluk `.env` gepusht?** Verwijder het bestand uit de repo, **draai direct alle secrets in dat bestand om** (Shopify token, SMTP, OpenAI, dashboardwachtwoord, enz.), en overweeg geschiedenis te schonen (`git filter-repo` / GitHub-support) — alleen verwijderen in een nieuwe commit is niet genoeg als de oude commits nog zichtbaar zijn.

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
