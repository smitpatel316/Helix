// Let the progress line paint before the conversion starts.
//
// The Convert dialog awaits this before doing the real work in either
// direction (prism-to-hlx and hlx-to-prism), so the progress text is on
// screen while the conversion runs.
//
// This used to yield with requestAnimationFrame — the only awaited rAF in
// the app. In the built Tauri webview rAF only fires while the window is
// the active/key window: driven without focus (the Mac proof agent never
// steals focus), the callback never runs, so the dialog sat on its progress
// line forever at 0% CPU in both directions, Cancel still working, while
// the same file imported via File ▸ Import in seconds (Import never awaits
// a frame). A timer always fires, focused or not, so yield on that instead:
// React has flushed the progress update by the time the timer runs, and the
// browser paints before the conversion starts. Never gate progress on the
// frame scheduler again.
export const yieldToPaint = () => new Promise<void>((r) => setTimeout(() => r(), 0));
