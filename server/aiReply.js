import {
  fetchOrdersMatchingName,
  fetchOrdersMatchingEmail,
  fetchProductThumbnailData,
  normShopHost,
  ordersToRichOrderRows,
} from './shopify.js';
import { shouldDiscardCustomerEmail } from './mailContactExtract.js';
import { resolveOrdersForOverview } from './overviewSync.js';
import { getDpdTracking, shouldQueryDpdTracking } from './dpd.js';
import { getOpenAiApiKey, getOpenAiModel, isOpenAiConfiguredFromPlatform } from './platformConfig.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function isOpenAiConfigured() {
  return isOpenAiConfiguredFromPlatform();
}

/**
 * @param {string} t
 */
function hintKey(t) {
  return String(t || '')
    .replace(/^#/, '')
    .trim()
    .toLowerCase();
}

/**
 * Mogelijke order-/bestelnummers uit vrije mailtekst (onderwerp + body).
 * Pakt o.a. #1234, TOD46541, "bestelnummer: …", "ordernummer …".
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function orderNameHintsFromMail(text) {
  const s = String(text || '');
  /** @type {string[]} */
  const out = [];
  const add = (x) => {
    const t = String(x || '').trim();
    if (!t) return;
    if (out.some((e) => hintKey(e) === hintKey(t))) return;
    out.push(t);
  };

  /** @type {{ re: RegExp; group?: number }[]} */
  const labeled = [
    {
      re: /\b(?:bestelnummer|ordernummer|bestelnr|order[-\s]?nr|order\s*#)\s*[:#]?\s*([#A-Za-z0-9][A-Za-z0-9\-]{1,})\b/gi,
      group: 1,
    },
    {
      re: /\b(?:order|bestelling)\s*(?:no|nr|number)\.?[\s#:,-]*\s*([#A-Za-z][A-Za-z0-9\-]*)\b/gi,
      group: 1,
    },
    {
      re: /\b(?:referentie|reference|ref\.?)\s*[:#]?\s*([#A-Za-z0-9][A-Za-z0-9\-]{2,})\b/gi,
      group: 1,
    },
  ];
  for (const { re, group = 1 } of labeled) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = r.exec(s)) !== null) {
      const frag = String(m[group] || '').replace(/^#/, '').trim();
      if (!frag || frag.length < 2) continue;
      add(frag);
      add(`#${frag}`);
    }
  }

  const hashAll = s.match(/#\d{3,}/g);
  if (hashAll) {
    for (const h of hashAll.slice(0, 8)) add(h);
  }

  const orderNoOnce = s.match(
    /\b(?:order|bestelling)\s*(?:no|nr|number)\.?[\s#:,-]*\s*([#A-Za-z][A-Za-z0-9\-]*)\b/i
  );
  if (orderNoOnce) {
    const frag = orderNoOnce[1].replace(/^#/, '');
    add(frag);
    add(`#${frag}`);
  }

  const alphaNumAll = s.match(/\b[A-Z]\d{5,}\b/g);
  if (alphaNumAll) {
    for (const x of [...new Set(alphaNumAll)].slice(0, 8)) {
      add(x);
      add(`#${x}`);
    }
  }

  const alphaNumMultiAll = s.match(/\b[A-Za-z]{2,}\d{4,}\b/g);
  if (alphaNumMultiAll) {
    for (const x of [...new Set(alphaNumMultiAll)].slice(0, 8)) {
      add(x);
      add(`#${x}`);
    }
  }

  return out.slice(0, 24);
}

/**
 * Body eerst (vaak het echte bestelnr), daarna onderwerp/extra regels — dedup.
 * @param {string | null | undefined} mailBody
 * @param {string | null | undefined} subjectAndExtras
 */
export function mergeMailOrderHints(mailBody, subjectAndExtras) {
  const a = orderNameHintsFromMail(mailBody);
  const b = orderNameHintsFromMail(subjectAndExtras);
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const h of [...a, ...b]) {
    const k = hintKey(h);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out.slice(0, 16);
}

/**
 * Mogelijke ordernamen uit onderwerp/snippet (o.a. #1234, T0046587, "order no. …").
 * @param {string | null | undefined} subject
 * @returns {string[]}
 */
export function orderNameHintsFromSubject(subject) {
  return orderNameHintsFromMail(subject).slice(0, 8);
}

/** @param {string | null | undefined} subject */
export function guessOrderNameFromSubject(subject) {
  const hints = orderNameHintsFromSubject(subject);
  return hints[0];
}

/**
 * Resultaten van GET orders.json?name= — optioneel filter op klant-e-mail (niet bij shop-inbox).
 * @param {any[]} apiOrders
 * @param {boolean} restrictByEmail
 * @param {string} emailNorm
 * @returns {any[]}
 */
function pickOrdersFromNameApi(apiOrders, restrictByEmail, emailNorm) {
  if (!apiOrders.length) return [];
  if (restrictByEmail) {
    const byMail = apiOrders.filter((o) => orderEmailNorm(o) === emailNorm);
    if (byMail.length === 1) return byMail;
    if (byMail.length > 1) {
      byMail.sort(
        (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
      );
      return [byMail[0]];
    }
    return [];
  }
  apiOrders.sort(
    (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
  );
  return [apiOrders[0]];
}

/** @param {any} o @param {string} hint */
function orderNameMatchesHint(o, hint) {
  const h = String(hint || '').trim();
  if (!h) return false;
  const norm = (x) => String(x || '').replace(/^#/, '').trim().toLowerCase();
  const on = String(o.name || '').trim();
  return norm(on) === norm(h) || on.toLowerCase() === h.toLowerCase();
}

const NAME_STOP = new Set(['de', 'het', 'een', 'van', 'voor', 'bij', 'mr', 'mrs', 'dr', 'ing']);

/** @param {string} s */
function nameTokens(s) {
  const raw = String(s || '')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  return raw
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !NAME_STOP.has(w));
}

/**
 * @param {string} senderDisplayName
 * @param {any} order
 */
function nameMatchScore(senderDisplayName, order) {
  const tokens = nameTokens(senderDisplayName);
  if (!tokens.length) return 0;
  const ship = [
    order.shipping_address?.first_name,
    order.shipping_address?.last_name,
    order.shipping_address?.name,
  ]
    .filter(Boolean)
    .join(' ');
  const cust = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');
  const hay = new Set(nameTokens(`${cust} ${ship}`));
  let score = 0;
  for (const t of tokens) {
    if (hay.has(t)) score += 4;
  }
  return score;
}

/** @param {any} o */
function orderEmailNorm(o) {
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

/**
 * Zoekt order voor mail/AI: eerst directe Shopify-zoekacties (order naam / e-mail, géén datums-cap → ook oude orders),
 * daarna pas de gecachte “recente” lijst (zelfde venster als dashboard).
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {{ customerEmail: string; senderName?: string | null; subjectHint?: string | null; incomingMailBody?: string | null }} q
 */
export async function findOrderForMailbox(cfg, q) {
  const emailRaw = String(q.customerEmail || '').trim();
  const emailNorm = emailRaw.toLowerCase();
  const hasEmail = emailNorm.includes('@');
  /** Bij info@shop e.d. niet op dat adres filteren op naam-treffers — de order hoort bij de klant. */
  const restrictByCustomerEmail =
    hasEmail && !shouldDiscardCustomerEmail(emailNorm);
  const senderName = String(q.senderName || '').trim();
  const mailBody = String(q.incomingMailBody ?? '').trim();
  const subjectHint = String(q.subjectHint || '');
  const nameHints = mergeMailOrderHints(mailBody, subjectHint);

  /** @type {any[]} */
  let candidates = [];

  // 1) GET orders.json?name=… — werkt op volledige ordernaam, niet gebonden aan created_at_min
  if (nameHints.length) {
    for (const hint of nameHints) {
      try {
        const apiOrders = await fetchOrdersMatchingName(cfg, hint);
        const picked = pickOrdersFromNameApi(apiOrders, restrictByCustomerEmail, emailNorm);
        if (picked.length) {
          candidates = picked;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 2) GET orders.json?email=… — eveneens zonder datumsfilter op deze client-route (sla over bij shop-inbox)
  if (candidates.length === 0 && restrictByCustomerEmail) {
    try {
      const byEmailApi = await fetchOrdersMatchingEmail(cfg, emailNorm);
      if (byEmailApi.length === 1) {
        candidates = byEmailApi;
      } else if (byEmailApi.length > 1) {
        byEmailApi.sort(
          (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
        );
        candidates = [byEmailApi[0]];
      }
    } catch {
      /* ignore */
    }
  }

  // 3) Cache / overzicht (incrementeel; created_at-venster + cap) — fallback voor fuzzy naam zonder duidelijke hint
  const searchCap = Math.min(
    500,
    Math.max(50, Number(process.env.MAIL_ORDER_SEARCH_CAP || '') || 250)
  );
  if (candidates.length === 0) {
    const { orders } = await resolveOrdersForOverview(cfg, normShopHost(cfg.shopDomain), {
      cap: searchCap,
      fullSync: false,
      explicitOrderLimit: null,
    });

    if (restrictByCustomerEmail) {
      candidates = orders.filter((o) => orderEmailNorm(o) === emailNorm);
    }

    if (nameHints.length) {
      const byOrderName = orders.filter((o) => nameHints.some((h) => orderNameMatchesHint(o, h)));
      if (byOrderName.length) {
        if (restrictByCustomerEmail) {
          const both = byOrderName.filter((o) => orderEmailNorm(o) === emailNorm);
          candidates = both.length ? both : byOrderName;
        } else {
          candidates = byOrderName;
        }
      }
    }

    if (candidates.length === 0 && restrictByCustomerEmail) {
      candidates = orders.filter((o) => orderEmailNorm(o) === emailNorm);
    }

    if (candidates.length === 0 && !hasEmail && senderName) {
      const scored = orders
        .map((o) => ({ o, s: nameMatchScore(senderName, o) }))
        .filter((x) => x.s >= 6)
        .sort(
          (a, b) =>
            b.s - a.s ||
            new Date(b.o.updated_at || 0).getTime() - new Date(a.o.updated_at || 0).getTime()
        );
      if (scored.length) candidates = [scored[0].o];
    }
  }

  if (candidates.length === 0) return null;

  if (candidates.length > 1 && senderName) {
    candidates = [...candidates].sort(
      (a, b) =>
        nameMatchScore(senderName, b) - nameMatchScore(senderName, a) ||
        new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    );
  } else {
    candidates.sort(
      (a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
    );
  }

  return candidates[0] || null;
}

/**
 * Zoekt de meest recente order bij e-mail (en optioneel ordernaam #1234) — zelfde logica als mailbox.
 * @param {{ shopDomain: string; accessToken: string }} cfg
 * @param {{ customerEmail: string; shopifyOrderName?: string | null }} q
 */
export async function findOrderForReply(cfg, q) {
  const hint = q.shopifyOrderName ? String(q.shopifyOrderName).trim() : '';
  return findOrderForMailbox(cfg, {
    customerEmail: q.customerEmail,
    senderName: undefined,
    subjectHint: hint ? `order ${hint}` : undefined,
  });
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
    const seenNums = new Set();
    for (const t of row.trackings) {
      if (!shouldQueryDpdTracking(t)) continue;
      const num = String(t.number).replace(/\s/g, '');
      if (seenNums.has(num)) continue;
      seenNums.add(num);
      try {
        const d = await getDpdTracking({
          creds: dpd,
          parcelLabelNumber: num,
        });
        out.dpdTrackings.push({
          number: t.number,
          company: t.company,
          label: d.label,
          rawStatus: d.rawStatus,
          location: d.location,
          date: d.date,
          description: d.description,
          timeline: d.timeline,
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
 * @param {Array<{ error?: string; label?: string; rawStatus?: string; date?: string; location?: string; number?: string }>} dpdTrackings
 */
export function summarizeDpdTrackings(dpdTrackings) {
  const list = Array.isArray(dpdTrackings) ? dpdTrackings : [];
  const first = list.find((d) => d && !d.error && (d.label || d.rawStatus));
  if (!first) return null;
  const parts = [first.label || first.rawStatus];
  if (first.date) parts.push(first.date);
  if (first.location) parts.push(first.location);
  if (first.number) parts.push(`pakket ${first.number}`);
  return parts.filter(Boolean).join(' · ');
}

/** @param {Array<{ error?: unknown }>} dpdTrackings */
export function hasUsableDpdData(dpdTrackings) {
  return (
    Array.isArray(dpdTrackings) &&
    dpdTrackings.some((d) => d && !d.error && (d.label || d.rawStatus || d.timeline?.length))
  );
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
          `DPD ${d.number} (actueel): ${d.label || d.rawStatus || 'status onbekend'}${d.location ? ` · locatie: ${d.location}` : ''}${d.date ? ` · laatste melding: ${d.date}` : ''}`
        );
        if (d.description) {
          lines.push(`  Actuele toelichting DPD: ${d.description}`);
        }
        if (d.timeline?.length) {
          lines.push(`  Tijdlijn DPD (${d.number}), chronologisch (oud → nieuw):`);
          for (const step of d.timeline) {
            const parts = [
              step.date || '—',
              step.label || step.status || '—',
              step.location ? `locatie ${step.location}` : '',
              step.description || '',
            ].filter(Boolean);
            lines.push(`    - ${parts.join(' · ')}`);
          }
          lines.push(
            '  Gebruik deze tijdlijn om de klant te vertellen waar het pakket nu staat en welke leverdatum of levervenster DPD meldt — alleen als dat expliciet in de regels hierboven staat; anders geen verzonnen dag noemen.'
          );
        }
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

  lines.push('');
  lines.push(
    'Let op: bovenstaande ordercontext is feitelijke achtergrond. Noem ordernummer, status of tracking in je antwoord alleen als de klantmail daar redelijkerwijs om vraagt (levering, betaling, product uit deze bestelling, retour, …). Bij puur algemene of product-/gebruiksvragen: antwoord daarop zonder onnodige orderkaders of excuses.'
  );

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

/**
 * Gaat de klantmail (onderwerp + body) over bestelling, levering, retour, betaling, …?
 * Bij twijfel: false — liever geen order in het antwoord.
 * @param {string | null | undefined} incomingBody
 * @param {string | null | undefined} [incomingSubject]
 * @param {string | null | undefined} [extraText]
 */
export function isCustomerMailOrderRelated(incomingBody, incomingSubject, extraText) {
  const text = [incomingSubject, incomingBody, extraText]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join('\n');
  if (text.length < 6) return false;

  const orderRe = [
    /\b(bestell|order|ordernummer|bestelnummer|order\s*#|order\s*nr)\b/i,
    /\b(verzend|verzending|lever|levering|geleverd|bezorg|bezorging)\b/i,
    /\b(track|trace|tracking|pakket|zending|dpd|postnl|colis|parcel|shipment|delivered|delivery)\b/i,
    /\b(waar blijft|nog niet ontvangen|niet ontvangen|not received|where is my|when will i receive)\b/i,
    /\b(retour|ruil|ruilen|terugsturen|return|exchange|refund|geld terug|annuleer|annuleren|cancel)\b/i,
    /\b(betaal|betaling|payment|factuur|invoice|rekening)\b/i,
    /\b(beschadigd|kapot|defect|verkeerd|misgeleverd|ontbreekt|damaged|wrong item|missing)\b/i,
    /\b(op voorraad|voorraad|weer leverbaar|uitverkocht|out of stock|restock)\b/i,
  ];
  const nonOrderRe = [
    /\b(hoe gebruik|how to use|handleiding|manual|montage|installatie|inbouw|welke maat|maatadvies)\b/i,
    /\b(productadvies|advies over|vraag over het product|werkt niet goed)\b/i,
    /\b(nieuwsbrief|newsletter|samenwerking|collab|wholesale|groothandel|vacature|sollicit)\b/i,
    /\b(algemene vraag|informatie over jullie bedrijf)\b/i,
  ];

  const orderHits = orderRe.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  const nonOrderHits = nonOrderRe.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

  if (orderHits >= 1 && nonOrderHits === 0) return true;
  if (orderHits >= 2) return true;
  if (nonOrderHits >= 1 && orderHits === 0) return false;
  if (orderHits >= 1 && nonOrderHits >= 1) return orderHits > nonOrderHits;
  return false;
}

/**
 * Minimale context als er wél een order is gekoppeld maar de vraag gaat er niet over.
 * @param {any} row
 * @param {string | null} shopName
 */
export function orderBackgroundOnlyPromptBlock(row, shopName) {
  return [
    `Winkel: ${shopName || 'onbekend'}`,
    '',
    '--- Achtergrond voor de assistent (niet in het klantantwoord) ---',
    `Intern is order ${row.shopifyOrderName} (id ${row.shopifyOrderId}) aan dit e-mailadres gekoppeld.`,
    'De inkomende klantmail gaat naar inschatting NIET over levering, tracking, betaling of retour van die order.',
    'Antwoord uitsluitend op de inhoudelijke vraag van de klant.',
    'Noem GEEN ordernummer, GEEN verzend-/betaalstatus en GEEN DPD — ook niet ter verduidelijking.',
  ].join('\n');
}

/**
 * @param {string | null | undefined} incomingBody
 * @param {string | null | undefined} incomingSubject
 */
export function orderContextBlockForCustomerMail(row, shopName, incomingBody, incomingSubject) {
  if (isCustomerMailOrderRelated(incomingBody, incomingSubject)) {
    return orderContextPromptBlock(row, shopName);
  }
  return orderBackgroundOnlyPromptBlock(row, shopName);
}

/**
 * @param {string | null | undefined} displayName
 */
export function voornaamFromDisplayName(displayName) {
  const s = String(displayName || '')
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .trim();
  if (!s) return 'daar';
  const part = s.split(/[\s,]+/)[0];
  return part || 'daar';
}

/**
 * @param {{ error?: string; number?: string; label?: string | null; rawStatus?: string | null; location?: string | null; date?: string | null; description?: string | null; timeline?: { label?: string; status?: string | null; location?: string | null; date?: string | null; description?: string | null }[] }} d
 */
export function formatDpdBlockForStandardReply(d) {
  if (d.error) {
    return `Live DPD-status tijdelijk niet beschikbaar voor ${d.number || 'deze zending'}. Je kunt je pakket altijd volgen op dpd.nl met pakketnummer ${d.number || '—'}.`;
  }
  const chunks = [];
  const headline = d.label || d.rawStatus || '—';
  chunks.push(`• Huidige status: ${headline}`);
  if (d.location) chunks.push(`• Laatste locatie: ${d.location}`);
  if (d.date) chunks.push(`• Laatste update: ${d.date}`);
  if (d.description) chunks.push(`• ${d.description}`);
  if (d.timeline?.length) {
    chunks.push('• Recente stappen (oud → nieuw):');
    for (const step of d.timeline.slice(-5)) {
      let line = `   ${step.date || '—'} — ${step.label || step.status || '—'}`;
      if (step.location) line += ` (${step.location})`;
      chunks.push(line);
    }
  }
  chunks.push(`• Meer detail: www.dpd.nl — zoek op ${d.number}.`);
  return chunks.join('\n');
}

/** @typedef {'nl' | 'en' | 'de' | 'fr' | 'es'} CustomerReplyLang */

/** @type {Record<CustomerReplyLang, { name: string; signOff: string; labelNl: string }>} */
export const CUSTOMER_REPLY_LANGUAGE_META = {
  nl: { name: 'Nederlands', signOff: 'Met vriendelijke groet', labelNl: 'Nederlands' },
  en: { name: 'English', signOff: 'Kind regards', labelNl: 'Engels' },
  de: { name: 'Deutsch', signOff: 'Mit freundlichen Grüßen', labelNl: 'Duits' },
  fr: { name: 'français', signOff: 'Cordialement', labelNl: 'Frans' },
  es: { name: 'español', signOff: 'Un saludo cordial', labelNl: 'Spaans' },
};

/**
 * Bepaalt de waarschijnlijke taal van de klant uit onderwerp + berichttekst.
 * @param {string | undefined | null} incomingBody
 * @param {string | undefined | null} [incomingSubject]
 * @returns {CustomerReplyLang}
 */
export function detectCustomerReplyLanguage(incomingBody, incomingSubject) {
  const text = [incomingSubject, incomingBody]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join('\n');
  if (!text) return 'nl';

  const sample = text.slice(0, 6000).toLowerCase();

  /** @type {Record<CustomerReplyLang, number>} */
  const scores = { nl: 0, en: 0, de: 0, fr: 0, es: 0 };
  const patterns = {
    nl: /\b(de|het|een|van|voor|graag|bedankt|bestelling|hallo|groet|waarom|niet|mijn|jullie|verzending|ontvangen|pakket|klopt|vraag)\b/gi,
    en: /\b(the|and|please|thank|thanks|order|hello|hi|dear|regards|shipment|delivery|received|tracking|my|your|not|where|when)\b/gi,
    de: /\b(ich|sie|danke|bestellung|hallo|guten|bitte|ware|lieferung|nicht|meine|ihre|und|der|die|paket|sendung)\b/gi,
    fr: /\b(merci|bonjour|commande|livraison|vous|je|mon|pas|pour|colis|bonne|reçu)\b/gi,
    es: /\b(gracias|hola|pedido|favor|envío|envio|mi|tu|no|cuando|recibido|pedido)\b/gi,
  };
  for (const [lang, re] of Object.entries(patterns)) {
    const m = sample.match(re);
    if (m) scores[/** @type {CustomerReplyLang} */ (lang)] = m.length;
  }
  if (/^(hi|hello|dear)\b/i.test(text)) scores.en += 4;
  if (/^(hallo|beste|goedemorgen|geachte)\b/i.test(text)) scores.nl += 4;
  if (/^(hallo|guten tag|sehr geehrte|guten morgen)\b/i.test(text)) scores.de += 4;
  if (/^(bonjour|bonsoir|madame|monsieur)\b/i.test(text)) scores.fr += 4;
  if (/^(hola|buenos|estimado)\b/i.test(text)) scores.es += 4;

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top || top[1] === 0) return 'nl';
  if (sorted.length >= 2 && sorted[0][1] === sorted[1][1]) {
    const langs = sorted.filter(([, n]) => n === top[1]).map(([l]) => l);
    if (langs.includes('nl')) return 'nl';
  }
  return /** @type {CustomerReplyLang} */ (top[0]);
}

/** @param {CustomerReplyLang | string} lang */
export function customerReplyLanguageLabel(lang) {
  const key = /** @type {CustomerReplyLang} */ (lang in CUSTOMER_REPLY_LANGUAGE_META ? lang : 'nl');
  return CUSTOMER_REPLY_LANGUAGE_META[key]?.labelNl || 'Nederlands';
}

/** @type {Record<'en' | 'de' | 'fr' | 'es', {
 *   greeting: string;
 *   thanksOpen: string;
 *   orderMatched: (order: string) => string;
 *   topicSummary: (topic: string) => string;
 *   orderHeader: string;
 *   fulfillmentLabel: string;
 *   paymentLabel: string;
 *   shippingHeader: string;
 *   carrierFallback: string;
 *   trackLabel: string;
 *   trackingSoon: string;
 *   closing: string;
 *   signOff: string;
 *   team: string;
 *   noOrderBody: (name: string, shop?: string | null) => string;
 * }>} */
const REPLY_STRINGS = {
  en: {
    greeting: 'Hi',
    thanksOpen: "Thank you for your message — we've read it carefully.",
    orderMatched: (o) =>
      `We've automatically matched your email to order ${o}, so the details below are tailored to your purchase.`,
    topicSummary: (t) => `What we picked up from your message: ${t}.`,
    orderHeader: '— Your order —',
    fulfillmentLabel: 'Fulfillment',
    paymentLabel: 'Payment',
    shippingHeader: '— Shipping (DPD) —',
    carrierFallback: 'Carrier',
    trackLabel: 'Track',
    trackingSoon:
      'Once your parcel ships, you will receive a tracking e-mail from us or the carrier — usually the same day.',
    closing:
      "If anything is missing or unclear, just reply to this thread and we'll pick it up straight away (same working day when possible).",
    signOff: 'Kind regards',
    team: 'Customer care',
    noOrderBody: (name, shop) =>
      `Hi ${name},\n\nThank you for your message.\n\nWe checked our order overview immediately, but we cannot yet match your request to one specific order. To share the exact live status, please reply with your order number (for example TOD12345) and the email address used when ordering.\n\nAs soon as we have that, we will send you the current shipping status right away.\n\nKind regards${shop ? `, ${shop}` : ''}\nSupport team`,
  },
  de: {
    greeting: 'Hallo',
    thanksOpen: 'vielen Dank für Ihre Nachricht — wir haben sie sorgfältig gelesen.',
    orderMatched: (o) =>
      `Wir haben Ihre E-Mail automatisch der Bestellung ${o} zugeordnet; die Angaben unten beziehen sich auf Ihren Kauf.`,
    topicSummary: (t) => `Kurz zusammengefasst aus Ihrer Nachricht: ${t}.`,
    orderHeader: '— Ihre Bestellung —',
    fulfillmentLabel: 'Versandstatus',
    paymentLabel: 'Zahlung',
    shippingHeader: '— Sendung (DPD) —',
    carrierFallback: 'Versanddienst',
    trackLabel: 'Sendung verfolgen',
    trackingSoon:
      'Sobald Ihr Paket versendet wird, erhalten Sie in der Regel noch am selben Tag eine E-Mail mit Sendungsverfolgung von uns oder dem Zusteller.',
    closing:
      'Wenn etwas unklar ist, antworten Sie einfach auf diese E-Mail — wir melden uns schnellstmöglich (werktags).',
    signOff: 'Mit freundlichen Grüßen',
    team: 'Kundenservice',
    noOrderBody: (name, shop) =>
      `Hallo ${name},\n\nvielen Dank für Ihre Nachricht.\n\nWir konnten Ihre Anfrage noch keiner konkreten Bestellung zuordnen. Bitte antworten Sie mit Ihrer Bestellnummer (z. B. TOD12345) und der E-Mail-Adresse, mit der Sie bestellt haben — dann senden wir Ihnen umgehend den aktuellen Versandstatus.\n\nMit freundlichen Grüßen${shop ? `\n${shop}` : ''}\nKundenservice`,
  },
  fr: {
    greeting: 'Bonjour',
    thanksOpen: 'merci pour votre message — nous l’avons bien lu.',
    orderMatched: (o) =>
      `Nous avons associé votre e-mail à la commande ${o}; les informations ci-dessous concernent votre achat.`,
    topicSummary: (t) => `Ce que nous avons retenu de votre message : ${t}.`,
    orderHeader: '— Votre commande —',
    fulfillmentLabel: 'Expédition',
    paymentLabel: 'Paiement',
    shippingHeader: '— Livraison (DPD) —',
    carrierFallback: 'Transporteur',
    trackLabel: 'Suivi',
    trackingSoon:
      'Dès l’expédition de votre colis, vous recevrez en général le jour même un e-mail de suivi de notre part ou du transporteur.',
    closing:
      'Si quelque chose n’est pas clair, répondez à ce fil — nous vous répondrons dès que possible (jours ouvrés).',
    signOff: 'Cordialement',
    team: 'Service client',
    noOrderBody: (name, shop) =>
      `Bonjour ${name},\n\nmerci pour votre message.\n\nNous n’avons pas encore pu associer votre demande à une commande précise. Merci de répondre avec votre numéro de commande (ex. TOD12345) et l’adresse e-mail utilisée lors de l’achat — nous vous enverrons alors le statut d’expédition actuel.\n\nCordialement${shop ? `\n${shop}` : ''}\nService client`,
  },
  es: {
    greeting: 'Hola',
    thanksOpen: 'gracias por su mensaje — lo hemos leído con atención.',
    orderMatched: (o) =>
      `Hemos vinculado su correo con el pedido ${o}; los datos siguientes corresponden a su compra.`,
    topicSummary: (t) => `Resumen de su mensaje: ${t}.`,
    orderHeader: '— Su pedido —',
    fulfillmentLabel: 'Envío',
    paymentLabel: 'Pago',
    shippingHeader: '— Envío (DPD) —',
    carrierFallback: 'Transportista',
    trackLabel: 'Seguimiento',
    trackingSoon:
      'Cuando se envíe su paquete, normalmente recibirá el mismo día un correo con seguimiento de nosotros o del transportista.',
    closing:
      'Si algo no está claro, responda a este hilo y le atenderemos lo antes posible (días laborables).',
    signOff: 'Un saludo cordial',
    team: 'Atención al cliente',
    noOrderBody: (name, shop) =>
      `Hola ${name},\n\ngracias por su mensaje.\n\nAún no hemos podido vincular su consulta a un pedido concreto. Responda con su número de pedido (p. ej. TOD12345) y el correo usado al comprar — le enviaremos el estado de envío actual.\n\nUn saludo cordial${shop ? `\n${shop}` : ''}\nAtención al cliente`,
  },
};

/**
 * Vast (niet-AI) antwoordtekst met order- en DPD-context.
 * @param {any} enriched — rij uit enrichOrderRowForAi
 * @param {string} voornaam
 * @param {string} topicHint
 * @param {{ shopName?: string | null; incomingText?: string; incomingSubject?: string; language?: CustomerReplyLang }} [meta]
 */
export function buildStandardMailReplyText(enriched, voornaam, topicHint, meta = {}) {
  const name =
    String(voornaam || '').trim() || voornaamFromDisplayName(enriched?.customerDisplayName);
  const topic = String(topicHint || '').trim();
  const shopTail = meta.shopName ? ` bij ${meta.shopName}` : '';
  const lang =
    meta.language ||
    detectCustomerReplyLanguage(meta.incomingText || topic, meta.incomingSubject);
  const looksEnglish = lang !== 'nl';
  const asksRestockNl =
    /\b(leverbaar|op voorraad|voorraad|weer binnen|beschikbaar)\b/i.test(topic) &&
    /\b(wanneer|wanneer weer|indicatie|verwacht)\b/i.test(topic);
  const asksShipmentNl =
    /\b(verzonden|verzendstatus|track|trace|ontvangen|bestelling)\b/i.test(topic) &&
    /\b(wanneer|waar|nog niet|niet ontvangen|status|al)\b/i.test(topic);
  const asksShipmentEn =
    /\b(order|shipment|shipping|tracking|received|arrived|delivered|missing)\b/i.test(topic) &&
    /\b(when|where|not|still|status|yet|haven't|havent)\b/i.test(topic);
  const cleanTopic = topic.replace(/[.\s]{2,}/g, ' ').replace(/\.+$/, '').slice(0, 180);
  const hasOrder = Boolean(enriched?.shopifyOrderName);
  const orderRelevant = isCustomerMailOrderRelated(
    meta.incomingText || topic,
    meta.incomingSubject,
    topic
  );
  const includeOrderBlock =
    asksRestockNl ||
    asksShipmentNl ||
    asksShipmentEn ||
    (hasOrder && orderRelevant);
  const includeShippingBlock =
    includeOrderBlock &&
    hasOrder &&
    (enriched?.dpdTrackings?.length ||
      enriched?.trackings?.some((t) => t && t.number) ||
      enriched?.displayFulfillmentStatus ||
      enriched?.fulfillmentStatus);

  if (looksEnglish) {
    const L = REPLY_STRINGS[lang] || REPLY_STRINGS.en;
    let enBody = `${L.greeting} ${name},

${L.thanksOpen}`;
    if (includeOrderBlock && enriched?.shopifyOrderName) {
      enBody += `\n\n${L.orderMatched(enriched.shopifyOrderName)}`;
    }
    if (cleanTopic) {
      enBody += `\n\n${L.topicSummary(cleanTopic)}`;
    }
    if (includeOrderBlock && enriched?.shopifyOrderName) {
      const fs = enriched.displayFulfillmentStatus || enriched.fulfillmentStatus;
      const pay = enriched.displayFinancialStatus || enriched.financialStatus;
      enBody += `\n\n${L.orderHeader}`;
      if (fs) enBody += `\n• ${L.fulfillmentLabel}: ${fs}.`;
      if (pay) enBody += `\n• ${L.paymentLabel}: ${pay}.`;
    }
    if (includeShippingBlock && enriched?.dpdTrackings?.length) {
      enBody += `\n\n${L.shippingHeader}`;
      for (const d of enriched.dpdTrackings) {
        enBody += `\n${formatDpdBlockForStandardReply(d)}\n`;
      }
    } else if (includeShippingBlock && enriched?.trackings?.some((t) => t && t.number)) {
      const t = enriched.trackings.find((x) => x.number);
      if (t) {
        enBody += `\n\n${L.shippingHeader}\n• ${t.company || L.carrierFallback}: ${t.number}`;
        if (t.url) enBody += `\n• ${L.trackLabel}: ${t.url}`;
      }
    } else if (includeShippingBlock && enriched?.shopifyOrderName) {
      enBody += `\n\n${L.trackingSoon}`;
    }
    enBody += `\n\n${L.closing}

${L.signOff}${meta.shopName ? `\n${meta.shopName}` : ''}
${L.team}`;

    return enBody.replace(/\n{3,}/g, '\n\n').trim();
  }

  if (asksRestockNl) {
    const brand = meta.shopName ? ` van ${meta.shopName}` : '';
    return `Beste ${name},

Dank je voor je bericht — fijn dat je interesse hebt in dit product${brand}.

Op dit moment staat dit artikel (nog) niet op voorraad. We werken aan een nieuwe levering; zodra het weer binnen is, zie je het direct als bestelbaar in de webshop. Een exacte datum kunnen we op dit moment niet garanderen.

Wil je dat we je een kort bericht sturen zodra het artikel weer leverbaar is? Antwoord dan even met “ja graag” op deze mail.

Met vriendelijke groet${shopTail}
Het team`;
  }

  if (!enriched?.shopifyOrderName && (asksShipmentNl || asksShipmentEn)) {
    if (looksEnglish) {
      const L = REPLY_STRINGS[lang] || REPLY_STRINGS.en;
      return L.noOrderBody(name, meta.shopName ?? null);
    }
    return `Beste ${name},

Dank je voor je bericht.

We hebben meteen in onze systemen gekeken, maar kunnen je vraag nog niet aan één specifieke bestelling koppelen. Mail je terug met je ordernummer (bijv. #12345 of T0046587) en het e-mailadres waarmee je bestelde? Dan sturen we je direct de actuele verzendstatus.

Met vriendelijke groet${shopTail}
Het team`;
  }

  let body = `Beste ${name},

Dank je wel voor je bericht — we hebben het gelezen en nemen je serieus.`;
  if (includeOrderBlock && enriched?.shopifyOrderName) {
    body += `\n\nWe hebben je mail automatisch gekoppeld aan bestelling ${enriched.shopifyOrderName}. Daardoor kun je hieronder meteen de actuele status zien — geen copy-paste van algemene teksten, maar wat bij jouw order hoort.`;
  }
  if (cleanTopic) {
    body += `\n\nWaar het in je bericht met name om gaat (samengevat): ${cleanTopic}.`;
  }
  if (includeOrderBlock && enriched?.shopifyOrderName) {
    const fs = enriched.displayFulfillmentStatus || enriched.fulfillmentStatus;
    const pay = enriched.displayFinancialStatus || enriched.financialStatus;
    body += '\n\n— Jouw order —';
    if (fs) body += `\n• Verzendstatus: ${fs}.`;
    if (pay) body += `\n• Betaling: ${pay}.`;
  }

  if (includeShippingBlock && enriched?.dpdTrackings?.length) {
    body += '\n\n— Verzending (DPD) —';
    for (const d of enriched.dpdTrackings) {
      body += `\n${formatDpdBlockForStandardReply(d)}\n`;
    }
  } else if (includeShippingBlock && enriched?.trackings?.some((t) => t && t.number)) {
    const t = enriched.trackings.find((x) => x.number);
    if (t) {
      body += `\n\n— Verzending —\n• ${t.company || 'Vervoerder'}: ${t.number}`;
      if (t.url) body += `\n• Volgen: ${t.url}`;
      body += '.';
    }
  } else if (includeShippingBlock && enriched?.shopifyOrderName) {
    body +=
      '\n\nZodra je pakket de deur uit gaat, ontvang je van ons of van de vervoerder een mail met track & trace — meestal dezelfde dag nog.';
  }

  body += `\n\nNog iets nodig? Antwoord op deze thread; we reageren bij voorkeur dezelfde werkdag (ma–vr).

Met vriendelijke groet${shopTail}
Het team`;

  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/** Contexttekst als er géén Shopify-order match is (wel zoekhints voor de LLM). */
export function noOrderContextPromptBlock(opts) {
  const shopName = opts.shopName != null ? String(opts.shopName).trim() : '';
  const customerEmail = opts.customerEmail != null ? String(opts.customerEmail).trim() : '';
  const senderName = opts.senderName != null ? String(opts.senderName).trim() : '';
  const hints = Array.isArray(opts.orderHintsFromSubject)
    ? opts.orderHintsFromSubject.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const lines = [
    `Winkel: ${shopName || 'onbekend'}`,
    '',
    '--- Achtergrond (voor jou als assistent): er is in Shopify geen bestelling automatisch gekoppeld aan deze thread (cache/zoekactie).',
    `Geprobeerd te matchen op: klant-e-mail ${customerEmail || '—'}`,
    senderName ? `Afzendernaam (uit mail): ${senderName}` : null,
    hints.length ? `Mogelijke orderhints uit onderwerp (niet bevestigd): ${hints.join(', ')}` : null,
    '',
    'Je mag geen ordernummers, betaal-/verzendstatus of tracking verzinnen of uit deze hints halen alsof ze bewezen zijn.',
    'Begin het antwoord niet met deze beperking tenzij de klant expliciet om orderstatus, tracking, betaling of annulering vraagt — zie systeemregels over wanneer je wél om een ordernummer mag vragen.',
  ].filter(Boolean);
  return lines.join('\n');
}

const INTENT_BLOCK = `
Intent (critical):
- Read what the customer email is really about first.
- Shipping, delivery, order status, tracking, payment, cancel, return, exchange, or a product from a recent order? You may use order/shipping context below.
- Other topics (product advice, general questions, complaints without order context): answer that directly. Only mention order numbers or tracking when it truly helps.
- Never say you "cannot find the order" if they did not ask about an order or delivery.
- Do not force order-matching boilerplate when irrelevant.
- If background says an order exists but the customer did NOT ask about it: do not mention that order at all.`;

const SYSTEM_RULES_WITH_ORDER = `Rules:
- Use only facts from the order context and DPD data for order-related parts. Do not invent tracking or delivery dates.
- If the context lists DPD parcel number(s) with status or timeline AND the customer's question is about shipping/delivery/order status: include a clear sentence with current DPD status, parcel number, and dpd.nl. If their question is NOT about shipping (e.g. product use, general info): do NOT mention DPD or tracking.
- If there is no tracking yet or fulfillment is unfulfilled, say honestly that shipment is still being prepared — only when relevant to their question.
- If production/lead time with business days is in the context, explain without promising beyond the data.
- If DPD timeline exists: summarize the latest status and the most recent timeline steps from the data only (no invented delivery dates).
- Tone: professional, warm, concise (~120–150 words in the body when DPD context is included).
- Do not sign with a real employee name unless instructed.
- If "Staff instructions" are provided, incorporate them naturally.
- Reply ONLY as a JSON object with keys: "subject" (string), "body" (string, plain text with line breaks). No markdown.`;

const SYSTEM_RULES_NO_ORDER = `There is no Shopify order linked to this email — you have no confirmed order status, tracking, or delivery dates from the shop, and you must not invent any.
${INTENT_BLOCK}
Rules:
- Do not invent order numbers, amounts, shipping dates, or tracking.
- If they explicitly ask about order/shipping/tracking/payment/cancel/return and you have no order data: briefly ask for order number and checkout email — one short sentence.
- If they did not ask about an order: answer only their actual question; no "we cannot find your order" paragraph.
- Tone: professional, warm, concise (~120 words).
- Reply ONLY as JSON: "subject", "body" (plain text). No markdown.`;

const SYSTEM_RULES_ORDER_BACKGROUND = `A Shopify order is linked to this email for internal reference only — the customer's message is NOT about that order.
${INTENT_BLOCK}
Rules:
- Answer only what the customer actually asked (product, general question, advice, etc.).
- Do NOT mention order numbers, shipping status, tracking, DPD, payment, or "we linked your email to order …".
- Do not invent order or shipping facts.
- Tone: professional, warm, concise (~80–120 words).
- Reply ONLY as JSON: "subject", "body" (plain text). No markdown.`;

/**
 * @param {{ noOrder: boolean; orderRelevant: boolean; lang: CustomerReplyLang }} opts
 */
function buildReplySystemPrompt(opts) {
  const L = CUSTOMER_REPLY_LANGUAGE_META[opts.lang] || CUSTOMER_REPLY_LANGUAGE_META.nl;
  const langBlock = `
LANGUAGE (critical): Write the entire reply — both "subject" and "body" — in ${L.name}, matching the customer's language and tone from their incoming message. Do not reply in another language unless staff instructions explicitly require it.
Sign-off: use "${L.signOff}" plus the shop name when provided.`;

  if (opts.noOrder) {
    return `You are customer support for an online shop. Write a short, friendly email reply to the customer's incoming message.
${SYSTEM_RULES_NO_ORDER}
${langBlock}`;
  }
  if (!opts.orderRelevant) {
    return `You are customer support for an online shop. Write a short, friendly email reply to the customer's incoming message.
${SYSTEM_RULES_ORDER_BACKGROUND}
${langBlock}`;
  }
  return `You are customer support for an online shop. Write a short, friendly email reply to the customer's incoming message.
${INTENT_BLOCK}
${SYSTEM_RULES_WITH_ORDER}
${langBlock}`;
}

/** @type {Record<string, string>} */
const REPLY_STYLE_EXTRA = {
  default: '',
  kort: '\n\nAdditional instruction: Keep the body very short (max ~60 words).',
  formeel: '\n\nAdditional instruction: Use a formal greeting and closing appropriate to the reply language.',
  vriendelijk:
    '\n\nAdditional instruction: Extra warm, personal tone; slightly longer is OK if helpful. Stay honest about lead times.',
  uitsluitend_feiten:
    '\n\nAdditional instruction: Facts only from context; no soft promises. Still include a brief greeting and sign-off.',
  stappen:
    '\n\nAdditional instruction: Use numbered steps (1., 2., …) where helpful. Max ~150 words.',
  track_focus:
    '\n\nAdditional instruction: Focus on shipping status and tracking — what the customer can do per the context.',
};

/**
 * @param {string | undefined | null} raw
 * @returns {keyof typeof REPLY_STYLE_EXTRA}
 */
export function normalizeReplyStyle(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  return s in REPLY_STYLE_EXTRA ? /** @type {keyof typeof REPLY_STYLE_EXTRA} */ (s) : 'default';
}

/**
 * @param {{ shopName: string | null; orderContextBlock: string; incomingSubject?: string; incomingBody: string; replyStyle?: string | null; extraInstructions?: string | null; noOrderMatch?: boolean; orderRelevantToQuestion?: boolean; deskKnowledgeBlock?: string | null }} input
 */
export async function generateCustomerReplyDraft(input) {
  const key = getOpenAiApiKey();
  if (!key) {
    throw new Error('OPENAI_API_KEY ontbreekt — stel in via Instellingen of .env');
  }
  const model = getOpenAiModel();
  const styleKey = normalizeReplyStyle(input.replyStyle);
  const noOrder = Boolean(input.noOrderMatch);
  const orderRelevant =
    input.orderRelevantToQuestion !== undefined
      ? Boolean(input.orderRelevantToQuestion)
      : !noOrder && isCustomerMailOrderRelated(input.incomingBody, input.incomingSubject);
  const replyLanguage = detectCustomerReplyLanguage(
    input.incomingBody,
    input.incomingSubject
  );
  const hasDpdInContext = /DPD\s+\d/i.test(input.orderContextBlock);
  const styleKeyEffective =
    styleKey === 'default' && hasDpdInContext && orderRelevant ? 'track_focus' : styleKey;
  const styleBlockEffective = REPLY_STYLE_EXTRA[styleKeyEffective] || '';
  const deskBlock =
    typeof input.deskKnowledgeBlock === 'string' && input.deskKnowledgeBlock.trim()
      ? input.deskKnowledgeBlock.trim()
      : '';
  const systemBase =
    buildReplySystemPrompt({ noOrder, orderRelevant, lang: replyLanguage }) +
    (deskBlock ? `\n\n${deskBlock}` : '');

  const extra =
    typeof input.extraInstructions === 'string' && input.extraInstructions.trim()
      ? input.extraInstructions.trim()
      : '';

  const userMsg = [
    'Task: reply to the customer email below; follow intent rules (do not mention missing order unless they asked about an order).',
    orderRelevant
      ? 'The customer message IS about their order/shipping/return — you may use order context.'
      : noOrder
        ? 'No confirmed order context — do not invent order details.'
        : 'An order exists internally but the customer question is NOT about it — do NOT mention the order, tracking, or DPD.',
    '',
    `Detected customer language: ${CUSTOMER_REPLY_LANGUAGE_META[replyLanguage].name} (${replyLanguage}) — write subject and body in this language.`,
    hasDpdInContext && orderRelevant
      ? 'DPD live tracking is in the context below — include current DPD status and parcel number only because this is an order/shipping question.'
      : '',
    '',
    '--- Context (facts; use only where relevant to the customer question) ---',
    input.orderContextBlock,
    '',
    '--- Incoming customer email ---',
    input.incomingSubject ? `Subject: ${input.incomingSubject}` : '(no subject)',
    '',
    input.incomingBody.trim() || '(empty)',
    '',
    '--- Staff instructions (incorporate if relevant; ignore if empty) ---',
    extra || '(none)',
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
        { role: 'system', content: systemBase + styleBlockEffective },
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

  return {
    subject,
    body,
    model,
    replyLanguage,
    orderRelevantToQuestion: orderRelevant,
    hasDpd: hasDpdInContext && orderRelevant,
    dpdSummary:
      hasDpdInContext && orderRelevant
        ? summarizeDpdTrackingsFromBlock(input.orderContextBlock)
        : null,
  };
}

/**
 * Parseert compacte DPD-samenvatting uit orderContextPromptBlock-tekst (voor API-response).
 * @param {string} block
 */
function summarizeDpdTrackingsFromBlock(block) {
  const m = String(block || '').match(
    /DPD\s+(\S+)\s+\(actueel\):\s*([^\n·]+)(?:\s*·\s*laatste melding:\s*([^\n·]+))?/
  );
  if (!m) return null;
  const parts = [m[2].trim()];
  if (m[3]) parts.push(m[3].trim());
  parts.push(`pakket ${m[1]}`);
  return parts.join(' · ');
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
  const key = getOpenAiApiKey();
  if (!key) {
    throw new Error('OPENAI_API_KEY ontbreekt — stel in via Instellingen of .env');
  }
  const model = getOpenAiModel();

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
