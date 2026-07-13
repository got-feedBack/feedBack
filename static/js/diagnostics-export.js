// The diagnostics-bundle export — the Settings "Export diagnostics" flow.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: imports nothing.
// It snapshots the browser-only state (console ring buffer, hardware probe,
// localStorage, ua) via window.feedBack.diagnostics, POSTs it to
// /api/diagnostics/export with the user's include/redact toggles, and streams the
// returned zip to disk. Bundle layout + schemas: docs/diagnostics-bundle-spec.md.
//
// Everything except the two entry points is module-private — the preview
// renderer, the file-label table, and the byte/HTML formatters are used nowhere
// else in core.

//
// Companion to Settings export but for troubleshooting bug reports.
// Bundle layout + schemas: docs/diagnostics-bundle-spec.md.
//
// Frontend's job is to:
//   1. Snapshot the browser-only state (console ring buffer, hardware
//      probe, localStorage, ua) via window.feedBack.diagnostics.
//   2. POST it to /api/diagnostics/export with the user's include /
//      redact toggles.
//   3. Stream the returned zip to disk.

import { downloadBlob } from './blob-io.js';

function _diagIncludeFromUI() {
    const v = (id) => document.getElementById(id)?.checked !== false;
    return {
        system: v('diag-incl-system'),
        hardware: v('diag-incl-hardware'),
        logs: v('diag-incl-logs'),
        console: v('diag-incl-console'),
        plugins: v('diag-incl-plugins'),
    };
}

function _diagRedactFromUI() {
    const el = document.getElementById('diag-redact');
    return el ? !!el.checked : true;
}

