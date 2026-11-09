// TEST ONLY, never shipped (tests/ is not in the zip). Added in front of
// content/forte.js in a test copy of the built add-on, active only on pages
// loaded with ?suspendctx=1.
//
// In Firefox 147 a page that already plays audible media can always start a
// new AudioContext, even under strict autoplay settings, so the case Forte
// guards against (a context Firefox keeps suspended until the user clicks,
// which would mute any player routed into it) can't be produced from a test.
// This shim reproduces exactly that: AudioContexts created by forte.js stay
// suspended, and resume() does nothing until a real (trusted) pointerdown on
// the page. Content scripts of one add-on share a sandbox, so this replaces
// the constructor for forte.js only, not for the page.
(() => {
  if (!/[?&]suspendctx=1/.test(location.search)) return;
  const Real = AudioContext;
  let unlocked = false;
  window.addEventListener("pointerdown", (e) => { if (e.isTrusted) unlocked = true; }, true);
  globalThis.AudioContext = function SuspendedUntilClick() {
    const ctx = new Real();
    ctx.suspend();
    const resume = ctx.resume.bind(ctx);
    ctx.resume = () => (unlocked ? resume() : Promise.resolve());
    return ctx;
  };
})();
