# Browser and phone coverage

## What runs automatically (`pnpm test:browsers`)

| Suite | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| `determinism`, `ephemeris` (physics, bit-identical) | yes | yes | yes |
| `smoke` (load or the no-WebGL message, mission, typed launch, replay, share link, planner) | yes | yes | yes (Linux headless: load test only, see below) |
| `mobile` (phone, touch only: shell, map gestures, bottom sheet, planner, end to end to the in-process leaderboard) | yes | yes | no: Playwright Firefox cannot emulate a phone (`isMobile` unsupported) |
| `editor`, `interaction`, `features`, `orbit-time`, `vehicles`, `planner`, `leaderboard`, `planet-textures`, `scheduling`, `responsive` | yes | yes, except the tests marked below | no (smoke only, to bound the run time) |
| `distances` (text audit of labels) | yes | no: engine-independent strings | no |

Tests skipped on one engine say so in their own `test.skip(...)` with the reason:

- CDP-driven touch (`Input.dispatchTouchEvent`) and CPU throttling exist only in Chromium. The touch
  flows they cover run on WebKit in `mobile.e2e.ts`, through `e2e/touch.ts` (synthetic Pointer Events).
- `responsive` layout tests are skipped in WebKit: Playwright's WebKit is macOS WebKit, whose native
  `<select>` ignores `min-height` (the timeline's Fit menu measures 23 px instead of 44). No Mac has a
  touch screen and iOS Safari honours the height, so this is an emulation artefact, but it means the
  layout checks (map share, overlaps, tap targets) are not run in WebKit. Fixing it for real would mean
  `appearance: none` plus a drawn chevron on every touch-mode `<select>`.

**Firefox on Linux (CI).** Headless Firefox on Linux has no WebGL, whatever the prefs: `webgl.force-enabled`,
`webgl.disabled=false`, `gfx.webrender.software`, `webgl.forbid-software=false`, `webgl.out-of-process=false`
all still fail with `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS` (checked in the Playwright 1.65.1 Docker image).
Headed Firefox under Xvfb gets Mesa llvmpipe with no prefs at all. So in CI run
`PW_FIREFOX_HEADED=1 xvfb-run -a pnpm test:browsers` and Firefox gets the full smoke set; without it only the
load test (the "could not create a WebGL context" message) runs there. CI also sets `REQUIRE_WEBGL=1`, which makes a missing WebGL fail
the smoke tests instead of skipping them. WebKit and Chromium have WebGL headless
on Linux (WebKit: yes; Chromium: SwiftShader).

## What Playwright's WebKit is not

Playwright's WebKit is a build of WebKit for macOS (or Linux), not Safari and not iOS. For this app:

- **No iOS UI.** No on-screen keyboard (so no viewport shrink, no `inputmode` pad, no scroll-into-view of a
  focused field), no URL bar that collapses (`100dvh` vs `100vh` never differs), no notch (safe-area insets are
  always 0), no home indicator gesture area.
- **No browser gestures.** Page pinch-zoom, double-tap zoom, scroll and rubber-banding, long-press callouts and
  text selection loupes are iOS features; `touch-action`, `-webkit-touch-callout` and `user-select` are only
  checked as computed styles. `e2e/touch.ts` gestures are synthetic Pointer Events: they test the app's
  handlers, not the browser's.
- **Different form controls.** `<select>` opens a macOS menu, not the iOS wheel; date inputs differ.
- **Emulated screen.** `screen.width` is the host's unless the test sets `screen`; `navigator.maxTouchPoints`
  is 0; device pixel ratio is honoured but rendering runs on the Mac's GPU, so frame times say nothing about
  a phone's GPU, heat or battery.
- **Different GPU and WebGL limits.** iOS caps canvas memory and WebGL contexts and may lose the context when
  the tab is backgrounded; none of that happens on a Mac.
- **Different process model.** iOS suspends background tabs and may kill workers; Playwright never does.

## Manual check on real phones (about ten minutes each)

Do it on one iPhone (Safari) and one Android phone (Chrome), on the production site or a preview build reached
over the network (`pnpm build && pnpm preview --host`). Note the phone model and OS version.

1. **First load (1 min).** Open the site from a cold start. Look for: the map appears within a few seconds, no
   "WebGL" message, the bottom sheet sits above the home indicator, nothing hidden under the notch or the
   status bar in portrait.
2. **Map by touch (2 min).** One finger: drag to orbit; the page must not scroll or bounce, the address bar must
   not collapse or reappear. Fling: the view keeps turning briefly. Two fingers: pinch zooms the map only (the
   page text and the sheet keep their size); two-finger vertical drag tilts. Double-tap the Moon: it is
   focused, the page does not zoom. Long-press the map and a label: no callout, no text selection, no
   magnifier.
3. **Bottom sheet (1 min).** Tap the grip: peek, half, full in turn. Drag it to about two thirds: it stays.
   Scroll inside the sheet with a flick: it scrolls with momentum and stops at its ends without dragging the
   page or the map behind it.
4. **Keyboard (2 min).** Start tab: tap the launch azimuth field. Look for: a number pad that has a decimal
   separator, the page does not zoom in on focus, the field stays visible above the keyboard. Type a decimal
   with your phone's separator (comma on many European settings) and press Done: the value is taken. Tap the
   date jump field: a keyboard that can type `-` and `:`. Close the keyboard: the layout returns, no gap at the
   bottom, the sheet not stuck halfway.
5. **Plan by touch (2 min).** Pick the lunar flyby, tap near the trajectory, "Add node here", drag the node's
   drag strip left and right, tap the step buttons. Look for: every button easy to hit, no accidental map
   moves, values change by the expected steps.
6. **Rotate (30 s).** Turn to landscape and back, with the sheet half open and with the keyboard open. Look for:
   the layout re-flows, nothing under the notch on the side, no horizontal scrolling.
7. **Performance and heat (1 min).** Warp time for a minute with the map moving. Look for: smooth motion, the
   phone not noticeably warm, then pause and leave it still: the phone should cool (the app stops drawing
   when nothing moves).
8. **Background and return (30 s).** Switch to another app for a minute, come back. Look for: the map is still
   drawn (not black or blank), the plan is intact, warp resumes or stays paused as before.
9. **Shared link from another app (30 s).** "Copy share link", paste it into Messages / a chat app, tap it there.
   Look for: it opens in the browser (or an in-app browser) and shows the same flight; in an in-app browser
   note whether WebGL works.

Report anything off with the phone, OS, browser, step number and a screenshot or screen recording.
