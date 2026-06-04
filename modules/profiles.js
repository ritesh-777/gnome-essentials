// GNOME Essentials: Sleek, Modular Desktop Utilities
// Author: Ritesh Seth
// License: GPL v3
//
// modules/profiles.js (Workspace Session Restorer Module)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DEBUG = true;
const MAX_GEOMETRY_VALUE = 100000;
const MAX_TILE_RATIO = 1000;
const SAFETY_SNAPSHOT_DEBOUNCE_MS = 1200;
const SAFETY_SNAPSHOT_INITIAL_DELAY_MS = 1000;

function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][Profiles] ' + msg);
}

function logError(msg) {
    console.error('[GnomeEssentials][Profiles] ERROR: ' + msg);
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveFiniteNumber(value, fallback = 1) {
    const number = finiteNumber(value, fallback);
    return number > 0 ? number : fallback;
}

function boundedNumber(value, fallback, min, max) {
    const number = finiteNumber(value, fallback);
    return Math.max(min, Math.min(max, number));
}

function isReasonableNumber(value, maxAbs) {
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= maxAbs;
}

class TilingAssistantCompatRect {
    constructor(rect, frameRect = null) {
        this._rect = this._toNativeRect(rect);
        this._frameRect = frameRect ? this._toNativeRect(frameRect) : null;
    }

    _toNativeRect(rect) {
        const source = rect?.meta || rect || {};
        let result = null;

        if (source && typeof source.copy === 'function') {
            result = source.copy();
        } else {
            try {
                result = global.display.get_monitor_geometry(0).copy();
            } catch (e) {
                result = {};
            }
        }

        result.x = Math.floor(finiteNumber(source.x, 0));
        result.y = Math.floor(finiteNumber(source.y, 0));
        result.width = Math.floor(positiveFiniteNumber(source.width, 1));
        result.height = Math.floor(positiveFiniteNumber(source.height, 1));
        return result;
    }

    _coerce(rect) {
        return this._toNativeRect(rect);
    }

    addGaps() {
        return this._frameRect ? new TilingAssistantCompatRect(this._frameRect) : this.copy();
    }

    containsRect(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.contains_rect === 'function') {
            return this._rect.contains_rect(other);
        }
        return other.x >= this.x &&
            other.y >= this.y &&
            other.x + other.width <= this.x2 &&
            other.y + other.height <= this.y2;
    }

    containsPoint(point) {
        return point.x >= this.x &&
            point.x <= this.x2 &&
            point.y >= this.y &&
            point.y <= this.y2;
    }

    copy() {
        return new TilingAssistantCompatRect(this._rect);
    }

    equal(rect) {
        const other = this._coerce(rect);
        return this.x === other.x &&
            this.y === other.y &&
            this.width === other.width &&
            this.height === other.height;
    }

    getNeighbor(dir, rects, wrap = true) {
        let startProp = 'x';
        let compareProp = 'x2';
        let nonCompareProp = 'y';
        if (dir === 1) {
            [startProp, compareProp, nonCompareProp] = ['y', 'y2', 'x'];
        } else if (dir === 4) {
            [startProp, compareProp, nonCompareProp] = ['y2', 'y', 'x'];
        } else if (dir === 8) {
            [startProp, compareProp, nonCompareProp] = ['x', 'x2', 'y'];
        } else if (dir === 2) {
            [startProp, compareProp, nonCompareProp] = ['x2', 'x', 'y'];
        }

        const candidates = (rects || []).filter(rect => rect && !this.equal(rect));
        if (!candidates.length) return null;

        const forward = dir === 4 || dir === 2;
        const neighbors = candidates
            .filter(rect => forward ? rect[compareProp] >= this[startProp] : rect[compareProp] <= this[startProp])
            .sort((a, b) => {
                const primary = Math.abs(a[compareProp] - this[startProp]) -
                    Math.abs(b[compareProp] - this[startProp]);
                if (primary !== 0) return primary;
                return Math.abs(a[nonCompareProp] - this[nonCompareProp]) -
                    Math.abs(b[nonCompareProp] - this[nonCompareProp]);
            });

        return neighbors[0] || (wrap ? candidates[0] : null);
    }

    horizOverlap(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.horiz_overlap === 'function') {
            return this._rect.horiz_overlap(other);
        }
        return this.x < other.x + other.width && this.x2 > other.x;
    }

    intersect(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.intersect === 'function') {
            const [ok, intersection] = this._rect.intersect(other);
            return [ok, new TilingAssistantCompatRect(intersection)];
        }

        const x1 = Math.max(this.x, other.x);
        const y1 = Math.max(this.y, other.y);
        const x2 = Math.min(this.x2, other.x + other.width);
        const y2 = Math.min(this.y2, other.y + other.height);
        const ok = x2 > x1 && y2 > y1;
        const intersection = ok
            ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
            : { x: 0, y: 0, width: 0, height: 0 };
        return [ok, new TilingAssistantCompatRect(intersection)];
    }

    minus(rect) {
        if (Array.isArray(rect)) {
            return rect.reduce((remaining, item) =>
                remaining.flatMap(candidate => candidate.minus(item)), [this.copy()]);
        }

        const other = this._coerce(rect);
        if (other.x <= this.x &&
            other.y <= this.y &&
            other.x + other.width >= this.x2 &&
            other.y + other.height >= this.y2) {
            return [];
        }
        if (!this.overlap(other)) return [this.copy()];

        const result = [];
        const leftWidth = other.x - this.x;
        if (leftWidth > 0) {
            result.push(new TilingAssistantCompatRect({
                x: this.x,
                y: this.y,
                width: leftWidth,
                height: this.height
            }));
        }

        const rightWidth = this.x2 - (other.x + other.width);
        if (rightWidth > 0) {
            result.push(new TilingAssistantCompatRect({
                x: other.x + other.width,
                y: this.y,
                width: rightWidth,
                height: this.height
            }));
        }

        const verticalX = Math.max(this.x, other.x);
        const verticalWidth = Math.min(this.x2, other.x + other.width) - verticalX;
        const topHeight = other.y - this.y;
        if (topHeight > 0 && verticalWidth > 0) {
            result.push(new TilingAssistantCompatRect({
                x: verticalX,
                y: this.y,
                width: verticalWidth,
                height: topHeight
            }));
        }

        const bottomHeight = this.y2 - (other.y + other.height);
        if (bottomHeight > 0 && verticalWidth > 0) {
            result.push(new TilingAssistantCompatRect({
                x: verticalX,
                y: other.y + other.height,
                width: verticalWidth,
                height: bottomHeight
            }));
        }

        return result;
    }

    overlap(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.overlap === 'function') {
            return this._rect.overlap(other);
        }
        return this.x < other.x + other.width &&
            this.x2 > other.x &&
            this.y < other.y + other.height &&
            this.y2 > other.y;
    }

    union(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.union === 'function') {
            return new TilingAssistantCompatRect(this._rect.union(other));
        }

        const x1 = Math.min(this.x, other.x);
        const y1 = Math.min(this.y, other.y);
        const x2 = Math.max(this.x2, other.x + other.width);
        const y2 = Math.max(this.y2, other.y + other.height);
        return new TilingAssistantCompatRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }

    tryAlignWith(rect, margin = 4) {
        const other = this._coerce(rect);
        const close = (a, b) => Math.abs(a - b) <= margin;

        if (close(other.x, this.x)) this.x = other.x;
        else if (close(other.x + other.width, this.x)) this.x = other.x + other.width;

        if (close(other.y, this.y)) this.y = other.y;
        else if (close(other.y + other.height, this.y)) this.y = other.y + other.height;

        if (close(other.x, this.x2)) this.width = other.x - this.x;
        else if (close(other.x + other.width, this.x2)) this.width = other.x + other.width - this.x;

        if (close(other.y, this.y2)) this.height = other.y - this.y;
        else if (close(other.y + other.height, this.y2)) this.height = other.y + other.height - this.y;

        return this;
    }

    vertOverlap(rect) {
        const other = this._coerce(rect);
        if (typeof this._rect.vert_overlap === 'function') {
            return this._rect.vert_overlap(other);
        }
        return this.y < other.y + other.height && this.y2 > other.y;
    }

    get meta() {
        return this._toNativeRect(this._rect);
    }

    get area() { return this.width * this.height; }
    get center() {
        return {
            x: this.x + Math.floor(this.width / 2),
            y: this.y + Math.floor(this.height / 2)
        };
    }
    get x() { return this._rect.x; }
    get x2() { return this._rect.x + this._rect.width; }
    get y() { return this._rect.y; }
    get y2() { return this._rect.y + this._rect.height; }
    get width() { return this._rect.width; }
    get height() { return this._rect.height; }

    set x(value) { this._rect.x = Math.floor(value); }
    set x2(value) { this._rect.width = Math.floor(value) - this.x; }
    set y(value) { this._rect.y = Math.floor(value); }
    set y2(value) { this._rect.height = Math.floor(value) - this.y; }
    set width(value) { this._rect.width = Math.floor(value); }
    set height(value) { this._rect.height = Math.floor(value); }
}

/**
 * ProfilesModule class.
 * Workspace Session Restorer module for GNOME Essentials.
 * Tracks, captures, and serializes the bounds, layout positions, and workspace IDs
 * of all open application windows, saving them into custom GSettings data structures.
 * On activation, restores the absolute workspace placements of running or newly spawned apps.
 */
export default class ProfilesModule {
    /**
     * Constructs the ProfilesModule instance.
     * @param {Object} extensionContext - Core orchestrator context.
     */
    constructor(extensionContext) {
        this.context = extensionContext;
        this._settings = extensionContext.getSettings();
        
        this._active = false;
        this._profilesButton = null;
        this._profilesMenuSection = null;
        
        // Signal IDs
        this._windowCreatedId = 0;
        this._settingsChangedId = 0;
        this._monitorsChangedId = 0;
        this._screenShieldSignalId = 0;
        this._loginManagerProxy = null;
        this._prepareForSleepSignalId = 0;
        
        // App Restoration Queue
        this._pendingRestorations = [];
        this._recentlyMappedWindows = [];
        this._settleTimerId = 0;
        this._menuRebuildTimerId = 0;
        this._rollingSnapshotTimerId = 0;
        this._launchTimerIds = [];
        this._paperWMSlurpTimerIds = [];
        this._paperWMReconcileTimerId = 0;
        this._paperWMReconcileAttempts = 0;
        this._paperWMRestoreConfigs = [];
        this._rollingSafetySnapshot = null;
        this._trackedWindowSignals = new Map();
        this._contextLaunchOverrides = null;
        this._contextLaunchOverrideClearId = 0;
        this._pendingScanTimerIds = [];
    }

    _isValidMonitorIndex(index) {
        if (index === null || index === undefined) return false;
        try {
            const displayMonitors = typeof global.display?.get_n_monitors === 'function'
                ? global.display.get_n_monitors()
                : 0;
            const layoutMonitors = Array.isArray(Main.layoutManager?.monitors)
                ? Main.layoutManager.monitors.length
                : 0;
            const numMonitors = Math.max(displayMonitors, layoutMonitors);
            return index >= 0 && index < numMonitors;
        } catch (e) {
            return false;
        }
    }

    /**
     * Enables the Workspace Restorer, connecting window monitoring signals, GSettings listeners,
     * and spawning the top bar workspace profiles dropdown widget.
     * @returns {void}
     */
    enable() {
        log('Enabling Workspace Session Restorer...');
        this._active = true;

        // 1. Hook window creation to position newly spawned applications
        this._connectSignals();

        // 2. Spawn premium top bar dropdown widget
        this._createPanelIndicator();

        // 3. Listen to profiles-saved-data changes to rebuild top bar menu live
        this._settingsChangedId = this._settings.connect('changed::profiles-saved-data', () => {
            this._scheduleMenuRebuild();
        });

        // 4. Hook IPC trigger save setting change
        this._triggerSaveHandlerId = this._settings.connect('changed::profiles-trigger-save', () => {
            this._processSaveTrigger();
        });

        // Process any pending save request that was written before this module loaded.
        this._processSaveTrigger();

        // 5. Listen to profiles-active-profile (triggered by prefs.js suggested action)
        this._lastAppliedProfile = this._settings.get_string('profiles-active-profile') || '';
        this._activeProfileHandlerId = this._settings.connect('changed::profiles-active-profile', () => {
            const name = this._settings.get_string('profiles-active-profile');
            if (name && !this._updatingActiveProfileSetting) {
                this.applyProfile(name);
            }
        });

        global.gnome_essentials_profiles = this;

        log('Workspace Session Restorer enabled successfully.');
    }

    /**
     * Disables the restorer, tearing down panel indicators, clearing timers,
     * and disconnecting signal handles.
     * @returns {void}
     */
    disable() {
        log('Disabling Workspace Session Restorer...');
        this._active = false;

        if (global.gnome_essentials_profiles === this) {
            global.gnome_essentials_profiles = null;
        }

        // 1. Disconnect all signal handlers
        this._disconnectSignals();

        if (this._settingsChangedId > 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._triggerSaveHandlerId > 0) {
            this._settings.disconnect(this._triggerSaveHandlerId);
            this._triggerSaveHandlerId = 0;
        }

        if (this._activeProfileHandlerId > 0) {
            this._settings.disconnect(this._activeProfileHandlerId);
            this._activeProfileHandlerId = 0;
        }

        // 2. Destroy panel widget
        this._destroyPanelIndicator();

        // 3. Clear queues and timers
        this._pendingRestorations = [];
        if (this._settleTimerId > 0) {
            GLib.source_remove(this._settleTimerId);
            this._settleTimerId = 0;
        }
        if (this._menuRebuildTimerId > 0) {
            GLib.source_remove(this._menuRebuildTimerId);
            this._menuRebuildTimerId = 0;
        }
        this._clearLaunchTimers();
        this._clearPaperWMSlurpTimers();
        this._clearPendingScanTimers();
        this._clearPaperWMReconcileTimer();
        this._clearContextLaunchOverrides();
        this._paperWMRestoreConfigs = [];
        this._recentlyMappedWindows = [];

        log('Workspace Session Restorer disabled and cleaned up.');
    }

