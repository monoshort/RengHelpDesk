import {
  detectCustomerReplyLanguage,
  customerReplyLanguageLabel,
  isOpenAiConfigured,
} from './aiReply.js';
import { getOpenAiApiKey, getOpenAiModel } from './platformConfig.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_INPUT_CHARS = 14_000;

/**
 * @param {string} html
 */
export function plainTextFromMailHtml(html) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * @param {{ text: string; subject?: string | null }} input
 */
export async function translateIncomingMailToDutch(input) {
  const subject = String(input.subject || '').trim();
  const plain = String(input.text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!plain) {
    return {
      detectedLanguage: 'nl',
      detectedLanguageLabel: 'Nederlands',
      translatedText: '',
      alreadyDutch: true,
    };
  }

  const detected = detectCustomerReplyLanguage(plain, subject);
  const detectedLanguageLabel = customerReplyLanguageLabel(detected);

  if (detected === 'nl') {
    return {
      detectedLanguage: 'nl',
      detectedLanguageLabel,
      translatedText: plain,
      alreadyDutch: true,
    };
  }

  if (!isOpenAiConfigured()) {
    throw new Error('OPENAI_API_KEY ontbreekt — vertalen naar Nederlands vereist OpenAI.');
  }

  const model = getOpenAiModel();
  const key = getOpenAiApiKey();
  const sourceName =
    customerReplyLanguageLabel(detected) || detected;

  const userContent = [
    `Bronstaal (waarschijnlijk): ${sourceName}`,
    subject ? `Onderwerp: ${subject}` : '',
    '',
    '--- Bericht ---',
    plain,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Je vertaalt inkomende klantmails naar helder Nederlands voor een Nederlandse webshop-medewerker.
Regels:
- Vertaal alleen de klanttekst; laat ordernummers, e-mailadressen, URLs en trackingcodes ongewijzigd.
- Geen markdown. Plain text met normale regelafbrekingen.
- Antwoord als JSON: {"text": "…"}`,
        },
        { role: 'user', content: userContent },
      ],
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${raw.slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('OpenAI: ongeldige JSON-response');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI: lege vertaling');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('OpenAI: verwacht JSON met text');
  }

  const translatedText =
    typeof parsed.text === 'string' ? parsed.text.trim() : '';
  if (!translatedText) {
    throw new Error('OpenAI: lege vertalingstekst');
  }

  return {
    detectedLanguage: detected,
    detectedLanguageLabel,
    translatedText,
    alreadyDutch: false,
    model,
  };
}
