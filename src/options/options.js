import { wireSupportLinks } from "../shared/support.js";
import { renderMoreAddons } from "../shared/more-addons.js";
import { EQ_PRESETS, cleanAudio, clampGain, formatGain, getSettings, saveSettings } from "../shared/settings.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let toastTimer = null;

function toast() {
  const t = $("toast");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1200);
}

async function save(patch) {
  settings = await saveSettings(patch);
  toast();
}

const CHECKS = ["enabled", "limiter", "showBadge"];

function fill() {
  for (const k of CHECKS) $(k).checked = !!settings[k];
  $("remember").value = settings.remember;
  $("defaultGain").value = Math.round(settings.defaultGain * 100);
  $("defaultPreset").value = settings.defaultPreset;
  $("blockedSites").value = settings.blockedSites.join("\n");
}

function eqName(a) {
  if (a.preset === "custom") return "Custom EQ";
  if (a.preset === "flat") return "No EQ";
  return EQ_PRESETS[a.preset].label;
}

async function renderSites() {
  const { sites = {} } = await browser.storage.local.get("sites");
  const box = $("sites");
  box.replaceChildren();
  const entries = Object.entries(sites).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "None yet. Change the volume or EQ on a site and Forte remembers it there.";
    box.append(p);
    return;
  }
  for (const [name, raw] of entries) {
    const a = cleanAudio(raw);
    const row = document.createElement("div");
    row.className = "site";
    const n = document.createElement("span");
    n.className = "name";
    n.textContent = name;
    const eq = document.createElement("span");
    eq.className = "eqname";
    eq.textContent = eqName(a);
    const v = document.createElement("span");
    v.className = "vol";
    v.textContent = formatGain(a.gain);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link-btn";
    del.textContent = "Forget";
    del.addEventListener("click", async () => {
      const cur = (await browser.storage.local.get("sites")).sites || {};
      delete cur[name];
      await browser.storage.local.set({ sites: cur });
      renderSites();
      toast();
    });
    row.append(n, eq, v, del);
    box.append(row);
  }
}

async function init() {
  wireSupportLinks();
  renderMoreAddons(document.getElementById("moreAddons")).catch(() => {});
  for (const [key, p] of Object.entries(EQ_PRESETS)) $("defaultPreset").append(new Option(p.label, key));
  settings = await getSettings();
  fill();
  renderSites();

  for (const k of CHECKS) $(k).addEventListener("change", (e) => save({ [k]: e.target.checked }));
  $("remember").addEventListener("change", (e) => save({ remember: e.target.value }));
  $("defaultPreset").addEventListener("change", (e) => save({ defaultPreset: e.target.value }));
  $("defaultGain").addEventListener("change", async (e) => {
    const g = clampGain(Number(e.target.value) / 100);
    e.target.value = Math.round(g * 100);
    await save({ defaultGain: g });
  });
  $("blockedSites").addEventListener("change", async (e) => {
    const list = e.target.value.split(/\s+/).map((s) => s.trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);
    await save({ blockedSites: Array.from(new Set(list)) });
    $("blockedSites").value = settings.blockedSites.join("\n");
  });

  browser.storage.onChanged.addListener((changes) => {
    if (changes.sites) renderSites();
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      fill();
    }
  });
}

init();
