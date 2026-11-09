import { cleanAudio, defaultAudio, getSettings, offReason, siteKey } from "./shared/settings.js";

// Serialise every read-modify-write of storage so concurrent writers never
// lose each other's updates.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------ audio memory

// The tab's current audio config lives in storage.session (survives the event
// page sleeping, gone when the browser closes); it is what new frames in the
// tab pick up. What gets remembered for later visits depends on settings.remember.
const tabKey = (tabId) => "tab:" + tabId;

async function rememberedAudio(site, settings) {
  if (settings.remember === "site" && site) {
    const { sites = {} } = await browser.storage.local.get("sites");
    if (sites[site]) return cleanAudio(sites[site]);
  } else if (settings.remember === "global") {
    const { globalAudio } = await browser.storage.local.get("globalAudio");
    if (globalAudio) return cleanAudio(globalAudio);
  }
  return defaultAudio(settings);
}

async function audioForTab(tabId, site, settings) {
  if (tabId != null) {
    const got = await browser.storage.session.get(tabKey(tabId));
    const t = got[tabKey(tabId)];
    if (t && t.site === site) return cleanAudio(t.audio);
  }
  return rememberedAudio(site, settings);
}

function persistAudio(site, audio, settings) {
  return serial(async () => {
    if (settings.remember === "site" && site) {
      const { sites = {} } = await browser.storage.local.get("sites");
      const def = defaultAudio(settings);
      if (JSON.stringify(audio) === JSON.stringify(def)) delete sites[site];
      else sites[site] = audio;
      await browser.storage.local.set({ sites });
    } else if (settings.remember === "global") {
      await browser.storage.local.set({ globalAudio: audio });
    }
  });
}

// ------------------------------------------------------------ frame status + badge

// tabId -> Map(frameId -> summary from that frame's content script)
const frames = new Map();
const statusKey = (tabId) => "status:" + tabId;

async function framesOf(tabId) {
  if (!frames.has(tabId)) {
    const got = await browser.storage.session.get(statusKey(tabId));
    frames.set(tabId, new Map(Object.entries(got[statusKey(tabId)] || {})));
  }
  return frames.get(tabId);
}

function aggregate(map) {
  const total = { media: 0, counts: {}, frames: [] };
  for (const [frameId, s] of map) {
    total.media += s.media || 0;
    for (const [k, v] of Object.entries(s.counts || {})) total.counts[k] = (total.counts[k] || 0) + v;
    if (s.media) total.frames.push({ frameId: Number(frameId), routed: (s.counts && s.counts.routed) || 0 });
  }
  return total;
}

const SKIPPED = ["cors", "claimed", "other", "stale", "lost", "error"];

async function updateBadge(tabId) {
  if (tabId == null) return;
  const settings = await getSettings();
  const map = await framesOf(tabId);
  const top = map.get("0");
  const agg = aggregate(map);
  let text = "";
  let color = "#c2410c";
  if (settings.showBadge && top && !top.off && top.processing) {
    const routed = agg.counts.routed || 0;
    const skipped = SKIPPED.reduce((n, k) => n + (agg.counts[k] || 0), 0);
    if (routed) text = Math.abs(top.gain - 1) > 0.001 ? String(Math.round(top.gain * 100)) : "EQ";
    else if (skipped) {
      text = "!";
      color = "#b45309";
    }
  }
  browser.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) browser.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function storeReport(tabId, frameId, summary) {
  return serial(async () => {
    const map = await framesOf(tabId);
    if (summary.media || frameId === 0) map.set(String(frameId), summary);
    else map.delete(String(frameId));
    await browser.storage.session.set({ [statusKey(tabId)]: Object.fromEntries(map) });
    await updateBadge(tabId);
    if (summary.counts && summary.counts.routed) await countUsageDay();
  });
}

// Days on which Forte processed something: drives the one-off thank-you card
// in the popup (7 / 30 / 100 days). Stays on this device like everything else.
async function countUsageDay() {
  const today = new Date().toISOString().slice(0, 10);
  const { usage } = await browser.storage.local.get("usage");
  if (usage && usage.last === today) return;
  await browser.storage.local.set({ usage: { days: ((usage && usage.days) || 0) + 1, last: today } });
}

// ------------------------------------------------------------ messaging

async function broadcast(tabId, msg) {
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // No content script in this tab (restricted page or not injected yet).
  }
}

async function setAudioForTab(tabId, url, audio) {
  const settings = await getSettings();
  const site = siteKey(url);
  const a = cleanAudio(audio);
  await browser.storage.session.set({ [tabKey(tabId)]: { site, audio: a } });
  await persistAudio(site, a, settings);
  await broadcast(tabId, { type: "forte:apply", audio: a });
  return a;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tab = sender.tab;
  switch (msg && msg.type) {
    case "forte:hello":
      return (async () => {
        const settings = await getSettings();
        const site = siteKey(tab ? tab.url : sender.url);
        const audio = await audioForTab(tab && tab.id, site, settings);
        return { settings, site, off: offReason(settings, site, msg.host), audio };
      })();
    case "forte:get":
      // Popup: the tab's current config plus what every frame reported.
      return (async () => {
        const settings = await getSettings();
        const site = siteKey(msg.url);
        return {
          audio: await audioForTab(msg.tabId, site, settings),
          status: aggregate(await framesOf(msg.tabId)),
          top: (await framesOf(msg.tabId)).get("0") || null,
        };
      })();
    case "forte:set": {
      // From the popup. An extension page opened in a tab also has sender.tab,
      // so the explicit target in the message wins.
      if (msg.tabId == null) return undefined;
      return setAudioForTab(msg.tabId, msg.url, msg.audio);
    }
    case "forte:report":
      if (tab) return storeReport(tab.id, sender.frameId || 0, msg.summary || {});
      return undefined;
    default:
      return undefined;
  }
});

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    frames.delete(tabId);
    browser.storage.session.remove(statusKey(tabId)).catch(() => {});
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  frames.delete(tabId);
  browser.storage.session.remove([statusKey(tabId), tabKey(tabId)]).catch(() => {});
});
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  for (const tabId of frames.keys()) updateBadge(tabId);
});

browser.action.setBadgeBackgroundColor({ color: "#c2410c" }).catch(() => {});
if (browser.action.setBadgeTextColor) browser.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});

// On install/update, inject into tabs that were already open so Forte works
// without a reload. Nothing is routed until the user asks for a boost, and a
// player routed by a previous version is detected and left alone.
browser.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try {
    tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }
  for (const t of tabs) {
    browser.scripting
      .executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content/forte.js"] })
      .catch(() => {});
  }
});
