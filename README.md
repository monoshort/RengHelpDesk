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
