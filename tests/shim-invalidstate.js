// TEST ONLY, never shipped (tests/ is not in the zip). Added in front of
// content/forte.js in a test copy of the built add-on.
//
// Firefox 147 lets several AudioContexts call createMediaElementSource on the
// same element without complaint, so the spec's InvalidStateError (what
// Chromium throws, and what Firefox may throw one day) can't be provoked from
// a page. This shim makes Forte's own calls behave per spec for elements the
// test page marks as already claimed, so Forte's real fallback path runs in a
// real browser. Content scripts of one add-on share a sandbox, so the override
// is visible to forte.js (and only to it).
(() => {
  const proto = AudioContext.prototype;
  const original = proto.createMediaElementSource;
  proto.createMediaElementSource = function (el) {
    if (el && el.hasAttribute && el.hasAttribute("data-test-claimed")) {
      throw new DOMException("HTMLMediaElement already connected previously to a different MediaElementSourceNode.", "InvalidStateError");
    }
    return original.call(this, el);
  };
})();
