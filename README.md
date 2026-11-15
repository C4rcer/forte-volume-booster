# Forte: Volume Booster & Equalizer

Firefox add-on (desktop + Android) that boosts and shapes the sound of audio and
video players on any site. Free, every feature unlocked, no ads, no tracking,
optional Ko-fi tip.

Why this one: on AMO, "Volume Control" has ~78k daily users at 3.8 stars,
"Volume Booster" ~15k at 2.4 stars (last update 2023), "Audio Equalizer" ~53k.
A common complaint with Firefox boosters is videos going silent. Forte is built
around not doing that.

## Features

- Volume 0% to 600% (slider, +/- in 10% steps, presets), per tab
- Limiter (hard knee at -3 dBFS, 20:1, then a soft clipper that never exceeds
  ~0.985) so big boosts don't crackle; its makeup gain is cancelled, so 300% is
  exactly 3x below the threshold. Can be turned off in settings
- 10-band EQ (32 Hz to 16 kHz, +/-12 dB) with 12 presets (Voice, Bass/Treble
  boost and reduce, Loudness, Laptop speakers, Rock, Pop, Electronic, Classical,
  Acoustic) or a custom curve
- "Even out loud and quiet parts" leveller (night mode), mono, left/right balance
- Remembers volume + EQ per site (default), one setting everywhere, or nothing
- One-click off per site, global pause, toolbar badge with the boost (amber "!"
  when the boost is on but no player could take it), live output meter with a
  limiter indicator
- Works in iframes and in open or closed shadow DOM players
- Injects into already-open tabs on install

## Not muting anyone's video

Firefox has no `tabCapture`, so the only way to process a page's sound is
`createMediaElementSource` in the content script. That is one-way: once an
element is routed, its sound only reaches the speakers through the add-on's
graph. Behaviour measured in Firefox 147 (headless, muted) while building this:

| Case | What Firefox does once routed |
| --- | --- |
| Same-origin file, MediaSource (blob:), CORS-approved cross-origin | Real samples |
| Cross-origin without CORS headers | Exact silence: the video goes mute |
| Same-origin URL that **redirects** to another origin without CORS | Exact silence (a URL check alone misses this) |
| AudioContext not allowed to start (autoplay blocking) | Silence until it starts. In practice Firefox lets a page start Web Audio once it plays audible media, even under strict (transient-activation) autoplay settings |
| Second `createMediaElementSource` on the same element (any context) | **No `InvalidStateError`** (unlike the spec and Chromium): both graphs get the sound, so two add-ons double it |
| Element `volume` / `muted` on a routed file or MSE element | Still applied |
| Element `volume` / `muted` on a routed `srcObject` MediaStream (web calls) | **Ignored** |

So `src/content/forte.js` follows these rules:

1. Nothing is touched until the user raises the volume or picks an EQ, and no
   AudioContext exists until a player actually plays with sound. At 100% with a
   flat EQ there is none at all.
2. Never route into an AudioContext that isn't running. Should Firefox ever hold
   it suspended, the player keeps playing untouched, the popup asks for one click
   on the page and routing waits for it.
3. Cross-origin media without `crossorigin` + CORS is skipped by URL.
4. Everything else is probed first with `mozCaptureStream()` into a
   `MediaStreamAudioSourceNode` (same cross-origin rule, but it doesn't take the
   sound away). One non-zero sample proves routing is safe; only zeros for 6 s
   while it plays audibly means a blocked source (e.g. a redirect), and the
   player is left alone. Players that can't be captured (DRM) are routed only
   when their source is a same-origin MediaSource.
5. `createMediaElementSource` is wrapped: `InvalidStateError` (or anything else)
   marks the player as handled by someone else and it is skipped.
6. For `srcObject` MediaStream players, Forte mirrors the element's own volume
   and mute in a per-player gain node, so muting a call participant keeps working.
7. A routed player that later switches to a blocked source can't be handed back;
   the popup notices the silence and suggests a reload.

## Living with other add-ons

- **YouTube/Twitch Enhancer** (YTE) routes the YouTube/Twitch `<video>` through
  its own AudioContext when its volume boost or compressor is on. Since Firefox
  lets both graphs have the sound, the clash would be doubled audio. Forte is
  therefore **off on youtube.com and twitch.tv** (all subdomains, including
  embeds on other sites) until the user opts in from the popup or settings; the
  popup says why. Even when opted in, Forte skips any element YTE has marked
  (`data-ytb-boost-wired`), and steps back (disconnects its own path) if YTE
  routes a video Forte already routed. Forte marks the elements it routes with
  `data-forte-wired`, which YTE could check in a future version.
