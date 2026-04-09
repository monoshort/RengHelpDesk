import {
  fetchRecentOrders,
  fetchProductThumbnailData,
  ordersToRichOrderRows,
} from './shopify.js';
import { getDpdTracking, isLikelyDpdCarrier } from './dpd.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/**
 * Zoekt de meest recente order bij e-mail (en optioneel ordernaam #1234).
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {{ customerEmail: string; shopifyOrderName?: string | null }} q
 */
export async function findOrderForReply(cfg, q) {
  const emailNorm = String(q.customerEmail || '')
    .trim()
    .toLowerCase();
  if (!emailNorm) return null;

  const orders = await fetchRecentOrders(cfg, { limit: 100 });
  const nameRaw = String(q.shopifyOrderName || '')
    .trim()
    .replace(/^#/, '');

  /** @param {any} o */
  function orderEmail(o) {
    return String(
      o.email ||
        o.contact_email ||
        o.customer?.email ||
        o.shipping_address?.email ||
        o.billing_address?.email ||
        ''
    )
      .trim()
      .toLowerCase();
  }

  let candidates = orders.filter((o) => orderEmail(o) === emailNorm);
  if (nameRaw) {
    const byName = orders.filter((o) => {
      const n = String(o.name || '').replace(/^#/, '');
      return n === nameRaw || String(o.name) === q.shopifyOrderName;
    });
    if (byName.length) {
      const emails = new Set(byName.map(orderEmail));
      if (emails.has(emailNorm)) {
        candidates = byName.filter((o) => orderEmail(o) === emailNorm);
      } else {
        candidates = byName;
      }
    }
  }

  if (candidates.length === 0) {
    candidates = orders.filter((o) => orderEmail(o) === emailNorm);
  }

  candidates.sort(
    (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
  );
  return candidates[0] || null;
}

/**
 * @param {any} order
 * @param {string} shopDomain
 * @param {{ delisId: string; password: string; useStage: boolean } | null} dpd
 */
export async function enrichOrderRowForAi(order, shopDomain, dpd, cfg) {
  const storeBaseUrl = process.env.SHOPIFY_PUBLIC_STORE_URL?.trim() || null;
  const storefrontBaseUrl = process.env.SHOPIFY_PUBLIC_STORE_URL?.trim() || null;
  let thumbData = { imageMap: {}, handles: {}, productionByProductId: {} };
  if (cfg) {
    try {
      thumbData = await fetchProductThumbnailData(cfg, [order], {
        loadImages: false,
        storefrontBaseUrl,
      });
    } catch {
      thumbData = { imageMap: {}, handles: {}, productionByProductId: {} };
    }
  }
  const rows = ordersToRichOrderRows([order], shopDomain, {
    imageMap: thumbData.imageMap,
    handles: thumbData.handles,
    storeBaseUrl,
    productionByProductId: thumbData.productionByProductId,
  });
  const row = rows[0];
  if (!row) return null;

  const out = { ...row, dpdTrackings: [] };
  if (dpd) {
    for (const t of row.trackings) {
      if (!t.number) continue;
      const tryDpd =
        isLikelyDpdCarrier(t.company) || /^\d{14}$/.test(t.number.replace(/\s/g, ''));
      if (!tryDpd) continue;
      try {
        const d = await getDpdTracking({
          creds: dpd,
          parcelLabelNumber: t.number,
        });
        out.dpdTrackings.push({
          number: t.number,
          company: t.company,
          label: d.label,
          rawStatus: d.rawStatus,
          location: d.location,
          date: d.date,
        });
      } catch (e) {
        out.dpdTrackings.push({
          number: t.number,
          company: t.company,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return out;
}

/**
 * Compacte, feitelijke context voor de LLM (geen volledige PII-boek).
 * @param {any} row
 * @param {string | null} shopName
 */
export function orderContextPromptBlock(row, shopName) {
  const lines = [
    `Winkel: ${shopName || 'onbekend'}`,
    `Order: ${row.shopifyOrderName} (id ${row.shopifyOrderId})`,
    `Klantnaam: ${row.customerDisplayName || '—'}`,
    `Financiële status: ${row.displayFinancialStatus || row.financialStatus || '—'}`,
    `Fulfillment / verzendstatus Shopify: ${row.displayFulfillmentStatus || row.fulfillmentStatus || '—'}`,
    `Regels: ${row.lineItemsSummary}`,
    `Verzendmethode: ${row.shippingMethod || '—'}`,
    `Verzendadres (samenvatting): ${row.shippingSummary}`,
  ];
  if (row.trackings?.length) {
    const tr = row.trackings
      .filter((t) => t.number)
      .map((t) => `${t.company || '?'} ${t.number}${t.url ? ` trace: ${t.url}` : ''}`)
      .join('; ');
    if (tr) lines.push(`Trackings uit Shopify: ${tr}`);
  }
  if (row.dpdTrackings?.length) {
    for (const d of row.dpdTrackings) {
      if (d.error) {
        lines.push(`DPD ${d.number}: fout — ${d.error}`);
      } else {
        lines.push(
          `DPD ${d.number}: ${d.label || d.rawStatus || 'status onbekend'}${d.location ? ` · ${d.location}` : ''}${d.date ? ` · ${d.date}` : ''}`
        );
      }
    }
  } else if (row.fulfillmentStatus === null || row.fulfillmentStatus === 'unfulfilled') {
    lines.push(
      'Geen verzending geregistreerd in Shopify: behandel als nog niet verzonden / in productie voorbereiding, tenzij klant expliciet anders meldt.'
    );
  }
  if (row.canceledAt) {
    lines.push(`Order geannuleerd: ${row.canceledAt}`);
  }

  const previews = row.lineItemsPreview;
  if (Array.isArray(previews) && previews.some((li) => li.productionHint)) {
    lines.push('');
    lines.push('Productie / levertijd (uit productbeschrijving of metavelden in Shopify):');
    for (const li of previews) {
      if (!li.productionHint) continue;
      let s = `- ${li.title}: ${li.productionHint}`;
      if (li.productionWorkingDays != null && li.productionShipByLabel) {
        s += ` → indicatief einde ${li.productionWorkingDays} werkdagen na orderdatum: ${li.productionShipByLabel} (weekend niet geteld; geen feestdagen meegerekend).`;
      }
      lines.push(s);
    }
    lines.push(
      'Als de klant vóór die indicatieve datum mailt over “waar blijft mijn bestelling”, en er is nog geen verzending/tracking: wijzen op deze productielevertijd en vriendelijk verzoeken te wachten tot die termijn voorbij is.'
    );
  }

  return lines.join('\n');
}

const SYSTEM_NL = `Je bent de klantenservice van een webshop. Je schrijft een korte, vriendelijke e-mail in het Nederlands als antwoord op de inkomende vraag van de klant.

Regels:
- Gebruik alleen informatie uit de meegeleverde ordercontext en DPD-gegevens. Vul geen verzonnen verzenddatums of tracking in.
- Als er nog geen tracking is of fulfillment "unfulfilled" is, zeg eerlijk dat de zending nog wordt voorbereid / nog niet verzonden is, zonder concrete dag te beloven tenzij die in de data staat.
- Als de context "productie / levertijd" met werkdagen en een indicatieve einddatum bevat: gebruik dat om uit te leggen dat maatwerk of productie tijd kost, en dat de klant tot die indicatieve datum mag verwachten tenzij er al tracking is. Geen harde belofte buiten wat in de context staat.
- Als er wel een DPD-nummer of status is, noem die helder (klant kan traceren).
- Toon: professioneel, warm, kort (maximaal ~120 woorden in de body).
- Onderteken niet met een echte medewerkernaam tenzij die in de instructie staat; gebruik "Met vriendelijke groet" en de winkelnaam als die gegeven is.
- Antwoord ALLEEN als JSON-object met keys: "subject" (string), "body" (string, platte tekst met regeleindes). Geen markdown, geen code fences.`;

/**
 * @param {{ shopName: string | null; orderContextBlock: string; incomingSubject?: string; incomingBody: string }} input
 */
export async function generateCustomerReplyDraft(input) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY ontbreekt in .env');
  }
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

  const userMsg = [
    '--- Order- en verzendcontext (feiten) ---',
    input.orderContextBlock,
    '',
    '--- Inkomende mail van de klant ---',
    input.incomingSubject ? `Onderwerp: ${input.incomingSubject}` : '(geen onderwerp)',
    '',
    input.incomingBody.trim() || '(leeg bericht)',
  ].join('\n');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_NL },
        { role: 'user', content: userMsg },
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

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('OpenAI: lege completion');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('OpenAI: verwacht JSON met subject en body');
  }

  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (!subject || !body) {
    throw new Error('OpenAI: subject of body ontbreekt in JSON');
  }

  return { subject, body, model };
}

const SYSTEM_OVERVIEW_INSIGHT = `Je bent een ervaren e-commerce servicedesk-analist voor een Nederlandse webshop (o.a. orderbevestiging, verzendmails, Sendcloud, DPD).

Je krijgt een compact JSON-object met tellingen en voorbeeld-orders (geen volledige klantgegevens). Taak:
- Geef één korte alinea "samenvatting" (max. 4 zinnen) voor het team: wat springt er uit in deze batch orders?
- Geef 3–5 concrete "prioriteiten" (korte zinnen): waar moeten medewerkers vandaag naar kijken?
- Geef 1–3 "let op"-punten: valkuilen (bijv. timeline mist mails terwijl fulfillment wél loopt; testorders; rate limits).

Regels:
- Baseer je ALLEEN op de meegegeven cijfers en sample-hints. Verzin geen orders of bedragen die niet in de data staan.
- Als de steekproef klein is of data onvolledig, zeg dat eerlijk.
- Antwoord ALLEEN als JSON-object met keys: "summary" (string), "priorities" (array van strings), "watchOut" (array van strings). Geen markdown, geen code fences.`;

/**
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ summary: string; priorities: string[]; watchOut: string[]; model: string }>}
 */
export async function generateOverviewDeskInsight(payload) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY ontbreekt in .env');
  }
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

  const userMsg = [
    'Analyseer deze helpdesk-batch (JSON). Antwoord in het Nederlands.',
    JSON.stringify(payload),
  ].join('\n\n');

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_OVERVIEW_INSIGHT },
        { role: 'user', content: userMsg },
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

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('OpenAI: lege completion');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('OpenAI: verwacht JSON met summary, priorities, watchOut');
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const priorities = Array.isArray(parsed.priorities)
    ? parsed.priorities.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const watchOut = Array.isArray(parsed.watchOut)
    ? parsed.watchOut.map((x) => String(x).trim()).filter(Boolean)
    : [];

  if (!summary) {
    throw new Error('OpenAI: summary ontbreekt');
  }

  return { summary, priorities, watchOut, model };
}
