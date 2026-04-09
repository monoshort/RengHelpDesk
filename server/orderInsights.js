/**
 * Helpdesk-hints op basis van orderrij + Shopify timeline (zelfde heuristiek als de mail-kolom).
 * @param {string} description
 * @param {string | null | undefined} author
 * @returns {{ kind: string }}
 */
export function classifyTimelineKind(description, author) {
  const d = String(description || '').toLowerCase();
  const auth = String(author || '').trim().toLowerCase();
  if (
    /order\s+confirmation|orderbevestiging|bevestiging.*bestelling|confirmation\s+email\s+was\s+sent/.test(
      d
    )
  ) {
    return { kind: 'order' };
  }
  if (
    /shipping\s+confirmation|verzend(bevestiging|mail)|delivery\s+confirmation|verzonden.*(email|e-mail)/.test(
      d
    ) ||
    /sendcloud.*(shipping|verzend)/.test(d) ||
    (auth.includes('sendcloud') && /email|e-mail|verzend|shipping/.test(d))
  ) {
    return { kind: 'shipping' };
  }
  if (/refund|terugbetaling|restitutie|refunded/.test(d)) return { kind: 'refund' };
  if (/invoice|factuur|vat\s+invoice|\binv-/.test(d)) return { kind: 'invoice' };
  if (/pickup|afhalen|ready\s+for\s+pickup|afhaal/.test(d)) return { kind: 'pickup' };
  if (/gift\s*card|cadeaubon|cadeaukaart/.test(d)) return { kind: 'gift' };
  if (/draft\s+order|concept|offerte/.test(d)) return { kind: 'draft' };
  if (/cancel|annulering|geannuleerd/.test(d)) return { kind: 'cancel' };
  return { kind: 'other' };
}

/** @param {Array<{ description: string; author?: string | null }>} logs */
export function mailKindsFromLogs(logs) {
  const kinds = new Set();
  for (const e of logs || []) {
    kinds.add(classifyTimelineKind(e.description, e.author).kind);
  }
  return kinds;
}

/**
 * @param {Record<string, unknown>} row dashboardrij (na DPD-enrichment)
 * @param {Array<{ description: string; author?: string | null }>} logs
 * @returns {string | null}
 */
export function deskHintForRow(row, logs) {
  const kinds = mailKindsFromLogs(logs);
  const ful = String(row.displayFulfillmentStatus || row.fulfillmentStatus || '').toLowerCase();
  const hasTracking = Array.isArray(row.trackings) && row.trackings.some((t) => t.number);
  const dpdIssue =
    Array.isArray(row.dpdTrackings) && row.dpdTrackings.some((d) => d && d.error);

  const noTimeline = Boolean(row.customerEmail) && (!logs || logs.length === 0);
  const productionWait =
    kinds.has('order') &&
    !kinds.has('shipping') &&
    !kinds.has('pickup') &&
    (ful === 'unfulfilled' || ful === 'partial' || ful === '');
  const shipState = ful === 'fulfilled' || ful === 'partial' || hasTracking;
  const fulfilledNoShipMail =
    shipState && !kinds.has('shipping') && !kinds.has('pickup') && !productionWait;

  /** @type {string[]} */
  const hints = [];
  if (row.testOrder) hints.push('Testorder');
  if (row.canceledAt) hints.push('Geannuleerd');
  if (noTimeline) hints.push('Geen klantmail in timeline');
  if (productionWait) hints.push('Orderbevestiging — nog geen verzendmail');
  if (fulfilledNoShipMail) hints.push('Verzending/track zonder verzendmail in timeline');
  if (dpdIssue) hints.push('DPD-status niet opgehaald');
  const fin = String(row.displayFinancialStatus || row.financialStatus || '').toLowerCase();
  if (fin.includes('pending') || fin === 'authorized' || fin === 'partially_paid') {
    hints.push('Betaling nog niet voltooid');
  }

  if (!hints.length) return null;
  return [...new Set(hints)].join(' · ');
}

/**
 * @param {Record<string, unknown>[]} enrichedRows
 * @param {Record<string, Array<{ description: string; author?: string | null }>>} orderMailLogs
 */
export function computeDeskHeuristics(enrichedRows, orderMailLogs) {
  /** @type {{ noTimelineMail: number; productionWait: number; fulfilledNoShipMail: number; dpdIssues: number; testOrders: number; withHint: number }} */
  const counts = {
    noTimelineMail: 0,
    productionWait: 0,
    fulfilledNoShipMail: 0,
    dpdIssues: 0,
    testOrders: 0,
    withHint: 0,
  };
  /** @type {Array<{ orderName: string; customerEmail: string | null; deskHint: string }>} */
  const samples = [];

  for (const r of enrichedRows) {
    const logs = orderMailLogs[String(r.shopifyOrderId)] || [];
    const kinds = mailKindsFromLogs(logs);
    const ful = String(r.displayFulfillmentStatus || r.fulfillmentStatus || '').toLowerCase();
    const hasTracking = Array.isArray(r.trackings) && r.trackings.some((t) => t.number);
    const dpdIssue =
      Array.isArray(r.dpdTrackings) && r.dpdTrackings.some((d) => d && d.error);

    if (r.customerEmail && logs.length === 0) counts.noTimelineMail++;
    if (
      kinds.has('order') &&
      !kinds.has('shipping') &&
      !kinds.has('pickup') &&
      (ful === 'unfulfilled' || ful === 'partial' || ful === '')
    ) {
      counts.productionWait++;
    }
    const shipState = ful === 'fulfilled' || ful === 'partial' || hasTracking;
    const productionWait =
      kinds.has('order') &&
      !kinds.has('shipping') &&
      !kinds.has('pickup') &&
      (ful === 'unfulfilled' || ful === 'partial' || ful === '');
    if (shipState && !kinds.has('shipping') && !kinds.has('pickup') && !productionWait) {
      counts.fulfilledNoShipMail++;
    }
    if (dpdIssue) counts.dpdIssues++;
    if (r.testOrder) counts.testOrders++;

    const hint = deskHintForRow(r, logs);
    if (hint) {
      counts.withHint++;
      if (samples.length < 10) {
        samples.push({
          orderName: String(r.shopifyOrderName || ''),
          customerEmail: r.customerEmail ? String(r.customerEmail) : null,
          deskHint: hint,
        });
      }
    }
  }

  return { counts, samples };
}
