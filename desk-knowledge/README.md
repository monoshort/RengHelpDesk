# Toddie helpdesk — kennisbank voor AI-antwoorden

Deze map is de **bron van waarheid** voor standaardantwoorden en werkwijzen. De helpdesk-app laadt deze bestanden bij elke AI-generatie (`Genereer met AI`) en voegt relevante delen toe aan de prompt — geen aparte model-training nodig.

Technisch: `server/deskKnowledge.js` matcht keywords uit `intents.json` op onderwerp + body, leest workflows/snippets, en stuurt dat als blok mee naar OpenAI. In de mail-UI zie je het gematchte playbook in de hint na genereren.

## Structuur

```
desk-knowledge/
  README.md                 ← dit bestand
  tone-and-rules.md         ← altijd meegenomen (toon, grenzen, handtekening)
  intents.json              ← koppelt klantvragen → workflow + snippets
  workflows/                ← werkwijze (stappen, wanneer wel/niet)
  snippets/                 ← voorbeeldteksten / formuleringen (NL-bron; AI vertaalt naar klanttaal)
```

## Nieuw onderwerp toevoegen

1. Maak `workflows/jouw-onderwerp.md` (stappen voor medewerkers + AI).
2. Maak optioneel `snippets/jouw-onderwerp.nl.md` (korte standaardtekst).
3. Voeg een intent toe in `intents.json`:

```json
{
  "id": "jouw_onderwerp",
  "label": "Korte titel in UI",
  "keywords": ["woord1", "woord2"],
  "workflow": "workflows/jouw-onderwerp.md",
  "snippets": ["snippets/jouw-onderwerp.nl.md"],
  "replyStyle": "vriendelijk"
}
```

4. Draai lokaal: `npm run desk:knowledge:check`
5. Deploy naar Vercel (bestanden zitten in de repo).

## `replyStyle` (optioneel per intent)

Waarden zoals in de app: `default`, `kort`, `formeel`, `vriendelijk`, `uitsluitend_feiten`, `stappen`, `track_focus`.

## Fine-tuning vs. deze aanpak

| Aanpak | Wanneer |
|--------|---------|
| **Deze kennisbank (aanbevolen)** | Snel aanpasbaar, versioneerbaar in git, geen GPU/training |
| OpenAI fine-tuning | Alleen als je duizenden goedgekeurde antwoorden hebt en vaste stijl wilt “bakken” |

Bewaar goede definitieve antwoorden uit de helpdesk later eventueel in `desk-knowledge/examples/` voor few-shot uitbreiding.

## Limieten

- Te lange bestanden worden ingekort (`DESK_KNOWLEDGE_MAX_CHARS` in `.env`, default 8000).
- Max. 2 intents per mail (hoogste keyword-match).
