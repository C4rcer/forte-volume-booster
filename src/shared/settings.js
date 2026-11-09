// Settings shared by background, popup and options (ES module).
// The content script is a classic script, so it receives what it needs from
// the background in its hello reply instead of importing this.

export const MAX_GAIN = 6; // 600 %
export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const BAND_LIMIT = 12; // dB either way

export const EQ_PRESETS = {
  flat: { label: "Flat (off)", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  voice: { label: "Voice / dialogue", gains: [-6, -5, -3, -1, 1, 3, 4.5, 4, 2, 0] },
  bass: { label: "Bass boost", gains: [6, 5.5, 4.5, 2.5, 0.5, 0, 0, 0, 0, 0] },
  bassReduce: { label: "Bass reduce", gains: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  treble: { label: "Treble boost", gains: [0, 0, 0, 0, 0, 0.5, 2, 4, 5.5, 6] },
  trebleReduce: { label: "Treble reduce", gains: [0, 0, 0, 0, 0, -0.5, -2, -4, -5.5, -6] },
  loudness: { label: "Loudness", gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  laptop: { label: "Laptop / small speakers", gains: [-8, -6, -2, 2, 3, 2, 1, 2, 3, 2] },
  rock: { label: "Rock", gains: [4.5, 3.5, 2, 0.5, -1, -0.5, 1.5, 3, 3.5, 4] },
  pop: { label: "Pop", gains: [-1, 0, 1.5, 3, 4, 3, 1.5, 0, -0.5, -1] },
  electronic: { label: "Electronic", gains: [5, 4, 1.5, 0, -1.5, 1, 0.5, 1.5, 4, 5] },
  classical: { label: "Classical", gains: [4, 3, 2, 1.5, -0.5, -0.5, 0, 2, 3, 3.5] },
  acoustic: { label: "Acoustic", gains: [4, 3.5, 2.5, 1, 1.5, 1.5, 3, 3.5, 3, 2] },
};

// Sites whose players are usually handled by dedicated add-ons (YouTube/Twitch
// Enhancer, Enhancer for YouTube, ...) that route the video through Web Audio
// themselves. Two add-ons processing one video clash, so Forte stays off there
// unless the user opts in.
export const CLASH_SITES = { "youtube.com": "YouTube", "twitch.tv": "Twitch" };

export const DEFAULT_AUDIO = {
  gain: 1,
  preset: "flat",
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  compressor: false,
  mono: false,
  balance: 0,
};

export const DEFAULTS = {
  enabled: true,
  remember: "site", // site | global | off
  defaultGain: 1,
  defaultPreset: "flat",
  limiter: true,
  showBadge: true,
  blockedSites: [],
  clashOptIn: [], // e.g. ["youtube.com"] once the user turns Forte on there
};

// Pages where Firefox never lets extensions run.
export const RESTRICTED_HOSTS = new Set([
  "addons.mozilla.org", "accounts.firefox.com", "accounts-static.cdn.mozilla.net",
  "addons.cdn.mozilla.net", "api.accounts.firefox.com", "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org", "install.mozilla.org", "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com", "support.mozilla.org", "sync.services.mozilla.com",
]);

export function clampGain(g) {
  const n = Number(g);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_GAIN, Math.max(0, Math.round(n * 100) / 100));
}

export function formatGain(g) {
  return Math.round(clampGain(g) * 100) + "%";
}

function clampBand(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(BAND_LIMIT, Math.max(-BAND_LIMIT, Math.round(n * 10) / 10));
}

/** Normalise a stored/received audio config (unknown keys dropped). */
export function cleanAudio(a) {
  const src = a || {};
  const out = { ...DEFAULT_AUDIO };
  out.gain = clampGain(src.gain != null ? src.gain : 1);
  out.preset = src.preset === "custom" || EQ_PRESETS[src.preset] ? src.preset : "flat";
  const bands = Array.isArray(src.bands) && src.bands.length === BANDS.length
    ? src.bands.map(clampBand)
    : (EQ_PRESETS[out.preset] || EQ_PRESETS.flat).gains.slice();
  out.bands = out.preset !== "custom" && EQ_PRESETS[out.preset] ? EQ_PRESETS[out.preset].gains.slice() : bands;
  out.compressor = !!src.compressor;
  out.mono = !!src.mono;
  const b = Number(src.balance);
  out.balance = Number.isFinite(b) ? Math.min(1, Math.max(-1, Math.round(b * 100) / 100)) : 0;
  return out;
}

export function isNeutral(a) {
  return Math.abs(a.gain - 1) < 0.001 && a.bands.every((x) => x === 0) && !a.compressor && !a.mono && a.balance === 0;
}

export function defaultAudio(settings) {
  return cleanAudio({ gain: settings.defaultGain, preset: settings.defaultPreset });
}

/** Hostname used for per-site memory and blocking ("" when not a web page). */
export function siteKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    if (!/^https?:$/.test(u.protocol)) return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The CLASH_SITES key a hostname belongs to ("" if none). */
export function clashSite(host) {
  const h = String(host || "").toLowerCase();
  for (const d of Object.keys(CLASH_SITES)) if (h === d || h.endsWith("." + d)) return d;
  return "";
}

export function mergeSettings(stored) {
  const s = { ...DEFAULTS, ...(stored || {}) };
  if (!Array.isArray(s.blockedSites)) s.blockedSites = [];
  if (!Array.isArray(s.clashOptIn)) s.clashOptIn = [];
  if (!["site", "global", "off"].includes(s.remember)) s.remember = "site";
  s.defaultGain = clampGain(s.defaultGain);
  if (!EQ_PRESETS[s.defaultPreset]) s.defaultPreset = "flat";
  return s;
}

export async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return mergeSettings(settings);
}

export async function saveSettings(patch) {
  const next = mergeSettings({ ...(await getSettings()), ...patch });
  await browser.storage.local.set({ settings: next });
  return next;
}

/** Why Forte stays out of a page, or "" when it may run. */
export function offReason(settings, site, frameHost) {
  if (!settings.enabled) return "paused";
  if (site && settings.blockedSites.includes(site)) return "blocked";
  const c = clashSite(site) || clashSite(frameHost);
  if (c && !settings.clashOptIn.includes(c)) return "clash:" + c;
  return "";
}
