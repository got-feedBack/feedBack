// The one <audio> element the whole app plays through.
//
// This exists so that code carved out of app.js can reach the player without
// importing app.js back — which would close a cycle and fail the import-x/no-cycle
// gate. It is the same handle app.js has always held (`document.getElementById`
// on the element in the shell), just given a home of its own.
//
// It is deliberately a `const`, and it is never reassigned anywhere in core — so a
// read-only import binding is exactly right, and no state container is needed.
// (Contrast the reassigned scalars — isPlaying, _avOffsetMs, … — which cannot be
// shared this way, because an imported binding cannot be written to.)
//
// Module scripts evaluate after the HTML is parsed, so the element is already in
// the document by the time this runs. app.js is loaded as <script type="module">,
// and its imports evaluate before its body — the same point at which app.js used
// to run this exact lookup itself.
export const audio = document.getElementById('audio');
