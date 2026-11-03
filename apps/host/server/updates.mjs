import { OFFLINE_MESSAGE, looksOffline, plainUpdateError } from './update-messages.mjs';

/** Read-only release checks. Installing/rolling back needs a managed installer. */
const RELEASES = 'https://api.github.com/repos/yeli19950109/Strata/releases?per_page=30';
const RELEASE_PREFIX = 'https://github.com/yeli19950109/Strata/releases/';

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export async function checkUpdates({ appVersion, engineVersion }, fetcher = fetch) {
  let strata;
  try {
    const response = await fetcher(RELEASES, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'The release service is busy. Try again later.' : 'Could not reach the Strata release feed. Try again.');
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('The release service returned an invalid response.');
    const candidates = releases.filter(r => !r.draft && !r.prerelease && versionParts(r.tag_name));
    candidates.sort((a, b) => compare(versionParts(b.tag_name), versionParts(a.tag_name)));
    const latest = candidates[0];
    const installed = versionParts(appVersion);
    if (!latest) strata = { status: 'no-releases', message: 'No stable Strata release is published in this feed yet.' };
    else if (!installed) strata = { status: 'unavailable', message: 'This installation has no comparable version number.' };
    else {
      const newer = compare(versionParts(latest.tag_name), installed) > 0;
      // Release content is untrusted. Only link back to the known repository.
      const releaseUrl = typeof latest.html_url === 'string' && latest.html_url.startsWith(RELEASE_PREFIX) ? latest.html_url : undefined;
      strata = { status: newer ? 'available' : 'current', latestVersion: latest.tag_name, releaseUrl, message: newer ? `Strata ${latest.tag_name} is available.` : 'Strata is up to date.' };
    }
  } catch (error) {
    strata = { status: 'error', message: looksOffline(error) ? OFFLINE_MESSAGE : error.name === 'TimeoutError' ? 'The release check timed out. Try again.' : error.message ?? 'Could not check for updates.' };
  }
  return {
    checkedAt: new Date().toISOString(),
    strata: { installedVersion: appVersion, ...strata, canInstall: false },
    // The existing binary downloader has no tested-release compatibility feed
    // or trustworthy installed build ID. Upstream's latest is not an update verdict.
    engine: { installedVersion: engineVersion, status: 'unavailable', canInstall: false, message: 'Engine update checks are not available in this build.' },
  };
}

/**
 * The packaged app's update check: the upstream signed component feed, read by Control, and the fork app's own updater
 * (or its release metadata in browser mode). These checks are independent and happen only on an explicit request.
 */
