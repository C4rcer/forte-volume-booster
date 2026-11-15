"""End-to-end test of Forte in a real, headless and muted Firefox (Selenium + geckodriver).

  python -m pip install selenium        (once, ideally in a venv)
  python tools/release.py build
  python tests/e2e_firefox.py [--headed]

Installs the built zip (extracted, by path) as a temporary add-on in throwaway
profiles. tests/server.py serves exact sine tones from two origins, so every
level is measured inside the page by Forte's own AnalyserNodes (input before
the chain, output after it) instead of by ear. Every browser runs with
media.volume_scale = 0.0: nothing is ever audible.

Sessions:
  A  Forte alone: untouched by default, boost, limiter, EQ presets, per-site and
     global memory, cross-origin (CORS-silent) players left alone, shadow DOM
     and iframes, one-click off, YouTube/Twitch default-off with opt-in, and
     players already routed by YouTube/Twitch Enhancer.
  B  Forte with test shims (tests/shim-*.js, never shipped) for two cases
     Firefox 147 can't be made to produce: createMediaElementSource throwing the
     spec's InvalidStateError, and an AudioContext held suspended until a click.
  C  Forte together with Tempo: Video Speed Controller.
  D  Strict autoplay (transient activation, as in hardened profiles): no
     AudioContext while nothing plays, routing right after the user's click,
     and a boost chosen later still applying.
"""
import json
import os
import shutil
import statistics
import sys
import tempfile
import time
import zipfile
from pathlib import Path

os.environ.setdefault("SE_AVOID_STATS", "true")

from selenium import webdriver  # noqa: E402
from selenium.webdriver.common.action_chains import ActionChains  # noqa: E402
from selenium.webdriver.common.by import By  # noqa: E402
from selenium.webdriver.firefox.options import Options  # noqa: E402
from selenium.webdriver.support.ui import Select  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
GITHUB = ROOT.parent
FIREFOX = r"C:\Program Files\Mozilla Firefox\firefox.exe"
ADDON_ID = "forte-volume-booster@c4rcer"
UUID = "4f0a7e2c-5b1d-4c8e-9f3a-0f0f0e000001"
TEMPO_ID = "tempo-video-speed@c4rcer"
TEMPO_UUID = "6f1c2c1e-7e3a-4b8a-9d55-7e3a00c0ffee"
P1, P2 = 8961, 8962
EXT = f"moz-extension://{UUID}"
HEADED = "--headed" in sys.argv
ONLY = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), "ABCD")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail != "" else ""), flush=True)


def wait(fn, timeout=10.0, step=0.15):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001
            last = None
        time.sleep(step)
    return last


