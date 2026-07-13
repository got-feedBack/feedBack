// Blob export helpers — the download idiom that used to be duplicated in
// settings-io.js and diagnostics-export.js, plus image-to-clipboard for
// shareable cards/posters. A LEAF module: imports nothing. Classic-script
// plugins reach it via dynamic import('/static/js/blob-io.js').

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Copy an image blob to the system clipboard. Returns true on success, false
// when the Clipboard API is unavailable or refuses (insecure context, no user
// gesture, permission denied) — callers fall back to downloadBlob and say so.
export async function copyImageBlob(blob) {
    try {
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        return true;
    } catch (_) {
        return false;
    }
}
