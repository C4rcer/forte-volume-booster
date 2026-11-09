"""Capture the AMO listing screenshots (1280x800) of Forte in a real, muted Firefox.

  python tools/release.py build
  python tests/screenshots.py          (needs selenium + pillow)

Writes store-assets/screenshots/{1-popup,2-equalizer,3-options}.png. The demo
profile is seeded with example per-site settings so the UI isn't empty;
nothing here ships in the add-on. media.volume_scale is 0, so nothing plays aloud.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

os.environ.setdefault("SE_AVOID_STATS", "true")

from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402
from selenium import webdriver  # noqa: E402
from selenium.webdriver.common.by import By  # noqa: E402
from selenium.webdriver.firefox.options import Options  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "forte-volume-booster@c4rcer"
UUID = "4f0a7e2c-5b1d-4c8e-9f3a-0f0f0e000001"
PORT = 8972
DEMO_HOST = "news.example.com"  # mapped to 127.0.0.1 via network.dns.localDomains
BASE = f"http://{DEMO_HOST}:{PORT}/demo-page.html"
EXT = f"moz-extension://{UUID}"
OUT = ROOT / "store-assets" / "screenshots"
W, H = 1280, 800
DPR = 1.6  # a 800x500 CSS viewport fills 1280x800 crisply
FONTS = Path(r"C:\Windows\Fonts")

SEED = """
const voice = [-6, -5, -3, -1, 1, 3, 4.5, 4, 2, 0];
await browser.storage.local.set({
  sites: {
    "news.example.com": {gain: 2.5, preset: "voice", bands: voice, compressor: false, mono: false, balance: 0},
    "lectures.example.edu": {gain: 3, preset: "voice", bands: voice, compressor: true, mono: false, balance: 0},
    "podcasts.example.org": {gain: 1.8, preset: "bass", bands: [6, 5.5, 4.5, 2.5, 0.5, 0, 0, 0, 0, 0], compressor: false, mono: false, balance: 0},
    "music.example.net": {gain: 1.2, preset: "loudness", bands: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5], compressor: false, mono: false, balance: 0},
    "meet.example.com": {gain: 4, preset: "flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], compressor: false, mono: true, balance: 0},
  },
  settings: {blockedSites: ["radio.example.com"]},
  usage: {days: 3, last: "2026-11-01"},
});
return true;
"""


def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def fit(img):
    canvas = Image.new("RGB", (W, H), (18, 16, 15))
    canvas.paste(img.crop((0, 0, min(W, img.width), min(H, img.height))), (0, 0))
    return canvas


def card_with_shadow(card, radius=14):
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width - 1, card.height - 1), radius, fill=255)
    pad = 30
    shadow = Image.new("RGBA", (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    sm = Image.new("L", shadow.size, 0)
    ImageDraw.Draw(sm).rounded_rectangle((pad, pad + 6, pad + card.width, pad + card.height + 6), radius, fill=160)
    shadow.putalpha(sm.filter(ImageFilter.GaussianBlur(14)))
    shadow.paste(card, (pad, pad), mask)
    return shadow


def scale_to(img, max_w, max_h):
    k = min(1.0, max_w / img.width, max_h / img.height)
    if k < 1:
        img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    return img


def main():
    zips = sorted((ROOT / "dist").glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if not zips:
        sys.exit("build first: python tools/release.py build")
    httpd = server.serve(PORT)

    opts = Options()
    opts.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
    opts.add_argument("-headless")
    for k, v in {
        "media.volume_scale": "0.0",
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
        "extensions.webextensions.uuids": json.dumps({ADDON_ID: UUID}),
        "ui.systemUsesDarkTheme": 1,
        "layout.css.prefers-color-scheme.content-override": 0,
        "layout.css.devPixelsPerPx": str(DPR),
        "network.dns.localDomains": DEMO_HOST,
        "dom.security.https_first": False,
        "dom.security.https_first_schemeless": False,
    }.items():
        opts.set_preference(k, v)
    driver = webdriver.Firefox(options=opts)
    unpacked = Path(tempfile.mkdtemp(prefix="forte-shots-"))
    OUT.mkdir(parents=True, exist_ok=True)

    def ext(code):
        return driver.execute_async_script(
            "const done = arguments[arguments.length - 1];"
            f"(async () => {{ {code} }})().then(done, (e) => done('ERR ' + e));")

    def set_viewport(cw, ch):
        driver.set_window_size(cw, ch)
        inner = driver.execute_script("return [innerWidth, innerHeight]")
        driver.set_window_size(cw + (cw - inner[0]), ch + (ch - inner[1]))

    try:
        with zipfile.ZipFile(zips[-1]) as z:
            z.extractall(unpacked)
        driver.execute("INSTALL_ADDON", {"path": str(unpacked), "temporary": True})
        time.sleep(1)
        set_viewport(int(W / DPR), int(H / DPR))

        driver.get(f"{EXT}/options/options.html")
        ext(SEED)

        # The demo page with its video playing, boosted to 250% with the Voice EQ.
        page = driver.current_window_handle
        driver.get(BASE)
        driver.execute_async_script("const d = arguments[arguments.length - 1]; window.ready.then(() => d(1));")
        driver.execute_script("const v = document.getElementById('main'); v.currentTime = 1.2; v.play();")
        time.sleep(2.5)
        base_path = OUT / "_base.png"
        driver.save_screenshot(str(base_path))

        driver.switch_to.new_window("tab")
        popup_win = driver.current_window_handle
        set_viewport(420, 760)
        driver.get(f"{EXT}/popup/popup.html")
        tab_id = ext(f"const t = (await browser.tabs.query({{}})).find((x) => x.url.startsWith('{BASE}')); return t.id;")

        def popup_shot(name, audio=None):
            if audio:
                ext(f"const t = await browser.tabs.get({tab_id});"
                    f"await browser.runtime.sendMessage({{type: 'forte:set', tabId: {tab_id}, url: t.url, audio: {json.dumps(audio)}}});"
                    "return true;")
            driver.get(f"{EXT}/popup/popup.html?tab={tab_id}")
            time.sleep(2.2)  # status + level meter settle
            path = OUT / f"_{name}.png"
            driver.find_element(By.TAG_NAME, "body").screenshot(str(path))
            return Image.open(path).convert("RGBA")

        # 1: popup over the page.
        pop = popup_shot("popup1")
        base = fit(Image.open(base_path)).convert("RGBA")
        base = Image.alpha_composite(base, Image.new("RGBA", base.size, (0, 0, 0, 80)))
        card = card_with_shadow(scale_to(pop, 520, H - 40))
        base.alpha_composite(card, (W - card.width - 4, max(-10, (H - card.height) // 2)))
        base.convert("RGB").save(OUT / "1-popup.png")

        # 2: the equalizer, with the night-mode leveller on.
        pop = popup_shot("popup2", {"gain": 1.8, "preset": "voice", "compressor": True, "mono": False, "balance": 0})
        # Smooth diagonal background: a 2x2 image of corner colours, upscaled.
        corners = Image.new("RGB", (2, 2))
        corners.putdata([(62, 32, 18), (30, 22, 18), (24, 18, 16), (16, 13, 12)])
        canvas = corners.resize((W, H), Image.BICUBIC)
        card = card_with_shadow(scale_to(pop, 520, H - 40))
        canvas = canvas.convert("RGBA")
        canvas.alpha_composite(card, (40, (H - card.height) // 2))
        d = ImageDraw.Draw(canvas)
        x = 40 + card.width + 40
        d.text((x, 150), "10-band equalizer", font=font("segoeuib.ttf", 46), fill=(246, 237, 230))
        lines = [
            ("Presets", "Voice, bass and treble boost, loudness, laptop speakers, music styles"),
            ("Your own curve", "Drag any band, +/-12 dB"),
            ("Night mode", "Quiet dialogue up, sudden explosions down"),
            ("Mono and balance", "For one earbud or uneven speakers"),
            ("Per site", "Every site keeps its own volume and EQ"),
        ]
        y = 240
        for head, body in lines:
            d.text((x, y), head, font=font("seguisb.ttf", 25), fill=(251, 146, 60))
            d.text((x, y + 34), body, font=font("segoeui.ttf", 20), fill=(214, 200, 190))
            y += 92
        canvas.convert("RGB").save(OUT / "2-equalizer.png")

        # 3: options, composed from its cards (news.example.com back to its seeded 250%).
        ext(f"const t = await browser.tabs.get({tab_id});"
            f"await browser.runtime.sendMessage({{type: 'forte:set', tabId: {tab_id}, url: t.url, "
            "audio: {gain: 2.5, preset: 'voice', compressor: false, mono: false, balance: 0}}); return true;")
        driver.get(f"{EXT}/options/options.html")
        set_viewport(900, 1400)
        time.sleep(1.0)
        driver.execute_script(
            "const st = document.createElement('style');"
            "st.textContent = '.page { max-width: 560px; padding: 0 } .card { margin: 0 }';"
            "document.head.append(st);")
        time.sleep(0.4)

        def section(el_id, name):
            el = driver.find_element(By.ID, el_id).find_element(By.XPATH, "./ancestor::section")
            path = OUT / f"_{name}.png"
            el.screenshot(str(path))
            return Image.open(path).convert("RGB")

        left = [section("remember", "general"), section("clash-youtube.com", "clash")]
        right = [section("sites", "sites"), section("aloneText", "alone")]
        bg = driver.execute_script("return getComputedStyle(document.body).backgroundColor")
        rgb = tuple(int(x) for x in bg[bg.index("(") + 1:bg.index(")")].split(",")[:3])
        canvas = Image.new("RGB", (W, H), rgb)
        gap = 24

        def col_h(col):
            return sum(i.height for i in col) + gap * (len(col) - 1)

        tall = max(col_h(left), col_h(right))
        wide = max(i.width for i in left) + max(i.width for i in right) + gap
        k = min(1.0, (H - 2 * gap) / tall, (W - 2 * gap) / wide)
        if k < 1:
            left = [i.resize((round(i.width * k), round(i.height * k)), Image.LANCZOS) for i in left]
            right = [i.resize((round(i.width * k), round(i.height * k)), Image.LANCZOS) for i in right]
        lw = max(i.width for i in left)
        rw = max(i.width for i in right)
        x_l = (W - lw - rw - gap) // 2
        x_r = x_l + lw + gap
        for col, x in ((left, x_l), (right, x_r)):
            y = max(16, (H - col_h(col)) // 2)
            for img in col:
                canvas.paste(img, (x, y))
                y += img.height + gap
        canvas.save(OUT / "3-options.png")
        driver.switch_to.window(page)
        driver.switch_to.window(popup_win)
    finally:
        driver.quit()
        httpd.shutdown()
        shutil.rmtree(unpacked, ignore_errors=True)
        for tmp in OUT.glob("_*.png"):
            tmp.unlink()
    for p in sorted(OUT.glob("*.png")):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
