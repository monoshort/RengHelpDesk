import { withGmailRetry } from './mail.js';

/**
 * @param {{ name?: string; value?: string }[]} headers
 * @param {string} name
 */
function getHeader(headers, name) {
  if (!headers || !Array.isArray(headers)) return '';
  const h = headers.find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
  return h?.value ? String(h.value) : '';
}

/**
 * @param {string} data
 */
function decodeBodyData(data) {
  if (!data) return '';
  try {
    const buf = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Diepte-eerst door geneste multipart (mixed/alternative/related) — veel nieuwsbrieven en replies
 * hebben HTML niet op het eerste niveau.
 * @param {import('googleapis').gmail_v1.Schema$MessagePart | undefined | null} payload
 */
function extractHtmlOrPlain(payload) {
  if (!payload) return '';
  /** @type {string[]} */
  const htmlChunks = [];
  /** @type {string[]} */
  const plainChunks = [];

  /** @param {import('googleapis').gmail_v1.Schema$MessagePart | null | undefined} part */
  function walk(part) {
    if (!part) return;
    const mt = String(part.mimeType || '');
    if (mt === 'text/html' && part.body?.data) {
      const raw = decodeBodyData(part.body.data);
      if (raw) htmlChunks.push(raw);
    } else if (mt === 'text/plain' && part.body?.data) {
      const raw = decodeBodyData(part.body.data);
      if (raw) plainChunks.push(raw);
    }
    if (part.parts && Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  }

  walk(payload);
  if (htmlChunks.length) return htmlChunks[0];
  if (plainChunks.length) {
    return `<pre style="white-space:pre-wrap;font:inherit">${escHtml(plainChunks[0])}</pre>`;
  }
  return '';
}

/**
 * @param {string} s
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} fromHeader
 * @returns {{ name: string; email: string }}
 */
export function parseFromHeader(fromHeader) {
  const raw = fromHeader.trim();
  const m = raw.match(/<?([^\s<>]+@[^\s<>]+)>?\s*$/);
  const email = m ? m[1] : raw.includes('@') ? raw.replace(/^.*<|>.*$/g, '').trim() : '';
  let name = raw;
  if (raw.includes('<')) {
    name = raw.replace(/<[^>]+>\s*$/, '').trim();
    name = name.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  } else if (email) {
    name = email.split('@')[0];
  }
  if (!name) name = email || '(onbekend)';
  return { name, email: email || raw };
}

/**
 * @param {number} internalMs
 */
function groupForDate(internalMs) {
  const d = new Date(internalMs);
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.floor((dayStart(now) - dayStart(d)) / 86400000);
  if (diff === 0) return 'Vandaag';
  if (diff < 7) return 'Deze week';
  if (diff < 14) return 'Vorige week';
  return 'Eerder';
}

/**
 * @param {number} internalMs
 */
function formatListTime(internalMs) {
  const d = new Date(internalMs);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'numeric' });
}

/**
 * Inbox van het gekoppelde Gmail-account (per ingelogde gebruiker indien gekoppeld).
 * @param {{ req?: import('express').Request; maxResults?: number; labelIds?: string[]; q?: string }} opts
 */
export async function fetchInboxForUi(opts = {}) {
  return withGmailRetry(opts.req, async ({ gmail }) => {
  const maxResults = Math.min(100, Math.max(1, Number(opts.maxResults) || 40));
  const labelIds = opts.labelIds || ['INBOX'];
  const q = typeof opts.q === 'string' ? opts.q.trim() : '';

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds,
    maxResults,
    q: q || undefined,
  });

  const refs = listRes.data.messages || [];
  if (refs.length === 0) {
    return { messages: [], resultSizeEstimate: listRes.data.resultSizeEstimate ?? 0 };
  }

  const messages = [];
  const concurrency = 6;
  for (let i = 0; i < refs.length; i += concurrency) {
    const chunk = refs.slice(i, i + concurrency);
    const batch = await Promise.all(
      chunk.map(async (ref) => {
        const id = ref.id;
        if (!id) return null;
        const full = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        });
        const msg = full.data;
        const internalMs = Number(msg.internalDate || Date.now());
        const headers = msg.payload?.headers || [];
        const fromH = getHeader(headers, 'From');
        const subj = getHeader(headers, 'Subject') || '(geen onderwerp)';
        const { name, email } = parseFromHeader(fromH);
        const snippet = msg.snippet || '';
        const body = extractHtmlOrPlain(msg.payload) || `<p>${escHtml(snippet)}</p>`;

        return {
          id,
          threadId: msg.threadId || undefined,
          group: groupForDate(internalMs),
          from: name,
          email: email || '—',
          subject: subj,
          snippet,
          time: formatListTime(internalMs),
          hasTemplate: false,
          body,
          internalDate: internalMs,
        };
      })
    );
    for (const m of batch) {
      if (m) messages.push(m);
    }
  }

  messages.sort((a, b) => b.internalDate - a.internalDate);

  return {
    messages,
    resultSizeEstimate: listRes.data.resultSizeEstimate ?? messages.length,
  };
  });
}