// Map raw file paths inside the bundle to plain-English labels +
// descriptions for the preview UI. Only paths that show up in
// previews need entries — unknown paths fall back to the path itself.
const _DIAG_FILE_LABELS = {
    'system/version.json':   { label: 'App version',    desc: 'FeedBack version, Python, OS' },
    'system/env.json':       { label: 'Environment',    desc: 'Allowlisted env vars (LOG_LEVEL, etc.). No secrets.' },
    'system/hardware.json':  { label: 'Hardware (server-side)', desc: 'CPU, RAM, GPU. In Docker this reflects the container, not the host.' },
    'system/plugins.json':   { label: 'Plugins',        desc: 'Loaded plugins + git commit + orphan detection.' },
    'logs/server.log':       { label: 'Server log',     desc: 'Tail of LOG_FILE (last ~5 MB).' },
    'logs/server.log.meta.json': { label: 'Log metadata', desc: 'Log file path, size, rotation info.' },
    'client/console.json':   { label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' },
    'client/hardware.json':  { label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' },
    'client/local_storage.json': { label: 'Browser storage', desc: 'localStorage contents (preferences).' },
    'client/ua.json':        { label: 'User agent',     desc: 'Browser, screen, page URL.' },
};

function _formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function _renderDiagPreview(data) {
    const m = data.manifest || {};
    const files = m.files || [];
    const groups = { system: [], logs: [], client: [], plugins: [], other: [] };
    for (const f of files) {
        const top = (f.path || '').split('/')[0];
        (groups[top] || groups.other).push(f);
    }
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const sections = [];
    // Per-file `summary` (server-derived) → human one-liner.
    function _summaryLine(path, summary) {
        if (!summary || typeof summary !== 'object') return '';
        if (path === 'system/plugins.json') {
            const loaded = summary.loaded_count || 0;
            const orphans = summary.orphan_count || 0;
            const orphPart = orphans ? ` · <span class="text-amber-400">${orphans} orphan${orphans === 1 ? '' : 's'}</span>` : '';
            return `${loaded} plugin${loaded === 1 ? '' : 's'} loaded${orphPart}`;
        }
        if (path === 'client/console.json') {
            const total = summary.entry_count || 0;
            const lvl = summary.by_level || {};
            const parts = [];
            for (const k of ['error','warn','info','log','debug']) {
                if (lvl[k]) parts.push(`${lvl[k]} ${k}`);
            }
            return `${total} entries${parts.length ? ' (' + parts.join(', ') + ')' : ''}`;
        }
        if (path === 'system/hardware.json') {
            const bits = [];
            if (summary.cpu_brand) bits.push(summary.cpu_brand);
            if (summary.cores_logical) bits.push(`${summary.cores_logical} cores`);
            if (summary.gpu_count) bits.push(`${summary.gpu_count} GPU`);
            if (summary.runtime) bits.push(`runtime: ${summary.runtime}`);
            return bits.join(' · ');
        }
        if (path === 'client/hardware.json') {
            const bits = [];
            if (summary.runtime) bits.push(summary.runtime);
            if (summary.webgl_renderer) bits.push(summary.webgl_renderer);
            return bits.join(' · ');
        }
        if (path === 'client/local_storage.json') {
            return `${summary.key_count || 0} keys`;
        }
        if (path === 'system/version.json') {
            const bits = [];
            if (summary.feedBack) bits.push(`feedBack ${summary.feedBack}`);
            if (summary.python) bits.push(`python ${summary.python}`);
            if (summary.os) bits.push(summary.os);
            return bits.join(' · ');
        }
        return '';
    }

    function pushSection(title, list, emptyHint) {
        if (!list.length) {
            if (emptyHint) {
                sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div><div class="text-gray-500">${_escapeHtml(emptyHint)}</div></div>`);
            }
            return;
        }
        const rows = list.map(f => {
            const meta = _DIAG_FILE_LABELS[f.path] || { label: f.path, desc: '' };
            const summary = _summaryLine(f.path, f.summary);
            const summaryHtml = summary
                ? `<div class="text-accent-light text-[10px] mt-0.5">${summary}</div>`
                : '';
            return `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
                <div class="min-w-0">
                    <div class="text-gray-200">${_escapeHtml(meta.label)}</div>
                    <div class="text-gray-500 text-[10px]">${_escapeHtml(meta.desc)}</div>
                    ${summaryHtml}
                </div>
                <div class="text-gray-400 text-right whitespace-nowrap">${_escapeHtml(_formatBytes(f.size))}</div>
            </div>`;
        }).join('');
        sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div>${rows}</div>`);
    }

    pushSection('System', groups.system, include.system ? '' : 'Skipped (toggle off)');
    pushSection('Server logs', groups.logs, include.logs
        ? 'No log file configured — set LOG_FILE env var to include server logs.'
        : 'Skipped (toggle off)');
    pushSection('Plugin diagnostics', groups.plugins, include.plugins
        ? 'No plugins have opted in to diagnostics.'
        : 'Skipped (toggle off)');

    // Client section preview is a server-side estimate only — actual
    // client/* payloads are added at Export time after the browser
    // snapshots. Show what WILL be added, not file sizes.
    const clientLines = [];
    if (include.console) clientLines.push({ label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' });
    if (include.hardware) clientLines.push({ label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' });
    clientLines.push({ label: 'Browser storage', desc: 'localStorage contents (preferences).' });
    clientLines.push({ label: 'User agent', desc: 'Browser, screen, page URL.' });
    const clientHtml = clientLines.map(c => `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
        <div><div class="text-gray-200">${_escapeHtml(c.label)}</div><div class="text-gray-500 text-[10px]">${_escapeHtml(c.desc)}</div></div>
        <div class="text-gray-500 text-right whitespace-nowrap">added on export</div>
    </div>`).join('');
    sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">Browser data</div>${clientHtml}</div>`);

    const notesHtml = (m.notes || []).length
        ? `<div class="mb-3 bg-dark-600 border border-amber-500/30 rounded-lg p-2">
              <div class="text-amber-400 text-[10px] font-semibold uppercase mb-1">Notes</div>
              ${(m.notes).map(n => `<div class="text-gray-300 text-[11px]">• ${_escapeHtml(n)}</div>`).join('')}
           </div>`
        : '';

    const privacyHtml = redact
        ? `<div class="text-emerald-400 text-[11px]">🔒 Redaction enabled — paths, song names, IPs, and secrets will be replaced with stable hash tokens.</div>`
        : `<div class="text-amber-400 text-[11px]">⚠ Redaction OFF — bundle will contain raw paths, song names, and IPs. Only share with people you trust.</div>`;

    return `
        <div class="text-[11px]">
            <div class="flex justify-between items-baseline mb-2">
                <div class="text-gray-200 font-semibold">${_escapeHtml(data.filename)}</div>
                <div class="text-gray-400">${_escapeHtml(_formatBytes(totalBytes))}<span class="text-gray-600"> server-side</span></div>
            </div>
            <div class="text-gray-500 text-[10px] mb-3">runtime: ${_escapeHtml(m.runtime || 'unknown')} · exported_at: ${_escapeHtml(m.exported_at || '')}</div>
            ${notesHtml}
            ${sections.join('')}
            ${privacyHtml}
        </div>`;
}

export async function previewDiagnostics() {
    const status = document.getElementById('diag-status');
    const preview = document.getElementById('diag-preview');
    if (!status || !preview) return;
    status.textContent = 'Building preview…';
    preview.classList.add('hidden');
    const include = _diagIncludeFromUI();
    const params = new URLSearchParams({
        redact: String(_diagRedactFromUI()),
        system: String(include.system),
        hardware: String(include.hardware),
        logs: String(include.logs),
        console: String(include.console),
        plugins: String(include.plugins),
    });
    try {
        const resp = await fetch(`/api/diagnostics/preview?${params.toString()}`);
        if (!resp.ok) {
            status.textContent = `Preview failed (HTTP ${resp.status})`;
            return;
        }
        const data = await resp.json();
        preview.innerHTML = _renderDiagPreview(data);
        preview.classList.remove('hidden');
        status.textContent = 'Preview ready.';
    } catch (e) {
        status.textContent = `Preview failed: ${e.message}`;
    }
}

export async function exportDiagnostics() {
    const status = document.getElementById('diag-status');
    if (!status) return;
    status.textContent = 'Building bundle…';
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const diag = window.feedBack && window.feedBack.diagnostics;
    const body = {
        redact,
        include,
        client_console: include.console && diag ? diag.snapshotConsole() : null,
        client_hardware: include.hardware && diag ? await diag.snapshotHardware() : null,
        client_ua: diag ? diag.snapshotUa() : null,
        local_storage: diag ? diag.snapshotLocalStorage() : null,
        client_contributions: diag ? diag.snapshotContributions() : null,
    };

    let resp;
    try {
        resp = await fetch('/api/diagnostics/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
        return;
    }
    if (!resp.ok) {
        status.textContent = `Export failed (HTTP ${resp.status})`;
        return;
    }
    let filename = 'feedBack-diag.zip';
    const disp = resp.headers.get('Content-Disposition');
    if (disp) {
        const m = /filename="([^"]+)"/.exec(disp);
        if (m) filename = m[1];
    }
    try {
        const blob = await resp.blob();
        downloadBlob(blob, filename);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed during download: ${e.message}`;
    }
}
