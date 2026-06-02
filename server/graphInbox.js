import { graphRequest, graphUserPath, getGraphMailbox } from './graphMail.js';
import { parseFromHeader } from './gmailInbox.js';

/** @type {Record<string, string>} */
const FOLDER_LABELS_NL = {
  inbox: 'Postvak IN',
  sentitems: 'Verzonden items',
  drafts: 'Concepten',
  deleteditems: 'Verwijderde items',
  junkemail: 'Ongewenste e-mail',
  archive: 'Archief',
};

const WELL_KNOWN_FOLDERS = [
  'inbox',
  'sentitems',
  'drafts',
  'archive',
  'deleteditems',
  'junkemail',
];

const LIST_SELECT =
  'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments';

/** Headers voor Graph-zoekacties / contains op message body. */
const GRAPH_SEARCH_HEADERS = { ConsistencyLevel: 'eventual' };

/**
 * @param {string} s
 */
function escapeODataLiteral(s) {
  return String(s || '').replace(/'/g, "''");
}

/**
 * @param {string} s
 */
function escapeKqlSearchTerm(s) {
  return String(s || '')
    .trim()
    .replace(/"/g, '')
    .slice(0, 200);
}

/**
 * @param {string} base — users/{mailbox}
 * @param {string} folderId
 * @param {string} folderWellKnown
 */
function graphMessagesCollectionPath(base, folderId, folderWellKnown) {
  if (folderId) {
    return `${base}/mailFolders/${encodeURIComponent(folderId)}/messages`;
  }
  const fk = String(folderWellKnown || 'inbox').trim().toLowerCase() || 'inbox';
  return `${base}/mailFolders/${encodeURIComponent(fk)}/messages`;
}

/**
 * Graph: $search (onderwerp, body, afzender) — bodyPreview is niet filterbaar.
 * @param {string} messagesPath
 * @param {string} q
 * @param {number} maxResults
 */
async function graphListMessagesBySearch(messagesPath, q, maxResults) {
  const term = escapeKqlSearchTerm(q);
  if (!term) {
    throw new Error('Lege zoekterm.');
  }
  const searchParam = encodeURIComponent(`"${term}"`);
  const path = `${messagesPath}?$search=${searchParam}&$top=${maxResults}&$select=${LIST_SELECT}`;
  return graphRequest(path, { headers: GRAPH_SEARCH_HEADERS });
}

/**
 * Fallback: $filter op subject en body/content (niet bodyPreview).
 * @param {string} messagesPath
 * @param {string} q
 * @param {number} maxResults
 */
async function graphListMessagesByFilter(messagesPath, q, maxResults) {
  const lit = escapeODataLiteral(q);
  const filterExpr = `contains(subject,'${lit}') or contains(body/content,'${lit}')`;
  const path = `${messagesPath}?$filter=${encodeURIComponent(filterExpr)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=${LIST_SELECT}`;
  return graphRequest(path, { headers: GRAPH_SEARCH_HEADERS });
}

/**
 * Laatste fallback: alleen onderwerp.
 * @param {string} messagesPath
 * @param {string} q
 * @param {number} maxResults
 */
async function graphListMessagesBySubjectFilter(messagesPath, q, maxResults) {
  const lit = escapeODataLiteral(q);
  const filterExpr = `contains(subject,'${lit}')`;
  const path = `${messagesPath}?$filter=${encodeURIComponent(filterExpr)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=${LIST_SELECT}`;
  return graphRequest(path, { headers: GRAPH_SEARCH_HEADERS });
}

/**
 * @param {string} messagesPath
 * @param {string} q
 * @param {number} maxResults
 */
async function graphListMessagesForQuery(messagesPath, q, maxResults) {
  const errors = [];
  try {
    return await graphListMessagesBySearch(messagesPath, q, maxResults);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    return await graphListMessagesByFilter(messagesPath, q, maxResults);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    return await graphListMessagesBySubjectFilter(messagesPath, q, maxResults);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  throw new Error(
    `Zoeken in mailbox mislukt. ${errors[errors.length - 1] || 'Onbekende fout'}`.slice(0, 400)
  );
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
 * @param {{ contentType?: string; content?: string } | undefined | null} body
 * @param {string} snippet
 */
function bodyFromGraph(body, snippet) {
  const ct = String(body?.contentType || '').toLowerCase();
  const content = body?.content ? String(body.content) : '';
  if (content) {
    if (ct === 'html' || content.includes('<')) return content;
    return `<pre style="white-space:pre-wrap;font:inherit">${escHtml(content)}</pre>`;
  }
  if (snippet) return `<p style="white-space:pre-wrap">${escHtml(snippet)}</p>`;
  return '';
}

/** @param {string} nextLink */
export function encodeGraphPageToken(nextLink) {
  return Buffer.from(nextLink, 'utf8').toString('base64url');
}

/** @param {string} token */
export function decodeGraphPageToken(token) {
  return Buffer.from(token, 'base64url').toString('utf8');
}

/**
 * @param {unknown} recipients
 */
function formatRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map((r) => {
      const row = /** @type {{ emailAddress?: { name?: string; address?: string } }} */ (r);
      const name = row.emailAddress?.name || '';
      const addr = row.emailAddress?.address || '';
      if (name && addr) return `${name} <${addr}>`;
      return addr || name || '';
    })
    .filter(Boolean);
}

/**
 * @param {string} wellKnown
 * @param {string} [displayName]
 */
function folderLabel(wellKnown, displayName) {
  return FOLDER_LABELS_NL[wellKnown] || displayName || wellKnown;
}

export async function fetchGraphFoldersForUi() {
  const base = graphUserPath(getGraphMailbox());
  /** @type {Array<{ id: string; wellKnown: string; displayName: string; totalCount: number; unreadCount: number }>} */
  const folders = [];

  await Promise.all(
    WELL_KNOWN_FOLDERS.map(async (wellKnown) => {
      try {
        const res = await graphRequest(
          `${base}/mailFolders/${wellKnown}?$select=id,displayName,totalItemCount,unreadItemCount`
        );
        const data = /** @type {Record<string, unknown>} */ (res.data);
        const id = typeof data.id === 'string' ? data.id : '';
        if (!id) return;
        folders.push({
          id,
          wellKnown,
          displayName: folderLabel(wellKnown, String(data.displayName || '')),
          totalCount: Number(data.totalItemCount) || 0,
          unreadCount: Number(data.unreadItemCount) || 0,
        });
      } catch {
        /* map niet beschikbaar */
      }
    })
  );

  const order = new Map(WELL_KNOWN_FOLDERS.map((k, i) => [k, i]));
  folders.sort((a, b) => (order.get(a.wellKnown) ?? 99) - (order.get(b.wellKnown) ?? 99));
  return { folders };
}

/**
 * @param {Record<string, unknown>} row
 */
function mapGraphListRow(row) {
  const id = typeof row.id === 'string' ? row.id : '';
  if (!id) return null;

  const received = typeof row.receivedDateTime === 'string' ? row.receivedDateTime : '';
  const internalMs = received ? Date.parse(received) : Date.now();
  const fromObj = /** @type {{ emailAddress?: { name?: string; address?: string } }} */ (row.from);
  const fromName = fromObj?.emailAddress?.name || '';
  const fromAddr = fromObj?.emailAddress?.address || '';
  const fromH =
    fromName && fromAddr ? `${fromName} <${fromAddr}>` : fromAddr || fromName || '';
  const { name, email } = parseFromHeader(fromH);
  const subj =
    typeof row.subject === 'string' && row.subject.trim()
      ? row.subject.trim()
      : '(geen onderwerp)';
  const snippet = typeof row.bodyPreview === 'string' ? row.bodyPreview : '';
  const body = snippet
    ? `<p style="white-space:pre-wrap">${escHtml(snippet)}</p>`
    : '<p style="color:var(--muted)">Open het bericht om de volledige inhoud te laden.</p>';

  return {
    id,
    threadId: typeof row.conversationId === 'string' ? row.conversationId : undefined,
    group: groupForDate(internalMs),
    from: name,
    email: email || '—',
    subject: subj,
    snippet,
    time: formatListTime(internalMs),
    hasTemplate: false,
    body,
    bodyIsPreview: true,
    internalDate: internalMs,
    isRead: Boolean(row.isRead),
    hasAttachments: Boolean(row.hasAttachments),
  };
}

/**
 * @param {{ maxResults?: number; q?: string; pageToken?: string; folderId?: string; folder?: string }} [opts]
 */
export async function fetchGraphInboxForUi(opts = {}) {
  const mailbox = getGraphMailbox();
  const cap = Math.min(
    250,
    Math.max(1, Number(process.env.MAIL_INBOX_PAGE_SIZE || '') || 100)
  );
  const maxResults = Math.min(cap, Math.max(1, Number(opts.maxResults) || cap));
  const q = typeof opts.q === 'string' ? opts.q.trim() : '';
  const pageToken = typeof opts.pageToken === 'string' ? opts.pageToken.trim() : '';
  const folderId = typeof opts.folderId === 'string' ? opts.folderId.trim() : '';
  const folderWellKnown =
    typeof opts.folder === 'string' && opts.folder.trim()
      ? opts.folder.trim().toLowerCase()
      : 'inbox';
  const base = graphUserPath(mailbox);

  let listRes;
  if (pageToken) {
    const listPath = decodeGraphPageToken(pageToken);
    listRes = await graphRequest(listPath, { headers: GRAPH_SEARCH_HEADERS });
  } else if (q) {
    const messagesPath = graphMessagesCollectionPath(base, folderId, folderWellKnown);
    listRes = await graphListMessagesForQuery(messagesPath, q, maxResults);
  } else {
    const folderSeg = folderId
      ? `mailFolders/${encodeURIComponent(folderId)}`
      : `mailFolders/${encodeURIComponent(folderWellKnown)}`;
    const listPath = `${base}/${folderSeg}/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=${LIST_SELECT}`;
    listRes = await graphRequest(listPath);
  }
  const listData = /** @type {{ value?: unknown[]; '@odata.nextLink'?: string }} */ (listRes.data);
  const refs = Array.isArray(listData?.value) ? listData.value : [];
  const nextLink =
    typeof listData?.['@odata.nextLink'] === 'string' ? listData['@odata.nextLink'] : '';

  const messages = [];
  for (const ref of refs) {
    const m = mapGraphListRow(/** @type {Record<string, unknown>} */ (ref));
    if (m) messages.push(m);
  }

  messages.sort((a, b) => b.internalDate - a.internalDate);

  return {
    messages,
    resultSizeEstimate: messages.length,
    nextPageToken: nextLink ? encodeGraphPageToken(nextLink) : undefined,
    hasMore: Boolean(nextLink),
    folder: folderWellKnown,
    folderId: folderId || undefined,
    pageSize: maxResults,
  };
}

/**
 * @param {string} messageId
 */
export async function fetchGraphMessageAttachments(messageId) {
  const id = String(messageId || '').trim();
  const base = graphUserPath(getGraphMailbox());
  const res = await graphRequest(
    `${base}/messages/${encodeURIComponent(id)}/attachments?$top=50&$select=id,name,size,contentType,isInline`
  );
  const items = /** @type {{ value?: unknown[] }} */ (res.data)?.value || [];
  return items
    .map((a) => {
      const row = /** @type {Record<string, unknown>} */ (a);
      const attId = typeof row.id === 'string' ? row.id : '';
      if (!attId) return null;
      return {
        id: attId,
        name: typeof row.name === 'string' ? row.name : 'bijlage',
        size: Number(row.size) || 0,
        contentType: typeof row.contentType === 'string' ? row.contentType : '',
        isInline: Boolean(row.isInline),
      };
    })
    .filter(Boolean);
}

/**
 * @param {string} messageId
 * @param {string} attachmentId
 */
export async function fetchGraphAttachmentBytes(messageId, attachmentId) {
  const base = graphUserPath(getGraphMailbox());
  const res = await graphRequest(
    `${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  const data = /** @type {Record<string, unknown>} */ (res.data);
  const name = typeof data.name === 'string' ? data.name : 'attachment';
  const contentType =
    typeof data.contentType === 'string' ? data.contentType : 'application/octet-stream';
  const bytes = typeof data.contentBytes === 'string' ? data.contentBytes : '';
  if (!bytes) throw new Error('Bijlage heeft geen inhoud.');
  return { name, contentType, buffer: Buffer.from(bytes, 'base64') };
}

/**
 * @param {string} messageId
 */
export async function fetchGraphMessageForUi(messageId) {
  const id = String(messageId || '').trim();
  if (!id) throw new Error('messageId ontbreekt.');
  const base = graphUserPath(getGraphMailbox());
  const fullRes = await graphRequest(
    `${base}/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,ccRecipients,replyTo,receivedDateTime,body,bodyPreview,conversationId,isRead,hasAttachments`
  );
  const msg = /** @type {Record<string, unknown>} */ (fullRes.data);
  const row = mapGraphListRow(msg);
  if (!row) throw new Error('Bericht niet gevonden.');
  const snippet = typeof msg.bodyPreview === 'string' ? msg.bodyPreview : '';
  const to = formatRecipients(msg.toRecipients);
  const cc = formatRecipients(msg.ccRecipients);
  const replyTo = formatRecipients(msg.replyTo);
  let attachments = [];
  if (row.hasAttachments) {
    try {
      attachments = await fetchGraphMessageAttachments(id);
    } catch {
      attachments = [];
    }
  }
  return {
    ...row,
    body: bodyFromGraph(
      /** @type {{ contentType?: string; content?: string }} */ (msg.body),
      snippet
    ),
    bodyIsPreview: false,
    to,
    cc,
    replyTo: replyTo[0] || undefined,
    attachments,
  };
}

/**
 * @param {string} messageId
 * @param {boolean} isRead
 */
export async function patchGraphMessageRead(messageId, isRead) {
  const base = graphUserPath(getGraphMailbox());
  await graphRequest(`${base}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: { isRead },
  });
}