    _connectSignals() {
        this._windowCreatedId = global.display.connect('window-created', (display, win) => {
            if (!this._active || !win) return;
            this._trackWindowForSafetySnapshot(win);
            this._scheduleRollingSnapshotRefresh();

            // Wait briefly for window mapping and application metadata association
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                if (this._active && win) {
                    this._restorePendingWindow(win);
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        this._trackExistingWindowsForSafetySnapshot();
        this._scheduleRollingSnapshotRefresh(SAFETY_SNAPSHOT_INITIAL_DELAY_MS);

        if (Main.layoutManager) {
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
                this._saveSafetySnapshotFromRollingCache('before-monitor-change');
                this._scheduleRollingSnapshotRefresh(SAFETY_SNAPSHOT_INITIAL_DELAY_MS);
            });
        }

        if (Main.screenShield) {
            this._screenShieldSignalId = Main.screenShield.connect('locked-changed', () => {
                if (Main.screenShield.locked) {
                    this._saveSafetySnapshot('before-screen-lock');
                } else {
                    this._scheduleRollingSnapshotRefresh(SAFETY_SNAPSHOT_INITIAL_DELAY_MS);
                }
            });
        }

        this._connectLoginManagerSleepSignal();
    }

    _disconnectSignals() {
        if (this._windowCreatedId > 0) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (Main.layoutManager && this._monitorsChangedId > 0) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (Main.screenShield && this._screenShieldSignalId > 0) {
            Main.screenShield.disconnect(this._screenShieldSignalId);
            this._screenShieldSignalId = 0;
        }
        this._disconnectLoginManagerSleepSignal();
        this._disconnectTrackedWindowSignals();
        if (this._rollingSnapshotTimerId > 0) {
            GLib.source_remove(this._rollingSnapshotTimerId);
            this._rollingSnapshotTimerId = 0;
        }
    }

    _connectLoginManagerSleepSignal() {
        try {
            this._loginManagerProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.login1',
                g_object_path: '/org/freedesktop/login1',
                g_interface_name: 'org.freedesktop.login1.Manager'
            });

            this._loginManagerProxy.init_async(GLib.PRIORITY_DEFAULT, null, (proxy, result) => {
                try {
                    proxy.init_finish(result);
                    if (!this._active || proxy !== this._loginManagerProxy) return;

                    this._prepareForSleepSignalId = proxy.connectSignal('PrepareForSleep', (_proxy, _sender, params) => {
                        const unpacked = params?.deepUnpack?.() || [];
                        const preparingForSleep = !!unpacked[0];
                        if (preparingForSleep) {
                            this._saveSafetySnapshot('before-suspend');
                        } else {
                            this._scheduleRollingSnapshotRefresh(SAFETY_SNAPSHOT_INITIAL_DELAY_MS);
                        }
                    });
                } catch (e) {
                    log(`Could not subscribe to login manager sleep signal: ${e.message}`);
                }
            });
        } catch (e) {
            log(`Login manager sleep signal unavailable: ${e.message}`);
            this._loginManagerProxy = null;
        }
    }

    _disconnectLoginManagerSleepSignal() {
        if (this._loginManagerProxy && this._prepareForSleepSignalId > 0) {
            try {
                this._loginManagerProxy.disconnectSignal(this._prepareForSleepSignalId);
            } catch (e) {
                // Ignore disconnect differences across GJS versions.
            }
        }
        this._prepareForSleepSignalId = 0;
        this._loginManagerProxy = null;
    }

    _trackExistingWindowsForSafetySnapshot() {
        try {
            for (const actor of global.get_window_actors()) {
                const win = actor.get_meta_window();
                this._trackWindowForSafetySnapshot(win);
            }
        } catch (e) {
            log(`Failed to track existing windows for safety snapshots: ${e.message}`);
        }
    }

    _trackWindowForSafetySnapshot(win) {
        try {
            if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;
            if (this._trackedWindowSignals.has(win)) return;

            const signalIds = [];
            const connectSignal = (signalName, handler) => {
                try {
                    const id = win.connect(signalName, handler);
                    signalIds.push(id);
                } catch (e) {
                    // Not every Meta.Window signal exists on every Shell version.
                }
            };

            const scheduleRefresh = () => this._scheduleRollingSnapshotRefresh();
            connectSignal('position-changed', scheduleRefresh);
            connectSignal('size-changed', scheduleRefresh);
            connectSignal('workspace-changed', scheduleRefresh);
            connectSignal('monitor-changed', scheduleRefresh);
            connectSignal('notify::minimized', scheduleRefresh);
            connectSignal('unmanaged', () => {
                this._scheduleRollingSnapshotRefresh();
                this._untrackWindowForSafetySnapshot(win);
            });

            if (signalIds.length > 0) {
                this._trackedWindowSignals.set(win, signalIds);
            }
        } catch (e) {
            log(`Failed to track window for safety snapshots: ${e.message}`);
        }
    }

    _untrackWindowForSafetySnapshot(win) {
        const signalIds = this._trackedWindowSignals.get(win);
        if (!signalIds) return;

        for (const id of signalIds) {
            try {
                win.disconnect(id);
            } catch (e) {
                // The window may already be unmanaged/finalized.
            }
        }
        this._trackedWindowSignals.delete(win);
    }

    _disconnectTrackedWindowSignals() {
        for (const [win, signalIds] of this._trackedWindowSignals.entries()) {
            for (const id of signalIds) {
                try {
                    win.disconnect(id);
                } catch (e) {
                    // The window may already be unmanaged/finalized.
                }
            }
        }
        this._trackedWindowSignals.clear();
    }

    _scheduleRollingSnapshotRefresh(delayMs = SAFETY_SNAPSHOT_DEBOUNCE_MS) {
        if (!this._active) return;

        if (this._rollingSnapshotTimerId > 0) {
            GLib.source_remove(this._rollingSnapshotTimerId);
            this._rollingSnapshotTimerId = 0;
        }

        this._rollingSnapshotTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._rollingSnapshotTimerId = 0;
            this._refreshRollingSafetySnapshot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshRollingSafetySnapshot() {
        if (!this._active) return;

        try {
            this._trackExistingWindowsForSafetySnapshot();
            const windows = this._captureCurrentLayoutWindows();
            if (!windows.length) return;

            this._rollingSafetySnapshot = {
                created_at: new Date().toISOString(),
                reason: 'rolling-cache',
                monitor_signature: this._getMonitorSignature(),
                windows
            };
            log(`Updated rolling safety snapshot cache with ${windows.length} windows`);
        } catch (e) {
            log(`Failed to refresh rolling safety snapshot: ${e.message}`);
        }
    }

    _getMonitorSignature() {
        try {
            const monitors = Main.layoutManager?.monitors || [];
            return monitors.map((monitor, index) => [
                monitor.index ?? index,
                monitor.x ?? 0,
                monitor.y ?? 0,
                monitor.width ?? 0,
                monitor.height ?? 0
            ].join(':')).join('|');
        } catch (e) {
            return '';
        }
    }

    _saveSafetySnapshotFromRollingCache(reason) {
        if (this._rollingSafetySnapshot?.windows?.length) {
            return this._saveSafetySnapshot(reason, {
                windows: this._rollingSafetySnapshot.windows,
                createdAt: this._rollingSafetySnapshot.created_at,
                monitorSignature: this._rollingSafetySnapshot.monitor_signature,
                source: 'rolling-cache'
            });
        }

        return this._saveSafetySnapshot(reason, { source: 'fallback-capture' });
    }

    _saveSafetySnapshot(reason, options = {}) {
        if (!this._active) return false;

        try {
            const windows = Array.isArray(options.windows)
                ? this._cloneWindows(options.windows)
                : this._captureCurrentLayoutWindows();

            if (!windows.length) {
                log(`Skipped safety snapshot (${reason}); no restorable windows found`);
                return false;
            }

            const data = this._readProfilesData();
            data.safety_snapshot = {
                reason,
                source: options.source || 'capture',
                created_at: options.createdAt || new Date().toISOString(),
                monitor_signature: options.monitorSignature || this._getMonitorSignature(),
                windows
            };
            this._writeProfilesData(data);
            try {
                Gio.Settings.sync();
            } catch (e) {
                // Best effort: regular GSettings writes still work if sync is unavailable.
            }
            log(`Saved safety snapshot (${reason}) with ${windows.length} windows`);
            return true;
        } catch (e) {
            logError(`Failed to save safety snapshot (${reason}): ${e.message}`);
            return false;
        }
    }

    _normalizeSafetySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.windows)) return null;

        const windows = this._cloneWindows(snapshot.windows);
        if (!windows.length) return null;

        return {
            reason: snapshot.reason || 'unknown',
            source: snapshot.source || 'capture',
            created_at: snapshot.created_at || null,
            monitor_signature: snapshot.monitor_signature || '',
            windows
        };
    }

    _getSafetySnapshot(data = null) {
        const normalized = this._normalizeProfilesData(data || this._readProfilesData());
        return this._normalizeSafetySnapshot(normalized.safety_snapshot);
    }

    _formatSafetySnapshotReason(reason) {
        switch (reason) {
            case 'before-profile-restore':
                return 'profile restore';
            case 'before-monitor-change':
                return 'monitor change';
            case 'before-screen-lock':
                return 'screen lock';
            case 'before-suspend':
                return 'suspend';
            case 'before-safety-restore':
                return 'previous-layout restore';
            default:
                return 'desktop change';
        }
    }

    _formatSafetySnapshotTime(createdAt) {
        if (!createdAt) return '';
        try {
            return new Date(createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (e) {
            return '';
        }
    }

    restoreSafetySnapshot() {
        if (!this._active) return;

        try {
            const snapshot = this._getSafetySnapshot();
            if (!snapshot) {
                this._notify('No previous layout snapshot is available yet.');
                return;
            }

            const windows = this._cloneWindows(snapshot.windows);
            this._saveSafetySnapshot('before-safety-restore');
            this._applyWindowConfigs('Previous Layout', windows, {
                setActiveProfile: false,
                operation: 'restore-safety-snapshot',
                successMessage: 'Restored previous layout.',
                statusProfile: 'Previous Layout'
            });
        } catch (e) {
            const message = `Failed to restore previous layout: ${e.message}`;
            logError(message);
            this._emitProfileOperation('error', 'restore-safety-snapshot', message, {
                name: 'Previous Layout'
            });
        }
    }

    // ==========================================
    // Top Bar Dropdown Panel Widget
    // ==========================================
    _createPanelIndicator() {
        if (this._profilesButton) return;

        log('Creating top bar profiles panel indicator...');
        this._profilesButton = new PanelMenu.Button(0.5, 'WorkspaceProfilesIndicator', false);

        // Grid/Desktop symbolic icon
        const icon = new St.Icon({
            gicon: Gio.Icon.new_for_string('view-fullscreen-symbolic'),
            style_class: 'system-status-icon'
        });
        
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        box.add_child(icon);
        this._profilesButton.add_child(box);

        // Build profiles list section
        this._profilesMenuSection = new PopupMenu.PopupMenuSection();
        this._profilesButton.menu.addMenuItem(this._profilesMenuSection);

        this._rebuildMenu();

        // Add to Status Area
        Main.panel.addToStatusArea('profiles-indicator', this._profilesButton, 0, 'right');
    }

    _destroyPanelIndicator() {
        if (this._profilesButton) {
            this._profilesButton.destroy();
            this._profilesButton = null;
            this._profilesMenuSection = null;
        }
    }

    _scheduleMenuRebuild() {
        if (this._menuRebuildTimerId > 0) return;

        this._menuRebuildTimerId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._menuRebuildTimerId = 0;
            if (this._active) {
                this._rebuildMenu();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildMenu() {
        if (!this._profilesMenuSection) return;

        // Clear existing items
        this._profilesMenuSection.removeAll();

        try {
            const data = this._readProfilesData();
            const profileNames = Object.keys(data.profiles);
            const safetySnapshot = this._getSafetySnapshot(data);

            if (profileNames.length === 0) {
                const emptyItem = new PopupMenu.PopupMenuItem('No profiles saved yet', { reactive: false });
                this._profilesMenuSection.addMenuItem(emptyItem);
            } else {
                // Header item
                const headerItem = new PopupMenu.PopupMenuItem('Saved Layout Profiles', { reactive: false });
                headerItem.label.set_style('font-weight: bold; font-size: 0.9em; opacity: 0.7;');
                this._profilesMenuSection.addMenuItem(headerItem);

                for (const name of profileNames) {
                    const entry = data.profiles[name];
                    const count = entry.windows.length;
                    const windowWord = count === 1 ? 'window' : 'windows';
                    this._profilesMenuSection.addMenuItem(this._createProfileMenuItem(
                        name,
                        `${count} ${windowWord}`
                    ));
                }
            }

            if (safetySnapshot) {
                const reason = this._formatSafetySnapshotReason(safetySnapshot.reason);
                const time = this._formatSafetySnapshotTime(safetySnapshot.created_at);
                const detail = time ? `saved before ${reason} at ${time}` : `saved before ${reason}`;
                const restoreItem = new PopupMenu.PopupImageMenuItem(
                    `Restore Previous Layout (${detail})`,
                    'edit-undo-symbolic'
                );
                restoreItem.connect('activate', () => {
                    this._profilesButton?.menu?.close?.();
                    this.restoreSafetySnapshot();
                });
                this._profilesMenuSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._profilesMenuSection.addMenuItem(restoreItem);
            }

            // Separator
            this._profilesMenuSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Save layout shortcut
            const saveItem = new PopupMenu.PopupImageMenuItem('Save Current Layout...', 'document-save-symbolic');
            saveItem.connect('activate', () => {
                this._promptAndSaveLayout();
            });
            this._profilesMenuSection.addMenuItem(saveItem);

        } catch (e) {
            logError('Failed to rebuild top bar menu: ' + e.message);
        }
    }

    _promptAndSaveLayout() {
        // Quick saving from Top Bar generates a default layout named with the current time
        const date = new Date();
        const timeStr = date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const defaultName = `Profile at ${timeStr}`;
        
        log(`Triggering save current layout for: ${defaultName}`);
        const result = this.saveCurrentLayout(defaultName, { source: 'panel' });

        // Show standard desktop notification to verify success
        this._notify(result.message);
    }

    _createProfileMenuItem(name, detailText) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'profiles-profile-row'
        });

        const profileButton = new St.Button({
            style_class: 'profiles-profile-name-button',
            x_expand: true,
            can_focus: true,
            track_hover: true,
            accessible_name: `Apply ${name}`
        });
        const nameLabel = new St.Label({
            text: `${name} (${detailText})`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        profileButton.set_child(nameLabel);
        profileButton.connect('clicked', () => {
            this._profilesButton?.menu?.close?.();
            this.applyProfile(name);
        });

        item.add_child(profileButton);
        item.add_child(this._createProfileActionButton(
            'document-save-symbolic',
            `Modify ${name} with current layout`,
            () => {
                const result = this.saveCurrentLayout(name, {
                    source: 'panel',
                    overwrite: true,
                    operation: 'modify'
                });
                this._profilesButton?.menu?.close?.();
                this._notify(result.message);
            }
        ));
        item.add_child(this._createProfileActionButton(
            'document-edit-symbolic',
            `Rename ${name}`,
            () => {
                this._profilesButton?.menu?.close?.();
                this._promptRenameProfile(name);
            }
        ));
        item.add_child(this._createProfileActionButton(
            'user-trash-symbolic',
            `Delete ${name}`,
            () => {
                this._profilesButton?.menu?.close?.();
                this._promptDeleteProfile(name);
            },
            'destructive'
        ));

        return item;
    }

    _createProfileActionButton(iconName, tooltipText, callback, extraStyleClass = '') {
        const button = new St.Button({
            style_class: extraStyleClass
                ? `profiles-profile-action-button ${extraStyleClass}`
                : 'profiles-profile-action-button',
            can_focus: true,
            track_hover: true,
            accessible_name: tooltipText
        });
        button.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon'
        }));
        button.connect('clicked', callback);
        return button;
    }

    _renameProfile(oldName, newName) {
        newName = (newName || '').trim();
        if (!newName) {
            this._notify('Profile name cannot be empty.');
            return false;
        }
        if (oldName === newName) return true;

        const data = this._readProfilesData();
        if (!data.profiles[oldName]) {
            this._notify(`Profile "${oldName}" no longer exists.`);
            return false;
        }
        if (data.profiles[newName]) {
            this._notify(`Profile "${newName}" already exists.`);
            return false;
        }

        data.profiles[newName] = {
            ...data.profiles[oldName],
            name: newName,
            updated_at: new Date().toISOString()
        };
        delete data.profiles[oldName];

        if (this._settings.get_string('profiles-active-profile') === oldName) {
            this._settings.set_string('profiles-active-profile', newName);
        }

        this._writeProfilesData(data);
        const message = `Renamed "${oldName}" to "${newName}".`;
        this._emitProfileOperation('success', 'rename', message, {
            name: newName,
            source: 'panel'
        }, {
            old_profile: oldName,
            profile: newName
        });
        this._notify(message);
        return true;
    }

    _promptRenameProfile(oldName) {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'profiles-rename-dialog'
        });
        const title = new St.Label({
            text: 'Rename Profile',
            style_class: 'headline'
        });
        const entry = new St.Entry({
            text: oldName,
            can_focus: true,
            x_expand: true
        });

        dialog.contentLayout.add_child(title);
        dialog.contentLayout.add_child(entry);
        dialog.setButtons([
            {
                label: 'Cancel',
                action: () => dialog.close(),
                key: Clutter.KEY_Escape
            },
            {
                label: 'Rename',
                action: () => {
                    if (this._renameProfile(oldName, entry.get_text())) {
                        dialog.close();
                    }
                },
                default: true
            }
        ]);
        dialog.open();
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, oldName.length);
        entry.clutter_text.connect('activate', () => {
            if (this._renameProfile(oldName, entry.get_text())) {
                dialog.close();
            }
        });
    }

    _deleteProfile(name) {
        const data = this._readProfilesData();
        if (!data.profiles[name]) {
            this._notify(`Profile "${name}" no longer exists.`);
            return false;
        }

        delete data.profiles[name];
        if (this._settings.get_string('profiles-active-profile') === name) {
            this._settings.set_string('profiles-active-profile', '');
        }

        this._writeProfilesData(data);
        const message = `Deleted "${name}".`;
        this._emitProfileOperation('success', 'delete', message, {
            name,
            source: 'panel'
        }, {
            profile: name
        });
        this._notify(message);
        return true;
    }

    _promptDeleteProfile(name) {
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'profiles-delete-dialog'
        });
        dialog.contentLayout.add_child(new St.Label({
            text: `Delete "${name}"?`,
            style_class: 'headline'
        }));
        dialog.contentLayout.add_child(new St.Label({
            text: 'This profile will be removed permanently.',
            style_class: 'profiles-dialog-detail'
        }));
        dialog.setButtons([
            {
                label: 'Cancel',
                action: () => dialog.close(),
                key: Clutter.KEY_Escape
            },
            {
                label: 'Delete',
                action: () => {
                    if (this._deleteProfile(name)) {
                        dialog.close();
                    }
                }
            }
        ]);
        dialog.open();
    }

    _processSaveTrigger() {
        const rawValue = this._settings.get_string('profiles-trigger-save') || '';
        if (!rawValue.trim()) return;

        let request = {
            id: '',
            name: rawValue,
            overwrite: true,
            source: 'legacy'
        };

        try {
            const parsed = JSON.parse(rawValue);
            if (parsed && typeof parsed === 'object') {
                request = {
                    id: parsed.id || '',
                    name: parsed.name || '',
                    overwrite: parsed.overwrite !== false,
                    source: parsed.source || 'prefs',
                    operation: parsed.operation || 'save'
                };
            }
        } catch (e) {
            // Backward compatible path: older prefs wrote the raw profile name.
        }

        const name = (request.name || '').trim();
        try {
            if (!name) {
                this._emitProfileOperation('error', 'save', 'Profile name cannot be empty.', request);
                return;
            }

            log(`IPC requested save for profile: ${name}`);
            this.saveCurrentLayout(name, request);
        } finally {
            // Always clear so the same profile can be saved again on the next click.
            this._settings.set_string('profiles-trigger-save', '');
        }
    }

    _readProfilesData() {
        try {
            const dataStr = this._settings.get_string('profiles-saved-data') || '{}';
            return this._normalizeProfilesData(JSON.parse(dataStr));
        } catch (e) {
            logError('Failed to parse profiles-saved-data: ' + e.message);
            return { version: 2, profiles: {}, safety_snapshot: null };
        }
    }

    _writeProfilesData(data) {
        this._settings.set_string('profiles-saved-data', JSON.stringify(this._normalizeProfilesData(data)));
    }

    _normalizeProfilesData(data) {
        const normalized = { version: 2, profiles: {}, safety_snapshot: null };
        if (!data || typeof data !== 'object') return normalized;

        const source = data.version === 2 && data.profiles ? data.profiles : data;
        for (const [name, entry] of Object.entries(source)) {
            if (!name || name === 'version' || name === 'profiles' || name === 'safety_snapshot') continue;

            if (Array.isArray(entry)) {
                normalized.profiles[name] = {
                    name,
                    created_at: null,
                    updated_at: null,
                    windows: this._cloneWindows(entry)
                };
            } else if (entry && typeof entry === 'object' && Array.isArray(entry.windows)) {
                normalized.profiles[name] = {
                    name: entry.name || name,
                    created_at: entry.created_at || null,
                    updated_at: entry.updated_at || null,
                    windows: this._cloneWindows(entry.windows)
                };
            }
        }

        normalized.safety_snapshot = this._normalizeSafetySnapshot(data.safety_snapshot);
        return normalized;
    }

    _getProfileWindows(data, profileName) {
        const entry = this._normalizeProfilesData(data).profiles[profileName];
        if (!entry) return null;
        return this._cloneWindows(Array.isArray(entry) ? entry : entry.windows);
    }

    _cloneWindows(windows) {
        if (!Array.isArray(windows)) return [];

        const cloned = windows.map(windowConfig => ({
            ...windowConfig,
            identity_key: windowConfig?.identity_key || this._buildIdentityKey(
                windowConfig?.app_id,
                windowConfig?.wm_class,
                windowConfig?.title
            ),
            rect: this._cloneRectObject(windowConfig?.rect),
            tilingshell_tile: this._cloneTilingShellTile(windowConfig?.tilingshell_tile),
            forge: this._cloneForgePlacement(windowConfig?.forge),
            tilingassistant: this._cloneTilingAssistantPlacement(windowConfig?.tilingassistant),
            gtile: this._cloneGTilePlacement(windowConfig?.gtile)
        }));

        this._addIdentityIndexes(cloned);
        this._addCreationIndexes(cloned);
        return cloned;
    }

    _emitProfileOperation(status, action, message, request = {}, extra = {}) {
        try {
            const payload = {
                id: request.id || `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
                status,
                action,
                message,
                profile: request.name || extra.profile || '',
                source: request.source || 'extension',
                timestamp: new Date().toISOString(),
                ...extra
            };
            this._settings.set_string('profiles-last-operation', JSON.stringify(payload));
        } catch (e) {
            logError('Failed to emit profile operation status: ' + e.message);
        }
    }

    _getWindowApp(win) {
        try {
            const tracker = Shell.WindowTracker.get_default();
            return tracker ? tracker.get_window_app(win) : null;
        } catch (e) {
            return null;
        }
    }

    _isWindowMaximized(win) {
        try {
            if (typeof win.get_maximized === 'function') {
                return (win.get_maximized() & Meta.MaximizeFlags.BOTH) === Meta.MaximizeFlags.BOTH;
            }

            if (typeof win.is_maximized === 'function') {
                return win.is_maximized();
            }
        } catch (e) {
            // Fall through to false.
        }

        return false;
    }

    _getStableSequence(win) {
        try {
            if (typeof win.get_stable_sequence === 'function') {
                return win.get_stable_sequence();
            }
        } catch (e) {
            // Ignore unavailable Mutter details.
        }

        return null;
    }

    _cloneTilingShellTile(tile) {
        if (!tile ||
            !isReasonableNumber(tile.x, MAX_TILE_RATIO) ||
            !isReasonableNumber(tile.y, MAX_TILE_RATIO) ||
            !isReasonableNumber(tile.width, MAX_TILE_RATIO) ||
            !isReasonableNumber(tile.height, MAX_TILE_RATIO) ||
            Number(tile.width) <= 0 ||
            Number(tile.height) <= 0) {
            return null;
        }

        return {
            x: Number(tile.x),
            y: Number(tile.y),
            width: Number(tile.width),
            height: Number(tile.height),
            groups: Array.isArray(tile.groups) ? [...tile.groups] : []
        };
    }

    _getTilingShellAssignedTile(win) {
        try {
            return this._cloneTilingShellTile(win?.assignedTile);
        } catch (e) {
            return null;
        }
    }

    _cloneRectObject(rect) {
        if (!rect ||
            !isReasonableNumber(rect.x, MAX_GEOMETRY_VALUE) ||
            !isReasonableNumber(rect.y, MAX_GEOMETRY_VALUE) ||
            !isReasonableNumber(rect.width, MAX_GEOMETRY_VALUE) ||
            !isReasonableNumber(rect.height, MAX_GEOMETRY_VALUE) ||
            Number(rect.width) <= 0 ||
            Number(rect.height) <= 0) {
            return null;
        }

        return {
            x: Math.round(Number(rect.x)),
            y: Math.round(Number(rect.y)),
            width: Math.max(1, Math.round(Number(rect.width))),
            height: Math.max(1, Math.round(Number(rect.height)))
        };
    }

    _cloneTilingAssistantPlacement(placement) {
        if (!placement || typeof placement !== 'object') return null;

        const tiledRect = this._cloneRectObject(placement.tiled_rect);
        const untiledRect = this._cloneRectObject(placement.untiled_rect);
        const frameRect = this._cloneRectObject(placement.frame_rect);

        if (!tiledRect && !frameRect) return null;

        return {
            is_tiled: !!placement.is_tiled,
            tiled_rect: tiledRect,
            untiled_rect: untiledRect,
            frame_rect: frameRect,
            tile_group_size: placement.tile_group_size ?? 0
        };
    }

    _cloneGTilePlacement(placement) {
        if (!placement || typeof placement !== 'object') return null;

        const frameRect = this._cloneRectObject(placement.frame_rect);
        const workArea = this._cloneRectObject(placement.work_area);
        const normalized = placement.normalized && typeof placement.normalized === 'object'
            ? {
                x: Number(placement.normalized.x),
                y: Number(placement.normalized.y),
                width: Number(placement.normalized.width),
                height: Number(placement.normalized.height)
            }
            : null;

        if (!frameRect || !workArea || !normalized ||
            !Number.isFinite(normalized.x) ||
            !Number.isFinite(normalized.y) ||
            !Number.isFinite(normalized.width) ||
            !Number.isFinite(normalized.height) ||
            Math.abs(normalized.x) > MAX_TILE_RATIO ||
            Math.abs(normalized.y) > MAX_TILE_RATIO ||
            Math.abs(normalized.width) > MAX_TILE_RATIO ||
            Math.abs(normalized.height) > MAX_TILE_RATIO ||
            normalized.width <= 0 ||
            normalized.height <= 0) {
            return null;
        }

        const spacing = finiteNumber(placement.spacing, 0);
        if (Math.abs(spacing) > MAX_GEOMETRY_VALUE) return null;

        return {
            frame_rect: frameRect,
            work_area: workArea,
            normalized,
            spacing,
            is_primary_monitor: !!placement.is_primary_monitor
        };
    }

    _getGTileExtension() {
        try {
            return Main.extensionManager.lookup('gTile@vibou')?.stateObj || null;
        } catch (e) {
            return null;
        }
    }

    _getGTileSettings() {
        try {
            const gtileExt = this._getGTileExtension();
            if (!gtileExt) return null;

            if (gtileExt.settings) return gtileExt.settings;
            if (typeof gtileExt.getSettings === 'function') {
                return gtileExt.getSettings('org.gnome.shell.extensions.gtile');
            }
        } catch (e) {
            // gTile is not installed, enabled, or exposes a different runtime shape.
        }

        return null;
    }

    _getGTileInt(settings, key, fallback = 0) {
        try {
            return settings && typeof settings.get_int === 'function'
                ? settings.get_int(key)
                : fallback;
        } catch (e) {
            return fallback;
        }
    }

    _getGTileWorkArea(monitorIndex, workspace = null, settings = null) {
        try {
            const ws = workspace || global.workspace_manager.get_active_workspace();
            if (!this._isValidMonitorIndex(monitorIndex)) return null;
            const source = ws?.get_work_area_for_monitor?.(monitorIndex);
            if (!source) return null;

            const workArea = this._cloneRectObject(source);
            if (!workArea) return null;

            settings = settings || this._getGTileSettings();
            const spacing = boundedNumber(this._getGTileInt(settings, 'window-spacing', 0), 0, 0, MAX_GEOMETRY_VALUE);
            const primaryIndex = Main.layoutManager?.primaryIndex ?? 0;
            const prefix = monitorIndex === primaryIndex ? 'insets-primary' : 'insets-secondary';

            const left = Math.max(0, Math.min(
                this._getGTileInt(settings, `${prefix}-left`, 0),
                Math.floor(workArea.width / 2)
            ));
            const right = Math.max(0, Math.min(
                this._getGTileInt(settings, `${prefix}-right`, 0),
                Math.floor(workArea.width / 2)
            ));
            const top = Math.max(0, Math.min(
                this._getGTileInt(settings, `${prefix}-top`, 0),
                Math.floor(workArea.height / 2)
            ));
            const bottom = Math.max(0, Math.min(
                this._getGTileInt(settings, `${prefix}-bottom`, 0),
                Math.floor(workArea.height / 2)
            ));

            return {
                x: workArea.x + left - spacing,
                y: workArea.y + top - spacing,
                width: workArea.width - left - right + spacing * 2,
                height: workArea.height - top - bottom + spacing * 2
            };
        } catch (e) {
            return null;
        }
    }

    _getGTilePlacement(win, frameRect = null, workspace = null, monitor = null) {
        try {
            const settings = this._getGTileSettings();
            if (!settings) return null;

            const monitorIndex = monitor ?? (typeof win.get_monitor === 'function' ? win.get_monitor() : 0);
            const gtileWorkArea = this._getGTileWorkArea(monitorIndex, workspace || win?.get_workspace?.(), settings);
            const frame = this._cloneRectObject(frameRect || win?.get_frame_rect?.());
            if (!gtileWorkArea || !frame || gtileWorkArea.width <= 0 || gtileWorkArea.height <= 0) {
                return null;
            }

            const spacing = boundedNumber(this._getGTileInt(settings, 'window-spacing', 0), 0, 0, MAX_GEOMETRY_VALUE);
            const expandedFrame = {
                x: frame.x - spacing,
                y: frame.y - spacing,
                width: frame.width + spacing * 2,
                height: frame.height + spacing * 2
            };

            return this._cloneGTilePlacement({
                frame_rect: frame,
                work_area: gtileWorkArea,
                normalized: {
                    x: (expandedFrame.x - gtileWorkArea.x) / gtileWorkArea.width,
                    y: (expandedFrame.y - gtileWorkArea.y) / gtileWorkArea.height,
                    width: expandedFrame.width / gtileWorkArea.width,
                    height: expandedFrame.height / gtileWorkArea.height
                },
                spacing,
                is_primary_monitor: monitorIndex === (Main.layoutManager?.primaryIndex ?? 0)
            });
        } catch (e) {
            return null;
        }
    }

    _getTilingAssistantWindowManager() {
        try {
            const tilingAssistantExt = Main.extensionManager.lookup('tiling-assistant@leleat-on-github');
            return tilingAssistantExt?.stateObj?._twm || null;
        } catch (e) {
            return null;
        }
    }

    _getTilingAssistantPlacement(win, frameRect = null) {
        try {
            if (!win || (!win.isTiled && !win.tiledRect)) return null;

            const twm = this._getTilingAssistantWindowManager();
            const tileGroup = twm && typeof twm.getTileGroupFor === 'function'
                ? twm.getTileGroupFor(win)
                : [];

            return this._cloneTilingAssistantPlacement({
                is_tiled: !!win.isTiled,
                tiled_rect: this._cloneRectObject(win.tiledRect),
                untiled_rect: this._cloneRectObject(win.untiledRect),
                frame_rect: frameRect || this._cloneRectObject(win.get_frame_rect?.()),
                tile_group_size: tileGroup.length
            });
        } catch (e) {
            return null;
        }
    }

    _cloneForgePlacement(forge) {
        if (!forge || typeof forge !== 'object' || !Array.isArray(forge.path) || forge.path.length === 0) {
            return null;
        }

        return {
            mode: forge.mode || null,
            rect: this._cloneRectObject(forge.rect),
            render_rect: this._cloneRectObject(forge.render_rect),
            path: forge.path.map(entry => ({
                node_type: entry?.node_type || null,
                node_value: typeof entry?.node_value === 'string' ? entry.node_value : null,
                node_layout: entry?.node_layout || null,
                parent_type: entry?.parent_type || null,
                parent_value: typeof entry?.parent_value === 'string' ? entry.parent_value : null,
                parent_layout: entry?.parent_layout || null,
                index: Math.max(0, Math.floor(finiteNumber(entry?.index, 0))),
                percent: finiteNumber(entry?.percent, 0)
            }))
        };
    }

    _getForgeWindowManager() {
        try {
            const forgeExt = Main.extensionManager.lookup('forge@jmmaranan.com');
            return forgeExt?.stateObj?.extWm || null;
        } catch (e) {
            return null;
        }
    }

    _getForgeNode(win) {
        try {
            const extWm = this._getForgeWindowManager();
            if (!extWm || typeof extWm.findNodeWindow !== 'function') return null;
            return extWm.findNodeWindow(win);
        } catch (e) {
            return null;
        }
    }

    _getForgePlacement(win) {
        try {
            const node = this._getForgeNode(win);
            if (!node || !node.parentNode) return null;

            const path = [];
            let current = node;
            while (current && current.parentNode) {
                const parent = current.parentNode;
                if (parent.nodeType === 'ROOT' || parent.nodeType === 'WORKSPACE') break;

                path.unshift({
                    node_type: current.nodeType || null,
                    node_value: typeof current.nodeValue === 'string' ? current.nodeValue : null,
                    node_layout: current.layout || null,
                    parent_type: parent.nodeType || null,
                    parent_value: typeof parent.nodeValue === 'string' ? parent.nodeValue : null,
                    parent_layout: parent.layout || null,
                    index: current.index ?? 0,
                    percent: current.percent ?? 0
                });
                current = parent;
            }

            if (!path.length) return null;

            return this._cloneForgePlacement({
                mode: node.mode || null,
                rect: node.rect ? { ...node.rect } : null,
                render_rect: node.renderRect ? { ...node.renderRect } : null,
                path
            });
        } catch (e) {
            return null;
        }
    }

    _buildIdentityKey(appId, wmClass, title) {
        return [appId || '', (wmClass || '').toLowerCase(), title || ''].join('|');
    }

    _createWindowConfig(win, workspaceIndex = null, stackIndex = null, isFocused = false) {
        const app = this._getWindowApp(win);
        let appId = app ? app.get_id() : null;
        const wmClass = win.get_wm_class() || '';
        if (!appId && wmClass) {
            appId = wmClass.includes('.') ? wmClass + '.desktop' : wmClass.toLowerCase() + '.desktop';
        }
        const title = win.get_title() || '';
        const frameRect = win.get_frame_rect();
        const ws = win.get_workspace();
        const workspace = workspaceIndex ?? (ws ? (typeof ws.index === 'function' ? ws.index() : (typeof ws.get_index === 'function' ? ws.get_index() : 0)) : 0);
        const monitor = typeof win.get_monitor === 'function' ? win.get_monitor() : null;

        let paperwmCol = null;
        let paperwmRow = null;
        try {
            const paperwmExt = Main.extensionManager.lookup('paperwm@paperwm.github.com');
            if (paperwmExt && paperwmExt.stateObj) {
                const tiling = paperwmExt.stateObj.modules.find(m => m && m.spaces);
                if (tiling) {
                    const space = tiling.spaces.spaceOfWindow(win);
                    if (space) {
                        const [col, row] = space.positionOf(win);
                        paperwmCol = col;
                        paperwmRow = row;
                    }
                }
            }
        } catch (pErr) {
            // ignore PaperWM errors
        }

        const tilingShellTile = this._getTilingShellAssignedTile(win);
        const tilingAssistantPlacement = this._getTilingAssistantPlacement(win, frameRect);
        const gtilePlacement = this._getGTilePlacement(win, frameRect, ws, monitor);
        const forgePlacement = this._getForgePlacement(win);

        return {
            app_id: appId,
            wm_class: wmClass,
            title,
            workspace,
            monitor,
            stable_sequence: this._getStableSequence(win),
            identity_key: this._buildIdentityKey(appId, wmClass, title),
            maximized: this._isWindowMaximized(win),
            stack_index: stackIndex,
            is_focused: isFocused,
            paperwm_col: paperwmCol,
            paperwm_row: paperwmRow,
            tilingshell_tile: tilingShellTile,
            tilingassistant: tilingAssistantPlacement,
            gtile: gtilePlacement,
            forge: forgePlacement,
            rect: {
                x: frameRect.x,
                y: frameRect.y,
                width: frameRect.width,
                height: frameRect.height
            }
        };
    }

    _addIdentityIndexes(windowConfigs) {
        const counts = new Map();

        const sortedConfigs = [...windowConfigs].sort((a, b) => this._compareWindowConfigs(a, b));
        for (const config of sortedConfigs) {
            const key = config.identity_key || this._buildIdentityKey(config.app_id, config.wm_class, config.title);
            const index = counts.get(key) || 0;
            config.identity_key = key;
            config.identity_index = index;
            counts.set(key, index + 1);
        }
        return windowConfigs;
    }

    _addCreationIndexes(windowConfigs) {
        const counts = new Map();
        const sortedConfigs = [...windowConfigs].sort((a, b) => {
            const seqA = a.stable_sequence ?? 0;
            const seqB = b.stable_sequence ?? 0;
            if (seqA !== seqB) return seqA - seqB;
            const rectA = a.rect || {};
            const rectB = b.rect || {};
            if ((rectA.x ?? 0) !== (rectB.x ?? 0)) return (rectA.x ?? 0) - (rectB.x ?? 0);
            return (rectA.y ?? 0) - (rectB.y ?? 0);
        });

        for (const config of sortedConfigs) {
            const appKey = (config.wm_class || config.app_id || '').toLowerCase();
            if (!appKey) continue;
            const index = counts.get(appKey) || 0;
            config.creation_index = index;
            counts.set(appKey, index + 1);
        }
        return windowConfigs;
    }

    _addLaunchIndexes(candidates) {
        const counts = new Map();
        const sorted = [...candidates].sort((a, b) => {
            const seqA = a.config.stable_sequence ?? 0;
            const seqB = b.config.stable_sequence ?? 0;
            return seqA - seqB;
        });

        for (const candidate of sorted) {
            const appKey = (candidate.config.wm_class || '').toLowerCase();
            if (!appKey) continue;
            const index = counts.get(appKey) || 0;
            candidate.config.launch_index = index;
            counts.set(appKey, index + 1);
        }
        return candidates;
    }

    _compareWindowConfigs(a, b) {
        const keyA = a.identity_key || this._buildIdentityKey(a.app_id, a.wm_class, a.title);
        const keyB = b.identity_key || this._buildIdentityKey(b.app_id, b.wm_class, b.title);
        if (keyA !== keyB) return keyA < keyB ? -1 : 1;

        // Inside the same identity key, sort chronologically by stable_sequence
        const seqA = a.stable_sequence ?? 0;
        const seqB = b.stable_sequence ?? 0;
        if (seqA !== seqB) return seqA - seqB;

        // Spatial fallback only if stable_sequence is missing/identical
        const rectA = a.rect || {};
        const rectB = b.rect || {};
        const xDiff = (rectA.x ?? 0) - (rectB.x ?? 0);
        if (xDiff !== 0) return xDiff;

        return (rectA.y ?? 0) - (rectB.y ?? 0);
    }

    _compareWindowsForTiling(a, b) {
        // 1. Sort by Workspace index first
        const wsA = a.workspace ?? 0;
        const wsB = b.workspace ?? 0;
        if (wsA !== wsB) return wsA - wsB;

        // 2. Sort by Monitor index
        const monA = a.monitor ?? 0;
        const monB = b.monitor ?? 0;
        if (monA !== monB) return monA - monB;

        // 3. PaperWM tiling order (if both have column indices)
        const hasPaperA = a.paperwm_col !== undefined && a.paperwm_col !== null;
        const hasPaperB = b.paperwm_col !== undefined && b.paperwm_col !== null;
        if (hasPaperA && hasPaperB) {
            if (a.paperwm_col !== b.paperwm_col) {
                return a.paperwm_col - b.paperwm_col;
            }
            return (a.paperwm_row ?? 0) - (b.paperwm_row ?? 0);
        }

        // 4. Standard GNOME coordinate-based tiling order (if no PaperWM)
        const rectA = a.rect || {};
        const rectB = b.rect || {};
        const xDiff = (rectA.x ?? 0) - (rectB.x ?? 0);
        if (xDiff !== 0) return xDiff;

        const yDiff = (rectA.y ?? 0) - (rectB.y ?? 0);
        if (yDiff !== 0) return yDiff;

        // 5. Stacking order fallback
        return (a.stack_index ?? 0) - (b.stack_index ?? 0);
    }

    _hasPaperWMPlacement(config) {
        return config &&
            config.paperwm_col !== undefined &&
            config.paperwm_col !== null;
    }

    _hasTilingShellPlacement(config) {
        return !!this._cloneTilingShellTile(config?.tilingshell_tile);
    }

    _hasTilingAssistantPlacement(config) {
        return !!this._cloneTilingAssistantPlacement(config?.tilingassistant);
    }

    _hasGTilePlacement(config) {
        return !!this._cloneGTilePlacement(config?.gtile);
    }

    _hasForgePlacement(config) {
        return !!this._cloneForgePlacement(config?.forge);
    }

    _compareTilingShellTiles(a, b) {
        const tileA = this._cloneTilingShellTile(a?.tilingshell_tile);
        const tileB = this._cloneTilingShellTile(b?.tilingshell_tile);
        if (!tileA || !tileB) return this._compareWindowsForTiling(a, b);

        if (tileA.y !== tileB.y) return tileA.y - tileB.y;
        if (tileA.x !== tileB.x) return tileA.x - tileB.x;
        if (tileA.height !== tileB.height) return tileA.height - tileB.height;
        return tileA.width - tileB.width;
    }

    _compareTilingAssistantPlacements(a, b) {
        const placementA = this._cloneTilingAssistantPlacement(a?.tilingassistant);
        const placementB = this._cloneTilingAssistantPlacement(b?.tilingassistant);
        const rectA = placementA?.tiled_rect || placementA?.frame_rect;
        const rectB = placementB?.tiled_rect || placementB?.frame_rect;
        if (!rectA || !rectB) return this._compareWindowsForTiling(a, b);

        if (rectA.y !== rectB.y) return rectA.y - rectB.y;
        if (rectA.x !== rectB.x) return rectA.x - rectB.x;
        if (rectA.height !== rectB.height) return rectA.height - rectB.height;
        return rectA.width - rectB.width;
    }

    _compareGTilePlacements(a, b) {
        const placementA = this._cloneGTilePlacement(a?.gtile);
        const placementB = this._cloneGTilePlacement(b?.gtile);
        const rectA = placementA?.normalized;
        const rectB = placementB?.normalized;
        if (!rectA || !rectB) return this._compareWindowsForTiling(a, b);

        if (rectA.y !== rectB.y) return rectA.y - rectB.y;
        if (rectA.x !== rectB.x) return rectA.x - rectB.x;
        if (rectA.height !== rectB.height) return rectA.height - rectB.height;
        return rectA.width - rectB.width;
    }

    _compareForgePlacements(a, b) {
        const forgeA = this._cloneForgePlacement(a?.forge);
        const forgeB = this._cloneForgePlacement(b?.forge);
        if (!forgeA || !forgeB) return this._compareWindowsForTiling(a, b);

        const pathA = forgeA.path;
        const pathB = forgeB.path;
        const len = Math.min(pathA.length, pathB.length);
        for (let i = 0; i < len; i++) {
            const entryA = pathA[i];
            const entryB = pathB[i];

            const parentA = entryA.parent_value || '';
            const parentB = entryB.parent_value || '';
            if (parentA !== parentB) return parentA < parentB ? -1 : 1;

            const indexA = entryA.index ?? 0;
            const indexB = entryB.index ?? 0;
            if (indexA !== indexB) return indexA - indexB;
        }

        if (pathA.length !== pathB.length) return pathA.length - pathB.length;
        return this._compareWindowsForTiling(a, b);
    }

    _compareWindowsForLaunchOrder(a, b) {
        const configA = a.config || a;
        const configB = b.config || b;
        const hasPaperA = this._hasPaperWMPlacement(configA);
        const hasPaperB = this._hasPaperWMPlacement(configB);
        const hasTilingShellA = this._hasTilingShellPlacement(configA);
        const hasTilingShellB = this._hasTilingShellPlacement(configB);
        const hasTilingAssistantA = this._hasTilingAssistantPlacement(configA);
        const hasTilingAssistantB = this._hasTilingAssistantPlacement(configB);
        const hasGTileA = this._hasGTilePlacement(configA);
        const hasGTileB = this._hasGTilePlacement(configB);
        const hasForgeA = this._hasForgePlacement(configA);
        const hasForgeB = this._hasForgePlacement(configB);

        if (hasPaperA || hasPaperB) {
            // PaperWM's normal RIGHT/END/DOWN insertion creates the target layout
            // when apps open left-to-right. LEFT/START/UP create it in reverse.
            const wsA = configA.workspace ?? 0;
            const wsB = configB.workspace ?? 0;
            if (wsA !== wsB) return wsA - wsB;

            const monA = configA.monitor ?? 0;
            const monB = configB.monitor ?? 0;
            if (monA !== monB) return monA - monB;

            let order = 0;
            if (hasPaperA && hasPaperB) {
                if (configA.paperwm_col !== configB.paperwm_col) {
                    order = configA.paperwm_col - configB.paperwm_col;
                } else {
                    order = (configA.paperwm_row ?? 0) - (configB.paperwm_row ?? 0);
                }
            } else {
                order = this._compareWindowsForTiling(configA, configB);
            }

            const openPosition = this._getPaperWMOpenWindowPosition();
            return [1, 2, 5].includes(openPosition) ? -order : order;
        }

        if (hasTilingShellA || hasTilingShellB) {
            const wsA = configA.workspace ?? 0;
            const wsB = configB.workspace ?? 0;
            if (wsA !== wsB) return wsA - wsB;

            const monA = configA.monitor ?? 0;
            const monB = configB.monitor ?? 0;
            if (monA !== monB) return monA - monB;

            if (hasTilingShellA && hasTilingShellB) {
                return this._compareTilingShellTiles(configA, configB);
            }

            return this._compareWindowsForTiling(configA, configB);
        }

        if (hasTilingAssistantA || hasTilingAssistantB) {
            const wsA = configA.workspace ?? 0;
            const wsB = configB.workspace ?? 0;
            if (wsA !== wsB) return wsA - wsB;

            const monA = configA.monitor ?? 0;
            const monB = configB.monitor ?? 0;
            if (monA !== monB) return monA - monB;

            if (hasTilingAssistantA && hasTilingAssistantB) {
                return this._compareTilingAssistantPlacements(configA, configB);
            }

            return this._compareWindowsForTiling(configA, configB);
        }

        if (hasGTileA || hasGTileB) {
            const wsA = configA.workspace ?? 0;
            const wsB = configB.workspace ?? 0;
            if (wsA !== wsB) return wsA - wsB;

            const monA = configA.monitor ?? 0;
            const monB = configB.monitor ?? 0;
            if (monA !== monB) return monA - monB;

            if (hasGTileA && hasGTileB) {
                return this._compareGTilePlacements(configA, configB);
            }

            return this._compareWindowsForTiling(configA, configB);
        }

        if (hasForgeA || hasForgeB) {
            const wsA = configA.workspace ?? 0;
            const wsB = configB.workspace ?? 0;
            if (wsA !== wsB) return wsA - wsB;

            const monA = configA.monitor ?? 0;
            const monB = configB.monitor ?? 0;
            if (monA !== monB) return monA - monB;

            if (hasForgeA && hasForgeB) {
                return this._compareForgePlacements(configA, configB);
            }

            return this._compareWindowsForTiling(configA, configB);
        }

        const seqA = configA.stable_sequence ?? 0;
        const seqB = configB.stable_sequence ?? 0;
        if (seqA !== seqB) return seqA - seqB;

        const createA = configA.creation_index ?? 0;
        const createB = configB.creation_index ?? 0;
        if (createA !== createB) return createA - createB;

        const stackA = configA.stack_index ?? 0;
        const stackB = configB.stack_index ?? 0;
        return stackA - stackB;
    }

    _getPaperWMOpenWindowPosition() {
        try {
            const paperwmExt = Main.extensionManager.lookup('paperwm@paperwm.github.com');
            const settingsModule = paperwmExt?.stateObj?.modules?.find(m =>
                m?.prefs && m?.OpenWindowPositions
            );

            if (settingsModule?.prefs?.open_window_position !== undefined) {
                return settingsModule.prefs.open_window_position;
            }
        } catch (e) {
            // Fall back to PaperWM's default RIGHT insertion mode.
        }

        return 0;
    }

    _getPaperWMWindowGap() {
        try {
            const paperwmExt = Main.extensionManager.lookup('paperwm@paperwm.github.com');
            const settingsModule = paperwmExt?.stateObj?.modules?.find(m =>
                m?.prefs && m.prefs.window_gap !== undefined
            );

            return Math.max(0, finiteNumber(settingsModule?.prefs?.window_gap, 0));
        } catch (e) {
            return 0;
        }
    }

    _getPaperWMEqualHeightAllocator(tiling = null) {
        if (typeof tiling?.allocateEqualHeight === 'function') {
            return tiling.allocateEqualHeight;
        }

        const gap = this._getPaperWMWindowGap();
        return (column, available) => {
            const count = Math.max(1, column?.length || 1);
            const usableHeight = Math.max(1, finiteNumber(available, 1) - (count - 1) * gap);
            const height = Math.max(1, Math.floor(usableHeight / count));
            return column.map(() => height);
        };
    }

    _buildRunningWindowCandidates(windows) {
        const candidates = windows.map(win => ({
            win,
            config: this._createWindowConfig(win)
        }));

        const configs = candidates.map(candidate => candidate.config);
        this._addIdentityIndexes(configs);
        this._addCreationIndexes(configs);
        return candidates;
    }

    _rectDistance(a, b) {
        if (!a || !b) return 100000;
        return Math.abs(a.x - b.x) +
            Math.abs(a.y - b.y) +
            Math.abs(a.width - b.width) +
            Math.abs(a.height - b.height);
    }

    _scoreCandidate(config, candidate) {
        const candidateConfig = candidate.config;
        let score = 0;

        const configKey = config.identity_key || this._buildIdentityKey(config.app_id, config.wm_class, config.title);
        const candidateKey = candidateConfig.identity_key || this._buildIdentityKey(candidateConfig.app_id, candidateConfig.wm_class, candidateConfig.title);

        const configParts = configKey.split('|');
        const candidateParts = candidateKey.split('|');

        const exactMatch = (configKey === candidateKey);
        const fuzzyIdentityMatch = (!exactMatch && 
            configParts[1] === candidateParts[1] && // wm_class matches
            configParts[2] === candidateParts[2] && // title matches
            (!configParts[0] || !candidateParts[0] || configParts[0] === candidateParts[0])
        );

        if (exactMatch || fuzzyIdentityMatch) {
            // High priority: exact match of app + wm_class + title!
            score += 10000;

            if (config.identity_index !== undefined && candidateConfig.identity_index !== undefined) {
                score += config.identity_index === candidateConfig.identity_index
                    ? 5000
                    : -Math.abs(config.identity_index - candidateConfig.identity_index) * 500;
            }
        } else {
            // Fallback match of app_id or wm_class
            if (config.app_id && candidateConfig.app_id === config.app_id) score += 3000;
            if (config.wm_class && candidateConfig.wm_class &&
                candidateConfig.wm_class.toLowerCase() === config.wm_class.toLowerCase()) score += 2000;
            
            // Fuzzy title matching or title similarity
            if (config.title && candidateConfig.title) {
                if (candidateConfig.title === config.title) {
                    score += 1500;
                } else if (candidateConfig.title.includes(config.title) || config.title.includes(candidateConfig.title)) {
                    score += 800; // partial overlap
                }
            }
        }

        const contextScore = this._scoreContextCandidate(config, candidateConfig);
        const contextMatchRequired = !!config?._context_match_required &&
            Array.isArray(config?._context_match_terms) &&
            config._context_match_terms.length > 0;
        if (contextMatchRequired &&
            this._appsShareContextFamily(config, candidateConfig) &&
            contextScore <= 0) {
            return -Infinity;
        }

        if (contextScore > 0) {
            score += contextScore;
        }

        if (score <= 0) return -Infinity;

        // Autostarted window launch order matching (highest priority for newly launched apps)
        if (config.launch_index !== undefined && candidateConfig.launch_index !== undefined) {
            score += config.launch_index === candidateConfig.launch_index
                ? 15000
                : -Math.abs(config.launch_index - candidateConfig.launch_index) * 1500;
        }

        // Absolute stable sequence matching if both are from the same runtime session
        if (config.stable_sequence !== null &&
            config.stable_sequence !== undefined &&
            candidateConfig.stable_sequence === config.stable_sequence) {
            score += 3000;
        }

        // Chronological creation index matching (extremely stable fallback for identical apps already running)
        if (config.creation_index !== undefined && candidateConfig.creation_index !== undefined) {
            score += config.creation_index === candidateConfig.creation_index
                ? 4000
                : -Math.abs(config.creation_index - candidateConfig.creation_index) * 400;
        }

        // Workspace and monitor matching
        if (candidateConfig.workspace === config.workspace) score += 600;
        if (candidateConfig.monitor === config.monitor) score += 300;
        if (candidateConfig.maximized === config.maximized) score += 200;

        if (this._hasTilingShellPlacement(config) && this._hasTilingShellPlacement(candidateConfig)) {
            const distance = this._tilingShellTileDistance(config.tilingshell_tile, candidateConfig.tilingshell_tile);
            score += Math.max(0, 1000 - Math.floor(distance * 1000));
        }

        if (this._hasTilingAssistantPlacement(config) && this._hasTilingAssistantPlacement(candidateConfig)) {
            const distance = this._tilingAssistantPlacementDistance(config.tilingassistant, candidateConfig.tilingassistant);
            score += Math.max(0, 1000 - Math.floor(distance / 2));
        }

        if (this._hasGTilePlacement(config) && this._hasGTilePlacement(candidateConfig)) {
            const distance = this._gTilePlacementDistance(config.gtile, candidateConfig.gtile);
            score += Math.max(0, 1000 - Math.floor(distance * 1000));
        }

        if (this._hasForgePlacement(config) && this._hasForgePlacement(candidateConfig)) {
            const distance = this._forgePathDistance(config.forge, candidateConfig.forge);
            score += Math.max(0, 1000 - distance * 200);
        }

        // Spatial proximity score
        const distance = this._rectDistance(config.rect, candidateConfig.rect);
        score += Math.max(0, 800 - Math.floor(distance / 2));

        return score;
    }

    _scoreContextCandidate(config, candidateConfig) {
        const terms = Array.isArray(config?._context_match_terms)
            ? config._context_match_terms
            : [];
        if (terms.length === 0 || !candidateConfig?.title) return 0;

        const title = this._normalizeContextMatchText(candidateConfig.title);
        if (!title) return 0;

        let best = 0;
        for (const term of terms) {
            const normalizedTerm = this._normalizeContextMatchText(term);
            if (normalizedTerm.length < 3) continue;

            if (title === normalizedTerm) {
                best = Math.max(best, 9000);
            } else if (title.includes(normalizedTerm)) {
                best = Math.max(best, 7200);
            }
        }

        if (best <= 0) return 0;

        if (this._appsShareContextFamily(config, candidateConfig)) {
            best += 1500;
        }

        return best;
    }

    _appsShareContextFamily(config, candidateConfig) {
        const configFamily = this._contextAppFamily(config?.app_id || config?.wm_class);
        const candidateFamily = this._contextAppFamily(candidateConfig?.app_id || candidateConfig?.wm_class);
        return !!configFamily && !!candidateFamily && configFamily === candidateFamily;
    }

    _contextAppFamily(value) {
        const text = String(value ?? '').toLowerCase();
        if (!text) return '';

        if (text.includes('libreoffice') || text.includes('openoffice')) return 'office';
        if (text.includes('onlyoffice') || text.includes('wps')) return 'office';
        if (text.includes('papers') || text.includes('evince') || text.includes('okular') || text.includes('zotero')) return 'pdf';
        if (text.includes('nautilus') || text.includes('files') || text.includes('nemo') || text.includes('thunar')) return 'files';
        if (text.includes('chrome') || text.includes('chromium') || text.includes('firefox') || text.includes('browser')) return 'browser';

        return text.replace(/\.desktop$/i, '').replace(/[^a-z0-9]+/g, '-');
    }

    _normalizeContextMatchText(value) {
        let text = String(value ?? '').trim();
        if (!text) return '';

        try {
            text = decodeURIComponent(text);
        } catch (e) {
            // Keep original text if it is not URI-encoded.
        }

        return text
            .toLowerCase()
            .replace(/^file:\/+/i, '')
            .replace(/[._-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _findOptimalMatches(configs, candidates) {
        const matches = new Map(); // configIndex -> candidateIndex
        const matchedConfigs = new Set();
        const matchedCandidates = new Set();

        // 1. Build all possible pairs with scores
        const pairs = [];
        for (let i = 0; i < configs.length; i++) {
            for (let j = 0; j < candidates.length; j++) {
                const score = this._scoreCandidate(configs[i], candidates[j]);
                if (score !== -Infinity) {
                    pairs.push({ configIndex: i, candidateIndex: j, score });
                }
            }
        }

        // 2. Sort pairs by score descending
        pairs.sort((a, b) => b.score - a.score);

        // 3. Match greedily by highest score
        for (const pair of pairs) {
            if (!matchedConfigs.has(pair.configIndex) && !matchedCandidates.has(pair.candidateIndex)) {
                matches.set(pair.configIndex, pair.candidateIndex);
                matchedConfigs.add(pair.configIndex);
                matchedCandidates.add(pair.candidateIndex);
            }
        }

        return matches;
    }

    _ensureWorkspaceExists(workspaceIndex) {
        if (workspaceIndex === null || workspaceIndex === undefined || workspaceIndex < 0) {
            return false;
        }

        const workspaceManager = global.workspace_manager;
        try {
            while (workspaceManager.get_n_workspaces() <= workspaceIndex) {
                if (typeof workspaceManager.append_new_workspace !== 'function') break;
                workspaceManager.append_new_workspace(false, global.get_current_time());
            }
        } catch (e) {
            logError(`Failed to create workspace ${workspaceIndex}: ${e.message}`);
        }

        return workspaceManager.get_n_workspaces() > workspaceIndex;
    }

    _moveWindowToWorkspace(win, workspaceIndex) {
        if (!win || workspaceIndex === null || workspaceIndex === undefined || workspaceIndex < 0) return;
        if (!this._ensureWorkspaceExists(workspaceIndex)) return;

        const workspaceManager = global.workspace_manager;
        const targetWorkspace = workspaceManager.get_workspace_by_index(workspaceIndex);
        if (!targetWorkspace) return;

        try {
            const currentWorkspace = win.get_workspace();
            const currentIndex = currentWorkspace ? (typeof currentWorkspace.index === 'function' ? currentWorkspace.index() : (typeof currentWorkspace.get_index === 'function' ? currentWorkspace.get_index() : -1)) : -1;
            if (currentIndex === workspaceIndex) return;

            if (typeof win.change_workspace_by_index === 'function') {
                win.change_workspace_by_index(workspaceIndex, false);
            } else if (typeof win.change_workspace === 'function') {
                win.change_workspace(targetWorkspace);
            }
        } catch (e) {
            logError(`Failed to move window to workspace ${workspaceIndex}: ${e.message}`);
        }
    }

    _getPaperWMTilingModule() {
        try {
            const paperwmState = this._getPaperWMState();
            return paperwmState?.modules?.find(m => m && m.spaces) || null;
        } catch (e) {
            return null;
        }
    }

    _getPaperWMState() {
        try {
            const paperwmExt = Main.extensionManager.lookup('paperwm@paperwm.github.com');
            return paperwmExt?.stateObj || null;
        } catch (e) {
            return null;
        }
    }

    _isPaperWMActive() {
        return !!this._getPaperWMState();
    }

    _getPaperWMPosition(win, tiling = null) {
        try {
            tiling = tiling || this._getPaperWMTilingModule();
            const space = tiling?.spaces?.spaceOfWindow(win);
            if (!space) return null;

            const position = space.positionOf(win);
            if (!position || position.length < 2) return null;

            return {
                space,
                col: position[0],
                row: position[1]
            };
        } catch (e) {
            return null;
        }
    }

    _isPaperWMWindowInSavedPosition(win, config, tiling = null) {
        if (!this._hasPaperWMPlacement(config)) return false;

        const position = this._getPaperWMPosition(win, tiling);
        return position &&
            position.col === config.paperwm_col &&
            position.row === (config.paperwm_row ?? 0);
    }

    _findPaperWMRestoreConfig(config, row) {
        return (this._paperWMRestoreConfigs || []).find(candidate =>
            candidate !== config &&
            candidate.workspace === config.workspace &&
            candidate.monitor === config.monitor &&
            candidate.paperwm_col === config.paperwm_col &&
            (candidate.paperwm_row ?? 0) === row
        ) || null;
    }

    _applyPaperWMVerticalPlacement(win, config, tiling = null) {
        if (!win || !this._hasPaperWMPlacement(config) || (config.paperwm_row ?? 0) <= 0) {
            return false;
        }

        try {
            tiling = tiling || this._getPaperWMTilingModule();
            if (!tiling) return false;

            if (this._isPaperWMWindowInSavedPosition(win, config, tiling)) {
                return true;
            }

            const anchorConfig = this._findPaperWMRestoreConfig(config, (config.paperwm_row ?? 0) - 1);
            const anchorWin = anchorConfig?._matched_window || null;
            if (!anchorWin) return false;
            if (anchorWin === win) return false;

            const targetPosition = this._getPaperWMPosition(win, tiling);
            const anchorPosition = this._getPaperWMPosition(anchorWin, tiling);
            if (!targetPosition || !anchorPosition || targetPosition.space !== anchorPosition.space) {
                return false;
            }

            const space = anchorPosition.space;
            const sourceColIndex = space.indexOf(win);
            if (sourceColIndex < 0) return false;

            const sourceColumn = space[sourceColIndex];
            const sourceRowIndex = sourceColumn.indexOf(win);
            if (sourceRowIndex < 0) return false;

            sourceColumn.splice(sourceRowIndex, 1);
            if (sourceColumn.length === 0) {
                space.splice(sourceColIndex, 1);
            }

            const destColIndex = space.indexOf(anchorWin);
            if (destColIndex < 0) return false;

            const destColumn = space[destColIndex];
            const anchorRowIndex = destColumn.indexOf(anchorWin);
            if (anchorRowIndex < 0) return false;

            destColumn.splice(anchorRowIndex + 1, 0, win);
            if (typeof space.layout === 'function') {
                const options = { ensure: false };
                const allocator = this._getPaperWMEqualHeightAllocator(tiling);
                if (destColumn.length > 1) {
                    options.customAllocators = {
                        [destColIndex]: allocator
                    };
                }
                space.layout(true, options);
            }

            log(`PaperWM: Placed ${win.get_title?.() || config.title || config.app_id} below ${anchorWin.get_title?.() || anchorConfig.title || anchorConfig.app_id}`);
            return this._isPaperWMWindowInSavedPosition(win, config, tiling);
        } catch (e) {
            logError(`PaperWM vertical placement failed: ${e.message}`);
            return false;
        }
    }

    _isLiveNormalWindow(win) {
        try {
            return !!win && win.get_window_type() === Meta.WindowType.NORMAL;
        } catch (e) {
            return false;
        }
    }

    _schedulePaperWMLayoutReconcile() {
        if (!this._active ||
            !this._isPaperWMActive() ||
            !this._paperWMRestoreConfigs ||
            this._paperWMRestoreConfigs.length === 0 ||
            this._paperWMReconcileTimerId > 0) {
            return;
        }

        this._paperWMReconcileTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._paperWMReconcileTimerId = 0;

            if (!this._active || !this._paperWMRestoreConfigs || this._paperWMRestoreConfigs.length === 0) {
                this._paperWMReconcileAttempts = 0;
                return GLib.SOURCE_REMOVE;
            }

            const result = this._reconcilePaperWMLayout();
            if (result.done) {
                this._paperWMReconcileAttempts = 0;
                return GLib.SOURCE_REMOVE;
            }

            this._paperWMReconcileAttempts++;
            const maxAttempts = 20;
            if (this._paperWMReconcileAttempts < maxAttempts) {
                this._schedulePaperWMLayoutReconcile();
            } else {
                log(`PaperWM: Layout reconcile gave up after ${maxAttempts} attempts (${result.reason || 'unknown'}; matched ${result.matched ?? 0}/${result.total ?? 0})`);
                this._paperWMReconcileAttempts = 0;
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _reconcilePaperWMLayout() {
        const configs = (this._paperWMRestoreConfigs || []).filter(config =>
            this._hasPaperWMPlacement(config)
        );
        const total = configs.length;

        if (total === 0) {
            return { done: true, matched: 0, total: 0 };
        }

        try {
            const tiling = this._getPaperWMTilingModule();
            if (!tiling) {
                return { done: false, reason: 'tiling unavailable', matched: 0, total };
            }

            const matchedConfigs = [];
            const missingConfigs = [];
            for (const config of configs) {
                if (!this._isLiveNormalWindow(config._matched_window)) {
                    missingConfigs.push(config);
                    continue;
                }
                matchedConfigs.push(config);
            }

            if (missingConfigs.length > 0) {
                return {
                    done: false,
                    reason: `waiting for matched windows (${missingConfigs.length} missing)`,
                    matched: matchedConfigs.length,
                    total
                };
            }

            const groups = new Map();
            for (const config of matchedConfigs) {
                const win = config._matched_window;
                const position = this._getPaperWMPosition(win, tiling);
                if (!position?.space) {
                    return {
                        done: false,
                        reason: 'waiting for PaperWM space',
                        matched: matchedConfigs.length,
                        total
                    };
                }

                const key = `${config.workspace ?? 0}:${config.monitor ?? 0}`;
                let group = groups.get(key);
                if (!group) {
                    group = {
                        key,
                        space: position.space,
                        configs: []
                    };
                    groups.set(key, group);
                }

                if (group.space !== position.space) {
                    return {
                        done: false,
                        reason: 'windows are not in the same PaperWM space yet',
                        matched: matchedConfigs.length,
                        total
                    };
                }

                group.configs.push(config);
            }

            let changed = false;
            let columnCount = 0;
            for (const group of groups.values()) {
                const result = this._reconcilePaperWMGroup(group.space, group.configs, tiling);
                changed = changed || result.changed;
                columnCount += result.columns ?? 0;

                if (!result.verified) {
                    return {
                        done: false,
                        reason: 'verification pending',
                        matched: matchedConfigs.length,
                        total
                    };
                }
            }

            if (changed) {
                log(`PaperWM: Reconciled saved layout for ${matchedConfigs.length} windows across ${columnCount} columns`);
            }

            return { done: true, matched: matchedConfigs.length, total };
        } catch (e) {
            logError(`PaperWM layout reconcile failed: ${e.message}`);
            return { done: false, reason: e.message, matched: 0, total };
        }
    }

    _reconcilePaperWMGroup(space, configs, tiling) {
        const columns = new Map();
        for (const config of configs) {
            const col = config.paperwm_col ?? 0;
            if (!columns.has(col)) {
                columns.set(col, []);
            }
            columns.get(col).push(config);
        }

        const targetColumns = Array.from(columns.keys())
            .sort((a, b) => a - b)
            .map(col => {
                const windows = columns.get(col)
                    .sort((a, b) => (a.paperwm_row ?? 0) - (b.paperwm_row ?? 0))
                    .map(config => config._matched_window)
                    .filter(win => this._isLiveNormalWindow(win));

                return {
                    savedCol: col,
                    windows
                };
            })
            .filter(column => column.windows.length > 0);

        if (targetColumns.length === 0) {
            return { changed: false, verified: true, columns: 0 };
        }

        if (this._isPaperWMGroupReconciled(space, targetColumns)) {
            return { changed: false, verified: true, columns: targetColumns.length };
        }

        const targetWindows = new Set();
        for (const column of targetColumns) {
            for (const win of column.windows) {
                targetWindows.add(win);
            }
        }

        for (let colIndex = space.length - 1; colIndex >= 0; colIndex--) {
            const column = space[colIndex];
            if (!column) continue;

            for (let rowIndex = column.length - 1; rowIndex >= 0; rowIndex--) {
                if (targetWindows.has(column[rowIndex])) {
                    column.splice(rowIndex, 1);
                }
            }

            if (column.length === 0) {
                space.splice(colIndex, 1);
            }
        }

        const firstSavedCol = targetColumns[0].savedCol;
        const insertAt = Math.max(0, Math.min(firstSavedCol, space.length));
        const rebuiltColumns = targetColumns.map(column => [...column.windows]);
        space.splice(insertAt, 0, ...rebuiltColumns);

        try {
            if (typeof space.getWindows === 'function') {
                const liveWindows = space.getWindows();
                if (!space.selectedWindow || !liveWindows.includes(space.selectedWindow)) {
                    space.selectedWindow = rebuiltColumns[0]?.[0] || liveWindows[0] || null;
                }
            }
        } catch (e) {
            // PaperWM will choose its own selected window if this lookup is unavailable.
        }

        if (typeof space.layout === 'function') {
            const options = { ensure: false };
            const allocator = this._getPaperWMEqualHeightAllocator(tiling);
            if (typeof allocator === 'function') {
                const customAllocators = {};
                for (let i = 0; i < rebuiltColumns.length; i++) {
                    if (rebuiltColumns[i].length > 1) {
                        customAllocators[insertAt + i] = allocator;
                    }
                }
                if (Object.keys(customAllocators).length > 0) {
                    options.customAllocators = customAllocators;
                }
            }

            space.layout(true, options);
        }

        return {
            changed: true,
            verified: this._isPaperWMGroupReconciled(space, targetColumns),
            columns: targetColumns.length
        };
    }

    _isPaperWMGroupReconciled(space, targetColumns) {
        for (const targetColumn of targetColumns) {
            const currentColumn = space[targetColumn.savedCol];
            if (!currentColumn || currentColumn.length !== targetColumn.windows.length) {
                return false;
            }

            for (let row = 0; row < targetColumn.windows.length; row++) {
                if (currentColumn[row] !== targetColumn.windows[row]) {
                    return false;
                }
            }
        }

        return true;
    }

    _getTilingShellManagers() {
        try {
            const tilingShellExt = Main.extensionManager.lookup('tilingshell@ferrarodomenico.com');
            const state = tilingShellExt?.stateObj;
            if (!state) return [];

            if (Array.isArray(state._tilingManagers)) {
                return state._tilingManagers;
            }

            if (Array.isArray(state.tilingManagers)) {
                return state.tilingManagers;
            }
        } catch (e) {
            // Tiling Shell is not installed, enabled, or exposes a different runtime shape.
        }

        return [];
    }

    _getTilingShellManager(monitorIndex) {
        const managers = this._getTilingShellManagers();
        if (!managers.length) return null;

        const normalizedMonitor = monitorIndex ?? 0;
        const directManager = managers[normalizedMonitor];
        if (directManager && typeof directManager.onTileFromWindowMenu === 'function') {
            return directManager;
        }

        return managers.find(manager =>
            manager &&
            typeof manager.onTileFromWindowMenu === 'function' &&
            manager._monitor &&
            manager._monitor.index === normalizedMonitor
        ) || null;
    }

    _tilingShellTileDistance(a, b) {
        const tileA = this._cloneTilingShellTile(a);
        const tileB = this._cloneTilingShellTile(b);
        if (!tileA || !tileB) return 1000;

        return Math.abs(tileA.x - tileB.x) +
            Math.abs(tileA.y - tileB.y) +
            Math.abs(tileA.width - tileB.width) +
            Math.abs(tileA.height - tileB.height);
    }

    _isTilingShellTileEqual(a, b) {
        return this._tilingShellTileDistance(a, b) < 0.001;
    }

    _isTilingShellWindowInSavedPosition(win, config) {
        return this._isTilingShellTileEqual(win?.assignedTile, config?.tilingshell_tile);
    }

    _tilingAssistantPlacementDistance(a, b) {
        const placementA = this._cloneTilingAssistantPlacement(a);
        const placementB = this._cloneTilingAssistantPlacement(b);
        if (!placementA || !placementB) return 100000;

        return this._rectDistance(
            placementA.tiled_rect || placementA.frame_rect,
            placementB.tiled_rect || placementB.frame_rect
        );
    }

    _gTilePlacementDistance(a, b) {
        const placementA = this._cloneGTilePlacement(a);
        const placementB = this._cloneGTilePlacement(b);
        if (!placementA || !placementB) return 1000;

        const rectA = placementA.normalized;
        const rectB = placementB.normalized;
        return Math.abs(rectA.x - rectB.x) +
            Math.abs(rectA.y - rectB.y) +
            Math.abs(rectA.width - rectB.width) +
            Math.abs(rectA.height - rectB.height);
    }

    _applyTilingShellTile(win, config) {
        const tile = this._cloneTilingShellTile(config?.tilingshell_tile);
        if (!win || !tile) return false;

        try {
            if (this._isTilingShellWindowInSavedPosition(win, config)) {
                return true;
            }

            const monitorIndex = typeof win.get_monitor === 'function'
                ? win.get_monitor()
                : (config.monitor ?? 0);
            const manager = this._getTilingShellManager(monitorIndex);
            if (!manager) return false;

            manager.onTileFromWindowMenu(tile, win);
            if (this._isTilingShellWindowInSavedPosition(win, config)) {
                log(`Tiling Shell: restored tile for ${win.get_title?.() || config.title || config.app_id}`);
            } else {
                log(`Tiling Shell: requested tile restore for ${win.get_title?.() || config.title || config.app_id}`);
            }

            return true;
        } catch (e) {
            logError(`Tiling Shell tile restore failed: ${e.message}`);
            return false;
        }
    }

    _isTilingAssistantWindowInSavedPosition(win, config) {
        const placement = this._cloneTilingAssistantPlacement(config?.tilingassistant);
        if (!win || !placement) return false;

        const savedRect = placement.tiled_rect || placement.frame_rect;
        const currentRect = this._cloneRectObject(win.tiledRect) || this._cloneRectObject(win.get_frame_rect?.());
        return !!win.isTiled && this._rectDistance(savedRect, currentRect) < 4;
    }

    _applyTilingAssistantPlacement(win, config) {
        const placement = this._cloneTilingAssistantPlacement(config?.tilingassistant);
        if (!win || !placement) return false;

        try {
            if (this._isTilingAssistantWindowInSavedPosition(win, config)) {
                return true;
            }

            const twm = this._getTilingAssistantWindowManager();
            if (!twm || typeof twm.tile !== 'function') return false;

            const tiledRect = placement.tiled_rect || placement.frame_rect || config.rect;
            const frameRect = placement.frame_rect || config.rect;
            const rect = new TilingAssistantCompatRect(tiledRect, frameRect);
            let monitor = config.monitor ?? (typeof win.get_monitor === 'function' ? win.get_monitor() : null);
            if (monitor !== null && !this._isValidMonitorIndex(monitor)) {
                monitor = typeof win.get_monitor === 'function' ? win.get_monitor() : 0;
            }
            const result = twm.tile(win, rect, {
                openTilingPopup: false,
                ignoreTA: false,
                monitorNr: monitor,
                skipAnim: true
            });

            if (result && typeof result.catch === 'function') {
                result.catch(err => logError(`Tiling Assistant tile restore failed: ${err.message}`));
            }

            if (placement.untiled_rect) {
                win.untiledRect = new TilingAssistantCompatRect(placement.untiled_rect);
            }

            log(`Tiling Assistant: restored tile for ${win.get_title?.() || config.title || config.app_id}`);
            return true;
        } catch (e) {
            logError(`Tiling Assistant tile restore failed: ${e.message}`);
            return false;
        }
    }

    _applyGTilePlacement(win, config) {
        const placement = this._cloneGTilePlacement(config?.gtile);
        if (!win || !placement) return false;

        try {
            const settings = this._getGTileSettings();
            if (!settings) return false;
            if (typeof win.move_resize_frame !== 'function') return false;

            let monitorIndex = config.monitor ?? (typeof win.get_monitor === 'function' ? win.get_monitor() : 0);
            if (!this._isValidMonitorIndex(monitorIndex)) {
                monitorIndex = typeof win.get_monitor === 'function' ? win.get_monitor() : 0;
            }
            if (!this._isValidMonitorIndex(monitorIndex)) {
                monitorIndex = 0;
            }
            const workspace = config.workspace !== null && config.workspace !== undefined
                ? global.workspace_manager.get_workspace_by_index(config.workspace)
                : win.get_workspace?.();
            const workArea = this._getGTileWorkArea(monitorIndex, workspace, settings);
            if (!workArea || workArea.width <= 0 || workArea.height <= 0) return false;

            const spacing = boundedNumber(
                this._getGTileInt(settings, 'window-spacing', placement.spacing ?? 0),
                placement.spacing ?? 0,
                0,
                MAX_GEOMETRY_VALUE
            );
            const projected = {
                x: workArea.x + workArea.width * placement.normalized.x,
                y: workArea.y + workArea.height * placement.normalized.y,
                width: workArea.width * placement.normalized.width,
                height: workArea.height * placement.normalized.height
            };

            if (typeof win.unmake_fullscreen === 'function') {
                win.unmake_fullscreen();
            }
            if (typeof win.set_unmaximize_flags === 'function') {
                win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
            }
            if (typeof win.unmaximize === 'function') {
                win.unmaximize();
            }

            if (typeof win.move_to_monitor === 'function') {
                win.move_to_monitor(monitorIndex);
            }

            const x = Math.round(projected.x + spacing);
            const y = Math.round(projected.y + spacing);
            const width = Math.max(1, Math.round(projected.width - spacing * 2));
            const height = Math.max(1, Math.round(projected.height - spacing * 2));

            if (typeof win.move_frame === 'function') {
                win.move_frame(true, x, y);
            }
            win.move_resize_frame(true, x, y, width, height);
            log(`gTile: restored grid-relative geometry for ${win.get_title?.() || config.title || config.app_id}`);
            return true;
        } catch (e) {
            logError(`gTile placement restore failed: ${e.message}`);
            return false;
        }
    }

    _forgePathDistance(a, b) {
        const forgeA = this._cloneForgePlacement(a);
        const forgeB = this._cloneForgePlacement(b);
        if (!forgeA || !forgeB) return 1000;

        let distance = Math.abs(forgeA.path.length - forgeB.path.length) * 4;
        const len = Math.min(forgeA.path.length, forgeB.path.length);
        for (let i = 0; i < len; i++) {
            const entryA = forgeA.path[i];
            const entryB = forgeB.path[i];
            if (entryA.parent_value !== entryB.parent_value) distance += 4;
            if (entryA.parent_layout !== entryB.parent_layout) distance += 2;
            distance += Math.abs((entryA.index ?? 0) - (entryB.index ?? 0));
        }

        return distance;
    }

    _findForgeParentForPath(tree, forge) {
        if (!tree || !forge?.path?.length) return null;

        const monitorEntry = forge.path.find(entry => entry.parent_type === 'MONITOR');
        const monitorNodeValue = monitorEntry?.parent_value || `mo${forge.monitor ?? 0}ws${forge.workspace ?? 0}`;
        let current = typeof tree.findNode === 'function'
            ? tree.findNode(monitorNodeValue)
            : null;
        if (!current) return null;

        for (let i = 0; i < forge.path.length - 1; i++) {
            const entry = forge.path[i];
            if (entry.parent_layout && current.layout !== entry.parent_layout) {
                current.layout = entry.parent_layout;
            }

            const next = current.childNodes?.[entry.index ?? 0];
            if (!next || next.nodeType !== entry.node_type) {
                return null;
            }
            if (entry.node_layout && next.layout !== entry.node_layout) {
                next.layout = entry.node_layout;
            }
            next.percent = entry.percent ?? next.percent ?? 0;
            current = next;
        }

        return current;
    }

    _applyForgePlacement(win, config) {
        const forge = this._cloneForgePlacement(config?.forge);
        if (!win || !forge) return false;

        try {
            const extWm = this._getForgeWindowManager();
            const tree = extWm?.tree;
            if (!extWm || !tree) return false;

            const node = typeof extWm.findNodeWindow === 'function'
                ? extWm.findNodeWindow(win)
                : null;
            if (!node) return false;

            const leaf = forge.path[forge.path.length - 1];
            const targetParent = this._findForgeParentForPath(tree, {
                ...forge,
                monitor: config.monitor,
                workspace: config.workspace
            });
            if (!targetParent) return false;

            if (leaf.parent_layout && targetParent.layout !== leaf.parent_layout) {
                targetParent.layout = leaf.parent_layout;
            }

            if (forge.mode === 'FLOAT') {
                return false;
            }

            node.mode = forge.mode || 'TILE';
            node.percent = leaf.percent ?? node.percent ?? 0;

            const targetIndex = leaf.index ?? 0;
            if (node.parentNode !== targetParent || node.index !== targetIndex) {
                const referenceIndex = node.parentNode === targetParent && node.index < targetIndex
                    ? targetIndex + 1
                    : targetIndex;
                const referenceNode = targetParent.childNodes?.[referenceIndex] || null;
                targetParent.insertBefore(node, referenceNode);
            }

            if (typeof extWm.renderTree === 'function') {
                extWm.renderTree('gnome-essentials-forge', true);
                return true;
            }

            if (typeof extWm.move === 'function' && forge.rect) {
                extWm.move(win, forge.rect);
                return true;
            }
        } catch (e) {
            logError(`Forge placement restore failed: ${e.message}`);
        }

        return false;
    }

    _applyWindowGeometry(win, config) {
        if (!win) return;

        try {
            const rect = this._cloneRectObject(config?.rect);
            const isPaperWMConfig = this._hasPaperWMPlacement(config);
            const paperWMHandled = isPaperWMConfig && this._isPaperWMActive();
            const isTilingShellConfig = this._hasTilingShellPlacement(config);
            const isTilingAssistantConfig = this._hasTilingAssistantPlacement(config);
            const isGTileConfig = this._hasGTilePlacement(config);
            const isForgeConfig = this._hasForgePlacement(config);

            if (config.monitor !== null &&
                config.monitor !== undefined &&
                this._isValidMonitorIndex(config.monitor) &&
                typeof win.get_monitor === 'function' &&
                typeof win.move_to_monitor === 'function' &&
                win.get_monitor() !== config.monitor) {
                win.move_to_monitor(config.monitor);
            }

            const tilingShellHandled = isTilingShellConfig && this._applyTilingShellTile(win, config);
            const tilingAssistantHandled = !tilingShellHandled &&
                isTilingAssistantConfig &&
                this._applyTilingAssistantPlacement(win, config);
            const gTileHandled = !tilingShellHandled &&
                !tilingAssistantHandled &&
                isGTileConfig &&
                this._applyGTilePlacement(win, config);
            const forgeHandled = !tilingShellHandled &&
                !tilingAssistantHandled &&
                !gTileHandled &&
                isForgeConfig &&
                this._applyForgePlacement(win, config);
            const handledByTiler = paperWMHandled || tilingShellHandled || tilingAssistantHandled || gTileHandled || forgeHandled;

            if (!handledByTiler && config.maximized && typeof win.maximize === 'function') {
                win.maximize(Meta.MaximizeFlags.BOTH);
            } else if (!handledByTiler && rect && typeof win.move_resize_frame === 'function') {
                if (typeof win.unmake_fullscreen === 'function') {
                    win.unmake_fullscreen();
                }
                if (typeof win.unmaximize === 'function') {
                    win.unmaximize();
                }
                win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
            }

            if (!handledByTiler) {
                try {
                    if (typeof win.raise === 'function') {
                        win.raise();
                    }
                } catch (raiseErr) {
                    // ignore
                }
            }

            // Restore visual active focus
            if (config.is_focused) {
                try {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        if (!this._active) return GLib.SOURCE_REMOVE;
                        if (win && typeof win.activate === 'function') {
                            win.activate(global.get_current_time());
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (focusErr) {
                    // ignore
                }
            }

            // PaperWM vertical tiling support
            try {
                if (paperWMHandled && config.paperwm_row > 0 && !config._paperwm_slurp_scheduled) {
                    config._paperwm_slurp_scheduled = true;
                    let attempts = 0;
                    const maxAttempts = 12;
                    const cleanupSlurpTimer = () => {
                        config._paperwm_slurp_scheduled = false;
                        this._paperWMSlurpTimerIds = (this._paperWMSlurpTimerIds || []).filter(id => id !== timerId);
                    };

                    const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        attempts++;
                        if (!this._active) {
                            cleanupSlurpTimer();
                            return GLib.SOURCE_REMOVE;
                        }

                        try {
                            const tiling = this._getPaperWMTilingModule();
                            if (!tiling || this._isPaperWMWindowInSavedPosition(win, config, tiling)) {
                                cleanupSlurpTimer();
                                return GLib.SOURCE_REMOVE;
                            }

                            if (this._applyPaperWMVerticalPlacement(win, config, tiling)) {
                                cleanupSlurpTimer();
                                return GLib.SOURCE_REMOVE;
                            }

                            if (attempts < maxAttempts) {
                                return GLib.SOURCE_CONTINUE;
                            }

                            log(`PaperWM: Could not place ${win.get_title?.() || config.title || config.app_id} in saved vertical row after ${attempts} attempts`);
                        } catch (err) {
                            logError(`PaperWM slurp failed: ${err.message}`);
                        }
                        cleanupSlurpTimer();
                        return GLib.SOURCE_REMOVE;
                    });
                    this._paperWMSlurpTimerIds.push(timerId);
                }
            } catch (err) {
                // ignore
            }
        } catch (e) {
            logError(`Failed to apply window geometry: ${e.message}`);
        }
    }

    _launchAppForConfig(app, config) {
        this._ensureWorkspaceExists(config.workspace);

        try {
            if (this._launchAppForContextOverride(app, config)) {
                return;
            }

            if (typeof app.open_new_window === 'function') {
                app.open_new_window(config.workspace ?? -1);
            } else {
                app.activate();
            }
        } catch (e) {
            logError(`Failed to launch ${config.app_id} on workspace ${config.workspace}: ${e.message}`);
            try {
                app.activate();
            } catch (fallbackError) {
                logError(`Fallback launch failed for ${config.app_id}: ${fallbackError.message}`);
            }
        }
    }

    setContextLaunchOverrides(profileName, contexts) {
        this._clearContextLaunchOverrides();

        const byAppId = new Map();
        for (const context of Array.isArray(contexts) ? contexts : []) {
            const appId = this._normalizeAppIdForContext(context?.appId || context?.value);
            const attachments = Array.isArray(context?.attachments)
                ? context.attachments
                    .map(attachment => ({ ...attachment }))
                    .filter(attachment => attachment.type === 'file' || attachment.type === 'folder' || attachment.type === 'url')
                : [];
            if (!appId || attachments.length === 0) continue;

            byAppId.set(appId, {
                label: context.label || appId,
                attachments
            });
        }

        if (byAppId.size === 0) return false;

        this._contextLaunchOverrides = {
            profileName,
            byAppId
        };
        this._contextLaunchOverrideClearId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
            this._clearContextLaunchOverrides();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _primeContextLaunchMatching(profileName, configs) {
        if (!Array.isArray(configs)) return;

        const overrides = this._contextLaunchOverrides;
        const offsets = new Map();

        for (const config of configs) {
            delete config._context_match_attachment;
            delete config._context_match_attachment_key;
            delete config._context_match_required;
            delete config._context_match_terms;

            if (!overrides || !config?.app_id) continue;
            if (overrides.profileName && profileName && overrides.profileName !== profileName) continue;
            if (overrides.profileName &&
                config._restore_profile_name &&
                overrides.profileName !== config._restore_profile_name) {
                continue;
            }

            const appId = this._normalizeAppIdForContext(config.app_id);
            const bucket = overrides.byAppId?.get(appId);
            if (!bucket || !Array.isArray(bucket.attachments) || bucket.attachments.length === 0) continue;

            const offset = offsets.get(appId) || 0;
            const attachment = bucket.attachments[offset] || null;
            if (!attachment) continue;

            const terms = this._contextTermsFromAttachment(attachment);
            if (terms.length === 0) continue;

            config._context_match_attachment = { ...attachment };
            config._context_match_attachment_key = this._contextAttachmentKey(attachment);
            config._context_match_required = true;
            config._context_match_terms = terms;
            offsets.set(appId, offset + 1);
        }
    }

    _clearContextLaunchOverrides() {
        if (this._contextLaunchOverrideClearId > 0) {
            try {
                GLib.source_remove(this._contextLaunchOverrideClearId);
            } catch (e) {
                // Timer may already have fired.
            }
            this._contextLaunchOverrideClearId = 0;
        }
        this._contextLaunchOverrides = null;
    }

    _launchAppForContextOverride(app, config) {
        const attachment = this._takeContextLaunchAttachment(config);
        if (!attachment) return false;
        this._annotateContextLaunchConfig(config, attachment);

        try {
            const appInfo = app?.get_app_info?.() || app?.appInfo || null;
            if (!appInfo) return false;

            const timestamp = global.get_current_time?.() ?? 0;
            const context = global.create_app_launch_context?.(timestamp, config.workspace ?? -1) ?? null;

            if (attachment.type === 'url') {
                const uri = String(attachment.value || attachment.uri || '').trim();
                if (uri && typeof appInfo.launch_uris === 'function') {
                    appInfo.launch_uris([uri], context);
                    log(`Context-launched ${config.app_id} with URL ${uri}`);
                    return true;
                }
                return false;
            }

            const file = this._fileFromContextAttachment(attachment);
            if (!file) return false;

            appInfo.launch([file], context);
            log(`Context-launched ${config.app_id} with ${attachment.type} ${attachment.path || attachment.uri || attachment.value}`);
            return true;
        } catch (e) {
            logError(`Context launch failed for ${config.app_id}: ${e.message}`);
            return false;
        }
    }

    _takeContextLaunchAttachment(config) {
        const overrides = this._contextLaunchOverrides;
        if (!overrides || !config?.app_id) return null;
        if (overrides.profileName && config._restore_profile_name && overrides.profileName !== config._restore_profile_name) {
            return null;
        }

        const appId = this._normalizeAppIdForContext(config.app_id);
        const bucket = overrides.byAppId?.get(appId);
        if (!bucket || !Array.isArray(bucket.attachments) || bucket.attachments.length === 0) return null;

        if (config._context_match_attachment_key) {
            const index = bucket.attachments.findIndex(attachment =>
                this._contextAttachmentKey(attachment) === config._context_match_attachment_key);
            if (index >= 0) {
                return bucket.attachments.splice(index, 1)[0];
            }
        }

        return bucket.attachments.shift();
    }

    _contextAttachmentKey(attachment) {
        const type = String(attachment?.type || '').trim().toLowerCase();
        const value = String(attachment?.uri || attachment?.path || attachment?.value || '').trim();
        return `${type}:${value}`;
    }

    _fileFromContextAttachment(attachment) {
        try {
            if (attachment?.uri) return Gio.File.new_for_uri(attachment.uri);
            if (attachment?.path) return Gio.File.new_for_path(attachment.path);
            if (attachment?.value?.startsWith?.('file://')) return Gio.File.new_for_uri(attachment.value);
            if (GLib.path_is_absolute(attachment?.value || '')) return Gio.File.new_for_path(attachment.value);
        } catch (e) {
            logError(`Could not resolve context launch attachment: ${e.message}`);
        }

        return null;
    }

    _annotateContextLaunchConfig(config, attachment) {
        if (!config || !attachment) return;

        config._context_launch_attachment = { ...attachment };
        config._context_match_terms = this._contextTermsFromAttachment(attachment);
    }

    _contextTermsFromAttachment(attachment) {
        const terms = [];
        const addTerm = value => {
            const text = String(value ?? '').trim();
            if (!text) return;
            if (!terms.includes(text)) terms.push(text);
        };

        addTerm(attachment?.label);
        addTerm(this._basenameFromContextValue(attachment?.path));
        addTerm(this._basenameFromContextValue(attachment?.uri));
        addTerm(this._basenameFromContextValue(attachment?.value));

        const basename = terms.find(term => term && term.includes('.')) || '';
        const dot = basename.lastIndexOf('.');
        if (dot > 0) {
            addTerm(basename.slice(0, dot));
        }

        return terms;
    }

    _basenameFromContextValue(value) {
        let text = String(value ?? '').trim();
        if (!text) return '';

        try {
            text = decodeURIComponent(text);
        } catch (e) {
            // Keep original text if it is not URI-encoded.
        }

        text = text.split(/[?#]/)[0].replace(/^file:\/+/i, '/');
        const parts = text.split(/[\\/]/).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : text;
    }

    _normalizeAppIdForContext(appId) {
        const value = String(appId ?? '').trim().toLowerCase();
        if (!value) return '';
        return value.endsWith('.desktop') ? value : `${value}.desktop`;
    }

    _clearLaunchTimers() {
        if (!this._launchTimerIds) {
            this._launchTimerIds = [];
            return;
        }

        for (const id of this._launchTimerIds) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Source may already have fired.
            }
        }
        this._launchTimerIds = [];
    }

    _clearPaperWMSlurpTimers() {
        if (!this._paperWMSlurpTimerIds) {
            this._paperWMSlurpTimerIds = [];
            return;
        }

        for (const id of this._paperWMSlurpTimerIds) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Source may already have fired.
            }
        }
        this._paperWMSlurpTimerIds = [];
    }

    _clearPaperWMReconcileTimer() {
        if (this._paperWMReconcileTimerId > 0) {
            try {
                GLib.source_remove(this._paperWMReconcileTimerId);
            } catch (e) {
                // Source may already have fired.
            }
        }

        this._paperWMReconcileTimerId = 0;
        this._paperWMReconcileAttempts = 0;
    }

    // ==========================================
    // Layout Capture and Storage Logic
    // ==========================================
    _captureCurrentLayoutWindows() {
        const workspaceManager = global.workspace_manager;
        const numWorkspaces = workspaceManager.get_n_workspaces();
        const savedWindows = [];
        const seenStableSequences = new Set();

        const focusedWindow = global.display.get_focus_window();
        const actors = global.get_window_actors();
        const stackMap = new Map();
        actors.forEach((a, idx) => {
            const w = a.get_meta_window();
            if (w) stackMap.set(w, idx);
        });

        for (let i = 0; i < numWorkspaces; i++) {
            const ws = workspaceManager.get_workspace_by_index(i);
            const windows = ws.list_windows();

            for (const win of windows) {
                // Save normal user applications only
                if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) continue;
                if (win.minimized) continue;

                const stableSequence = this._getStableSequence(win);
                if (stableSequence !== null && stableSequence !== undefined) {
                    if (seenStableSequences.has(stableSequence)) continue;
                    seenStableSequences.add(stableSequence);
                }

                savedWindows.push(this._createWindowConfig(win, null, stackMap.get(win) ?? 0, win === focusedWindow));
            }
        }

        // Sort captured windows in exact physical tiling order so they are saved sequentially
        savedWindows.sort((a, b) => this._compareWindowsForTiling(a, b));

        this._addIdentityIndexes(savedWindows);
        this._addCreationIndexes(savedWindows);
        return savedWindows;
    }

    saveCurrentLayout(profileName, options = {}) {
        if (!profileName) {
            const result = { ok: false, message: 'Profile name cannot be empty.' };
            this._emitProfileOperation('error', 'save', result.message, options);
            return result;
        }

        try {
            const now = new Date().toISOString();
            const savedWindows = this._captureCurrentLayoutWindows();

            const data = this._readProfilesData();
            const existing = data.profiles[profileName];
            if (existing && options.overwrite === false) {
                const result = { ok: false, message: `Profile "${profileName}" already exists.` };
                this._emitProfileOperation('error', 'save', result.message, options, { profile: profileName });
                return result;
            }

            data.profiles[profileName] = {
                name: profileName,
                created_at: existing?.created_at || now,
                updated_at: now,
                windows: savedWindows
            };

            this._writeProfilesData(data);

            const windowWord = savedWindows.length === 1 ? 'window' : 'windows';
            const verb = options.operation === 'modify' ? 'Modified' : 'Saved';
            const message = `${verb} "${profileName}" with ${savedWindows.length} ${windowWord}.`;
            this._emitProfileOperation('success', options.operation || 'save', message, options, {
                profile: profileName,
                window_count: savedWindows.length,
                overwritten: !!existing
            });
            log(`Profile layout saved successfully: ${profileName}`);
            return { ok: true, message, windowCount: savedWindows.length };
        } catch (e) {
            const message = `Failed to save layout profile: ${e.message}`;
            logError(message);
            this._emitProfileOperation('error', 'save', message, options, { profile: profileName });
            return { ok: false, message };
        }
    }

    renameProfile(oldName, newName) {
        return this._renameProfile(oldName, newName);
    }

    deleteProfile(name) {
        return this._deleteProfile(name);
    }

    // ==========================================
    // Layout Positioning and Application Spawning Logic
    // ==========================================
    applyProfile(profileName) {
        if (!profileName || !this._active) return;

        log(`Applying workspace layout profile: ${profileName}`);
        
        try {
            const data = this._readProfilesData();
            const profile = this._getProfileWindows(data, profileName);
            if (!profile) {
                const message = `Profile not found: ${profileName}`;
                logError(message);
                this._emitProfileOperation('error', 'apply', message, { name: profileName });
                return;
            }

            this._saveSafetySnapshot('before-profile-restore', {
                source: 'profile-restore',
                targetProfile: profileName
            });
            this._applyWindowConfigs(profileName, profile, {
                setActiveProfile: true,
                operation: 'apply',
                successMessage: `Switched to layout profile "${profileName}"`
            });
        } catch (e) {
            const message = `Failed to apply workspace layout: ${e.message}`;
            logError(message);
            this._emitProfileOperation('error', 'apply', message, { name: profileName });
        }
    }

    _applyWindowConfigs(profileName, profile, options = {}) {
        if (!Array.isArray(profile) || !this._active) return;

        try {
            const appSystem = Shell.AppSystem.get_default();
            const actors = global.get_window_actors();
            const runningWindows = actors.map(a => a.get_meta_window()).filter(w => w && w.get_window_type() === Meta.WindowType.NORMAL);
            const candidates = this._buildRunningWindowCandidates(runningWindows);

            // Sort profile configs in exact physical tiling order to naturally replicate the window positions
            this._clearPaperWMReconcileTimer();
            const sortedProfile = [...profile].sort((a, b) => this._compareWindowsForTiling(a, b));
            for (const config of sortedProfile) {
                config._restore_profile_name = profileName;
            }
            const autoLaunch = this._settings.get_boolean('profiles-auto-launch');
            if (autoLaunch) this._primeContextLaunchMatching(profileName, sortedProfile);
            this._paperWMRestoreConfigs = sortedProfile.filter(config => this._hasPaperWMPlacement(config));
            for (const config of this._paperWMRestoreConfigs) {
                delete config._matched_window;
                delete config._paperwm_slurp_scheduled;
            }

            for (const config of sortedProfile) {
                this._ensureWorkspaceExists(config.workspace);
            }

            // Set active profile name setting
            if (options.setActiveProfile !== false) {
                this._lastAppliedProfile = profileName;
            }
            if (options.setActiveProfile !== false && this._settings.get_string('profiles-active-profile') !== profileName) {
                try {
                    this._updatingActiveProfileSetting = true;
                    this._settings.set_string('profiles-active-profile', profileName);
                } finally {
                    this._updatingActiveProfileSetting = false;
                }
            }

            this._clearLaunchTimers();
            this._clearPaperWMSlurpTimers();
            this._clearPendingScanTimers();
            this._pendingRestorations = [];

            // Find optimal matches globally using our two-pass optimal assignment matrix
            const optimalMatches = this._findOptimalMatches(sortedProfile, candidates);

            // 1. Position all running matched windows first
            for (let i = 0; i < sortedProfile.length; i++) {
                if (optimalMatches.has(i)) {
                    const config = sortedProfile[i];
                    const candidateIndex = optimalMatches.get(i);
                    const matchedWindow = candidates[candidateIndex].win;
                    this._positionWindow(matchedWindow, config);
                }
            }

            // 2. Collect missing configurations for launching.
            const launchConfigs = [];
            if (autoLaunch) {
                for (let i = 0; i < sortedProfile.length; i++) {
                    if (!optimalMatches.has(i)) {
                        const config = sortedProfile[i];
                        if (config.app_id) {
                            const app = appSystem.lookup_app(config.app_id);
                            if (app) {
                                launchConfigs.push({ config, app });
                            }
                        }
                    }
                }
            }

            // PaperWM still benefits from launch order, but the reconciler
            // below treats saved PaperWM columns/rows as the source of truth.
            launchConfigs.sort((a, b) => this._compareWindowsForLaunchOrder(a, b));

            // 3. Assign launch indices and add to pending restorations immediately (synchronously)
            const launchCounts = new Map();
            for (const { config } of launchConfigs) {
                const appKey = (config.wm_class || '').toLowerCase();
                const launchIdx = launchCounts.get(appKey) || 0;
                config.launch_index = launchIdx;
                launchCounts.set(appKey, launchIdx + 1);

                this._pendingRestorations.push(config);
            }

            // Refresh matching indexes; launch_index remains the restore-order signal.
            this._addIdentityIndexes(this._pendingRestorations);
            this._addCreationIndexes(this._pendingRestorations);

            // 4. Stagger launches in restore order so PaperWM can rebuild tiling.
            let delay = 0;
            const STAGGER_MS = 600; // 600ms gap gives each app a chance to map in order
            for (const { config, app } of launchConfigs) {
                const currentDelay = delay;
                const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, currentDelay, () => {
                    this._launchTimerIds = this._launchTimerIds.filter(id => id !== timerId);
                    if (!this._active) return GLib.SOURCE_REMOVE;
                    try {
                        this._ensureWorkspaceExists(config.workspace);
                        log(`Autostarting application in restore order: ${config.app_id} (paperwm_col: ${config.paperwm_col}, stable_sequence: ${config.stable_sequence}) with delay ${currentDelay}ms`);
                        this._launchAppForConfig(app, config);
                    } catch (appErr) {
                        logError(`Failed to autostart application ${config.app_id}: ${appErr.message}`);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                this._launchTimerIds.push(timerId);
                delay += STAGGER_MS;
            }

            if (launchConfigs.length > 0) {
                this._schedulePendingRestorationScan(delay + 900);
                this._schedulePendingRestorationScan(delay + 2400);
                this._schedulePendingRestorationScan(delay + 4800);
                this._schedulePendingRestorationScan(delay + 7600);
            }

            const operation = options.operation || 'apply';
            const message = options.successMessage || `Switched to layout profile "${profileName}"`;
            this._emitProfileOperation('success', operation, message, {
                name: options.statusProfile || profileName
            }, {
                window_count: profile.length,
                pending_launches: this._pendingRestorations.length
            });
            this._notify(message);
        } catch (e) {
            const operation = options.operation || 'apply';
            const message = `Failed to apply workspace layout: ${e.message}`;
            logError(message);
            this._emitProfileOperation('error', operation, message, {
                name: options.statusProfile || profileName
            });
        }
    }

    _positionWindow(win, config) {
        if (!win) return;
        config._matched_window = win;
        if (this._hasPaperWMPlacement(config)) {
            this._schedulePaperWMLayoutReconcile();
        }

        // Perform geometry movements in an idle task to ensure Mutter processes layout sizes fully
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._active) return GLib.SOURCE_REMOVE;

            this._moveWindowToWorkspace(win, config.workspace);
            this._applyWindowGeometry(win, config);

            // Some clients reassert size after workspace moves/unmaximize. Reapply once after Mutter settles.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (!this._active) return GLib.SOURCE_REMOVE;

                this._moveWindowToWorkspace(win, config.workspace);
                this._applyWindowGeometry(win, config);
                return GLib.SOURCE_REMOVE;
            });

            if (config._context_launch_attachment) {
                for (const delay of [900, 2200, 4200]) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                        if (!this._active) return GLib.SOURCE_REMOVE;

                        this._moveWindowToWorkspace(win, config.workspace);
                        this._applyWindowGeometry(win, config);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _restorePendingWindow(win) {
        if (!this._pendingRestorations || this._pendingRestorations.length === 0) return;
        
        try {
            // Guard against finalized or quickly closed windows
            if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) return;

            const wmClass = win.get_wm_class();
            const app = this._getWindowApp(win);
            const appId = app ? app.get_id() : null;
            const candidate = {
                win,
                config: this._createWindowConfig(win)
            };
            this._addIdentityIndexes([candidate.config]);
            this._addCreationIndexes([candidate.config]);
            this._addLaunchIndexes([candidate]);

            // Verify if this newly created window matches one of our autostarted app configs
            const hasMatch = this._pendingRestorations.some(c => 
                (appId && c.app_id === appId) || 
                (wmClass && c.wm_class && c.wm_class.toLowerCase() === wmClass.toLowerCase()) ||
                (win.get_title && c.title && c.title === win.get_title()) ||
                this._scoreCandidate(c, candidate) !== -Infinity
            );

            if (!hasMatch) return;

            // Add to the recently mapped settling queue
            if (!this._recentlyMappedWindows) {
                this._recentlyMappedWindows = [];
            }
            if (!this._recentlyMappedWindows.includes(win)) {
                this._recentlyMappedWindows.push(win);
            }

            // Reset/Set the settling timer
            if (this._settleTimerId > 0) {
                GLib.source_remove(this._settleTimerId);
                this._settleTimerId = 0;
            }

            this._settleTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._settleTimerId = 0;
                this._processSettleQueue();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            log(`Failed to restore pending window: ${e.message}`);
        }
    }

    _processSettleQueue() {
        if (!this._recentlyMappedWindows || this._recentlyMappedWindows.length === 0) return;
        if (!this._pendingRestorations || this._pendingRestorations.length === 0) {
            this._recentlyMappedWindows = [];
            return;
        }

        try {
            log(`Processing settling queue with ${this._recentlyMappedWindows.length} windows...`);

            // Build candidate configs for the recently mapped windows
            // First filter out any windows that might have been destroyed/closed
            const activeWindows = this._recentlyMappedWindows.filter(win => {
                try {
                    return win && win.get_window_type() === Meta.WindowType.NORMAL;
                } catch (e) {
                    return false;
                }
            });

            if (activeWindows.length === 0) {
                this._recentlyMappedWindows = [];
                return;
            }

            const candidates = this._buildRunningWindowCandidates(activeWindows);
            this._addLaunchIndexes(candidates);
            
            // Find optimal matches between pending restorations and candidates
            const optimalMatches = this._findOptimalMatches(this._pendingRestorations, candidates);

            // Apply positions for matched ones in descending order of config index to avoid splicing issues
            const matchedConfigIndices = Array.from(optimalMatches.keys()).sort((a, b) => b - a);

            for (const configIdx of matchedConfigIndices) {
                const candidateIdx = optimalMatches.get(configIdx);
                const config = this._pendingRestorations[configIdx];
                const matchedWindow = candidates[candidateIdx].win;

                log(`Settling queue matched: ${config.wm_class} (creation_index: ${config.creation_index}) to window "${matchedWindow.get_title()}"`);
                this._positionWindow(matchedWindow, config);

                // Remove from pending restorations
                this._pendingRestorations.splice(configIdx, 1);
            }

            // Re-index remaining pending restorations
            this._addIdentityIndexes(this._pendingRestorations);
            this._addCreationIndexes(this._pendingRestorations);
            if (this._pendingRestorations.length > 0) {
                this._schedulePendingRestorationScan(900);
            }

        } catch (e) {
            logError(`Failed during settling queue processing: ${e.message}`);
        } finally {
            this._recentlyMappedWindows = [];
        }
    }

    _schedulePendingRestorationScan(delayMs) {
        if (!this._active || !this._pendingRestorations || this._pendingRestorations.length === 0) return;

        const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
            this._pendingScanTimerIds = (this._pendingScanTimerIds || []).filter(id => id !== timerId);
            if (!this._active) return GLib.SOURCE_REMOVE;
            this._scanPendingRestorations();
            return GLib.SOURCE_REMOVE;
        });
        this._pendingScanTimerIds.push(timerId);
    }

    _clearPendingScanTimers() {
        if (!this._pendingScanTimerIds) {
            this._pendingScanTimerIds = [];
            return;
        }

        for (const id of this._pendingScanTimerIds) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Source may already have fired.
            }
        }
        this._pendingScanTimerIds = [];
    }

    _scanPendingRestorations() {
        if (!this._pendingRestorations || this._pendingRestorations.length === 0) return;

        try {
            const windows = global.get_window_actors()
                .map(actor => actor.get_meta_window())
                .filter(win => win && win.get_window_type() === Meta.WindowType.NORMAL);
            if (windows.length === 0) return;

            const candidates = this._buildRunningWindowCandidates(windows);
            this._addLaunchIndexes(candidates);
            const optimalMatches = this._findOptimalMatches(this._pendingRestorations, candidates);
            const matchedConfigIndices = Array.from(optimalMatches.keys()).sort((a, b) => b - a);
            if (matchedConfigIndices.length === 0) return;

            for (const configIdx of matchedConfigIndices) {
                const candidateIdx = optimalMatches.get(configIdx);
                const config = this._pendingRestorations[configIdx];
                const matchedWindow = candidates[candidateIdx].win;

                log(`Delayed scan matched: ${config.wm_class || config.app_id} to window "${matchedWindow.get_title?.() || ''}"`);
                this._positionWindow(matchedWindow, config);
                this._pendingRestorations.splice(configIdx, 1);
            }

            this._addIdentityIndexes(this._pendingRestorations);
            this._addCreationIndexes(this._pendingRestorations);
        } catch (e) {
            logError(`Failed during delayed pending restoration scan: ${e.message}`);
        }
    }

    _notify(message) {
        let showNotifications = true;
        try {
            showNotifications = this._settings.get_boolean('profiles-show-notifications');
        } catch (e) {
            // Default to true if not found
        }
        if (showNotifications) {
            Main.notify('Workspace Session Restorer', message);
        }
    }
}
