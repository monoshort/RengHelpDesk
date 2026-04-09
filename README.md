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

- Commit **nooit** `.env` of `.shopify_token.json` (staan in `.gitignore`).
- Zie `.env.example` voor alle variabelen.

## Op GitHub zetten

GitHub CLI is aan te raden (`winget install GitHub.cli`).

1. Eenmalig inloggen: `gh auth login` (kies GitHub.com, HTTPS, browser).
2. In deze map: `gh repo create RengHelpDesk --public --source=. --remote=origin --push`

Als de repository al op github.com bestaat: `git remote add origin https://github.com/JOUW-USER/RengHelpDesk.git` en daarna `git push -u origin main`.

Windows: je kunt ook `powershell -ExecutionPolicy Bypass -File scripts/publish-github.ps1` uitvoeren (die script vraagt om login indien nodig).
