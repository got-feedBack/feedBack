// Regression test for feedBack#800: tuner injectPlayerButton() must anchor the
// injected button to a DIRECT-child button of #player-controls. The old
// `controls.querySelector('button:last-child')` could resolve to a NESTED
// button, and `controls.insertBefore(btn, nestedButton)` then throws
// NotFoundError — which propagated out of the player-screen transition and
// aborted its render.
//
// Same isolation strategy as the core tests/js suite: extract the real function
// from source with extractFunction() and run it in a vm sandbox over a small
// but faithful DOM model. The model's insertBefore() enforces the real DOM
// invariant (reference node must be a direct child, else NotFoundError), and
// querySelector() implements the exact semantics of both the old
// (`button:last-child`) and new (`:scope > button:last-of-type`) selectors — so
// reverting the fix makes this test throw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('../../../js/test_utils');

const UI_JS = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'tuner', 'utils', 'ui.js');
const SRC = fs.readFileSync(UI_JS, 'utf8');
const FN_SRC = extractFunction(SRC, 'function injectPlayerButton(');

// ── Minimal, faithful DOM model ──────────────────────────────────────────────

class El {
    constructor(tag, id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.children = [];
        this.parentNode = null;
        this.textContent = '';
        this.title = '';
        this.onclick = null;
    }
    appendChild(node) {
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    insertBefore(node, ref) {
        const idx = this.children.indexOf(ref);
        if (ref == null || idx === -1) {
            // Faithful to the browser: ref must be a direct child.
            const e = new Error(
                "Failed to execute 'insertBefore' on 'Node': The node before which the "
                + 'new node is to be inserted is not a child of this node.'
            );
            e.name = 'NotFoundError';
            throw e;
        }
        node.parentNode = this;
        this.children.splice(idx, 0, node);
        return node;
    }
    querySelector(sel) {
        if (sel === ':scope > button:last-of-type') {
            // Last direct-child <button>.
            const btns = this.children.filter((c) => c.tagName === 'BUTTON');
            return btns.length ? btns[btns.length - 1] : null;
        }
        if (sel === 'button:last-child') {
            // First descendant <button> (document order) that is the last child
            // of its own parent — the buggy legacy anchor.
            let found = null;
            const walk = (node) => {
                for (const c of node.children) {
                    if (found) return;
                    const isLast = c.parentNode.children[c.parentNode.children.length - 1] === c;
                    if (c.tagName === 'BUTTON' && isLast) { found = c; return; }
                    walk(c);
                }
            };
            walk(this);
            return found;
        }
        throw new Error(`unhandled selector in stub: ${sel}`);
    }
}

function findById(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
        const r = findById(c, id);
        if (r) return r;
    }
    return null;
}

// Run the extracted injectPlayerButton() against a given controls tree.
// Returns { controls, threw }.
function run({ controls, isV3 = false, slot = null }) {
    const roots = [controls, slot].filter(Boolean);
    const document = {
        getElementById(id) {
            if (id === 'player-controls') return controls;
            for (const r of roots) {
                const hit = findById(r, id);
                if (hit) return hit;
            }
            return null;
        },
        createElement(tag) { return new El(tag); },
    };
    const window = {
        feedBack: isV3
            ? { uiVersion: 'v3', ui: { playerControlSlot: () => slot } }
            : { uiVersion: 'v2' },
        tuner: { toggle: () => {} },
    };
    const sandbox = {
        window,
        document,
        Element: El,
        updatePlayerButton: () => {},
    };
    vm.createContext(sandbox);
    let threw = null;
    try {
        vm.runInContext(FN_SRC + '\nglobalThis.__run = injectPlayerButton;\n__run();', sandbox);
    } catch (e) {
        threw = e;
    }
    return { controls, slot, threw };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('does not throw when the last button is nested (feedBack#800 repro)', () => {
    // controls > div.transport > [play, close]; `close` is button:last-child of
    // the div but NOT a direct child of controls. The old anchor threw here.
    const controls = new El('div', 'player-controls');
    const transport = new El('div');
    transport.appendChild(new El('button', 'play'));
    transport.appendChild(new El('button', 'close'));
    controls.appendChild(transport);

    const { threw } = run({ controls });
    assert.equal(threw, null, threw && threw.message);
    // With no direct-child button, it appends to controls.
    assert.ok(findById(controls, 'btn-tuner-player'), 'tuner button was added');
    assert.equal(controls.children[controls.children.length - 1].id, 'btn-tuner-player');
});

test('inserts before the last direct-child button when one exists', () => {
    const controls = new El('div', 'player-controls');
    controls.appendChild(new El('button', 'play'));
    controls.appendChild(new El('button', 'close'));

    const { threw } = run({ controls });
    assert.equal(threw, null, threw && threw.message);
    const ids = controls.children.map((c) => c.id);
    // tuner button sits immediately before the last direct-child button.
    assert.deepEqual(ids, ['play', 'btn-tuner-player', 'close']);
});

test('appends when controls has no buttons at all', () => {
    const controls = new El('div', 'player-controls');
    controls.appendChild(new El('span'));
    const { threw } = run({ controls });
    assert.equal(threw, null, threw && threw.message);
    assert.equal(controls.children[controls.children.length - 1].id, 'btn-tuner-player');
});

test('is idempotent — a second call does not add a duplicate', () => {
    const controls = new El('div', 'player-controls');
    controls.appendChild(new El('button', 'close'));
    run({ controls });
    run({ controls });
    const injected = controls.children.filter((c) => c.id === 'btn-tuner-player');
    assert.equal(injected.length, 1);
});

test('v3 mounts into the plugin-control slot and never uses the legacy anchor', () => {
    const slot = new El('div', 'plugin-control-slot');
    // A nested button in the slot would trip the legacy anchor; v3 must ignore it.
    const inner = new El('div');
    inner.appendChild(new El('button', 'other'));
    slot.appendChild(inner);
    const controls = new El('div', 'player-controls');

    const { threw } = run({ controls, isV3: true, slot });
    assert.equal(threw, null, threw && threw.message);
    assert.ok(findById(slot, 'btn-tuner-player'), 'tuner button mounted into the slot');
    assert.equal(findById(controls, 'btn-tuner-player'), null, 'not mounted into #player-controls');
});
