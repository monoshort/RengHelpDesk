/**
 * Microsoft Graph mail-smoke (geen secrets in output).
 * npm run mail:doctor:graph
 *
 * Optioneel: GRAPH_SMOKE_DENY_MAILBOX=ander@toddie.nl (verwacht 403/404)
 * GRAPH_SMOKE_SEND_TO=jouw@mail.nl (stuurt één testmail; anders wordt verzenden overgeslagen)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const {
  isGraphMailConfigured,
  graphConnectionHints,
  graphRequest,
  graphUserPath,
  getGraphMailbox,
  sendGraphMail,
} = await import('../server/graphMail.js');

process.stdout.write('--- Microsoft Graph mail diagnose ---\n');

if (!isGraphMailConfigured()) {
  const { hints } = graphConnectionHints();
  process.stdout.write('Graph niet volledig geconfigureerd.\n');
  for (const h of hints) process.stdout.write(`  • ${h}\n`);
  process.exit(2);
}

const mailbox = getGraphMailbox();
process.stdout.write(`Mailbox: ${mailbox}\n`);
process.stdout.write(
  `Tenant/client: ${process.env.MICROSOFT_GRAPH_TENANT_ID ? 'gezet' : '—'} / ${process.env.MICROSOFT_GRAPH_CLIENT_ID ? 'gezet' : '—'}\n`
);
process.stdout.write(`Secret: ${process.env.MICROSOFT_GRAPH_CLIENT_SECRET ? 'gezet' : 'ONTBREEKT'}\n\n`);

/** @type {string[]} */
const ok = [];
/** @type {string[]} */
const skip = [];
/** @type {string[]} */
const fail = [];

function pass(label) {
  ok.push(label);
  process.stdout.write(`OK  — ${label}\n`);
}
function skipNote(label, reason) {
  skip.push(`${label}: ${reason}`);
  process.stdout.write(`SKIP — ${label}: ${reason}\n`);
}
function die(label, e) {
  const msg = e instanceof Error ? e.message : String(e);
  fail.push(`${label}: ${msg}`);
  process.stdout.write(`FAIL — ${label}: ${msg}\n`);
}

try {
  const base = graphUserPath(mailbox);
  const listRes = await graphRequest(
    `${base}/mailFolders/inbox/messages?$top=5&$select=id,subject,hasAttachments,receivedDateTime`
  );
  const items = /** @type {{ value?: unknown[] }} */ (listRes.data)?.value || [];
  pass(`Inbox lezen (${items.length} bericht(en) opgehaald)`);

  const denyMb = process.env.GRAPH_SMOKE_DENY_MAILBOX?.trim();
  if (denyMb) {
    try {
      await graphRequest(`${graphUserPath(denyMb)}/mailFolders/inbox/messages?$top=1`);
      die(`RBAC: geen toegang tot ${denyMb}`, new Error('verwacht 403/404, maar request slaagde'));
    } catch (e) {
      const st = /** @type {{ status?: number }} */ (e).status;
      if (st === 403 || st === 404) {
        pass(`RBAC: geen toegang tot ${denyMb} (${st})`);
      } else {
        die(`RBAC-check ${denyMb}`, e);
      }
    }
  } else {
    skipNote('RBAC negatief', 'zet GRAPH_SMOKE_DENY_MAILBOX om ander postvak te testen');
  }

  const withAtt = items.find((m) => {
    const row = /** @type {Record<string, unknown>} */ (m);
    return row.hasAttachments === true && typeof row.id === 'string';
  });
  if (withAtt && typeof /** @type {Record<string, unknown>} */ (withAtt).id === 'string') {
    const mid = /** @type {Record<string, unknown>} */ (withAtt).id;
    const attRes = await graphRequest(
      `${base}/messages/${encodeURIComponent(String(mid))}/attachments?$top=3&$select=id,name,size`
    );
    const atts = /** @type {{ value?: unknown[] }} */ (attRes.data)?.value || [];
    if (atts.length) {
      const first = /** @type {Record<string, unknown>} */ (atts[0]);
      pass(`Bijlagen (${atts.length} op bericht; eerste: ${first.name || first.id})`);
    } else {
      skipNote('Bijlagen', 'hasAttachments=true maar lijst leeg');
    }
  } else {
    skipNote('Bijlagen', 'geen bericht met bijlage in eerste 5 inbox-berichten');
  }

  const markTarget = items.find((m) => typeof /** @type {Record<string, unknown>} */ (m).id === 'string');
  if (markTarget) {
    const mid = String(/** @type {Record<string, unknown>} */ (markTarget).id);
    await graphRequest(`${base}/messages/${encodeURIComponent(mid)}`, {
      method: 'PATCH',
      body: { isRead: true },
    });
    await graphRequest(`${base}/messages/${encodeURIComponent(mid)}`, {
      method: 'PATCH',
      body: { isRead: false },
    });
    pass('Markeren (isRead true → false teruggezet)');
  } else {
    skipNote('Markeren', 'geen bericht om te patchen');
  }

  const foldersRes = await graphRequest(`${base}/mailFolders?$top=50&$select=id,displayName`);
  const folders = /** @type {{ value?: { id?: string; displayName?: string }[] }} */ (
    foldersRes.data
  )?.value;
  const inbox = folders?.find((f) => String(f.displayName).toLowerCase() === 'inbox');
  const archive =
    folders?.find((f) => String(f.displayName).toLowerCase() === 'archive') ||
    folders?.find((f) => String(f.displayName).toLowerCase() === 'archief');
  const moveTarget = archive || inbox;
  if (markTarget && moveTarget?.id && inbox?.id && archive?.id) {
    const mid = String(/** @type {Record<string, unknown>} */ (markTarget).id);
    await graphRequest(`${base}/messages/${encodeURIComponent(mid)}/move`, {
      method: 'POST',
      body: { destinationId: archive.id },
    });
    await graphRequest(`${base}/messages/${encodeURIComponent(mid)}/move`, {
      method: 'POST',
      body: { destinationId: inbox.id },
    });
    pass('Verplaatsen (inbox → archive → inbox)');
  } else if (markTarget && moveTarget?.id) {
    skipNote('Verplaatsen', 'alleen inbox-map gevonden (geen Archive/Archief-map)');
  } else {
    skipNote('Verplaatsen', 'geen bericht of mappen');
  }

  const sendTo = process.env.GRAPH_SMOKE_SEND_TO?.trim();
  if (sendTo) {
    await sendGraphMail({
      to: sendTo,
      subject: `[RengHelpDesk] Graph smoke ${new Date().toISOString()}`,
      text: 'Automatische testmail — mag verwijderd worden.',
      from: mailbox,
    });
    pass(`Verzenden naar ${sendTo}`);
  } else {
    skipNote(
      'Verzenden',
      'zet GRAPH_SMOKE_SEND_TO=jouw@adres.nl voor een echte send-test'
    );
  }
} catch (e) {
  die('Graph API', e);
}

process.stdout.write('\n--- Samenvatting ---\n');
process.stdout.write(`Geslaagd: ${ok.length}\n`);
if (skip.length) process.stdout.write(`Overgeslagen: ${skip.length}\n`);
if (fail.length) {
  process.stdout.write(`Mislukt: ${fail.length}\n`);
  process.exit(1);
}
process.exit(0);
