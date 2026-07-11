// Shared, MUTABLE library state.
//
// WHY A CONTAINER AND NOT PLAIN EXPORTS. An imported binding is READ-ONLY:
// `import { _treeStats }; _treeStats = x` throws. Of the library module's 28 outward
// bindings, 23 are only ever READ from outside, so they stay plain exports. These five
// are genuinely WRITTEN from outside — by showScreen (session teardown bumps the epoch,
// resets the page), deleteSongFromModal, and syncLibrarySong, none of which can move into
// the library module because they reach the playSong/showScreen core.
//
// So exactly these five move onto an object, and no more. `L.treeStats = x` is a property
// write, which works from any module holding the same `L`. Same shape as ./player-state.js.
//
// Add to it when a carve actually needs it, not before — a container is a shared mutable
// global with better manners, and every field on it is a coupling you have to keep true.
export const L = {
    /** Library tree stats (artist -> counts), cached from /api/library/tree-stats. */
    treeStats: null,
    /** Same, for the favourites tree. */
    favTreeStats: null,
    /** Tuning names, cached from /api/library/tuning-names. */
    tuningNames: null,
    /**
     * Session generation for the library. Bumped on teardown so an in-flight page fetch
     * that resolves against a stale library can't render into the new one.
     */
    libEpoch: 0,
    /** Current grid page (0-based). */
    currentPage: 0,
};
