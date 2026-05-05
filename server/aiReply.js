import {
  fetchOrdersMatchingName,
  fetchOrdersMatchingEmail,
  fetchProductThumbnailData,
  normShopHost,
  ordersToRichOrderRows,
} from './shopify.js';
import { shouldDiscardCustomerEmail } from './mailContactExtract.js';
import { resolveOrdersForOverview } from './overviewSync.js';
import { getDpdTracking, isLikelyDpdCarrier } from './dpd.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
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

/**
 * Vast (niet-AI) antwoordtekst met order- en DPD-context.
 * @param {any} enriched — rij uit enrichOrderRowForAi
 * @param {string} voornaam
 * @param {string} topicHint
 * @param {{ shopName?: string | null }} [meta]
 */
export function buildStandardMailReplyText(enriched, voornaam, topicHint, meta = {}) {
  const name =
    String(voornaam || '').trim() || voornaamFromDisplayName(enriched?.customerDisplayName);
  const topic = String(topicHint || '').trim();
  const shopTail = meta.shopName ? ` bij ${meta.shopName}` : '';
  const looksEnglish = /\b(hi|hello|missing|order|placed|received|please|quickly|regards|br)\b/i.test(
    topic
  );
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
  const topicOrderish =
    /\b(bestell|order|verzend|lever|track|trace|pakket|zending|retour|ruil|annule|betaal|factuur|refund|ontvangen|shipment|delivered|invoice|cancel)\b/i.test(
      topic
    );
  const includeOrderBlock =
    asksRestockNl || asksShipmentNl || asksShipmentEn || topicOrderish;

  if (looksEnglish) {
    let enBody = `Hi ${name},

Thank you for your message — we've read it carefully.`;
    if (includeOrderBlock && enriched?.shopifyOrderName) {
      enBody += `\n\nWe've automatically matched your email to order ${enriched.shopifyOrderName}, so the details below are tailored to your purchase.`;
    }
    if (cleanTopic) {
      enBody += `\n\nWhat we picked up from your message: ${cleanTopic}.`;
    }
    if (includeOrderBlock && enriched?.shopifyOrderName) {
      const fs = enriched.displayFulfillmentStatus || enriched.fulfillmentStatus;
      const pay = enriched.displayFinancialStatus || enriched.financialStatus;
      enBody += '\n\n— Your order —';
      if (fs) enBody += `\n• Fulfillment: ${fs}.`;
      if (pay) enBody += `\n• Payment: ${pay}.`;
    }
    if (includeOrderBlock && enriched?.dpdTrackings?.length) {
      enBody += '\n\n— Shipping (DPD) —';
      for (const d of enriched.dpdTrackings) {
        enBody += `\n${formatDpdBlockForStandardReply(d)}\n`;
      }
    } else if (includeOrderBlock && enriched?.trackings?.some((t) => t && t.number)) {
      const t = enriched.trackings.find((x) => x.number);
      if (t) {
        enBody += `\n\n— Shipment —\n• ${t.company || 'Carrier'}: ${t.number}`;
        if (t.url) enBody += `\n• Track: ${t.url}`;
      }
    } else if (includeOrderBlock && enriched?.shopifyOrderName) {
      enBody +=
        '\n\nOnce your parcel ships, you will receive a tracking e-mail from us or the carrier — usually the same day.';
    }
    enBody += `\n\nIf anything is missing or unclear, just reply to this thread and we'll pick it up straight away (same working day when possible).

Kind regards${meta.shopName ? `\n${meta.shopName}` : ''}
Customer care`;

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
    if (asksShipmentEn || looksEnglish) {
      return `Hi ${name},

Thank you for your message.

We checked our order overview immediately, but we cannot yet match your request to one specific order. To share the exact live status, please reply with your order number (for example TOD12345) and the email address used when ordering.

As soon as we have that, we will send you the current shipping status right away.

Kind regards${meta.shopName ? `, ${meta.shopName}` : ''}
Support team`;
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

  if (includeOrderBlock && enriched?.dpdTrackings?.length) {
    body += '\n\n— Verzending (DPD) —';
    for (const d of enriched.dpdTrackings) {
      body += `\n${formatDpdBlockForStandardReply(d)}\n`;
    }
  } else if (includeOrderBlock && enriched?.trackings?.some((t) => t && t.number)) {
    const t = enriched.trackings.find((x) => x.number);
    if (t) {
      body += `\n\n— Verzending —\n• ${t.company || 'Vervoerder'}: ${t.number}`;
      if (t.url) body += `\n• Volgen: ${t.url}`;
      body += '.';
    }
  } else if (includeOrderBlock && enriched?.shopifyOrderName) {
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

const INTENT_BLOCK_NL = `
Intent (heel belangrijk):
- Lees eerst waar de mail écht over gaat.
- Gaat de mail over verzending, levering, "waar blijft mijn bestelling", track & trace, betaling/achteraf betalen, annuleren, retour, ruilen, of een concreet product uit een recente bestelling? Dan mag je order- en verzendcontext gebruiken zoals hieronder.
- Gaat de mail over iets anders (bijv. onderhoud, verf/materiaal, gebruik/advies, algemene productvraag, klacht zonder bestelcontext, openingstijden): antwoord direct op die inhoud. Noem ordernummer, Shopify-status of tracking dan alleen als dat de vraag echt verheldert.
- Zeg nooit dat je "de order niet kunt vinden", "geen order kunt matchen" of "geen bestelling ziet" als de klant helemaal niet naar een bestelling of levering vroeg. Dat is storend en onnodig.
- Forceer geen standaardzin over orderkoppeling als de vraag daar niet om vraagt.`;

const SYSTEM_NL = `Je bent de klantenservice van een webshop. Je schrijft een korte, vriendelijke e-mail in het Nederlands als antwoord op de inkomende vraag van de klant.
${INTENT_BLOCK_NL}
Regels:
- Gebruik alleen informatie uit de meegeleverde ordercontext en DPD-gegevens voor order-gerelateerde onderdelen van je antwoord. Vul geen verzonnen verzenddatums of tracking in.
- Als er nog geen tracking is of fulfillment "unfulfilled" is, zeg eerlijk dat de zending nog wordt voorbereid / nog niet verzonden is, zonder concrete dag te beloven tenzij die in de data staat — maar alleen als de klant over levering/verzending vraagt of als je die status kort moet verduidelijken bij een gecombineerde vraag.
- Als de context "productie / levertijd" met werkdagen en een indicatieve einddatum bevat: gebruik dat om uit te leggen dat maatwerk of productie tijd kost, en dat de klant tot die indicatieve datum mag verwachten tenzij er al tracking is. Geen harde belofte buiten wat in de context staat.
- Als er een DPD-tijdlijn staat: vat de laatste status samen en noem, als DPD dat zo meldt, het levervenster of de verwachte bezorgdag (alleen uit de meegeleverde regels — niets verzinnen).
- Als er wel een DPD-nummer of status is, noem het zendingsnummer helder (klant kan traceren op dpd.nl) wanneer de vraag over de zending gaat.
- Toon: professioneel, warm, kort (maximaal ~120 woorden in de body).
- Onderteken niet met een echte medewerkernaam tenzij die in de instructie staat; gebruik "Met vriendelijke groet" en de winkelnaam als die gegeven is.
- Als er "Instructies van de medewerker" staan (niet leeg), verwerk die inhoudelijk in je antwoord; herhaal ze niet als losse opsomming tenzij dat helpt.
- Antwoord ALLEEN als JSON-object met keys: "subject" (string), "body" (string, platte tekst met regeleindes). Geen markdown, geen code fences.`;

const SYSTEM_NL_NO_ORDER = `Je bent de klantenservice van een webshop. Je schrijft een korte, vriendelijke e-mail in het Nederlands als antwoord op de inkomende vraag van de klant.

Er is in onze systemen geen Shopify-bestelling automatisch gekoppeld aan deze mail: je hebt dus geen bevestigde orderstatus, geen tracking en geen leverdata uit de shop — en je mag die ook niet verzinnen.
${INTENT_BLOCK_NL}
Regels:
- Gebruik GEEN verzonnen ordernummers, bedragen, verzenddata of tracking.
- Als de klant wél expliciet vraagt naar status van een bestelling, verzending, track & trace, betaling/annulering/retour en je hebt geen orderdata: wees kort en vriendelijk; vraag dan om het ordernummer (zoals in de bevestigingsmail) en het e-mailadres waarmee besteld is, zodat het team het kan nakijken. Eén korte zin is genoeg; geen lange excuus-tekst.
- Als de klant niet om orderinformatie vraagt: antwoord alleen op de inhoud (advies, uitleg, doorverwijzen naar handleiding/montage, algemene productinfo). Geen paragraaf over "we kunnen je order niet vinden" en geen verzoek om ordernummer tenzij je zonder die gegevens echt niet verder kunt bij een bestel-gerelateerde vraag.
- Bij twijfel tussen "algemene vraag" en "bestelvraag": kies het meest behulpzame antwoord zonder onnodige orderfocus.
- Toon: professioneel, warm, kort (maximaal ~120 woorden in de body).
- Onderteken met "Met vriendelijke groet" en de winkelnaam als die in de context staat.
- Als er "Instructies van de medewerker" staan (niet leeg), verwerk die inhoudelijk; herhaal ze niet als losse opsomming tenzij dat helpt.
- Antwoord ALLEEN als JSON-object met keys: "subject" (string), "body" (string, platte tekst met regeleindes). Geen markdown, geen code fences.`;

/** @type {Record<string, string>} */
const REPLY_STYLE_EXTRA = {
  default: '',
  kort:
    '\n\nAanvullende instructie voor dit antwoord: Houd de body zeer kort (maximaal 60 woorden). Minimaal aantal alinea\'s.',
  formeel:
    '\n\nAanvullende instructie: Gebruik een formele aanhef (bijv. Geachte) en passende afsluiting. Blijf bij de feiten uit de ordercontext.',
  vriendelijk:
    '\n\nAanvullende instructie: Extra warme, persoonlijke toon; iets uitgebreider mag als het de klant helpt. Blijf professioneel en eerlijk over levertijden.',
  uitsluitend_feiten:
    '\n\nAanvullende instructie: Allen feiten uit de context; geen verzachtende beloftes. Wel een korte groet en afsluiting.',
  stappen:
    '\n\nAanvullende instructie: Structuur het antwoord met genummerde stappen (1., 2., …) waar nuttig. Maximaal ~150 woorden.',
  track_focus:
    '\n\nAanvullende instructie: Focus op verzendstatus en tracking: wat is de status, wat kan de klant doen (traceerlink/nummer) volgens de context.',
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
 * @param {{ shopName: string | null; orderContextBlock: string; incomingSubject?: string; incomingBody: string; replyStyle?: string | null; extraInstructions?: string | null; noOrderMatch?: boolean }} input
 */
export async function generateCustomerReplyDraft(input) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY ontbreekt in .env');
  }
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const styleKey = normalizeReplyStyle(input.replyStyle);
  const styleBlock = REPLY_STYLE_EXTRA[styleKey] || '';
  const noOrder = Boolean(input.noOrderMatch);
  const systemBase = noOrder ? SYSTEM_NL_NO_ORDER : SYSTEM_NL;

  const extra =
    typeof input.extraInstructions === 'string' && input.extraInstructions.trim()
      ? input.extraInstructions.trim()
      : '';

  const userMsg = [
    'Taak: beantwoord de onderstaande inkomende mail inhoudelijk en natuurlijk; volg de intent-regels uit het systeembericht (geen "order niet gevonden" als er niet om een bestelling werd gevraagd).',
    '',
    '--- Order- en verzendcontext (feiten; alleen gebruiken waar relevant) ---',
    input.orderContextBlock,
    '',
    '--- Inkomende mail van de klant ---',
    input.incomingSubject ? `Onderwerp: ${input.incomingSubject}` : '(geen onderwerp)',
    '',
    input.incomingBody.trim() || '(leeg bericht)',
    '',
    '--- Instructies van de medewerker (verwerk in het antwoord waar passend; negeer als leeg) ---',
    extra || '(geen extra instructies)',
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
        { role: 'system', content: systemBase + styleBlock },
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
