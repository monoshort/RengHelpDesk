const BASE_LIVE = 'https://wsshipper.dpd.nl';
const BASE_STAGE = 'https://wsshippertest.dpd.nl';

let cached = null;

function baseUrl(useStage) {
  return useStage ? BASE_STAGE : BASE_LIVE;
}

function parseExpiry(iso) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {{ delisId: string, password: string, useStage: boolean }} creds
 * @returns {Promise<{ delisId: string, authToken: string }>}
 */
export async function getDpdAuth(creds) {
  const now = Date.now();
  const marginMs = 5 * 60 * 1000;
  if (
    cached &&
    cached.delisId === creds.delisId &&
    cached.expiresAt > now + marginMs
  ) {
    return { delisId: cached.delisId, authToken: cached.authToken };
  }

  const url = `${baseUrl(creds.useStage)}/rest/services/LoginService/V2_1/getAuth`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      delisId: creds.delisId,
      password: creds.password,
      messageLanguage: 'nl_NL',
    }),
  });

  const data = await res.json().catch(() => ({}));
  const ret = data?.getAuthResponse?.return;
  if (!res.ok || !ret?.authToken) {
    const msg =
      data?.status?.message ||
      data?.fault?.faultstring ||
      `DPD login failed (${res.status})`;
    throw new Error(msg);
  }

  cached = {
    delisId: ret.delisId || creds.delisId,
    authToken: ret.authToken,
    expiresAt: parseExpiry(ret.authTokenExpires) || now + 23 * 60 * 60 * 1000,
  };
  return { delisId: cached.delisId, authToken: cached.authToken };
}

/**
 * @param {object} opts
 * @param {{ delisId: string, password: string, useStage: boolean }} opts.creds
 * @param {string} opts.parcelLabelNumber
 */
export async function getDpdTracking(opts) {
  const auth = await getDpdAuth(opts.creds);
  const url = `${baseUrl(opts.creds.useStage)}/rest/services/ParcelLifeCycleService/V2_0/getTrackingData`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      authentication: {
        delisId: auth.delisId,
        authToken: auth.authToken,
        messageLanguage: 'nl_NL',
      },
      getTrackingData: {
        parcelLabelNumber: String(opts.parcelLabelNumber).replace(/\s/g, ''),
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status?.type !== 'OK') {
    const msg =
      data?.status?.message ||
      data?.fault?.faultstring ||
      `DPD tracking failed (${res.status})`;
    throw new Error(msg);
  }

  const tracking = data?.getTrackingDataResponse?.trackingResult;
  const statusInfo = tracking?.statusInfo;
  const list = Array.isArray(statusInfo) ? statusInfo : [];
  const current = [...list].reverse().find((s) => s.isCurrentStatus) || list[list.length - 1];

  /** @param {Record<string, unknown>} s */
  function stepDesc(s) {
    const c = s?.description?.content;
    if (Array.isArray(c)) return c.map((x) => x.content).filter(Boolean).join(' ').trim() || null;
    if (typeof c === 'string') return c.trim() || null;
    return null;
  }

  const timeline = list
    .map((s) => ({
      label: s?.label?.content || s?.status || '',
      status: s?.status || null,
      location: s?.location?.content || null,
      date: s?.date?.content || null,
      description: stepDesc(s),
      isCurrent: Boolean(s?.isCurrentStatus),
    }))
    .filter((x) => x.label || x.status);

  return {
    rawStatus: current?.status || null,
    label: current?.label?.content || current?.status || null,
    location: current?.location?.content || null,
    date: current?.date?.content || null,
    description:
      current?.description?.content?.map((c) => c.content).filter(Boolean).join(' ') || null,
    timeline,
  };
}

export function isLikelyDpdCarrier(trackingCompany) {
  if (!trackingCompany) return false;
  return /dpd/i.test(String(trackingCompany));
}
