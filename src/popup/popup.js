import { wireSupportLinks, maybeShowMilestone } from "../shared/support.js";
import {
  BANDS, CLASH_SITES, EQ_PRESETS, MAX_GAIN, RESTRICTED_HOSTS, clampGain, clashSite, cleanAudio,
  formatGain, getSettings, offReason, saveSettings, siteKey,
} from "../shared/settings.js";

const $ = (id) => document.getElementById(id);
const PRESET_GAINS = [0.5, 1, 1.5, 2, 3, 4, 5, 6];
let tab = null;
let site = "";
let host = "";
let settings = null;
let audio = cleanAudio(null);
let status = null;

// ------------------------------------------------------------ render

function bandLabel(f) {
  return f >= 1000 ? f / 1000 + "k" : String(f);
}

function buildControls() {
  const presets = $("presets");
  for (const g of PRESET_GAINS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.gain = String(g);
    b.textContent = formatGain(g);
    b.addEventListener("click", () => update({ gain: g }));
    presets.append(b);
  }
  const sel = $("preset");
  for (const [key, p] of Object.entries(EQ_PRESETS)) sel.append(new Option(p.label, key));
  sel.append(new Option("Custom", "custom"));
  sel.addEventListener("change", (e) => {
    const key = e.target.value;
    if (key === "custom") return update({ preset: "custom" });
    update({ preset: key, bands: EQ_PRESETS[key].gains.slice() });
  });
  const bands = $("bands");
  BANDS.forEach((f, i) => {
    const wrap = document.createElement("label");
    wrap.className = "band";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "-12";
    input.max = "12";
    input.step = "0.5";
    input.value = "0";
    input.dataset.band = String(i);
    input.setAttribute("aria-label", `${bandLabel(f)} Hz`);
    input.addEventListener("input", () => {
      const next = audio.bands.slice();
      next[i] = Number(input.value);
      update({ preset: "custom", bands: next });
    });
    input.addEventListener("dblclick", () => {
      const next = audio.bands.slice();
      next[i] = 0;
      update({ preset: "custom", bands: next });
    });
    const lab = document.createElement("span");
    lab.textContent = bandLabel(f);
    wrap.append(input, lab);
    bands.append(wrap);
  });
}

function render() {
  const g = $("gain");
  g.textContent = formatGain(audio.gain);
  g.classList.toggle("loud", audio.gain > 1.001);
  $("slider").value = String(Math.round(audio.gain * 100));
  for (const b of $("presets").children) b.classList.toggle("on", Math.abs(Number(b.dataset.gain) - audio.gain) < 0.001);
  $("preset").value = audio.preset;
  for (const input of $("bands").querySelectorAll("input")) {
    const v = audio.bands[Number(input.dataset.band)];
    input.value = String(v);
    input.title = `${v > 0 ? "+" : ""}${v} dB (double-click to reset)`;
  }
  $("compressor").checked = audio.compressor;
  $("mono").checked = audio.mono;
  $("balance").value = String(Math.round(audio.balance * 100));
}

// ------------------------------------------------------------ sending

// Send the latest config, never more than one message in flight, never losing
// the final value of a slider drag.
let sending = false;
let dirty = false;
async function flush() {
  if (!tab) return;
  if (sending) {
    dirty = true;
    return;
  }
  sending = true;
  do {
    dirty = false;
    await browser.runtime.sendMessage({ type: "forte:set", tabId: tab.id, url: tab.url, audio }).catch(() => {});
  } while (dirty);
  sending = false;
  refreshStatus();
}

function update(patch) {
  audio = cleanAudio({ ...audio, ...patch });
  render();
  flush();
}

// ------------------------------------------------------------ status

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function renderStatus() {
  const box = $("status");
  box.replaceChildren();
  const add = (text, warn) => {
    const s = document.createElement("span");
    s.textContent = text;
    if (warn) s.className = "warn";
    box.append(s);
  };
  if (!status || !tab) return;
  const c = status.counts || {};
  const top = status.top;
  if (top && top.off) {
    if (top.off === "blocked") add("Forte is off here. Players it already processed play unchanged at their own volume.");
    return;
  }
  if (!status.media) {
    add("No audio or video on this page yet. Your settings apply as soon as one plays.");
    return;
  }
  const n = (k) => c[k] || 0;
  if (n("routed")) {
    const what = Math.abs(audio.gain - 1) > 0.001 ? "Boosting" : "Processing";
    add(`${what} ${n("routed")} ${plural(n("routed"), "player", "players")} on this page.`);
  } else if (top && !top.processing) {
    add("Playing untouched at 100%. Turn it up or pick an EQ preset to start.");
  }
  if (n("gesture")) add("Click anywhere on the page once: Firefox lets add-ons process a page's sound only after you've interacted with it.", true);
  if (n("waiting")) add(`Starts when the ${plural(n("waiting"), "player plays", "players play")} with sound.`);
  if (n("probing")) add("Checking that the sound can be processed...");
  if (n("cors")) {
    const one = n("cors") === 1;
    add(`${n("cors")} ${one ? "player plays" : "players play"} at normal volume: ${one ? "its" : "their"} sound comes from another site that doesn't allow add-ons to process it, and boosting ${one ? "it" : "them"} would mute ${one ? "it" : "them"}.`, true);
  }
  const other = n("claimed") + n("other");
  if (other) add(`${other} ${plural(other, "player is", "players are")} already handled by another add-on or by the site, so Forte leaves ${plural(other, "it", "them")} alone.`, true);
  if (n("stale")) add("Forte was updated: reload the page to let the new version take over.", true);
  if (n("lost")) add("A player switched to a source Forte can't process. If it went quiet, reload the page.", true);
  if (n("error")) add(`${n("error")} ${plural(n("error"), "player", "players")} couldn't be processed and ${plural(n("error"), "plays", "play")} normally.`, true);
}