def latest_zip(folder):
    zips = sorted((folder / "dist").glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if not zips:
        sys.exit(f"build first: python tools/release.py build  (in {folder})")
    return zips[-1]


def extract(zip_path):
    out = Path(tempfile.mkdtemp(prefix="forte-e2e-"))
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(out)
    return out


class Session:
    """One Firefox with the add-on(s) installed, a page window and an extension window."""

    def __init__(self, addon_dirs, prefs=None):
        opts = Options()
        opts.binary_location = FIREFOX
        if not HEADED:
            opts.add_argument("-headless")
        base = {
            "media.volume_scale": "0.0",  # muted: tests measure levels, never listen
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
            "extensions.webextensions.uuids": json.dumps({ADDON_ID: UUID, TEMPO_ID: TEMPO_UUID}),
            # Real hostnames for the default-off sites and a second "site", all served locally.
            "network.dns.localDomains": "www.youtube.com,www.twitch.tv,other.test",
            "network.stricttransportsecurity.preloadlist": False,
            "dom.security.https_first": False,
            "dom.security.https_first_schemeless": False,
            "network.trr.mode": 5,
        }
        base.update(prefs or {})
        for k, v in base.items():
            opts.set_preference(k, v)
        self.d = webdriver.Firefox(options=opts)
        self.d.set_window_size(1200, 900)
        for path in addon_dirs:
            # Install the extracted zip by path: handing geckodriver the zip makes it
            # install from a temp copy it deletes, and content scripts then fail to load.
            self.d.execute("INSTALL_ADDON", {"path": str(path), "temporary": True})
        time.sleep(1.0)
        self.page = self.d.current_window_handle
        self.d.switch_to.new_window("window")  # a window, not a tab: no background-tab throttling
        self.ext_win = self.d.current_window_handle
        self.d.get(f"{EXT}/options/options.html")
        self.d.switch_to.window(self.page)
        self.tab_id = None

    # ---------------------------------------------------------- plumbing

    def js(self, code, *args):
        self.d.switch_to.window(self.page)
        return self.d.execute_script(code, *args)

    def ext(self, code):
        """Run async code with the WebExtension API inside an extension page."""
        self.d.switch_to.window(self.ext_win)
        try:
            return self.d.execute_async_script(
                "const done = arguments[arguments.length - 1];"
                f"(async () => {{ {code} }})().then(done, (e) => done('ERR ' + e));")
        finally:
            self.d.switch_to.window(self.page)

    def load(self, players, host="127.0.0.1", extra=""):
        self.d.switch_to.window(self.page)
        self.d.get(f"http://{host}:{P1}/test-page.html?p={players}&xport={P2}{extra}")
        wait(lambda: self.d.execute_script("return document.readyState") == "complete")
        if self.tab_id is None:
            self.tab_id = self.ext(
                f"const t = (await browser.tabs.query({{}})).find((x) => x.url.includes(':{P1}/test-page.html')); return t ? t.id : null;")
        time.sleep(0.6)

    def play(self, *ids):
        for i in ids:
            r = self.js("return window.play(arguments[0])", i)
            if r != "ok":
                print(f"  play({i}) -> {r}")

    def pause_all(self):
        self.js("window.pauseAll()")

    def info(self, i):
        return self.js("return window.info(arguments[0])", i)

    def status(self, frame=0):
        return self.ext(
            f"return await browser.tabs.sendMessage({self.tab_id}, {{type: 'forte:status'}}, {{frameId: {frame}}});")

    def item(self, i, frame=0):
        s = self.status(frame)
        if not isinstance(s, dict):
            return None
        return next((x for x in s["items"] if x["id"] == i), None)

    def item_status(self, i, frame=0):
        it = self.item(i, frame)
        return it and it["status"]

    def tab_summary(self):
        return self.ext(
            f"const t = await browser.tabs.get({self.tab_id});"
            f"return await browser.runtime.sendMessage({{type: 'forte:get', tabId: {self.tab_id}, url: t.url}});")

    def set_audio(self, **patch):
        a = {"gain": 1, "preset": "flat", "compressor": False, "mono": False, "balance": 0}
        a.update(patch)
        return self.ext(
            f"const t = await browser.tabs.get({self.tab_id});"
            f"return await browser.runtime.sendMessage({{type: 'forte:set', tabId: {self.tab_id}, url: t.url, audio: {json.dumps(a)}}});")

    def set_settings(self, **patch):
        return self.ext(
            "const {settings} = await browser.storage.local.get('settings');"
            f"await browser.storage.local.set({{settings: Object.assign({{}}, settings || {{}}, {json.dumps(patch)})}});"
            "return true;")

    def levels(self, frame=0):
        return self.ext(
            f"return await browser.tabs.sendMessage({self.tab_id}, {{type: 'forte:levels'}}, {{frameId: {frame}}});")

    def ratio(self, frame=0, n=6):
        """Output RMS / input RMS of Forte's chain, measured by its AnalyserNodes."""
        vals = []
        for _ in range(n):
            lv = self.levels(frame)
            if isinstance(lv, dict) and lv["input"]["rms"] > 1e-4:
                vals.append(lv["output"]["rms"] / lv["input"]["rms"])
            time.sleep(0.1)
        return round(statistics.median(vals), 3) if vals else None

    def badge(self):
        return self.ext(f"return await browser.action.getBadgeText({{tabId: {self.tab_id}}});")

    def open_popup(self):
        self.d.switch_to.window(self.ext_win)
        self.d.get(f"{EXT}/popup/popup.html?tab={self.tab_id}")
        time.sleep(1.2)

    def popup_text(self, el_id):
        self.d.switch_to.window(self.ext_win)
        try:
            return self.d.find_element(By.ID, el_id).text
        finally:
            self.d.switch_to.window(self.page)

    def popup_click(self, css):
        self.d.switch_to.window(self.ext_win)
        try:
            self.d.find_element(By.CSS_SELECTOR, css).click()
        finally:
            self.d.switch_to.window(self.page)

    def quit(self):
        self.d.quit()


def near(x, target, tol):
    return x is not None and abs(x - target) <= tol


def db(r):
    import math
    return None if not r else round(20 * math.log10(r), 2)


# =============================================================== session A

def session_a(forte_dir):
    s = Session([forte_dir])
    try:
        # ---- untouched until asked
        s.load("main")
        s.play("main")
        time.sleep(1.5)
        st = s.status()
        check("player found, left untouched at 100% (no AudioContext, not routed)",
              st and st["items"] and st["items"][0]["status"] == "idle" and st["ctx"] == "none"
              and s.info("main")["wired"] is None, st)

        # ---- boost through the popup
        s.open_popup()
        s.popup_click('#presets button[data-gain="3"]')
        check("popup 300% routes the player", wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        time.sleep(0.4)
        r = s.ratio()
        check("300% measured as 3x (output/input RMS)", near(r, 3.0, 0.12), r)
        check("toolbar badge shows 300", wait(lambda: s.badge() == "300", 4), s.badge())
        check("popup says it is boosting", wait(lambda: "Boosting 1 player" in s.popup_text("status"), 4),
              s.popup_text("status"))
        meter = s.ext("return document.getElementById('meterBar').style.width")
        check("popup level meter moves", meter not in (None, "", "0%"), meter)
        check("Forte marks the element it routed", bool(s.info("main")["wired"]))
        check("player keeps playing", not s.info("main")["paused"])

        # ---- limiter: 600% of a loud (-6 dBFS) tone
        s.set_audio(gain=6)
        s.load("loud")
        s.play("loud")
        check("loud player routed at 600%", wait(lambda: s.item_status("loud") == "routed", 8), s.item("loud"))
        time.sleep(0.8)
        lv = s.levels()
        peak = lv and lv["output"]["peak"]
        check("limiter keeps 600% of a loud track under 0 dBFS", peak is not None and peak <= 1.0, peak)
        check("limiter reports gain reduction", lv and lv["reduction"] < -3, lv and lv["reduction"])
        s.set_settings(limiter=False)
        time.sleep(1.0)
        lv = s.levels()
        raw = lv and lv["output"]["peak"]
        check("with the limiter off the raw boost clips (3x of 0.5)", raw is not None and raw > 2.5, raw)
        s.set_settings(limiter=True)
        time.sleep(0.8)
        lv = s.levels()
        check("limiter back on", lv and lv["output"]["peak"] <= 1.0, lv and lv["output"]["peak"])

        # ---- small boosts are exact (the limiter's makeup gain is cancelled)
        s.set_audio(gain=1.5)
        s.load("main")
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        time.sleep(0.4)
        r = s.ratio()
        check("150% measured as 1.5x with the limiter in the chain", near(r, 1.5, 0.06), r)

        # ---- the site's own volume and mute keep working on a routed player
        def in_rms():
            vals = []
            for _ in range(4):
                lv = s.levels()
                if isinstance(lv, dict):
                    vals.append(lv["input"]["rms"])
                time.sleep(0.1)
            return statistics.median(vals) if vals else None

        full = in_rms()
        s.js("window.el('main').volume = 0.5")
        time.sleep(0.5)
        half = in_rms()
        check("site's own volume control still works on a routed player",
              full and half and near(half / full, 0.5, 0.03), f"{full} -> {half}")
        s.js("const m = window.el('main'); m.volume = 1; m.muted = true;")
        time.sleep(0.5)
        muted = in_rms()
        check("site's own mute still works on a routed player", muted is not None and muted < 1e-4, muted)
        s.js("window.el('main').muted = false")

        # ---- a MediaStream player (web call): Firefox stops applying its
        # volume/mute once routed, so Forte mirrors them
        s.load("ms")
        s.play("ms")
        check("MediaStream (web call) player routed", wait(lambda: s.item_status("ms") == "routed", 8), s.item("ms"))
        time.sleep(0.4)
        r = s.ratio()
        check("...boosted 1.5x", near(r, 1.5, 0.06), r)
        full = in_rms()
        s.js("window.el('ms').volume = 0.5")
        time.sleep(0.5)
        half = in_rms()
        check("...its volume control still works", full and half and near(half / full, 0.5, 0.03), f"{full} -> {half}")
        s.js("const m = window.el('ms'); m.volume = 1; m.muted = true;")
        time.sleep(0.5)
        muted = in_rms()
        check("...muting it still works (e.g. muting a call participant)", muted is not None and muted < 1e-4, muted)
        s.js("window.el('ms').muted = false")

        # ---- equalizer presets, measured on 100 Hz and 8 kHz tones
        def eq_response(preset):
            s.set_audio(gain=1, preset=preset)
            s.load("low,high")
            out = {}
            for tone in ("low", "high"):
                s.pause_all()
                s.play(tone)
                wait(lambda: s.item_status(tone) == "routed", 8)
                time.sleep(0.5)
                out[tone] = db(s.ratio())
            s.pause_all()
            return out

        bass = eq_response("bass")
        check("Bass boost: +4 dB or more at 100 Hz", bass["low"] is not None and bass["low"] >= 4, bass)
        check("Bass boost: 8 kHz unchanged", bass["high"] is not None and abs(bass["high"]) <= 1, bass)
        treble = eq_response("treble")
        check("Treble boost: +4 dB or more at 8 kHz", treble["high"] is not None and treble["high"] >= 4, treble)
        check("Treble boost: 100 Hz unchanged", treble["low"] is not None and abs(treble["low"]) <= 1, treble)
        voice = eq_response("voice")
        check("Voice: cuts 100 Hz rumble, lifts 8 kHz",
              voice["low"] is not None and voice["low"] <= -3 and voice["high"] is not None and voice["high"] >= 1, voice)

        # ---- EQ preset from the popup's select + a dragged band
        s.load("main")
        s.open_popup()
        s.d.switch_to.window(s.ext_win)
        Select(s.d.find_element(By.ID, "preset")).select_by_value("bass")
        s.d.switch_to.window(s.page)
        got = wait(lambda: (s.tab_summary() or {}).get("audio", {}).get("preset") == "bass", 4)
        check("popup EQ preset select applies to the tab", got)
        s.d.switch_to.window(s.ext_win)
        band = s.d.find_element(By.CSS_SELECTOR, '#bands input[data-band="5"]')
        s.d.execute_script("arguments[0].value = '6'; arguments[0].dispatchEvent(new Event('input'));", band)
        s.d.switch_to.window(s.page)
        a = wait(lambda: (lambda x: x if x["preset"] == "custom" and x["bands"][5] == 6 else None)(s.tab_summary()["audio"]), 4)
        check("dragging a band makes a custom EQ", bool(a), a)

        # ---- per-site memory
        s.set_audio(gain=2.5)
        s.load("main")
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        time.sleep(0.4)
        r = s.ratio()
        check("per-site: 250% survives a reload of 127.0.0.1", near(r, 2.5, 0.1), r)
        s.d.switch_to.window(s.ext_win)
        s.d.get(f"{EXT}/options/options.html")
        sites = wait(lambda: s.d.find_element(By.ID, "sites").text, 4)
        s.d.switch_to.window(s.page)
        check("options lists the remembered site", "127.0.0.1" in (sites or "") and "250%" in (sites or ""), sites)
        # ---- settings: rate link and "More free add-ons" (expected list comes from the shared file)
        more = wait(lambda: s.ext("""
          const items = [...document.querySelectorAll('#moreAddons .more-item a')];
          if (!items.length) return null;
          const rate = document.querySelector('[data-rate]');
          const all = document.querySelector('[data-more-all]');
          const m = await import('/shared/more-addons.js');
          const me = browser.runtime.id;
          const self = m.ADDONS.find((a) => a.id === me);
          const fake = [{id: 'a', live: true, android: false}, {id: 'b', live: true, android: true},
                        {id: 'self', live: true, android: true}, {id: 'c', live: false, android: true}];
          return {
            names: items.map((a) => a.querySelector('.more-name').textContent),
            expected: m.ADDONS.filter((a) => a.live && a.id !== me).map((a) => a.name),
            left_out: m.ADDONS.filter((a) => !a.live || a.id === me).map((a) => a.name),
            self_slug: self ? self.slug : null, self_live: self ? self.live : null,
            hrefs: items.map((a) => a.href),
            newTab: items.every((a) => a.target === '_blank' && a.rel === 'noopener'),
            rate: rate.hidden ? null : rate.href, rateNewTab: rate.target === '_blank',
            all: all.href,
            androidPick: m.moreAddons('self', 'android', fake).map((x) => x.id),
            desktopPick: m.moreAddons('self', 'win', fake).map((x) => x.id),
          };
        """))
        more = more if isinstance(more, dict) else {}
        check("this add-on is marked live in the shared add-on list", more.get("self_live") is True, more.get("self_slug"))
        check("settings page lists every other live add-on, in order",
              bool(more.get("names")) and more.get("names") == more.get("expected"), (more.get("names"), more.get("expected")))
        check("it leaves out itself and add-ons still in review",
              bool(more.get("names")) and not set(more["names"]) & set(more.get("left_out") or []), more.get("left_out"))
        check("each listed add-on links to its AMO page in a new tab",
              bool(more.get("hrefs")) and all(h.startswith("https://addons.mozilla.org/firefox/addon/") for h in more["hrefs"])
              and more.get("newTab") is True, more.get("hrefs"))
        check("rate link opens this add-on's own AMO page",
              bool(more.get("self_slug")) and more.get("rate") == "https://addons.mozilla.org/firefox/addon/%s/" % more.get("self_slug")
              and more.get("rateNewTab") is True, more.get("rate"))
        check("see-all link opens the author's AMO page",
              more.get("all") == "https://addons.mozilla.org/firefox/user/20013808/", more.get("all"))
        check("list skips itself and unreleased add-ons, and desktop-only ones on Android",
              more.get("desktopPick") == ["a", "b"] and more.get("androidPick") == ["b"],
              (more.get("desktopPick"), more.get("androidPick")))
        # A later visit in a new tab: no tab state, only what was remembered for the site.
        s.ext(f"await browser.storage.session.remove('tab:{s.tab_id}'); return true;")
        s.load("main")
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        time.sleep(0.4)
        r = s.ratio()
        check("per-site: 250% remembered for 127.0.0.1 on a later visit", near(r, 2.5, 0.1), r)
        s.load("main", host="other.test")
        s.play("main")
        time.sleep(1.5)
        check("another site starts at the default 100% (untouched)", s.item_status("main") == "idle", s.item("main"))
        s.set_settings(remember="global")
        s.set_audio(gain=1.5)
        s.load("main")
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        time.sleep(0.4)
        r = s.ratio()
        check("global memory: 150% set on other.test applies on 127.0.0.1", near(r, 1.5, 0.06), r)
        s.set_settings(remember="site")

        # ---- cross-origin players (the CORS-silent trap)
        s.load("cross,corsok,redir")
        s.set_audio(gain=2)
        ctl = s.js("return window.pageProbe('cross')")
        check("control: Web Audio really turns this cross-origin player silent", ctl == 0, ctl)
        ctl_ok = s.js("return window.pageProbe('corsok')")
        check("control: the CORS-enabled copy is not silent", ctl_ok and ctl_ok > 0.05, ctl_ok)
        s.play("cross")
        check("cross-origin player without CORS is skipped (URL check)",
              wait(lambda: (s.item("cross") or {}).get("why") == "url" and s.item_status("cross") == "cors", 6), s.item("cross"))
        i0 = s.info("cross")
        time.sleep(1.0)
        i1 = s.info("cross")
        check("...and keeps playing untouched (not routed, not muted, volume 1)",
              i1["wired"] is None and not i1["paused"] and not i1["muted"] and i1["volume"] == 1 and i1["t"] > i0["t"], i1)
        s.play("corsok")
        check("cross-origin player WITH CORS is boosted", wait(lambda: s.item_status("corsok") == "routed", 8), s.item("corsok"))
        time.sleep(0.4)
        r = s.ratio()
        check("...at 2x", near(r, 2.0, 0.08), r)
        s.js("window.el('corsok').pause()")
        s.play("redir")
        check("same-origin URL redirecting cross-origin: probed first",
              wait(lambda: s.item_status("redir") == "probing", 5), s.item("redir"))
        check("...then skipped because it only gives silence",
              wait(lambda: s.item_status("redir") == "cors", 12) and (s.item("redir") or {}).get("why") == "probe", s.item("redir"))
        i2 = s.info("redir")
        check("...and keeps playing untouched", i2["wired"] is None and not i2["paused"], i2)
        s.open_popup()
        txt = wait(lambda: "normal volume" in s.popup_text("status") and s.popup_text("status"), 4)
        check("popup explains the skipped players", bool(txt), s.popup_text("status"))
        check("badge still shows the boost for the CORS player", s.badge() == "200", s.badge())

        # ---- shadow DOM and iframes
        s.load("shadow,frame")
        s.play("shadow")
        s.js("document.getElementById('frame').contentWindow.play('main')")
        check("closed shadow-DOM player routed", wait(lambda: s.item_status("shadow") == "routed", 8), s.item("shadow"))
        agg = wait(lambda: (lambda t: t if t["status"]["counts"].get("routed") == 2 else None)(s.tab_summary()), 8)
        check("iframe player routed too (2 players across frames)", bool(agg), s.tab_summary()["status"])

        # ---- one click off for the site
        s.load("main")
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        time.sleep(0.4)
        before = s.ratio()
        s.open_popup()
        s.popup_click("#siteEnabled")
        time.sleep(1.0)
        r_off = s.ratio()
        check("site switch off: processed player goes back to 1x at once", near(before, 2.0, 0.08) and near(r_off, 1.0, 0.03),
              f"{before} -> {r_off}")
        check("site switch off clears the badge", wait(lambda: s.badge() == "", 4), s.badge())
        s.open_popup()
        s.popup_click("#siteEnabled")
        time.sleep(1.0)
        r_on = s.ratio()
        check("site switch on again: back to 2x", near(r_on, 2.0, 0.08), r_on)

        # ---- YouTube and Twitch: off by default, opt-in from the popup
        s.load("main", host="www.youtube.com")
        s.play("main")
        s.set_audio(gain=3)
        time.sleep(1.5)
        st = s.status()
        check("youtube.com: Forte is off by default", st and st["off"] == "clash:youtube.com", st and st["off"])
        check("youtube.com: player untouched (no AudioContext, not routed)",
              st and st["ctx"] == "none" and s.info("main")["wired"] is None and not s.info("main")["paused"], st)
        s.open_popup()
        note = s.popup_text("notice")
        check("popup explains why YouTube is off", "off on YouTube by default" in note and "YouTube/Twitch Enhancer" in note, note)
        disabled = s.ext("return document.getElementById('controls').classList.contains('disabled')")
        check("popup controls disabled on YouTube until opt-in", disabled is True, disabled)
        s.popup_click("#notice button")
        check("opt-in from the popup turns Forte on for YouTube",
              wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        time.sleep(0.4)
        r = s.ratio()
        check("...and applies the 300% set earlier", near(r, 3.0, 0.12), r)
        s.set_settings(clashOptIn=[])
        s.load("main", host="www.twitch.tv")
        s.play("main")
        s.set_audio(gain=3)
        time.sleep(1.2)
        st = s.status()
        check("twitch.tv: Forte is off by default", st and st["off"] == "clash:twitch.tv" and st["ctx"] == "none", st and st["off"])
        s.load("frame", extra="&fhost=www.youtube.com")
        s.set_audio(gain=2)
        s.d.switch_to.frame(s.d.find_element(By.ID, "frame"))
        s.d.execute_script("return window.play('main')")
        time.sleep(1.5)
        emb = s.d.execute_script("return window.info('main')")
        s.d.switch_to.default_content()
        check("embedded YouTube player on another site is left alone too", emb["wired"] is None and not emb["paused"], emb)

        # ---- players YouTube/Twitch Enhancer already routed
        s.load("main,yte")
        s.set_audio(gain=2)
        s.js("return window.simulateYte('yte')")
        s.play("yte")
        check("element routed by YouTube/Twitch Enhancer is left to it",
              wait(lambda: s.item_status("yte") == "other", 6), s.item("yte"))
        lvl = wait(lambda: (lambda v: v if v > 0.05 else None)(s.js("return window.yteLevel()")), 4)
        check("...its own graph still gets the sound", lvl and s.info("yte")["wired"] is None, lvl)
        s.pause_all()
        s.play("main")
        wait(lambda: s.item_status("main") == "routed", 8)
        s.js("return window.simulateYte('main')")
        check("Forte steps back when YouTube/Twitch Enhancer routes its player later",
              wait(lambda: s.item_status("main") == "other", 6), s.item("main"))
        check("...and the Enhancer's graph has the sound", s.js("return window.yteLevel()") > 0.05)
    finally:
        s.quit()


# =============================================================== session B

def session_b(forte_dir):
    shimmed = Path(tempfile.mkdtemp(prefix="forte-shim-"))
    shutil.copytree(forte_dir, shimmed, dirs_exist_ok=True)
    shutil.copy(ROOT / "tests" / "shim-invalidstate.js", shimmed / "content" / "test-shim-invalidstate.js")
    shutil.copy(ROOT / "tests" / "shim-suspended.js", shimmed / "content" / "test-shim-suspended.js")
    man = json.loads((shimmed / "manifest.json").read_text(encoding="utf-8"))
    man["content_scripts"][0]["js"] = [
        "content/test-shim-invalidstate.js", "content/test-shim-suspended.js", "content/forte.js"]
    (shimmed / "manifest.json").write_text(json.dumps(man, indent=2), encoding="utf-8")
    s = Session([shimmed])
    try:
        s.load("claimed,main")
        s.set_audio(gain=2)
        s.play("claimed")
        check("InvalidStateError: element skipped as claimed by someone else",
              wait(lambda: s.item_status("claimed") == "claimed", 8)
              and (s.item("claimed") or {}).get("why") == "InvalidStateError", s.item("claimed"))
        i0 = s.info("claimed")
        time.sleep(0.8)
        i1 = s.info("claimed")
        check("...and keeps playing, unmarked", i1["wired"] is None and not i1["paused"] and i1["t"] > i0["t"], i1)
        s.js("window.el('claimed').pause()")
        s.play("main")
        check("other players on the page are still boosted", wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        time.sleep(0.4)
        r = s.ratio()
        check("...at 2x", near(r, 2.0, 0.08), r)
        s.open_popup()
        txt = wait(lambda: "already handled by another add-on" in s.popup_text("status") and s.popup_text("status"), 4)
        check("popup explains the claimed player", bool(txt), s.popup_text("status"))

        # ---- an AudioContext Firefox keeps suspended until a click (shim, see
        # tests/shim-suspended.js): routing into it would mute the player.
        s.load("main", host="other.test", extra="&suspendctx=1")
        s.play("main")
        s.set_audio(gain=2)
        time.sleep(1.5)
        st = s.status()
        check("suspended AudioContext: player NOT routed, keeps playing",
              st and st["ctx"] == "suspended" and s.item_status("main") == "gesture"
              and s.info("main")["wired"] is None and not s.info("main")["paused"], st)
        s.open_popup()
        txt = wait(lambda: "Click anywhere on the page" in s.popup_text("status") and s.popup_text("status"), 4)
        check("popup asks for one click on the page", bool(txt), s.popup_text("status"))
        s.d.switch_to.window(s.page)
        s.d.find_element(By.ID, "title").click()
        check("after one click on the page the player is routed",
              wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        time.sleep(0.4)
        r = s.ratio()
        check("...and boosted 2x", near(r, 2.0, 0.08), r)
    finally:
        s.quit()
        shutil.rmtree(shimmed, ignore_errors=True)


# =============================================================== session C

def session_c(forte_dir, tempo_dir):
    s = Session([forte_dir, tempo_dir])
    try:
        s.load("main")
        s.play("main")
        s.set_audio(gain=2)
        check("with Tempo installed, Forte routes the player", wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        check("Tempo's on-video control is there",
              wait(lambda: s.js("return document.querySelectorAll('[data-tempo-overlay]').length") >= 1, 5))
        s.js("document.activeElement && document.activeElement.blur(); window.focus();")
        s.d.find_element(By.ID, "title").click()
        ActionChains(s.d).send_keys("d" * 10).perform()
        check("Tempo's D key still sets 2x on a Forte-routed player",
              wait(lambda: abs(s.info("main")["rate"] - 2) < 0.001, 5), s.info("main")["rate"])
        t0 = s.info("main")["t"]
        time.sleep(2.0)
        t1 = s.info("main")["t"]
        adv = t1 - t0 if t1 >= t0 else t1 + 20 - t0  # the tone loops every 20 s
        check("playback really runs at 2x through Forte's graph", 3.3 < adv < 4.7, round(adv, 2))
        r = s.ratio()
        check("Forte's 2x boost unaffected by Tempo's speed", near(r, 2.0, 0.08), r)
        s.set_audio(gain=3)
        time.sleep(0.6)
        r = s.ratio()
        check("changing Forte's boost keeps Tempo's speed", near(r, 3.0, 0.12) and abs(s.info("main")["rate"] - 2) < 0.001,
              f"ratio {r}, rate {s.info('main')['rate']}")
        s.load("main")
        s.play("main")
        check("after reload both apply again: Tempo 2x (remembered) and Forte routed",
              wait(lambda: abs(s.info("main")["rate"] - 2) < 0.001 and s.item_status("main") == "routed", 8),
              f"{s.info('main')['rate']} / {s.item('main')}")
    finally:
        s.quit()


# =============================================================== session D

def session_d(forte_dir):
    # Strict autoplay, as in privacy-hardened profiles: audible playback and Web
    # Audio both need a *transient* user activation (a click within the last 5 s).
    s = Session([forte_dir], prefs={
        "media.autoplay.default": 1,
        "media.autoplay.block-webaudio": True,
        "media.autoplay.blocking_policy": 1,
    })
    try:
        # Boost chosen before anything plays: nothing is created yet.
        s.load("main")
        s.set_audio(gain=2)
        time.sleep(1.0)
        st = s.status()
        check("strict autoplay: boost set while nothing plays creates no AudioContext",
              st and st["ctx"] == "none" and s.item_status("main") == "waiting", st)
        s.d.find_element(By.ID, "playBtn").click()
        check("user clicks play: routed straight away (inside the click's activation)",
              wait(lambda: s.item_status("main") == "routed", 8), s.item("main"))
        time.sleep(0.4)
        r = s.ratio()
        check("...and boosted 2x", near(r, 2.0, 0.08), r)

        # Boost chosen while it already plays and the click's activation has
        # expired: Firefox still lets the page start Web Audio (it already plays
        # audible media), so the boost applies without another click.
        s.set_audio(gain=1)
        s.load("main", host="other.test")
        s.d.find_element(By.ID, "playBtn").click()
        time.sleep(6.5)  # the click's activation expires after 5 s
        check("playing audibly after a click", not s.info("main")["paused"], s.info("main"))
        s.set_audio(gain=2)
        check("boost chosen later, activation expired: still routed without another click",
              wait(lambda: s.item_status("main") == "routed", 8), s.status())
        time.sleep(0.4)
        r = s.ratio()
        check("...and boosted 2x", near(r, 2.0, 0.08), r)
    finally:
        s.quit()


# =============================================================== main

def main():
    forte_zip = latest_zip(ROOT)
    httpd = [server.serve(P1), server.serve(P2)]
    forte_dir = extract(forte_zip)
    tempo_dir = None
    print(f"Testing {forte_zip.name}")
    try:
        if "A" in ONLY:
            session_a(forte_dir)
        if "B" in ONLY:
            session_b(forte_dir)
        if "C" in ONLY:
            tempo_zip = latest_zip(GITHUB / "tempo-video-speed")
            print(f"Coexistence with {tempo_zip.name}")
            tempo_dir = extract(tempo_zip)
            session_c(forte_dir, tempo_dir)
        if "D" in ONLY:
            session_d(forte_dir)
    finally:
        failed = [n for n, ok in results if not ok]
        print(f"\n{len(results) - len(failed)}/{len(results)} passed")
        if failed:
            print("FAILED: " + ", ".join(failed))
        for h in httpd:
            h.shutdown()
        shutil.rmtree(forte_dir, ignore_errors=True)
        if tempo_dir:
            shutil.rmtree(tempo_dir, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
