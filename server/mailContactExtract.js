/**
 * Haalt het echte klant-e-mailadres uit mailtekst (contactformulier, forward, test naar info@…).
 * Shop-/roladressen (info@eigen-domein) worden alleen gebruikt als er geen beter adres in de tekst staat.
 */

/** @param {string} raw */
function defaultShopDomainsFromEnv(raw) {
  const s = String(raw || '').trim();
  if (!s) return ['toddie.nl'];
  return s
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} email
 * @param {string[] | undefined} shopDomains — weglaatbaar: dan uit MAIL_SHOP_CUSTOMER_DOMAINS / toddie.nl
 */
export function shouldDiscardCustomerEmail(email, shopDomains) {
  const lower = String(email || '')
    .trim()
    .toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return true;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (/^(mailer-daemon|postmaster|noreply|no-reply)@/i.test(lower)) return true;
  const domains =
    shopDomains && shopDomains.length
      ? shopDomains.map((d) => d.toLowerCase())
      : defaultShopDomainsFromEnv(process.env.MAIL_SHOP_CUSTOMER_DOMAINS);
  const onShop = domains.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (onShop) {
    if (
      /^(info|contact|support|sales|service|team|orders|webshop|hello|admin|noreply|no-reply|verzend|shipping|factuur|billing)$/i.test(
        local
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function uniqueEmailsFromText(text) {
  const s = String(text || '');
  const raw = s.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const x of raw) {
    const e = x.toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/**
 * @param {string} text
 * @param {string[]} candidates niet-lege kandidaten
 */
function pickEmailByNearbyKeywords(text, candidates) {
  const lines = String(text || '').split(/\n/);
  /** @type {{ e: string; score: number }[]} */
  const scored = [];
  for (const e of candidates) {
    let score = 0;
    const needle = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(needle, 'i');
    for (const line of lines) {
      if (!re.test(line)) continue;
      const L = line.toLowerCase();
      if (/(^|\b)(van|from|e-?mail|reply-to|afzender|email|uw\s+e-?mail)\b/i.test(L)) score += 55;
      if (/mailto:/i.test(L)) score += 22;
      if (/(bestel|order|vraag|contact|bericht)/i.test(L)) score += 8;
    }
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].e : '';
}

/**
 * @param {{ text: string; fallbackEmail?: string; fallbackName?: string; replyTo?: string; shopDomains?: string[] }} opts
 * @returns {{ email: string; name: string }}
 */
export function extractCustomerContactFromText(opts) {
  const shopDomains = opts.shopDomains?.length
    ? opts.shopDomains.map((d) => d.toLowerCase())
    : defaultShopDomainsFromEnv(process.env.MAIL_SHOP_CUSTOMER_DOMAINS);
  const text = String(opts.text || '');
  const fallbackEmail = String(opts.fallbackEmail || '').trim().toLowerCase();
  let name = String(opts.fallbackName || '').trim();
  const replyTo = String(opts.replyTo || '')
    .trim()
    .replace(/^.*<([^>]+@[^>]+)>.*/, '$1')
    .trim();

  let email = '';

  if (replyTo.includes('@') && !shouldDiscardCustomerEmail(replyTo, shopDomains)) {
    email = replyTo.toLowerCase();
  }

  const allInBody = uniqueEmailsFromText(text);
  const good = allInBody.filter((e) => !shouldDiscardCustomerEmail(e, shopDomains));

  if (!email && good.length === 1) {
    email = good[0];
  } else if (!email && good.length > 1) {
    const picked = pickEmailByNearbyKeywords(text, good);
    email = picked || good[0];
  }

  if (!email && fallbackEmail.includes('@')) {
    if (!shouldDiscardCustomerEmail(fallbackEmail, shopDomains)) {
      email = fallbackEmail;
    }
  }

  if (!email && fallbackEmail.includes('@')) {
    email = fallbackEmail;
  }

  const directName = text.match(/(?:^|\n)\s*Naam:\s*([^\n]+)/i);
  const fromName = text.match(/(?:^|\n)\s*(?:Van|From):\s*["']?([^"'\n<]+)["']?\s*(?:<|$)/i);
  const fromName2 = text.match(/(?:^|\n)\s*(?:Van|From):\s*([^<\n]+)\s*</i);
  const signName = text.match(
    /(?:groet(?:en)?|met vriendelijke groet|mvg|br)[,\s]*\n+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,48})/i
  );
  const pickedName =
    (directName?.[1] || fromName?.[1] || fromName2?.[1] || signName?.[1] || '').trim();
  if (pickedName && (!name || /toddie|shop|support|team|klantenservice|info@/i.test(name))) {
    name = pickedName.replace(/\s+/g, ' ').trim();
  }

  return { email: email || '', name: name || '' };
}