- **Tempo: Video Speed Controller** only sets `playbackRate` / `preservesPitch`.
  Tested together: Tempo's keys and remembered speed still work on routed
  players, playback runs at the chosen speed through Forte's graph, and Forte's
  gain is unaffected. One quirk measured in an exploration run: a routed player
  keeps its pitch at 2x even with Tempo's "keep voices at normal pitch" turned
  off (Firefox time-stretches captured audio). Tempo's default is pitch-preserving,
  so only users who turned that option off would notice.
- Any other add-on or site script that routes the same element: in Firefox both
  get the sound. Forte cannot see graphs made by other add-ons; the per-site
  off switch is the escape hatch.

## Known limitations

- Players never attached to the document (`new Audio()` kept only in script) are
  invisible to content scripts, so they can't be boosted.
- Routing can't be undone without a reload (a Web Audio rule). Turning Forte off
  for the site makes routed players play unchanged instead.

## Layout

```
src/                       everything that ships
  manifest.json
  background.js            memory (site / global / tab), frame status, badge (event page, ES module)
  content/forte.js         per-frame player discovery, safety checks, Web Audio chain (classic script)
  popup/                   toolbar popup (?tab=<id> opens it against a tab, for tests)
  options/                 settings page
  shared/settings.js       defaults, EQ presets, helpers for background/popup/options
  shared/support.*         Ko-fi pill + milestone thank-you card (from the template)
  shared/more-addons.*     "More free add-ons" card + rate link (same file in every add-on; set `live: true` as listings are approved)
store-assets/listing.json  AMO listing text, categories, Ko-fi contributions_url
store-assets/screenshots/  1280x800 listing images (made by tests/screenshots.py)
tests/                     real-Firefox E2E, screenshot generator, local media server (not shipped)
tools/release.py           build / lint / submit / status / contrib / screenshots
```

## Develop and test

```powershell
python tools/release.py lint                 # build + web-ext lint the zip (expect 0/0/0)
python -m pip install selenium pillow        # once, ideally in a venv, for the tests
python tests/e2e_firefox.py                  # 82 checks in headless Firefox, 4 sessions
python tests/e2e_firefox.py --only=A         # just one session (A, B, C, D)
python tests/screenshots.py                  # regenerate store screenshots
```

Every test browser runs with `media.volume_scale = 0.0`, so nothing is ever
audible; levels are measured inside the page by Forte's own AnalyserNodes
(input before the chain, output after it) on exact sine tones served by
`tests/server.py` from two origins.

| Session | Covers |
| --- | --- |
| A | untouched by default, 300% measured as 3x, limiter (600% of a -6 dBFS tone peaks at 0.76; off: 3.0), EQ presets measured at 100 Hz / 8 kHz, popup EQ select and band drag, per-site and global memory, CORS-silent skip by URL and by probe (redirect) with a page-side control proving those players really go silent when routed, CORS-enabled player boosted, closed shadow DOM, iframes, site's own volume/mute on routed file and MediaStream players, one-click off (back to 1x at once), YouTube/Twitch off by default + popup opt-in, embedded YouTube left alone, YTE-routed players left to YTE (before and after) |
| B | two cases Firefox 147 can't be made to produce, via test shims added to a test copy of the zip (`tests/shim-*.js`, never shipped): the `InvalidStateError` fallback, and an AudioContext held suspended until a click (player left playing untouched, popup asks for a click, routed after it) |
| C | Forte + Tempo installed together (Tempo's zip from `../tempo-video-speed/dist/`): Tempo's keys and remembered speed on a routed player, real 2x playback through the graph, Forte's gain unaffected |
| D | strict autoplay (transient activation, as in hardened profiles): no AudioContext while nothing plays, routed right after the user's click, a boost chosen later still applies |

Manual: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `src/manifest.json`.

## Release

```powershell
python tools/release.py submit --notes "First release"
python tools/release.py screenshots          # after the listing exists
python tools/release.py status
```

Bump `version` in `src/manifest.json` for every later submit.