export async function checkComponentUpdates({ control, appUpdater = null, appVersion = null, fetcher = fetch }) {
  const checkedAt = new Date().toISOString();
  // These are independent sources. Never infer the fork app version from the
  // upstream component feed, and never hide the app verdict if that feed fails.
  const appCheck = async () => {
    if (!appUpdater) return (await checkUpdates({ appVersion, engineVersion: null }, fetcher)).strata;
    try {
      const verdict = await appUpdater.check();
      const available = verdict.available === true;
      return { installedVersion: appVersion, status: available ? 'available' : 'current',
        latestVersion: available ? verdict.version : undefined, canInstall: available,
        message: available ? `A new version of Strata is available.${verdict.notes ? ` ${verdict.notes}` : ''}` : 'Strata is up to date.' };
    } catch (error) {
      if (error?.code === 'app-update-unavailable' && appUpdater.unavailable) {
        const result = (await checkUpdates({ appVersion, engineVersion: null }, fetcher)).strata;
        return { ...result, canInstall: false, message: `${result.message} ${appUpdater.unavailable}` };
      }
      return { installedVersion: appVersion, status: 'error', canInstall: false,
        message: "Strata couldn't check for a new version of the app itself. Try again later.", details: String(error?.message ?? error) };
    }
  };
  const componentCheck = async () => {
    try { return { report: await control.updateCheck({ appVersion }) }; }
    catch (error) { return { error }; }
  };
  const [strata, component] = await Promise.all([appCheck(), componentCheck()]);
  if (component.error) {
    const plain = plainUpdateError(component.error, 'engine');
    return { checkedAt, strata, engine: { installedVersion: null, status: 'error', message: plain.message, details: plain.details, canInstall: false } };
  }
  const report = component.report;
  const mib = bytes => `${Math.round((bytes ?? 0) / 1_000_000)} MB`;
  const engine = report.engine ?? {};
  const installedEngine = engine.installed?.version ?? null;
  const offered = engine.offered?.version ?? null;
  const engineView = { installedVersion: installedEngine, latestVersion: offered ?? undefined, canInstall: engine.status === 'available' || engine.status === 'install' };
  if (engine.status === 'available' && engine.installed_locally) Object.assign(engineView, { status: 'available', message: 'A newer engine is already on this computer. Update switches to it; nothing is downloaded.' });
  else if (engine.status === 'available') Object.assign(engineView, { status: 'available', message: `A new engine is available (${mib(engine.download_bytes)}).` });
  else if (engine.status === 'install') Object.assign(engineView, { status: 'available', message: `This PC needs an engine to run models. Press Update engine to download it (${mib(engine.download_bytes)}).` });
  else if (engine.status === 'current' || engine.status === 'failed-before' || engine.status === 'skipped') Object.assign(engineView, { status: 'current', message: 'The engine is up to date.', details: engine.note });
  else if (engine.status === 'wrong-make') Object.assign(engineView, { status: 'unavailable', message: engine.note ?? 'Nothing was changed: the update was for another make of graphics card.', details: (engine.reasons ?? []).join('\n') || undefined });
  else if (engine.status === 'not-in-feed') Object.assign(engineView, { status: 'current', message: 'No engine update is listed right now.' });
  else Object.assign(engineView, { status: 'unavailable', message: "There isn't an engine for this PC's graphics card yet.", details: (engine.reasons ?? []).join('\n') || undefined });
  return { checkedAt, feed: report.feed, strata, engine: engineView, serving: report.serving ?? [] };
}

/**
 * What the first-run card shows: this PC's graphics card(s), the engine package the signed feed offers for it and how big it is.
 * One feed read, nothing downloaded. `status`: offer (a package fits), none (nothing fits; `reasons` say why), offline (the feed could not be
 * read), installed (an engine is already here), wrong-make (an engine for another make of card is installed).
 */
export async function engineFirstRun({ control, gpus = [] }) {
  const cards = gpus.map(g => ({ name: g.name ?? 'Graphics card', vramGb: g.vramGb ?? null }));
  let report;
  try {
    report = await control.updateCheck({});
  } catch (error) {
    const plain = plainUpdateError(error, 'Strata');
    return { status: looksOffline(error) || /update server|No internet/.test(plain.headline ?? '') ? 'offline' : 'error', gpus: cards, message: plain.message, details: plain.details };
  }
  const engine = report.engine ?? {};
  const hardware = report.hardware ?? {};
  const base = { gpus: cards, driver: hardware.nvidia_driver ?? null, backend: hardware.backend ?? null };
  if (engine.installed) return { ...base, status: 'installed', installedVersion: engine.installed.version ?? null };
  if (engine.status === 'wrong-make') return { ...base, status: 'wrong-make', message: engine.note ?? null, reasons: engine.reasons ?? [] };
  if (engine.offered && (engine.status === 'install' || engine.status === 'available')) {
    return { ...base, status: 'offer', offer: { version: engine.offered.version, bytes: engine.download_bytes || engine.offered.size || 0, variant: engine.offered.variant ?? '', backend: engine.offered.backend ?? null } };
  }
  return { ...base, status: 'none', message: engine.note ?? null, reasons: engine.reasons ?? [] };
}