async function refreshStatus() {
  if (!tab) return;
  const res = await browser.runtime.sendMessage({ type: "forte:get", tabId: tab.id, url: tab.url }).catch(() => null);
  if (!res) return;
  status = { ...res.status, top: res.top };
  renderStatus();
}

async function pollMeter() {
  if (!tab || !status) return;
  const frames = (status.frames || []).filter((f) => f.routed > 0);
  let best = null;
  for (const f of frames) {
    const l = await browser.tabs.sendMessage(tab.id, { type: "forte:levels" }, { frameId: f.frameId }).catch(() => null);
    if (l && (!best || l.output.peak > best.output.peak)) best = l;
  }
  const peak = best ? best.output.peak : 0;
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  $("meterBar").style.width = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) + "%";
  $("limTag").classList.toggle("on", !!best && best.reduction < -0.5);
}

// ------------------------------------------------------------ notices

function notice(lines, button) {
  const n = $("notice");
  n.replaceChildren();
  for (const t of [].concat(lines)) {
    const p = document.createElement("p");
    p.textContent = t;
    n.append(p);
  }
  if (button) n.append(button);
  n.hidden = false;
}

function button(text, onClick) {
  const b = document.createElement("button");
  b.className = "primary";
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function setControlsEnabled(on) {
  $("controls").classList.toggle("disabled", !on);
  $("btnReset").disabled = !on;
}

function applyOffState() {
  const reason = offReason(settings, site);
  $("notice").hidden = true;
  $("siteEnabled").checked = !settings.blockedSites.includes(site);
  if (reason === "paused") {
    notice("Forte is paused on every site.", button("Turn Forte back on", async () => {
      settings = await saveSettings({ enabled: true });
      applyOffState();
    }));
  }
  setControlsEnabled(!reason);
  $("siteEnabled").disabled = reason === "paused";
  setTimeout(refreshStatus, 400);
}

async function onSiteToggle(e) {
  const blocked = new Set(settings.blockedSites);
  if (e.target.checked) blocked.delete(site);
  else blocked.add(site);
  settings = await saveSettings({ blockedSites: Array.from(blocked) });
  applyOffState();
}

// ------------------------------------------------------------ init

async function inject() {
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content/forte.js"] });
    await new Promise((r) => setTimeout(r, 400));
  } catch {
    /* restricted page */
  }
}

async function renderUsage() {
  const { usage } = await browser.storage.local.get("usage");
  const days = usage ? usage.days : 0;
  await maybeShowMilestone($("supportCard"), days, [7, 30, 100], (d) =>
    `Forte has boosted your sound on ${d} different days.`);
}

async function init() {
  wireSupportLinks();
  buildControls();
  $("btnOptions").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  const step = (dir) => {
    const pct = Math.round(audio.gain * 100);
    const next = dir > 0 ? Math.floor(pct / 10) * 10 + 10 : Math.ceil(pct / 10) * 10 - 10;
    update({ gain: clampGain(Math.min(MAX_GAIN * 100, Math.max(0, next)) / 100) });
  };
  $("btnDown").addEventListener("click", () => step(-1));
  $("btnUp").addEventListener("click", () => step(1));
  $("slider").addEventListener("input", (e) => update({ gain: Number(e.target.value) / 100 }));
  $("compressor").addEventListener("change", (e) => update({ compressor: e.target.checked }));
  $("mono").addEventListener("change", (e) => update({ mono: e.target.checked }));
  $("balance").addEventListener("input", (e) => update({ balance: Number(e.target.value) / 100 }));
  $("balance").addEventListener("dblclick", () => update({ balance: 0 }));
  $("btnReset").addEventListener("click", () => update({ gain: 1, preset: "flat", bands: EQ_PRESETS.flat.gains.slice(), compressor: false, mono: false, balance: 0 }));
  $("siteEnabled").addEventListener("change", onSiteToggle);

  settings = await getSettings();
  render();
  renderUsage();

  // ?tab=<id> lets the popup be opened in a normal tab for tests and store screenshots.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  if (forced) tab = await browser.tabs.get(forced).catch(() => null);
  else [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  site = siteKey(tab && tab.url ? tab.url : "");
  try { host = new URL(tab.url).hostname; } catch { /* about: pages */ }

  if (!site || RESTRICTED_HOSTS.has(host)) {
    notice("Firefox doesn't let add-ons change the sound on this page. Open a page with audio or video to use Forte.");
    setControlsEnabled(false);
    $("siteEnabled").disabled = true;
    tab = null;
    return;
  }
  $("siteName").textContent = site === "file" ? "local files" : site;
  if (clashSite(host)) $("siteName").textContent = CLASH_SITES[clashSite(host)];
  applyOffState();

  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) {
    notice("Forte needs access to websites to change their sound. Nothing is collected or sent anywhere.",
      button("Allow access to websites", async () => {
        // permissions.request must run straight from the click.
        const ok = await browser.permissions.request({ origins: ["<all_urls>"] });
        if (ok) window.location.reload();
      }));
  }

  const res = await browser.runtime.sendMessage({ type: "forte:get", tabId: tab.id, url: tab.url }).catch(() => null);
  if (res) {
    audio = cleanAudio(res.audio);
    render();
  }
  if (granted && !(res && res.top)) await inject();
  await refreshStatus();
  if (granted && !(status && status.top)) {
    $("status").textContent = "Reload this page to let Forte reach its players.";
  }
  setInterval(refreshStatus, 1000);
  setInterval(pollMeter, 120);
}

init();
