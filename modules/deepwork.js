// GNOME Essentials: Sleek, Modular Desktop Utilities
// Author: Ritesh Seth
// License: GPL v3
//
// modules/deepwork.js (Deep Work Flagship Module)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DEBUG = false;
const POMODORO_FOCUS_MINUTES_MIN = 10;
const POMODORO_FOCUS_MINUTES_MAX = 300;
const POMODORO_REST_MINUTES_MIN = 5;
const POMODORO_REST_MINUTES_MAX = 180;
const POMODORO_FLOATING_POSITION_UNSET = -1.0;
const POMODORO_CLOCK_CHECK_SECONDS = 15;

function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][DeepWork] ' + msg);
}

function logError(msg) {
    console.error('[GnomeEssentials][DeepWork] ERROR: ' + msg);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * DeepWorkModule class.
 * Flagship deep focus engine for GNOME Essentials.
 * Dynamically overlays radial ambient gradients, manages high-performance Clutter window blurs,
 * silences incoming notification banners, auto-hides the top status bar, and controls
 * a floating Pomodoro alarm clock stopwatch.
 */
export default class DeepWorkModule {
    /**
     * Constructs the DeepWorkModule.
     * @param {Object} extensionContext - Core orchestrator context.
     */
    constructor(extensionContext) {
        this.context = extensionContext;
        this._settings = extensionContext.getSettings();
        this._notificationSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        
        this._active = false;
        
        // Cache original values to restore them exactly
        this._originalShowBanners = true;
        this._originalPanelVisible = true;
        
        // Signal IDs
        this._focusWindowId = 0;
        this._windowCreatedId = 0;
        this._workspaceChangedId = 0;
        this._overviewShowingId = 0;
        this._overviewShownId = 0;
        this._overviewHidingId = 0;
        this._overviewHiddenId = 0;
        this._overviewPanelHideTimerId = 0;
        this._postOverviewPanelReconcileTimerId = 0;
        this._panelRevealRefreshTimerId = 0;
        this._notificationSettingsChangedId = 0;
        this._notificationSuppressionTimerId = 0;
        this._messageTraySourceAddedId = 0;
        this._notificationSourceSignalIds = new Map();
        this._settingsHandlers = [];
        this._panelActorOriginalVisibility = new Map();
        this._panelChromeOriginalStates = new Map();
        this._panelChromeStrutsSuppressed = false;
        this._panelPeekActive = false;
        this._panelPeekTimerId = 0;
        this._panelOverviewRevealOriginalOpacity = new Map();
        this._paperWMOriginalShowTopBar = new Map();
        this._paperWMBridgeLastState = new Map();
        
        // Pomodoro State
        this._pomodoroTimer = null;
        this._pomodoroSessionActive = false;
        this._wasActiveBeforeLock = false;
        this._screenShieldSignalId = 0;
        this._pomodoroRemaining = 0;
        this._pomodoroState = 'focus'; // 'focus' or 'rest'
        this._pomodoroButton = null;
        this._pomodoroLabel = null;
        this._pomodoroClockTimerId = 0;
        this._pomodoroClockLastTriggerKey = null;
        this._pomodoroClockMenuItem = null;
        this._pomodoroClockToggleItem = null;
        this._pomodoroClockSetNowItem = null;
        this._pomodoroClockHourLabel = null;
        this._pomodoroClockMinuteLabel = null;
        this._pomodoroFocusLabel = null;
        this._pomodoroFocusInfiniteToggle = null;
        this._pomodoroFocusMinus = null;
        this._pomodoroFocusPlus = null;
        this._pomodoroRestLabel = null;
        this._pomodoroRestMinus = null;
        this._pomodoroRestPlus = null;
        this._pomodoroSettingsMenuItem = null;
        this._pomodoroCountBadge = null;
        this._focusNotificationCount = 0;
        this._focusNotificationSessionActive = false;
        this._focusNotificationHadSuppression = false;
        this._focusNotificationSummaryTimerId = 0;
        this._focusNotificationApps = null;
        this._focusNotifications = [];
        this._activeSummaryMenu = null;
        this._floatingPomodoroActor = null;
        this._floatingPomodoroLabel = null;
        this._floatingPomodoroCountBadge = null;
        this._floatingPomodoroIcon = null;
        this._floatingPomodoroDragHandle = null;
        this._floatingPomodoroPeekIcon = null;
        this._floatingPomodoroDragState = null;
        this._floatingPomodoroStageCaptureId = 0;
        this._floatingPomodoroChromeTracked = false;
        this._floatingPomodoroChromePlacement = null;
        this._floatingPomodoroRaiseTimerId = 0;
        this._ambientTimerId = 0;
        this._ambientOverlay = null;
        this._ambientOverlayMode = null;
        this._ambientDimmingRefreshTimerId = 0;
        this._ambientFocusPollerId = 0;

        this._dashToDockSettings = null;
        this._originalDashToDockDockFixed = null;
        this._externalDockActorStates = new Map();
        this._messageTrayBannerActorStates = new Map();
    }

    /**
     * Enables the Deep Work focus module, connects listeners, binds GSettings handlers,
     * and sets up the Pomodoro indicators.
     * @returns {void}
     */
    enable() {
        log('Enabling Deep Work module...');
        this._active = false;

        // Connect signals for focus shifts & dynamic dimming. They are cheap
        // while inactive and keep the timer-loaded module ready to activate.
        this._connectSignals();
        this._connectNotificationSignals();

        // Bind Settings changed listeners for all keys to support live customizations
        this._settingsHandlers = [];
        const bindKey = (key, callback) => {
            const id = this._settings.connect('changed::' + key, callback);
            this._settingsHandlers.push(id);
        };

        bindKey('deepwork-enabled', () => this._syncFocusModeFromSettings());
        bindKey('deepwork-snooze-level', () => this._applyFocusConfigurations());
        bindKey('deepwork-hide-dock', () => this._applyFocusConfigurations());
        bindKey('deepwork-hide-panel', () => this._applyFocusConfigurations());
        bindKey('deepwork-hide-panel-in-overview', () => this._applyFocusConfigurations());
        bindKey('deepwork-mute-notifications', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-dim', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-color', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-dim-opacity', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-blur-intensity', () => this._applyFocusConfigurations());
        bindKey('deepwork-true-ambient-opacity', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-dim-level3', () => this._applyFocusConfigurations());
        bindKey('deepwork-ambient-blur-level3', () => this._applyFocusConfigurations());
        bindKey('deepwork-pomodoro-timer-enabled', () => this._evaluatePomodoroIndicator());
        bindKey('deepwork-pomodoro-panel-peek-duration', () => {
            if (this._panelPeekActive) this._schedulePanelPeekTimeout();
        });
        bindKey('deepwork-pomodoro-focus-time', () => {
            this._resetPomodoroState();
            this._updatePomodoroSettingsMenu();
        });
        bindKey('deepwork-pomodoro-focus-infinite', () => {
            this._resetPomodoroState();
            this._updatePomodoroSettingsMenu();
        });
        bindKey('deepwork-pomodoro-rest-time', () => {
            this._resetPomodoroState();
            this._updatePomodoroSettingsMenu();
        });
        bindKey('deepwork-pomodoro-clock-enabled', () => this._syncPomodoroClockState());
        bindKey('deepwork-pomodoro-clock-hour', () => this._onPomodoroClockTimeChanged());
        bindKey('deepwork-pomodoro-clock-minute', () => this._onPomodoroClockTimeChanged());
        bindKey('deepwork-focus-notification-summary-enabled', () => this._updatePomodoroDisplay());
        bindKey('deepwork-pomodoro-floating-vertical', () => {
            this._animateFloatingPomodoroRecreation();
        });
        bindKey('deepwork-pomodoro-floating-show-time', () => {
            this._animateFloatingPomodoroRecreation();
        });
        bindKey('deepwork-pomodoro-floating-show-clock', () => {
            this._animateFloatingPomodoroRecreation();
        });
        bindKey('deepwork-pomodoro-floating-collapsed', () => {
            this._animateFloatingPomodoroRecreation(() => {
                const isCollapsed = this._settings.get_boolean('deepwork-pomodoro-floating-collapsed');
                if (!isCollapsed) {
                    this._settings.set_boolean('deepwork-pomodoro-floating-icon-only', false);
                }
            });
        });
        bindKey('deepwork-pomodoro-floating-icon-only', () => {
            this._animateFloatingPomodoroRecreation();
        });
        bindKey('deepwork-pomodoro-show-notification-count', () => this._updatePomodoroDisplay());

        this._evaluatePomodoroIndicator();
        this._syncFocusModeFromSettings();

        global.gnome_essentials_deepwork = this;

        log('Deep Work module enabled successfully.');
    }

    disable() {
        log('Disabling Deep Work module...');

        global.gnome_essentials_deepwork = null;

        // 1. Clean up settings listeners
        if (this._settingsHandlers) {
            for (const id of this._settingsHandlers) {
                this._settings.disconnect(id);
            }
            this._settingsHandlers = null;
        }

        // 2. Disconnect window and workspace signals
        this._disconnectNotificationSignals();
        this._disconnectSignals();

        // 3. Destroy Pomodoro timers and widgets
        this._cleanupPomodoro();

        // 4. Restore shell states if Deep Work effects are currently active
        this._deactivateFocusMode();

        log('Deep Work module disabled and cleaned up.');
    }

    // ==========================================
    // Focus States Management
    // ==========================================
    _getSnoozeLevel() {
        try {
            return Math.max(0, Math.min(2, this._settings.get_int('deepwork-snooze-level')));
        } catch (e) {
            return 0;
        }
    }

    _syncFocusModeFromSettings() {
        try {
            if (this._settings.get_boolean('deepwork-enabled')) {
                this._activateFocusMode();
            } else {
                this._deactivateFocusMode();
            }
        } catch (e) {
            logError('Failed to sync Deep Work activation state: ' + e.message);
        }
    }

    _setDeepWorkEnabledFromPomodoro(enabled) {
        try {
            if (this._settings.get_boolean('deepwork-enabled') === enabled) {
                this._syncFocusModeFromSettings();
                return;
            }

            this._settings.set_boolean('deepwork-enabled', enabled);
        } catch (e) {
            logError('Failed to update Deep Work from Pomodoro timer: ' + e.message);
        }
    }

    /**
     * Activates Deep Work Focus mode, capturing active panel parameters,
     * applying focus overlay layers, and showing Pomodoro counters.
     * @private
     * @returns {void}
     */
    _activateFocusMode() {
        if (this._active) {
            this._applyFocusConfigurations();
            this._syncFloatingPomodoroVisibility();
            return;
        }

        this._active = true;
        this._originalShowBanners = this._notificationSettings.get_boolean('show-banners');
        this._originalPanelVisible = Main.panel.visible;
        this._capturePanelActorOriginalVisibility();
        this._applyFocusConfigurations();
        this._syncFloatingPomodoroVisibility();
    }

    /**
     * Deactivates Deep Work Focus mode, restoring top bar panels, notification suppressions,
     * external docks, and removing all background blurs and overlay scrims.
     * @private
     * @returns {void}
     */
    _deactivateFocusMode() {
        if (!this._active) {
            this._syncFloatingPomodoroVisibility();
            return;
        }

        this._active = false;
        this._restoreShellStates();
        this._syncFloatingPomodoroVisibility();
    }

    _restorePanelVisibility(options = {}) {
        const restorePaperWMBridge = options.restorePaperWMBridge ?? true;
        const animatePanelReveal = options.animatePanelReveal ?? false;

        this._cancelPanelPeek(false);
        this._stopPostOverviewPanelReconcile();
        try {
            const shouldRevealPanel = this._shouldKeepPanelRevealed();
            if (animatePanelReveal) {
                this._preparePanelOverviewReveal();
            } else {
                this._resetPanelOverviewReveal();
            }

            this._restorePanelChromeTracking();
            this._restorePanelActorVisibility();
            if (shouldRevealPanel) {
                this._forcePanelActorsVisible();
            }
            this._queuePanelWorkAreaRefresh();
            if (restorePaperWMBridge) {
                this._restorePaperWMPanelWorkAreaBridge();
            }
            if (animatePanelReveal) {
                this._animatePanelOverviewReveal();
            }
            if (shouldRevealPanel) {
                this._schedulePanelRevealRefresh();
            }
        } catch (e) {
            // Ignore panel state races during shell shutdown.
        }
        this._syncFloatingPomodoroVisibility();
    }

    _hidePanelSafely() {
        this._stopPanelRevealRefresh();
        try {
            this._resetPanelOverviewReveal();
            this._suppressPanelChromeStruts();
            if (this._panelPeekActive) {
                this._setPanelActorsVisible(true);
            } else {
                this._setPanelActorsVisible(false);
            }
            this._queuePanelWorkAreaRefresh();
            this._applyPaperWMPanelWorkAreaBridge(true);
        } catch (e) {
            // Ignore panel state races during shell transitions.
        }
        this._syncFloatingPomodoroVisibility();
    }

    _getPanelChromeActors() {
        const actors = [];
        const addActor = actor => {
            if (actor && !actors.includes(actor)) actors.push(actor);
        };

        try {
            addActor(Main.layoutManager?.panelBox);
            addActor(Main.panel);
            addActor(Main.panel?.actor);
        } catch (e) {
            // Ignore shell teardown races.
        }

        return actors;
    }

    _capturePanelActorOriginalVisibility() {
        for (const actor of this._getPanelChromeActors()) {
            if (this._panelActorOriginalVisibility.has(actor)) continue;

            try {
                this._panelActorOriginalVisibility.set(actor, actor.visible);
            } catch (e) {
                // Ignore destroyed actors.
            }
        }
    }

    _setPanelActorsVisible(visible) {
        for (const actor of this._getPanelChromeActors()) {
            this._setPanelActorVisible(actor, visible);
        }
    }

    _setPanelActorVisible(actor, visible) {
        if (!actor) return;

        try {
            this._stopActorOpacityTransition(actor);
            actor.opacity = 255;
            if (visible) {
                actor.show();
            } else {
                actor.hide();
            }
        } catch (e) {
            // Ignore destroyed actors.
        }
    }

    _forcePanelActorsVisible() {
        const actors = [];
        const addActor = actor => {
            if (actor && !actors.includes(actor)) actors.push(actor);
        };

        this._getPanelChromeActors().forEach(addActor);
        this._getPanelVisualActors().forEach(addActor);

        for (const actor of actors) {
            this._setPanelActorVisible(actor, true);
        }
    }

    _getPanelVisualActors() {
        const actors = [];
        const addActor = actor => {
            if (actor && !actors.includes(actor)) actors.push(actor);
        };

        try {
            addActor(Main.layoutManager?.panelBox);
            if (actors.length === 0) {
                addActor(Main.panel?.actor);
                addActor(Main.panel);
            }
        } catch (e) {
            // Ignore shell teardown races.
        }

        return actors;
    }

    _stopActorOpacityTransition(actor) {
        try {
            if (typeof actor?.remove_transition === 'function') {
                actor.remove_transition('opacity');
            }
        } catch (e) {
            // Ignore stale actors.
        }
    }

    _preparePanelOverviewReveal() {
        for (const actor of this._getPanelVisualActors()) {
            try {
                this._stopActorOpacityTransition(actor);
                if (!this._panelOverviewRevealOriginalOpacity.has(actor)) {
                    const currentOpacity = actor.opacity ?? 255;
                    this._panelOverviewRevealOriginalOpacity.set(actor, currentOpacity > 0 ? currentOpacity : 255);
                }
                actor.opacity = 0;
                actor.show();
            } catch (e) {
                // Ignore stale actors.
            }
        }
    }

    _animatePanelOverviewReveal() {
        for (const actor of this._getPanelVisualActors()) {
            try {
                const targetOpacity = this._panelOverviewRevealOriginalOpacity.get(actor) ?? 255;
                this._stopActorOpacityTransition(actor);
                actor.show();

                if (typeof actor.ease === 'function') {
                    actor.ease({
                        opacity: targetOpacity,
                        duration: 140,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            this._panelOverviewRevealOriginalOpacity.delete(actor);
                        }
                    });
                } else {
                    actor.opacity = targetOpacity;
                    this._panelOverviewRevealOriginalOpacity.delete(actor);
                }
            } catch (e) {
                // Ignore stale actors.
            }
        }
    }

    _resetPanelOverviewReveal() {
        for (const [actor, opacity] of this._panelOverviewRevealOriginalOpacity.entries()) {
            try {
                this._stopActorOpacityTransition(actor);
                actor.opacity = opacity;
            } catch (e) {
                // Ignore stale actors.
            }
        }
        this._panelOverviewRevealOriginalOpacity.clear();
    }

    _restorePanelActorVisibility() {
        if (this._panelActorOriginalVisibility.size === 0) {
            this._setPanelActorsVisible(this._originalPanelVisible);
            return;
        }

        for (const [actor, visible] of this._panelActorOriginalVisibility.entries()) {
            this._setPanelActorVisible(actor, visible);
        }
    }

    _shouldKeepPanelRevealed() {
        return this._panelPeekActive || !this._active || !this._shouldHidePanelOnDesktop();
    }

    _schedulePanelRevealRefresh() {
        this._stopPanelRevealRefresh();

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._shouldKeepPanelRevealed()) {
                this._forcePanelActorsVisible();
                this._queuePanelWorkAreaRefresh();
                this._syncFloatingPomodoroVisibility();
            }
            return GLib.SOURCE_REMOVE;
        });

        this._panelRevealRefreshTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._panelRevealRefreshTimerId = 0;
            if (this._shouldKeepPanelRevealed()) {
                this._forcePanelActorsVisible();
                this._queuePanelWorkAreaRefresh();
                this._syncFloatingPomodoroVisibility();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPanelRevealRefresh() {
        if (this._panelRevealRefreshTimerId > 0) {
            try {
                GLib.source_remove(this._panelRevealRefreshTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._panelRevealRefreshTimerId = 0;
        }
    }

    _isPanelVisible() {
        const visualActors = this._getPanelVisualActors();
        if (visualActors.length > 0) {
            return visualActors.some(actor => this._isActorActuallyVisible(actor));
        }

        const actors = this._getPanelChromeActors();
        if (actors.length === 0) return Main.panel?.visible ?? false;

        return actors.some(actor => this._isActorActuallyVisible(actor));
    }

    _isActorActuallyVisible(actor) {
        try {
            return !!actor && actor.visible && (actor.opacity ?? 255) > 0;
        } catch (e) {
            return false;
        }
    }

    _getPanelChromeRecords() {
        const trackedActors = Main.layoutManager?._trackedActors || [];
        const panelActors = this._getPanelChromeActors();
        return trackedActors.filter(record => panelActors.includes(record.actor || record));
    }

    _capturePanelChromeOriginalStates(records) {
        for (const record of records) {
            const actor = record.actor || record;
            if (this._panelChromeOriginalStates.has(actor)) continue;

            this._panelChromeOriginalStates.set(actor, {
                affectsStruts: record.affectsStruts,
                affectsInputRegion: record.affectsInputRegion,
                trackFullscreen: record.trackFullscreen
            });
        }
    }

    _queuePanelWorkAreaRefresh() {
        try {
            const layoutManager = Main.layoutManager;
            if (typeof layoutManager?._queueUpdateRegions === 'function') {
                layoutManager._queueUpdateRegions();
            } else if (typeof layoutManager?._updateRegions === 'function') {
                layoutManager._updateRegions();
            }

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try {
                    if (typeof layoutManager?._queueUpdateRegions === 'function') {
                        layoutManager._queueUpdateRegions();
                    } else if (typeof layoutManager?._updateRegions === 'function') {
                        layoutManager._updateRegions();
                    }
                } catch (e) {
                    // Layout manager may already be gone during shell shutdown.
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            // Ignore layout refresh races during shell transitions.
        }
    }

    _startPostOverviewPanelReconcile() {
        this._stopPostOverviewPanelReconcile();

        let attempts = 0;
        this._postOverviewPanelReconcileTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            attempts++;

            if (!this._active || !this._shouldHidePanelOnDesktop()) {
                this._postOverviewPanelReconcileTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            this._hidePanelSafely();

            if (attempts >= 8) {
                this._postOverviewPanelReconcileTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPostOverviewPanelReconcile() {
        if (this._postOverviewPanelReconcileTimerId > 0) {
            try {
                GLib.source_remove(this._postOverviewPanelReconcileTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._postOverviewPanelReconcileTimerId = 0;
        }
    }

    _getPaperWMTilingModule() {
        try {
            const paperwmExt = Main.extensionManager.lookup('paperwm@paperwm.github.com');
            const state = paperwmExt?.stateObj;
            return state?.modules?.find(module => module && module.spaces) || null;
        } catch (e) {
            return null;
        }
    }

    _getPaperWMSpaces(tiling = null) {
        tiling = tiling || this._getPaperWMTilingModule();
        const spaces = [];
        const addSpace = space => {
            if (space && !spaces.includes(space)) spaces.push(space);
        };

        try {
            if (typeof tiling?.spaces?.forEach === 'function') {
                tiling.spaces.forEach(addSpace);
            }
        } catch (e) {
            // Fall back to window-derived spaces below.
        }

        try {
            for (const actor of global.get_window_actors()) {
                const win = actor?.meta_window;
                const space = tiling?.spaces?.spaceOfWindow?.(win);
                addSpace(space);
            }
        } catch (e) {
            // Ignore PaperWM internals while it is rebuilding spaces.
        }

        return spaces;
    }

    _getPaperWMTopWorkAreaOffset(space) {
        try {
            const monitor = space?.monitor;
            if (!monitor || typeof Main.layoutManager?.getWorkAreaForMonitor !== 'function') return 0;

            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            if (!workArea) return 0;

            return Math.max(0, workArea.y - monitor.y);
        } catch (e) {
            return 0;
        }
    }

    _layoutPaperWMSpace(space) {
        try {
            if (typeof space?.setSpaceTopbarElementsVisible === 'function') {
                space.setSpaceTopbarElementsVisible(space.showTopBar);
            }
            if (typeof space?.layout === 'function') {
                space.layout(false, { ensure: false, centerIfOne: false });
            }
        } catch (e) {
            // PaperWM may be in the middle of an overview transition.
        }
    }

    _applyPaperWMPanelWorkAreaBridge(hidden) {
        const tiling = this._getPaperWMTilingModule();
        if (!tiling) return;

        for (const space of this._getPaperWMSpaces(tiling)) {
            if (!this._paperWMOriginalShowTopBar.has(space)) {
                this._paperWMOriginalShowTopBar.set(space, space.showTopBar);
            }

            const originalShowTopBar = this._paperWMOriginalShowTopBar.get(space) ?? space.showTopBar;
            const topOffset = this._getPaperWMTopWorkAreaOffset(space);
            const needsTopOffsetCompensation = hidden && topOffset > 0;
            const desiredShowTopBar = hidden ? !needsTopOffsetCompensation : originalShowTopBar;
            const previousState = this._paperWMBridgeLastState.get(space);
            const bridgeStateChanged = !previousState ||
                previousState.hidden !== hidden ||
                previousState.topOffset !== topOffset ||
                previousState.desiredShowTopBar !== desiredShowTopBar;
            let needsLayout = bridgeStateChanged;

            if (space.showTopBar !== desiredShowTopBar) {
                log(`PaperWM: ${hidden ? 'adjusting' : 'restoring'} showTopBar for panel work-area bridge (${space.showTopBar} -> ${desiredShowTopBar})`);
                space.showTopBar = desiredShowTopBar;
                needsLayout = true;
            }

            if (needsLayout) {
                this._layoutPaperWMSpace(space);
                this._paperWMBridgeLastState.set(space, {
                    hidden,
                    topOffset,
                    desiredShowTopBar
                });
            }
        }
    }

    _restorePaperWMPanelWorkAreaBridge() {
        if (this._paperWMOriginalShowTopBar.size === 0) return;

        for (const [space, originalShowTopBar] of this._paperWMOriginalShowTopBar.entries()) {
            try {
                space.showTopBar = originalShowTopBar;
                this._layoutPaperWMSpace(space);
            } catch (e) {
                // PaperWM space may have been destroyed.
            }
        }

        this._paperWMOriginalShowTopBar.clear();
        this._paperWMBridgeLastState.clear();
    }

    _suppressPanelChromeStruts() {
        const records = this._getPanelChromeRecords();
        this._capturePanelChromeOriginalStates(records);

        let changed = false;
        for (const record of records) {
            if (record.affectsStruts !== false) {
                record.affectsStruts = false;
                changed = true;
            }
        }

        if (records.length === 0 && typeof Main.layoutManager?.trackChrome === 'function') {
            const actor = Main.layoutManager?.panelBox || Main.panel;
            if (actor) {
                try {
                    if (!this._panelChromeOriginalStates.has(actor)) {
                        this._panelChromeOriginalStates.set(actor, {
                            affectsStruts: true,
                            affectsInputRegion: true,
                            trackFullscreen: true,
                            retracked: true
                        });
                    }
                    Main.layoutManager.untrackChrome?.(actor);
                    Main.layoutManager.trackChrome(actor, {
                        affectsStruts: false,
                        affectsInputRegion: true,
                        trackFullscreen: true
                    });
                    changed = true;
                } catch (e) {
                    logError('Failed to suppress panel work area reservation: ' + e.message);
                }
            }
        }

        if (changed || !this._panelChromeStrutsSuppressed) {
            this._panelChromeStrutsSuppressed = true;
            this._queuePanelWorkAreaRefresh();
        }
    }

    _restorePanelChromeTracking() {
        const records = this._getPanelChromeRecords();
        let changed = false;

        for (const record of records) {
            const actor = record.actor || record;
            const original = this._panelChromeOriginalStates.get(actor);
            const targetAffectsStruts = original?.affectsStruts ?? true;
            const targetAffectsInputRegion = original?.affectsInputRegion;
            const targetTrackFullscreen = original?.trackFullscreen;

            if (record.affectsStruts !== targetAffectsStruts) {
                record.affectsStruts = targetAffectsStruts;
                changed = true;
            }
            if (targetAffectsInputRegion !== undefined && record.affectsInputRegion !== targetAffectsInputRegion) {
                record.affectsInputRegion = targetAffectsInputRegion;
                changed = true;
            }
            if (targetTrackFullscreen !== undefined && record.trackFullscreen !== targetTrackFullscreen) {
                record.trackFullscreen = targetTrackFullscreen;
                changed = true;
            }
        }

        if (records.length === 0 && typeof Main.layoutManager?.trackChrome === 'function') {
            const actor = Main.layoutManager?.panelBox || Main.panel;
            const original = this._panelChromeOriginalStates.get(actor);
            if (actor && original?.retracked) {
                try {
                    Main.layoutManager.untrackChrome?.(actor);
                    Main.layoutManager.trackChrome(actor, {
                        affectsStruts: original.affectsStruts ?? true,
                        affectsInputRegion: original.affectsInputRegion ?? true,
                        trackFullscreen: original.trackFullscreen ?? true
                    });
                    changed = true;
                } catch (e) {
                    logError('Failed to restore panel work area reservation: ' + e.message);
                }
            }
        }

        if (changed || this._panelChromeStrutsSuppressed) {
            this._panelChromeStrutsSuppressed = false;
            this._queuePanelWorkAreaRefresh();
        }
    }

    _shouldHidePanelInOverview() {
        try {
            return this._active &&
                this._getSnoozeLevel() >= 1 &&
                this._settings.get_boolean('deepwork-hide-panel-in-overview');
        } catch (e) {
            return false;
        }
    }

    _shouldHidePanelOnDesktopConfigured() {
        try {
            return this._active &&
                this._getSnoozeLevel() >= 1 &&
                this._settings.get_boolean('deepwork-hide-panel');
        } catch (e) {
            return false;
        }
    }

    _shouldHidePanelOnDesktop() {
        try {
            return this._shouldHidePanelOnDesktopConfigured() &&
                !Main.overview.visible;
        } catch (e) {
            return false;
        }
    }

    _startOverviewPanelHideWatchdog() {
        if (!this._shouldHidePanelInOverview()) return;

        this._hidePanelSafely();
        if (this._overviewPanelHideTimerId > 0) return;

        this._overviewPanelHideTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!this._shouldHidePanelInOverview() || !Main.overview.visible) {
                this._overviewPanelHideTimerId = 0;
                if (this._shouldHidePanelOnDesktop()) {
                    this._hidePanelSafely();
                } else {
                    this._restorePanelVisibility();
                }
                return GLib.SOURCE_REMOVE;
            }

            this._hidePanelSafely();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopOverviewPanelHideWatchdog() {
        if (this._overviewPanelHideTimerId > 0) {
            try {
                GLib.source_remove(this._overviewPanelHideTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._overviewPanelHideTimerId = 0;
        }
    }

    _applyFocusConfigurations() {
        if (!this._active) return;

        try {
            const snoozeLevel = this._getSnoozeLevel();
            const hideDock = this._settings.get_boolean('deepwork-hide-dock');
            const hidePanel = this._settings.get_boolean('deepwork-hide-panel');
            const hidePanelInOverview = this._settings.get_boolean('deepwork-hide-panel-in-overview');
            const muteNotifications = this._settings.get_boolean('deepwork-mute-notifications');
            const isLevel2 = snoozeLevel >= 1;

            // --- Notification suppression (DND-style banner hiding) ---
            this._setNotificationBannersSuppressed(muteNotifications);

            // --- Panel visibility. Level 1 leaves the panel alone; Level 2 can hide it.
            if (isLevel2 && hidePanel && !Main.overview.visible) {
                this._stopOverviewPanelHideWatchdog();
                this._hidePanelSafely();
            } else {
                if (isLevel2 && hidePanelInOverview && Main.overview.visible) {
                    this._startOverviewPanelHideWatchdog();
                } else {
                    this._stopOverviewPanelHideWatchdog();
                    this._restorePanelVisibility();
                }
            }

            // --- Dock/Panel extensions hiding (Dash to Dock, Dash to Panel) ---
            this._suppressExternalDocks(hideDock);

            // --- Apply ambient window dimming & blur ---
            this._applyAmbientDimming();
        } catch (e) {
            logError('Failed to apply focus configurations: ' + e.message);
        }
    }

    _restoreShellStates() {
        try {
            // Restore notification banners
            this._setNotificationBannersSuppressed(false);

            // Restore top panel visibility exactly as it was before Deep Work started
            this._stopOverviewPanelHideWatchdog();
            this._restorePanelVisibility();

            // Restore external docks
            this._suppressExternalDocks(false);

            // Clean up all ambient blurs and overlay actors
            this._cleanupAmbientEffects();
        } catch (e) {
            logError('Failed to restore shell states: ' + e.message);
        }
    }

    _connectNotificationSignals() {
        if (this._notificationSettingsChangedId === 0) {
            this._notificationSettingsChangedId = this._notificationSettings.connect('changed::show-banners', () => {
                if (!this._active || !this._settings.get_boolean('deepwork-mute-notifications')) return;

                if (this._notificationSettings.get_boolean('show-banners')) {
                    this._notificationSettings.set_boolean('show-banners', false);
                }
                this._suppressMessageTrayBanners(true);
            });
        }

        this._connectMessageTrayNotificationSignals();
    }

    _disconnectNotificationSignals() {
        if (this._notificationSettingsChangedId > 0) {
            this._notificationSettings.disconnect(this._notificationSettingsChangedId);
            this._notificationSettingsChangedId = 0;
        }
        this._disconnectMessageTrayNotificationSignals();
    }

    _connectMessageTrayNotificationSignals() {
        const tray = Main.messageTray;
        if (!tray) return;

        if (this._messageTraySourceAddedId === 0 && typeof tray.connect === 'function') {
            try {
                this._messageTraySourceAddedId = tray.connect('source-added', (_tray, source) => {
                    this._trackNotificationSource(source);
                });
            } catch (e) {
                this._messageTraySourceAddedId = 0;
            }
        }

        for (const source of this._getMessageTraySources()) {
            this._trackNotificationSource(source);
        }
    }

    _disconnectMessageTrayNotificationSignals() {
        const tray = Main.messageTray;
        if (this._messageTraySourceAddedId > 0 && tray) {
            try {
                tray.disconnect(this._messageTraySourceAddedId);
            } catch (e) {
                // Message tray may already be destroyed during shell teardown.
            }
            this._messageTraySourceAddedId = 0;
        }

        for (const [source, ids] of this._notificationSourceSignalIds.entries()) {
            for (const id of ids) {
                try {
                    source.disconnect(id);
                } catch (e) {
                    // Source may already be destroyed.
                }
            }
        }
        this._notificationSourceSignalIds.clear();
    }

    _getMessageTraySources() {
        const sources = [];
        const addSource = source => {
            if (source && !sources.includes(source)) sources.push(source);
        };

        try {
            const tray = Main.messageTray;
            if (!tray) return sources;

            if (typeof tray.getSources === 'function') {
                tray.getSources().forEach(addSource);
            }

            if (Array.isArray(tray._sources)) {
                tray._sources.forEach(addSource);
            } else if (typeof tray._sources?.forEach === 'function') {
                tray._sources.forEach(addSource);
            }
        } catch (e) {
            // Message tray internals vary between GNOME versions.
        }

        return sources;
    }

    _trackNotificationSource(source) {
        if (!source || this._notificationSourceSignalIds.has(source) || typeof source.connect !== 'function') return;

        const ids = [];
        try {
            ids.push(source.connect('notification-added', (_source, notification) => {
                this._recordFocusNotification(notification, _source);
            }));
        } catch (e) {
            return;
        }

        try {
            ids.push(source.connect('destroy', () => {
                this._notificationSourceSignalIds.delete(source);
            }));
        } catch (e) {
            // Source destroy signal may not exist on all Shell versions.
        }

        this._notificationSourceSignalIds.set(source, ids);
    }

    _setNotificationBannersSuppressed(suppress) {
        if (suppress) {
            if (this._notificationSettings.get_boolean('show-banners')) {
                this._notificationSettings.set_boolean('show-banners', false);
            }

            this._suppressMessageTrayBanners(true);
            this._startNotificationSuppressionWatchdog();
        } else {
            this._stopNotificationSuppressionWatchdog();
            this._suppressMessageTrayBanners(false);
            if (this._notificationSettings.get_boolean('show-banners') !== this._originalShowBanners) {
                this._notificationSettings.set_boolean('show-banners', this._originalShowBanners);
            }
        }
    }

    _startNotificationSuppressionWatchdog() {
        if (this._notificationSuppressionTimerId > 0) return;

        this._notificationSuppressionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!this._active || !this._settings.get_boolean('deepwork-mute-notifications')) {
                this._notificationSuppressionTimerId = 0;
                this._suppressMessageTrayBanners(false);
                return GLib.SOURCE_REMOVE;
            }

            if (this._notificationSettings.get_boolean('show-banners')) {
                this._notificationSettings.set_boolean('show-banners', false);
            }
            this._suppressMessageTrayBanners(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopNotificationSuppressionWatchdog() {
        if (this._notificationSuppressionTimerId > 0) {
            try {
                GLib.source_remove(this._notificationSuppressionTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._notificationSuppressionTimerId = 0;
        }
    }

    _getMessageTrayBannerActors() {
        const actors = new Set();
        const addActor = actor => {
            if (!actor) return;
            if (actor.actor) addActor(actor.actor);
            if (typeof actor.set_opacity === 'function' ||
                typeof actor.hide === 'function' ||
                typeof actor.set_visible === 'function') {
                actors.add(actor);
            }
        };

        try {
            const tray = Main.messageTray;
            if (!tray) return [];

            [
                tray._bannerBin,
                tray.bannerBin,
                tray._banner,
                tray.banner,
                tray._bannerActor,
                tray._notificationWidget,
                tray._notificationActor
            ].forEach(addActor);
        } catch (e) {
            // Message tray internals vary between GNOME versions.
        }

        return [...actors];
    }

    _suppressMessageTrayBanners(suppress) {
        if (suppress) {
            for (const actor of this._getMessageTrayBannerActors()) {
                try {
                    if (!this._messageTrayBannerActorStates.has(actor)) {
                        const state = {
                            opacity: actor.opacity,
                            reactive: typeof actor.get_reactive === 'function'
                                ? actor.get_reactive()
                                : actor.reactive,
                            visible: typeof actor.get_visible === 'function'
                                ? actor.get_visible()
                                : actor.visible,
                            destroyId: 0
                        };

                        try {
                            if (typeof actor.connect === 'function') {
                                state.destroyId = actor.connect('destroy', () => {
                                    this._messageTrayBannerActorStates.delete(actor);
                                });
                            }
                        } catch (e) {
                            state.destroyId = 0;
                        }

                        this._messageTrayBannerActorStates.set(actor, state);
                    }

                    if (typeof actor.set_opacity === 'function') actor.set_opacity(0);
                    if (typeof actor.set_reactive === 'function') actor.set_reactive(false);
                    if (typeof actor.hide === 'function') actor.hide();
                    else if (typeof actor.set_visible === 'function') actor.set_visible(false);
                } catch (e) {
                    // Actor may be transient or already destroyed.
                }
            }
            return;
        }

        for (const [actor, state] of this._messageTrayBannerActorStates.entries()) {
            try {
                if (typeof actor.set_opacity === 'function') actor.set_opacity(state.opacity ?? 255);
                if (typeof actor.set_reactive === 'function') actor.set_reactive(state.reactive ?? true);

                if (state.visible === false) {
                    if (typeof actor.hide === 'function') actor.hide();
                    else if (typeof actor.set_visible === 'function') actor.set_visible(false);
                } else if (state.visible === true) {
                    if (typeof actor.show === 'function') actor.show();
                    else if (typeof actor.set_visible === 'function') actor.set_visible(true);
                }

                if (state.destroyId > 0 && typeof actor.disconnect === 'function') {
                    actor.disconnect(state.destroyId);
                }
            } catch (e) {
                // Actor may have been destroyed while suppression was active.
            }
        }
        this._messageTrayBannerActorStates.clear();
    }

    _suppressExternalDocks(suppress) {
        // Dynamic detection and suppression of Dash to Dock or Dash to Panel actors
        try {
            // Suppress via Dash to Dock GSettings safely by verifying schema presence first to prevent Gio exceptions
            const source = Gio.SettingsSchemaSource.get_default();
            if (source && source.lookup('org.gnome.shell.extensions.dash-to-dock', true)) {
                if (!this._dashToDockSettings) {
                    this._dashToDockSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.dash-to-dock' });
                }

                if (suppress) {
                    if (this._originalDashToDockDockFixed === null) {
                        this._originalDashToDockDockFixed = this._dashToDockSettings.get_boolean('dock-fixed');
                    }
                    this._dashToDockSettings.set_boolean('dock-fixed', false);
                } else if (this._originalDashToDockDockFixed !== null) {
                    this._dashToDockSettings.set_boolean('dock-fixed', this._originalDashToDockDockFixed);
                    this._originalDashToDockDockFixed = null;
                }
            }
        } catch (e) {
            // Ignore if Dash to Dock is not installed/enabled
        }

        // Apply a direct CSS transition or opacity shift to any visible docks or panels in the layoutManager
        try {
            if (suppress) {
                // Loop through children of UI actors looking for dock overlays
                Main.layoutManager.uiGroup.get_children().forEach(actor => {
                    if (actor === Main.panel || actor === Main.layoutManager.panelBox) return;
                    const name = actor.get_name ? (actor.get_name() || '').toLowerCase() : '';
                    if (!name || (!name.includes('dock') && !name.includes('panel') && !name.includes('dash'))) return;

                    if (!this._externalDockActorStates.has(actor)) {
                        this._externalDockActorStates.set(actor, {
                            opacity: actor.opacity,
                            reactive: typeof actor.get_reactive === 'function'
                                ? actor.get_reactive()
                                : actor.reactive
                        });
                    }
                    actor.set_opacity(0);
                    actor.set_reactive(false);
                });
            } else {
                for (const [actor, state] of this._externalDockActorStates.entries()) {
                    try {
                        actor.set_opacity(state.opacity ?? 255);
                        actor.set_reactive(state.reactive ?? true);
                    } catch (restoreErr) {
                        // Actor may have been destroyed while Deep Work was active.
                    }
                }
                this._externalDockActorStates.clear();
            }
        } catch (e) {
            // ignore layout exceptions
        }
    }

    // ==========================================
    // Ambient Dimming & Interactive Blur Engine
    // ==========================================
    _getFocusedWindowInfo() {
        const win = global.display.focus_window ||
            (typeof global.display.get_focus_window === 'function'
                ? global.display.get_focus_window()
                : null);

        if (!win) {
            return { window: null, actor: null };
        }

        try {
            return {
                window: win,
                actor: win.get_compositor_private?.() || null
            };
        } catch (e) {
            return { window: win, actor: null };
        }
    }

    _findWindowActor(actors, window) {
        if (!window) return null;

        for (const actor of actors) {
            try {
                if (actor.get_meta_window?.() === window || actor.meta_window === window) {
                    return actor;
                }
            } catch (e) {
                // Ignore destroyed actors while focus is changing.
            }
        }

        return null;
    }

    _applyAmbientDimming() {
        if (!this._active) return;

        const snoozeLevel = this._getSnoozeLevel();
        const ambientDim = this._settings.get_boolean('deepwork-ambient-dim');
        const actors = global.get_window_actors();
        const focused = this._getFocusedWindowInfo();
        const focusedWindow = focused.window;
        const focusedActor = focused.actor || this._findWindowActor(actors, focusedWindow);

        if (!ambientDim || snoozeLevel < 1) {
            this._stopTrueAmbientFocusPoller();
            this._cleanupAmbientEffects();
            return;
        }

        if (snoozeLevel >= 2) {
            this._startTrueAmbientFocusPoller();
            if (!focusedWindow || !focusedActor) {
                this._cleanupAmbientEffects({ stopFocusPoller: false });
                return;
            }
            this._applyTrueAmbientDimming(actors, focusedWindow, focusedActor);
            return;
        }

        this._stopTrueAmbientFocusPoller();
        if (!focusedWindow) {
            this._cleanupAmbientEffects();
            return;
        }
        this._applySoftAmbientDimming(actors, focusedWindow, focusedActor);
    }

    _queueAmbientDimmingRefresh(delayMs = 80) {
        this._stopAmbientDimmingRefresh();

        this._ambientDimmingRefreshTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._ambientDimmingRefreshTimerId = 0;
            this._applyAmbientDimming();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopAmbientDimmingRefresh() {
        if (this._ambientDimmingRefreshTimerId > 0) {
            try {
                GLib.source_remove(this._ambientDimmingRefreshTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._ambientDimmingRefreshTimerId = 0;
        }
    }

    _startTrueAmbientFocusPoller() {
        if (this._ambientFocusPollerId > 0) return;

        this._ambientFocusPollerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (!this._active ||
                this._getSnoozeLevel() < 2 ||
                !this._settings.get_boolean('deepwork-ambient-dim')) {
                this._ambientFocusPollerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            this._applyAmbientDimming();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTrueAmbientFocusPoller() {
        if (this._ambientFocusPollerId > 0) {
            try {
                GLib.source_remove(this._ambientFocusPollerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._ambientFocusPollerId = 0;
        }
    }

    _applySoftAmbientDimming(actors, focusedWindow, focusedActor) {
        const dimOpacityVal = this._settings.get_double('deepwork-ambient-dim-opacity');
        const blurIntensity = this._settings.get_double('deepwork-ambient-blur-intensity');

        this._ensureAmbientOverlay('soft');
        this._positionAmbientOverlayBelowFocused(focusedActor);
        this._updateAmbientGradient();

        for (const actor of actors) {
            const win = actor.get_meta_window();
            if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) continue;

            try {
                if (win !== focusedWindow && actor !== focusedActor) {
                    actor.set_opacity(Math.round(dimOpacityVal * 255));

                    if (blurIntensity > 0) {
                        if (!actor._deepworkBlurEffect) {
                            const blurEffect = new Shell.BlurEffect({
                                mode: Shell.BlurMode.ACTOR
                            });
                            blurEffect.set_brightness(0.85);
                            actor.add_effect(blurEffect);
                            actor._deepworkBlurEffect = blurEffect;
                        }
                        let targetSigma = Math.round(Math.pow(blurIntensity, 2) * 25);
                        if (blurIntensity > 0) {
                            targetSigma = Math.max(1, targetSigma);
                        }
                        
                        const effect = actor._deepworkBlurEffect;
                        if (typeof effect.set_radius === 'function') {
                            effect.set_radius(targetSigma * 2);
                        } else if (typeof effect.set_sigma === 'function') {
                            effect.set_sigma(targetSigma);
                        } else {
                            effect.radius = targetSigma * 2;
                        }
                    } else if (actor._deepworkBlurEffect) {
                        actor.remove_effect(actor._deepworkBlurEffect);
                        delete actor._deepworkBlurEffect;
                    }
                } else {
                    actor.set_opacity(255);
                    if (actor._deepworkBlurEffect) {
                        actor.remove_effect(actor._deepworkBlurEffect);
                        delete actor._deepworkBlurEffect;
                    }
                }
            } catch (e) {
                // Ignore destroyed actors.
            }
        }
    }

    /**
     * Applies Level 3 (True Ambient Dimming) focus overlay, positioning a solid black scrim
     * immediately below the active focused window and optionally dimming/blurring
     * background window actors underneath the scrim.
     * @private
     * @param {Array<Clutter.Actor>} actors - List of desktop window actors.
     * @param {Meta.Window} focusedWindow - Active focused window metadata.
     * @param {Clutter.Actor} focusedActor - Active focused window actor.
     * @returns {void}
     */
    _applyTrueAmbientDimming(actors, focusedWindow, focusedActor) {
        this._ensureAmbientOverlay('true');
        
        // Dynamically honor Level 3 background dimming and blur custom settings
        const keepDim = this._settings.get_boolean('deepwork-ambient-dim-level3');
        const keepBlur = this._settings.get_boolean('deepwork-ambient-blur-level3');
        
        const dimOpacityVal = this._settings.get_double('deepwork-ambient-dim-opacity');
        const blurIntensity = this._settings.get_double('deepwork-ambient-blur-intensity');
        
        for (const actor of actors) {
            const win = actor.get_meta_window?.();
            if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) continue;
            
            try {
                if (win !== focusedWindow && actor !== focusedActor) {
                    // Stacking and window-level dimming
                    if (keepDim) {
                        actor.set_opacity(Math.round(dimOpacityVal * 255));
                    } else {
                        actor.set_opacity(255);
                    }
                    
                    // Stacking and window-level blur
                    if (keepBlur && blurIntensity > 0) {
                        if (!actor._deepworkBlurEffect) {
                            const blurEffect = new Shell.BlurEffect({
                                mode: Shell.BlurMode.ACTOR
                            });
                            blurEffect.set_brightness(0.85);
                            actor.add_effect(blurEffect);
                            actor._deepworkBlurEffect = blurEffect;
                        }
                        
                        let targetSigma = Math.round(Math.pow(blurIntensity, 2) * 25);
                        if (blurIntensity > 0) {
                            targetSigma = Math.max(1, targetSigma);
                        }
                        
                        const effect = actor._deepworkBlurEffect;
                        if (typeof effect.set_radius === 'function') {
                            effect.set_radius(targetSigma * 2);
                        } else if (typeof effect.set_sigma === 'function') {
                            effect.set_sigma(targetSigma);
                        } else {
                            effect.radius = targetSigma * 2;
                        }
                    } else {
                        if (actor._deepworkBlurEffect) {
                            actor.remove_effect(actor._deepworkBlurEffect);
                            delete actor._deepworkBlurEffect;
                        }
                    }
                } else {
                    // Focused window is always fully bright and sharp
                    actor.set_opacity(255);
                    if (actor._deepworkBlurEffect) {
                        actor.remove_effect(actor._deepworkBlurEffect);
                        delete actor._deepworkBlurEffect;
                    }
                }
            } catch (e) {
                // Ignore destroyed actors
            }
        }
        
        this._positionAmbientOverlayBelowFocused(focusedActor);
        this._updateTrueAmbientOverlay();
    }

    _ensureAmbientOverlay(mode) {
        if (!this._ambientOverlay) {
            this._createAmbientOverlay();
        }

        if (this._ambientOverlayMode === mode) {
            return;
        }

        this._ambientOverlayMode = mode;
        if (mode === 'soft') {
            this._startAmbientAnimationTimer();
        } else {
            this._stopAmbientAnimationTimer();
        }
    }

    _createAmbientOverlay() {
        if (this._ambientOverlay) return;

        this._ambientOverlay = new St.Widget({
            style_class: 'ambient-gradient-overlay',
            reactive: false,
            can_focus: false,
            track_hover: false,
            x: 0,
            y: 0,
            width: global.screen_width || 1920,
            height: global.screen_height || 1080
        });

        try {
            this._ambientOverlay.set_reactive?.(false);
            this._ambientOverlay.set_can_focus?.(false);
        } catch (e) {
            // Ignore shell-version differences in Clutter/St actor APIs.
        }

        this._ambientOverlayMode = null;
        this._ambientAngle = 0;
    }

    _startAmbientAnimationTimer() {
        if (this._ambientTimerId > 0) return;

        this._ambientTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            150,
            () => {
                if (this._active && this._ambientOverlay && this._ambientOverlayMode === 'soft') {
                    this._ambientAngle = (this._ambientAngle + 1) % 360;
                    this._updateAmbientGradient();
                    return GLib.SOURCE_CONTINUE;
                }
                this._ambientTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _stopAmbientAnimationTimer() {
        if (this._ambientTimerId > 0) {
            GLib.source_remove(this._ambientTimerId);
            this._ambientTimerId = 0;
        }
    }

    _positionAmbientOverlayBelowFocused(focusedActor) {
        if (!this._ambientOverlay) return;

        try {
            this._ambientOverlay.set_position(0, 0);
            this._ambientOverlay.set_size(global.screen_width || 1920, global.screen_height || 1080);
            this._ambientOverlay.set_reactive?.(false);
            this._ambientOverlay.set_can_focus?.(false);

            const parent = this._ambientOverlay.get_parent();
            if (parent) {
                parent.remove_child(this._ambientOverlay);
            }

            const focusedParent = focusedActor?.get_parent?.();
            if (focusedActor && focusedParent && typeof focusedParent.insert_child_below === 'function') {
                focusedParent.insert_child_below(this._ambientOverlay, focusedActor);
            } else {
                const children = global.window_group.get_children?.()
                    ?.filter(child => child !== this._ambientOverlay) || [];
                const bottomWindowActor = children[0];

                if (bottomWindowActor && typeof global.window_group.insert_child_below === 'function') {
                    global.window_group.insert_child_below(this._ambientOverlay, bottomWindowActor);
                } else {
                    global.window_group.add_child(this._ambientOverlay);
                }
            }

            this._ambientOverlay.show();
        } catch (e) {
            // Window actors can disappear while focus is changing.
        }
    }

    _updateAmbientGradient() {
        if (!this._ambientOverlay) return;
        const baseColor = this._settings.get_string('deepwork-ambient-color') || '#0a0d1a';
        const overlayColor = /^#[0-9a-fA-F]{6}$/.test(baseColor)
            ? `${baseColor}d0`
            : baseColor;
        
        // Dynamic duo-gradient rotation: blends the user's custom color with an aesthetic deep indigo
        this._ambientOverlay.set_style(
            `background: linear-gradient(${this._ambientAngle}deg, ${overlayColor}, #140d24d0);`
        );
    }

    _getTrueAmbientOpacity() {
        try {
            const value = this._settings.get_double('deepwork-true-ambient-opacity');
            const clamped = clamp(value, 0.1, 0.95);
            if (clamped !== value) {
                this._settings.set_double('deepwork-true-ambient-opacity', clamped);
            }
            return clamped;
        } catch (e) {
            return 0.82;
        }
    }

    _updateTrueAmbientOverlay() {
        if (!this._ambientOverlay) return;

        const opacity = this._getTrueAmbientOpacity().toFixed(2);
        this._ambientOverlay.set_style(`background-color: rgba(0, 0, 0, ${opacity});`);
    }

    _restoreAmbientWindowEffects(actors = global.get_window_actors()) {
        for (const actor of actors) {
            try {
                actor.set_opacity(255);
                if (actor._deepworkBlurEffect) {
                    actor.remove_effect(actor._deepworkBlurEffect);
                    delete actor._deepworkBlurEffect;
                }
            } catch (e) {
                // Ignore destroyed actors.
            }
        }
    }

    _cleanupAmbientEffects(options = {}) {
        const stopFocusPoller = options.stopFocusPoller ?? true;
        if (stopFocusPoller) {
            this._stopTrueAmbientFocusPoller();
        }
        this._stopAmbientDimmingRefresh();
        this._stopAmbientAnimationTimer();

        if (this._ambientOverlay) {
            const parent = this._ambientOverlay.get_parent();
            if (parent) {
                parent.remove_child(this._ambientOverlay);
            }
            this._ambientOverlay.destroy();
            this._ambientOverlay = null;
        }
        this._ambientOverlayMode = null;

        this._restoreAmbientWindowEffects();
    }

    _connectSignals() {
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            this._queueAmbientDimmingRefresh();
            this._queueFloatingPomodoroRaise();
        });

        this._windowCreatedId = global.display.connect('window-created', () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (!this._active) return GLib.SOURCE_REMOVE;
                this._queueAmbientDimmingRefresh();
                this._queueFloatingPomodoroRaise();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._workspaceChangedId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._queueAmbientDimmingRefresh();
            this._queueFloatingPomodoroRaise();
        });

        const updateOverviewPanel = (overviewVisible, options = {}) => {
            const settled = options.settled ?? true;

            if (!this._active) {
                this._finishFloatingPomodoroDrag();
                this._stopOverviewPanelHideWatchdog();
                this._stopPostOverviewPanelReconcile();
                this._cancelPanelPeek(false);
                this._syncFloatingPomodoroVisibility();
                return;
            }

            if (overviewVisible) {
                this._finishFloatingPomodoroDrag();
                this._stopPostOverviewPanelReconcile();
                this._cancelPanelPeek(false);

                if (!settled) {
                    const paperWMActive = !!this._getPaperWMTilingModule();
                    const keepPanelHiddenForTransition =
                        this._shouldHidePanelInOverview() ||
                        (paperWMActive && this._shouldHidePanelOnDesktopConfigured());

                    this._stopOverviewPanelHideWatchdog();
                    if (keepPanelHiddenForTransition) {
                        this._resetPanelOverviewReveal();
                        this._suppressPanelChromeStruts();
                        this._setPanelActorsVisible(false);
                    } else if (this._shouldHidePanelOnDesktopConfigured()) {
                        this._restorePanelVisibility({ restorePaperWMBridge: false });
                    }
                    this._floatingPomodoroActor?.hide();
                    return;
                }

                if (this._shouldHidePanelInOverview()) {
                    this._startOverviewPanelHideWatchdog();
                } else {
                    const animatePanelReveal = this._settings.get_boolean('deepwork-hide-panel') &&
                        !this._isPanelVisible();
                    this._stopOverviewPanelHideWatchdog();
                    this._restorePanelVisibility({
                        restorePaperWMBridge: false,
                        animatePanelReveal
                    });
                }
            } else {
                this._stopOverviewPanelHideWatchdog();
                if (!settled) {
                    this._finishFloatingPomodoroDrag();
                    this._stopPostOverviewPanelReconcile();
                    return;
                }

                if (this._shouldHidePanelOnDesktop()) {
                    this._hidePanelSafely();
                    this._startPostOverviewPanelReconcile();
                } else {
                    this._restorePanelVisibility();
                }
            }
        };

        // Overview timing varies a little between Shell versions, so listen to
        // both transition and settled states for overview-only panel hiding.
        this._overviewShowingId = Main.overview.connect('showing', () => {
            updateOverviewPanel(true, { settled: false });
        });

        this._overviewShownId = Main.overview.connect('shown', () => {
            updateOverviewPanel(true);
        });

        this._overviewHidingId = Main.overview.connect('hiding', () => {
            updateOverviewPanel(false, { settled: false });
        });

        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            updateOverviewPanel(false);
        });

        if (Main.screenShield) {
            this._screenShieldSignalId = Main.screenShield.connect('locked-changed', () => {
                const isLocked = Main.screenShield.locked;
                if (isLocked) {
                    if (this._pomodoroSessionActive && this._pomodoroTimer) {
                        this._wasActiveBeforeLock = true;
                        this._pausePomodoro();
                    }
                } else {
                    if (this._wasActiveBeforeLock) {
                        this._wasActiveBeforeLock = false;
                        this._startPomodoro();
                    } else {
                        this._syncFloatingPomodoroVisibility();
                    }
                }
            });
        }
    }

    _disconnectSignals() {
        if (this._focusWindowId > 0) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._windowCreatedId > 0) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._workspaceChangedId > 0) {
            global.workspace_manager.disconnect(this._workspaceChangedId);
            this._workspaceChangedId = 0;
        }
        if (this._overviewShowingId > 0) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = 0;
        }
        if (this._overviewShownId > 0) {
            Main.overview.disconnect(this._overviewShownId);
            this._overviewShownId = 0;
        }
        if (this._overviewHidingId > 0) {
            Main.overview.disconnect(this._overviewHidingId);
            this._overviewHidingId = 0;
        }
        if (this._overviewHiddenId > 0) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }
        if (Main.screenShield && this._screenShieldSignalId > 0) {
            Main.screenShield.disconnect(this._screenShieldSignalId);
            this._screenShieldSignalId = 0;
        }
        this._stopOverviewPanelHideWatchdog();
        this._stopPostOverviewPanelReconcile();
        this._stopPanelRevealRefresh();
        this._stopAmbientDimmingRefresh();
        this._stopTrueAmbientFocusPoller();
        this._stopFloatingPomodoroRaiseTimer();
    }

    // ==========================================
    // Pomodoro Timer Engine
    // ==========================================
    _evaluatePomodoroIndicator() {
        const enabled = this._settings.get_boolean('deepwork-pomodoro-timer-enabled');
        if (enabled) {
            this._createPomodoroIndicator();
            this._resetPomodoroState();
            this._syncFloatingPomodoroVisibility();
        } else {
            this._cleanupPomodoro();
        }
    }

    _createPomodoroIndicator() {
        if (this._pomodoroButton) return;

        log('Creating Pomodoro panel indicator...');
        try {
            this._destroyStalePomodoroIndicator();

            this._pomodoroButton = new PanelMenu.Button(0.0, 'PomodoroIndicator', false);

            const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
            
            this._pomodoroIcon = new St.Icon({
                icon_name: 'alarm-symbolic',
                style_class: 'system-status-icon'
            });
            box.add_child(this._pomodoroIcon);

            this._pomodoroLabel = new St.Label({
                text: '25:00',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-left: 6px; font-weight: bold; font-family: monospace;'
            });
            box.add_child(this._pomodoroLabel);

            this._pomodoroCountBadge = new St.Button({
                label: '0',
                style_class: 'pomodoro-count-badge',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
                reactive: true
            });
            this._pomodoroCountBadge.connect('button-press-event', () => {
                return Clutter.EVENT_STOP;
            });
            this._pomodoroCountBadge.connect('button-release-event', () => {
                this._showMutedNotificationsPopup(this._pomodoroCountBadge);
                return Clutter.EVENT_STOP;
            });
            box.add_child(this._pomodoroCountBadge);
            
            this._pomodoroButton.add_child(box);

            // Simple Dropdown Title
            const menuTitle = new PopupMenu.PopupMenuItem('Deep Work Timer', { reactive: false });
            this._pomodoroButton.menu.addMenuItem(menuTitle);

            // Control Items
            this._playPauseItem = new PopupMenu.PopupMenuItem('Start Session');
            this._playPauseItem.connect('activate', () => this._togglePomodoro());
            this._pomodoroButton.menu.addMenuItem(this._playPauseItem);

            const resetItem = new PopupMenu.PopupMenuItem('Reset Timer');
            resetItem.connect('activate', () => this._resetPomodoroState());
            this._pomodoroButton.menu.addMenuItem(resetItem);

            this._pomodoroButton.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._createPomodoroClockMenuItems();
            this._createPomodoroSettingsMenuItems();

            Main.panel.addToStatusArea('pomodoro-indicator', this._pomodoroButton, 0, 'right');
            this._createFloatingPomodoroIndicator();
            this._syncPomodoroClockState();
            this._syncFloatingPomodoroVisibility();
        } catch (e) {
            logError('Failed to create Pomodoro indicator: ' + e.message);
            this._cleanupPomodoro();
        }
    }

    _destroyStalePomodoroIndicator() {
        const existing = Main.panel.statusArea?.['pomodoro-indicator'];
        if (!existing || existing === this._pomodoroButton) return;

        try {
            existing.destroy();
        } catch (e) {
            logError('Failed to remove stale Pomodoro indicator: ' + e.message);
        }

        if (Main.panel.statusArea?.['pomodoro-indicator'] === existing) {
            delete Main.panel.statusArea['pomodoro-indicator'];
        }
    }

    _createPomodoroClockMenuItems() {
        const clockMenu = new PopupMenu.PopupSubMenuMenuItem(this._getPomodoroClockMenuTitle());
        this._pomodoroClockMenuItem = clockMenu;
        this._pomodoroButton.menu.addMenuItem(clockMenu);

        this._pomodoroClockToggleItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto Stop Clock',
            this._settings.get_boolean('deepwork-pomodoro-clock-enabled')
        );
        this._pomodoroClockToggleItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('deepwork-pomodoro-clock-enabled', state);
        });
        clockMenu.menu.addMenuItem(this._pomodoroClockToggleItem);

        this._pomodoroClockSetNowItem = new PopupMenu.PopupMenuItem('Set to +30 minutes');
        this._pomodoroClockSetNowItem.connect('activate', () => this._setPomodoroClockFromNow(30));
        clockMenu.menu.addMenuItem(this._pomodoroClockSetNowItem);

        // Custom Compact time selector row
        const timeSelectorItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const timeLayout = new St.BoxLayout({
            style_class: 'time-selector-layout',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER
        });

        // 1. Hour controls
        const hrBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const hrMinus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-remove-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        hrMinus.connect('clicked', () => {
            this._adjustPomodoroClockTime(-60);
        });

        this._pomodoroClockHourLabel = new St.Label({
            text: '00',
            style_class: 'time-selector-text',
            y_align: Clutter.ActorAlign.CENTER
        });

        const hrPlus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        hrPlus.connect('clicked', () => {
            this._adjustPomodoroClockTime(60);
        });

        hrBox.add_child(hrMinus);
        hrBox.add_child(this._pomodoroClockHourLabel);
        hrBox.add_child(hrPlus);

        // 2. Separator
        const separator = new St.Label({
            text: ':',
            style_class: 'time-selector-separator',
            y_align: Clutter.ActorAlign.CENTER
        });

        // 3. Minute controls
        const minBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const minMinus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-remove-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        minMinus.connect('clicked', () => {
            this._adjustPomodoroClockTime(-1);
        });

        this._pomodoroClockMinuteLabel = new St.Label({
            text: '00',
            style_class: 'time-selector-text',
            y_align: Clutter.ActorAlign.CENTER
        });

        const minPlus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        minPlus.connect('clicked', () => {
            this._adjustPomodoroClockTime(1);
        });

        minBox.add_child(minMinus);
        minBox.add_child(this._pomodoroClockMinuteLabel);
        minBox.add_child(minPlus);

        timeLayout.add_child(hrBox);
        timeLayout.add_child(separator);
        timeLayout.add_child(minBox);

        timeSelectorItem.add_child(timeLayout);
        clockMenu.menu.addMenuItem(timeSelectorItem);

        this._updatePomodoroClockMenu();
    }

    _createPomodoroSettingsMenuItems() {
        const settingsMenu = new PopupMenu.PopupSubMenuMenuItem('Timer Settings');
        this._pomodoroSettingsMenuItem = settingsMenu;
        this._pomodoroButton.menu.addMenuItem(settingsMenu);

        // Indefinite Focus Toggle
        this._pomodoroFocusInfiniteToggle = new PopupMenu.PopupSwitchMenuItem(
            'Indefinite Focus',
            this._settings.get_boolean('deepwork-pomodoro-focus-infinite')
        );
        this._pomodoroFocusInfiniteToggle.connect('toggled', (_item, state) => {
            this._settings.set_boolean('deepwork-pomodoro-focus-infinite', state);
        });
        settingsMenu.menu.addMenuItem(this._pomodoroFocusInfiniteToggle);

        // 1. Focus Duration Row
        const focusItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const focusLayout = new St.BoxLayout({
            style_class: 'time-selector-layout',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        const focusTitle = new St.Label({
            text: 'Focus Duration:',
            style_class: 'settings-selector-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });

        const focusBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const focusMinus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-remove-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        focusMinus.connect('clicked', () => {
            this._adjustPomodoroFocusTime(-5);
        });
        this._pomodoroFocusMinus = focusMinus;

        this._pomodoroFocusLabel = new St.Label({
            text: '25 min',
            style_class: 'time-selector-text',
            y_align: Clutter.ActorAlign.CENTER
        });

        const focusPlus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        focusPlus.connect('clicked', () => {
            this._adjustPomodoroFocusTime(5);
        });
        this._pomodoroFocusPlus = focusPlus;

        focusBox.add_child(focusMinus);
        focusBox.add_child(this._pomodoroFocusLabel);
        focusBox.add_child(focusPlus);

        focusLayout.add_child(focusTitle);
        focusLayout.add_child(focusBox);
        focusItem.add_child(focusLayout);
        settingsMenu.menu.addMenuItem(focusItem);

        // 2. Rest Duration Row
        const restItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const restLayout = new St.BoxLayout({
            style_class: 'time-selector-layout',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        const restTitle = new St.Label({
            text: 'Rest Duration:',
            style_class: 'settings-selector-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });

        const restBox = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });
        const restMinus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-remove-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        restMinus.connect('clicked', () => {
            this._adjustPomodoroRestTime(-1);
        });
        this._pomodoroRestMinus = restMinus;

        this._pomodoroRestLabel = new St.Label({
            text: '5 min',
            style_class: 'time-selector-text',
            y_align: Clutter.ActorAlign.CENTER
        });

        const restPlus = new St.Button({
            style_class: 'time-adjust-button',
            child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 14 }),
            y_align: Clutter.ActorAlign.CENTER
        });
        restPlus.connect('clicked', () => {
            this._adjustPomodoroRestTime(1);
        });
        this._pomodoroRestPlus = restPlus;

        restBox.add_child(restMinus);
        restBox.add_child(this._pomodoroRestLabel);
        restBox.add_child(restPlus);

        restLayout.add_child(restTitle);
        restLayout.add_child(restBox);
        restItem.add_child(restLayout);
        settingsMenu.menu.addMenuItem(restItem);

        this._updatePomodoroSettingsMenu();
    }

    _adjustPomodoroFocusTime(delta) {
        const current = this._getPomodoroDurationMinutes(
            'deepwork-pomodoro-focus-time',
            25,
            POMODORO_FOCUS_MINUTES_MIN,
            POMODORO_FOCUS_MINUTES_MAX
        );
        const next = clamp(current + delta, POMODORO_FOCUS_MINUTES_MIN, POMODORO_FOCUS_MINUTES_MAX);
        this._settings.set_int('deepwork-pomodoro-focus-time', next);
    }

    _adjustPomodoroRestTime(delta) {
        const current = this._getPomodoroDurationMinutes(
            'deepwork-pomodoro-rest-time',
            5,
            POMODORO_REST_MINUTES_MIN,
            POMODORO_REST_MINUTES_MAX
        );
        const next = clamp(current + delta, POMODORO_REST_MINUTES_MIN, POMODORO_REST_MINUTES_MAX);
        this._settings.set_int('deepwork-pomodoro-rest-time', next);
    }

    _updatePomodoroSettingsMenu() {
        try {
            const isInfinite = this._settings.get_boolean('deepwork-pomodoro-focus-infinite');
            const focus = this._getPomodoroDurationMinutes(
                'deepwork-pomodoro-focus-time',
                25,
                POMODORO_FOCUS_MINUTES_MIN,
                POMODORO_FOCUS_MINUTES_MAX
            );
            const rest = this._getPomodoroDurationMinutes(
                'deepwork-pomodoro-rest-time',
                5,
                POMODORO_REST_MINUTES_MIN,
                POMODORO_REST_MINUTES_MAX
            );

            if (this._pomodoroFocusInfiniteToggle) {
                this._pomodoroFocusInfiniteToggle.setToggleState?.(isInfinite);
            }
            if (this._pomodoroFocusLabel) {
                this._pomodoroFocusLabel.set_text(isInfinite ? '∞' : `${focus} min`);
            }
            if (this._pomodoroRestLabel) {
                this._pomodoroRestLabel.set_text(isInfinite ? '0 min' : `${rest} min`);
            }

            if (isInfinite) {
                if (this._pomodoroFocusMinus && this._pomodoroFocusPlus) {
                    this._pomodoroFocusMinus.set_reactive(false);
                    this._pomodoroFocusPlus.set_reactive(false);
                    this._pomodoroFocusMinus.set_opacity(100);
                    this._pomodoroFocusPlus.set_opacity(100);
                }
                if (this._pomodoroRestMinus && this._pomodoroRestPlus) {
                    this._pomodoroRestMinus.set_reactive(false);
                    this._pomodoroRestPlus.set_reactive(false);
                    this._pomodoroRestMinus.set_opacity(100);
                    this._pomodoroRestPlus.set_opacity(100);
                }
            } else {
                if (this._pomodoroFocusMinus && this._pomodoroFocusPlus) {
                    const canMinus = focus > POMODORO_FOCUS_MINUTES_MIN;
                    const canPlus = focus < POMODORO_FOCUS_MINUTES_MAX;
                    this._pomodoroFocusMinus.set_reactive(canMinus);
                    this._pomodoroFocusPlus.set_reactive(canPlus);
                    this._pomodoroFocusMinus.set_opacity(canMinus ? 255 : 100);
                    this._pomodoroFocusPlus.set_opacity(canPlus ? 255 : 100);
                }
                if (this._pomodoroRestMinus && this._pomodoroRestPlus) {
                    const canMinus = rest > POMODORO_REST_MINUTES_MIN;
                    const canPlus = rest < POMODORO_REST_MINUTES_MAX;
                    this._pomodoroRestMinus.set_reactive(canMinus);
                    this._pomodoroRestPlus.set_reactive(canPlus);
                    this._pomodoroRestMinus.set_opacity(canMinus ? 255 : 100);
                    this._pomodoroRestPlus.set_opacity(canPlus ? 255 : 100);
                }
            }
        } catch (e) {
            // Menu actors may be destroyed during Shell reload
        }
    }

    _createFloatingPomodoroIndicator() {
        this._destroyStaleFloatingPomodoroIndicators();
        if (this._floatingPomodoroActor) return;

        const isVertical = this._settings.get_boolean('deepwork-pomodoro-floating-vertical');
        const isCollapsed = this._settings.get_boolean('deepwork-pomodoro-floating-collapsed');
        if (this._floatingPomodoroMiniDotMode === undefined) {
            this._floatingPomodoroMiniDotMode = false;
        }

        const container = new St.BoxLayout({
            style_class: isVertical ? 'pomodoro-floating-chip vertical' : 'pomodoro-floating-chip',
            vertical: isVertical,
            reactive: true,
            track_hover: true,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });

        container.connect('destroy', () => {
            if (this._floatingPomodoroActor === container) {
                this._floatingPomodoroActor = null;
                this._floatingPomodoroLabel = null;
                this._floatingPomodoroClockSeparator = null;
                this._floatingPomodoroClockLabel = null;
                this._floatingPomodoroCountBadge = null;
                this._floatingPomodoroIcon = null;
                this._floatingPomodoroDragHandle = null;
                this._floatingPomodoroPeekIcon = null;
                this._floatingPomodoroCollapseButton = null;
                this._floatingPomodoroExpandButton = null;
            }
        });

        const dragHandle = new St.Button({
            style_class: 'pomodoro-floating-drag-handle',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Move floating Pomodoro timer',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: !isCollapsed
        });
        dragHandle.set_child(new St.Icon({
            icon_name: 'open-menu-symbolic',
            style_class: 'system-status-icon pomodoro-floating-drag-icon'
        }));
        dragHandle.connect('button-press-event', (_actor, event) => this._beginFloatingPomodoroDrag(event));

        const peekButton = new St.Button({
            style_class: 'pomodoro-floating-peek-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Temporarily show hidden top panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: !isCollapsed
        });
        this._floatingPomodoroPeekIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            style_class: 'system-status-icon pomodoro-floating-icon'
        });
        peekButton.set_child(this._floatingPomodoroPeekIcon);
        peekButton.connect('clicked', () => this._togglePanelPeek());

        const timerButton = new St.Button({
            style_class: 'pomodoro-floating-main-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Start or pause Pomodoro timer',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        const timerBox = new St.BoxLayout({
            style_class: isVertical ? 'pomodoro-floating-main-box vertical' : 'pomodoro-floating-main-box',
            vertical: isVertical,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        const currentIconName = (this._pomodoroIcon && this._pomodoroIcon.icon_name) || 'alarm-symbolic';
        this._floatingPomodoroIcon = new St.Icon({
            icon_name: currentIconName,
            style_class: 'system-status-icon pomodoro-floating-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        const showTime = this._settings.get_boolean('deepwork-pomodoro-floating-show-time');
        const showClock = this._settings.get_boolean('deepwork-pomodoro-floating-show-clock');

        this._floatingPomodoroLabel = new St.Label({
            text: '25:00',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pomodoro-floating-label',
            visible: showTime
        });

        this._floatingPomodoroClockSeparator = new St.Label({
            text: '•',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pomodoro-floating-clock-separator',
            visible: showTime && showClock
        });

        this._floatingPomodoroClockLabel = new St.Label({
            text: '00:00',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pomodoro-floating-clock-label',
            visible: showClock
        });

        timerBox.add_child(this._floatingPomodoroIcon);
        timerBox.add_child(this._floatingPomodoroLabel);
        timerBox.add_child(this._floatingPomodoroClockSeparator);
        timerBox.add_child(this._floatingPomodoroClockLabel);

        this._floatingPomodoroCountBadge = new St.Button({
            label: '0',
            style_class: 'pomodoro-count-badge',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            reactive: true
        });
        this._floatingPomodoroCountBadge.connect('button-press-event', () => {
            return Clutter.EVENT_STOP;
        });
        this._floatingPomodoroCountBadge.connect('button-release-event', () => {
            this._showMutedNotificationsPopup(this._floatingPomodoroCountBadge);
            return Clutter.EVENT_STOP;
        });
        timerBox.add_child(this._floatingPomodoroCountBadge);
        timerButton.set_child(timerBox);
        timerButton.connect('clicked', () => this._togglePomodoro());
        timerButton.connect('button-press-event', (_actor, event) => {
            if (event.get_button && event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            
            const now = event.get_time ? event.get_time() : Date.now();
            const lastTime = this._lastFloatingPomodoroClickTime || 0;
            if (now - lastTime < 300) {
                this._lastFloatingPomodoroClickTime = 0;
                return Clutter.EVENT_STOP;
            }
            this._lastFloatingPomodoroClickTime = now;
            return Clutter.EVENT_PROPAGATE;
        });

        const rotateButton = new St.Button({
            style_class: 'pomodoro-floating-rotate-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Rotate floating panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: !isCollapsed
        });
        rotateButton.set_child(new St.Icon({
            icon_name: 'system-reboot-symbolic',
            style_class: 'system-status-icon pomodoro-floating-icon'
        }));
        rotateButton.connect('clicked', () => {
            this._settings.set_boolean('deepwork-pomodoro-floating-vertical', !isVertical);
        });

        const resetButton = new St.Button({
            style_class: 'pomodoro-floating-reset-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Reset Pomodoro timer',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: !isCollapsed
        });
        resetButton.set_child(new St.Icon({
            icon_name: 'object-rotate-left-symbolic',
            style_class: 'system-status-icon pomodoro-floating-icon'
        }));
        resetButton.connect('clicked', () => this._resetPomodoroState());

        const collapseButton = new St.Button({
            style_class: 'pomodoro-floating-collapse-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Collapse floating panel further',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: container.hover
        });
        let collapseIconName;
        if (isVertical) {
            collapseIconName = 'go-up-symbolic';
        } else {
            collapseIconName = 'go-previous-symbolic';
        }
        collapseButton.set_child(new St.Icon({
            icon_name: collapseIconName,
            style_class: 'system-status-icon pomodoro-floating-icon'
        }));
        collapseButton.connect('clicked', () => {
            const isCollapsedCurrent = this._settings.get_boolean('deepwork-pomodoro-floating-collapsed');
            const isIconOnlyCurrent = this._settings.get_boolean('deepwork-pomodoro-floating-icon-only');
            
            if (!isCollapsedCurrent && !isIconOnlyCurrent) {
                this._settings.set_boolean('deepwork-pomodoro-floating-collapsed', true);
                this._settings.set_boolean('deepwork-pomodoro-floating-icon-only', false);
            } else if (isCollapsedCurrent && !isIconOnlyCurrent) {
                this._settings.set_boolean('deepwork-pomodoro-floating-collapsed', true);
                this._settings.set_boolean('deepwork-pomodoro-floating-icon-only', true);
            }
        });

        const expandButton = new St.Button({
            style_class: 'pomodoro-floating-collapse-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Expand floating panel',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: container.hover
        });
        let expandIconName;
        if (isVertical) {
            expandIconName = 'go-down-symbolic';
        } else {
            expandIconName = 'go-next-symbolic';
        }
        expandButton.set_child(new St.Icon({
            icon_name: expandIconName,
            style_class: 'system-status-icon pomodoro-floating-icon'
        }));
        expandButton.connect('clicked', () => {
            const isCollapsedCurrent = this._settings.get_boolean('deepwork-pomodoro-floating-collapsed');
            const isIconOnlyCurrent = this._settings.get_boolean('deepwork-pomodoro-floating-icon-only');
            
            if (isIconOnlyCurrent) {
                this._settings.set_boolean('deepwork-pomodoro-floating-collapsed', true);
                this._settings.set_boolean('deepwork-pomodoro-floating-icon-only', false);
            } else if (isCollapsedCurrent && !isIconOnlyCurrent) {
                this._settings.set_boolean('deepwork-pomodoro-floating-collapsed', false);
                this._settings.set_boolean('deepwork-pomodoro-floating-icon-only', false);
            }
        });

        container.add_child(dragHandle);
        container.add_child(peekButton);
        container.add_child(timerButton);
        container.add_child(rotateButton);
        container.add_child(resetButton);
        container.add_child(collapseButton);
        container.add_child(expandButton);

        container.connect('notify::hover', () => {
            this._updateFloatingPomodoroMiniDotState(true);
        });

        this._addFloatingPomodoroActor(container);

        this._floatingPomodoroActor = container;
        this._floatingPomodoroDragHandle = dragHandle;
        this._floatingPomodoroCollapseButton = collapseButton;
        this._floatingPomodoroExpandButton = expandButton;
        this._updateFloatingPomodoroMiniDotState(false);
        this._raiseFloatingPomodoro();
        this._updatePomodoroDisplay();
    }

    _destroyStaleFloatingPomodoroIndicators() {
        const staleActors = new Set();
        const collectStaleActors = actor => {
            if (!actor || typeof actor.get_children !== 'function') return;

            try {
                for (const child of actor.get_children()) {
                    const styleClass = child.style_class || child.get_style_class_name?.() || '';
                    if (child !== this._floatingPomodoroActor &&
                        styleClass.split(/\s+/).includes('pomodoro-floating-chip')) {
                        staleActors.add(child);
                    }
                    collectStaleActors(child);
                }
            } catch (e) {
                // Ignore actors that disappear while Shell is rebuilding chrome.
            }
        };

        collectStaleActors(Main.layoutManager?.uiGroup);
        collectStaleActors(global.stage);

        for (const actor of staleActors) {
            try {
                Main.layoutManager?.removeChrome?.(actor);
            } catch (e) {
                // It may not have been registered as chrome.
            }

            try {
                actor.destroy();
            } catch (e) {
                // Already gone.
            }
        }
    }

    _addFloatingPomodoroActor(actor) {
        this._floatingPomodoroChromeTracked = false;
        this._floatingPomodoroChromePlacement = null;

        if (typeof Main.layoutManager?.addTopChrome === 'function') {
            try {
                Main.layoutManager.addTopChrome(actor, {
                    affectsStruts: false
                });
                this._floatingPomodoroChromeTracked = true;
                this._floatingPomodoroChromePlacement = 'top';
                return;
            } catch (e) {
                logError('Failed to add floating Pomodoro as top chrome: ' + e.message);
            }
        }

        try {
            if (typeof Main.layoutManager?.addChrome === 'function') {
                Main.layoutManager.addChrome(actor, {
                    affectsStruts: false,
                    trackFullscreen: true
                });
                this._floatingPomodoroChromeTracked = true;
                this._floatingPomodoroChromePlacement = 'chrome';
                return;
            }
        } catch (e) {
            logError('Failed to add floating Pomodoro as chrome: ' + e.message);
        }

        try {
            Main.layoutManager.uiGroup.add_child(actor);
        } catch (e) {
            logError('Failed to add floating Pomodoro to uiGroup: ' + e.message);
        }
    }

    _removeFloatingPomodoroActor(actor) {
        if (!actor) return;

        try {
            if (this._floatingPomodoroChromeTracked &&
                typeof Main.layoutManager?.removeChrome === 'function') {
                Main.layoutManager.removeChrome(actor);
                this._floatingPomodoroChromeTracked = false;
                return;
            }
        } catch (e) {
            logError('Failed to remove floating Pomodoro chrome: ' + e.message);
        }

        try {
            const parent = actor.get_parent?.();
            if (parent) parent.remove_child(actor);
        } catch (e) {
            // Actor may already be detached.
        }

        this._floatingPomodoroChromeTracked = false;
        this._floatingPomodoroChromePlacement = null;
    }

    _raiseFloatingPomodoro() {
        if (!this._floatingPomodoroActor) return;

        try {
            if (typeof this._floatingPomodoroActor.raise_top === 'function') {
                this._floatingPomodoroActor.raise_top();
            }

            const parent = this._floatingPomodoroActor.get_parent();
            if (parent && typeof parent.set_child_above_sibling === 'function') {
                parent.set_child_above_sibling(this._floatingPomodoroActor, null);
            }
        } catch (e) {
            // Ignore ordering races while GNOME Shell is rebuilding actors.
        }
    }

    _queueFloatingPomodoroRaise() {
        if (!this._floatingPomodoroActor || !this._floatingPomodoroActor.visible) return;

        this._raiseFloatingPomodoro();
        this._stopFloatingPomodoroRaiseTimer();
        this._floatingPomodoroRaiseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            this._floatingPomodoroRaiseTimerId = 0;
            if (this._floatingPomodoroActor?.visible) {
                this._raiseFloatingPomodoro();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onUiGroupChanged() {
        if (!this._floatingPomodoroActor || !this._floatingPomodoroActor.visible) return;

        try {
            const parent = this._floatingPomodoroActor.get_parent();
            if (!parent) return;

            const children = parent.get_children();
            if (children.length > 0 && children[children.length - 1] !== this._floatingPomodoroActor) {
                this._queueFloatingPomodoroRaise();
            }
        } catch (e) {
            // Ignore ordering races during GNOME Shell reconstruction.
        }
    }

    _stopFloatingPomodoroRaiseTimer() {
        if (this._floatingPomodoroRaiseTimerId > 0) {
            try {
                GLib.source_remove(this._floatingPomodoroRaiseTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._floatingPomodoroRaiseTimerId = 0;
        }
    }

    _positionFloatingPomodoro() {
        if (!this._floatingPomodoroActor) return;

        const monitor = this._getSavedFloatingPomodoroMonitor();
        const { width, height } = this._getFloatingPomodoroSize();
        const savedPosition = this._getSavedFloatingPomodoroPosition(monitor, width, height);

        if (savedPosition) {
            this._floatingPomodoroActor.set_position(savedPosition.x, savedPosition.y);
            return;
        }

        this._floatingPomodoroActor.set_position(
            ...this._clampFloatingPomodoroPosition(
                monitor.x + monitor.width - width - 12,
                monitor.y + Math.max(56, (Main.panel?.height || 32) + 20),
                monitor,
                width,
                height
            )
        );
    }

    _getFloatingPomodoroSize() {
        if (!this._floatingPomodoroActor) return { width: 96, height: 32 };

        const [, naturalWidth] = this._floatingPomodoroActor.get_preferred_width(-1);
        const [, naturalHeight] = this._floatingPomodoroActor.get_preferred_height(naturalWidth || -1);

        return {
            width: Math.max(96, Math.ceil(naturalWidth || 96)),
            height: Math.max(28, Math.ceil(naturalHeight || 28))
        };
    }

    _getMonitorByIndex(index) {
        const monitors = Main.layoutManager.monitors || [];
        if (index >= 0 && index < monitors.length) {
            return { monitor: monitors[index], index };
        }

        const primaryIndex = Main.layoutManager.primaryIndex ?? 0;
        const monitor = Main.layoutManager.primaryMonitor || monitors[primaryIndex] || monitors[0] || {
            x: 0,
            y: 0,
            width: global.screen_width || 1920,
            height: global.screen_height || 1080
        };

        return {
            monitor,
            index: Math.max(0, primaryIndex)
        };
    }

    _getSavedFloatingPomodoroMonitor() {
        try {
            const savedIndex = this._settings.get_int('deepwork-pomodoro-floating-monitor');
            return this._getMonitorByIndex(savedIndex).monitor;
        } catch (e) {
            return this._getMonitorByIndex(-1).monitor;
        }
    }

    _getMonitorForPoint(x, y) {
        const monitors = Main.layoutManager.monitors || [];
        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            if (x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y && y < monitor.y + monitor.height) {
                return { monitor, index: i };
            }
        }

        return this._getMonitorByIndex(-1);
    }

    _clampFloatingPomodoroPosition(x, y, monitor, width, height) {
        const margin = 8;
        const minX = monitor.x + margin;
        const minY = monitor.y + margin;
        const maxX = Math.max(minX, monitor.x + monitor.width - width - margin);
        const maxY = Math.max(minY, monitor.y + monitor.height - height - margin);

        return [
            clamp(Math.round(x), minX, maxX),
            clamp(Math.round(y), minY, maxY)
        ];
    }

    _getSavedFloatingPomodoroPosition(monitor, width, height) {
        try {
            const xRatio = this._settings.get_double('deepwork-pomodoro-floating-x-ratio');
            const yRatio = this._settings.get_double('deepwork-pomodoro-floating-y-ratio');
            if (xRatio < 0 || yRatio < 0) return null;

            const x = monitor.x + xRatio * Math.max(0, monitor.width - width);
            const y = monitor.y + yRatio * Math.max(0, monitor.height - height);
            const [clampedX, clampedY] = this._clampFloatingPomodoroPosition(x, y, monitor, width, height);
            return { x: clampedX, y: clampedY };
        } catch (e) {
            return null;
        }
    }

    _saveFloatingPomodoroPosition() {
        if (!this._floatingPomodoroActor) return;

        try {
            const { width, height } = this._getFloatingPomodoroSize();
            const centerX = this._floatingPomodoroActor.x + width / 2;
            const centerY = this._floatingPomodoroActor.y + height / 2;
            const { monitor, index } = this._getMonitorForPoint(centerX, centerY);
            const [x, y] = this._clampFloatingPomodoroPosition(
                this._floatingPomodoroActor.x,
                this._floatingPomodoroActor.y,
                monitor,
                width,
                height
            );

            this._floatingPomodoroActor.set_position(x, y);
            this._settings.set_double(
                'deepwork-pomodoro-floating-x-ratio',
                clamp((x - monitor.x) / Math.max(1, monitor.width - width), 0, 1)
            );
            this._settings.set_double(
                'deepwork-pomodoro-floating-y-ratio',
                clamp((y - monitor.y) / Math.max(1, monitor.height - height), 0, 1)
            );
            this._settings.set_int('deepwork-pomodoro-floating-monitor', index);
        } catch (e) {
            logError('Failed to save floating Pomodoro position: ' + e.message);
        }
    }

    _beginFloatingPomodoroDrag(event) {
        if (!this._floatingPomodoroActor) return Clutter.EVENT_PROPAGATE;
        if (event.get_button && event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        this._floatingPomodoroDragState = {
            pointerOffsetX: stageX - this._floatingPomodoroActor.x,
            pointerOffsetY: stageY - this._floatingPomodoroActor.y
        };
        this._floatingPomodoroActor.add_style_pseudo_class('dragging');
        this._connectFloatingPomodoroDragCapture();
        return Clutter.EVENT_STOP;
    }

    _connectFloatingPomodoroDragCapture() {
        if (this._floatingPomodoroStageCaptureId > 0) return;

        this._floatingPomodoroStageCaptureId = global.stage.connect('captured-event', (_stage, event) => {
            if (!this._floatingPomodoroDragState || !this._floatingPomodoroActor) {
                this._disconnectFloatingPomodoroDragCapture();
                return Clutter.EVENT_PROPAGATE;
            }

            const eventType = event.type();
            if (eventType === Clutter.EventType.MOTION) {
                this._updateFloatingPomodoroDrag(event);
                return Clutter.EVENT_STOP;
            }

            if (eventType === Clutter.EventType.BUTTON_RELEASE) {
                this._finishFloatingPomodoroDrag();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disconnectFloatingPomodoroDragCapture() {
        if (this._floatingPomodoroStageCaptureId > 0) {
            try {
                global.stage.disconnect(this._floatingPomodoroStageCaptureId);
            } catch (e) {
                // Stage may be tearing down.
            }
            this._floatingPomodoroStageCaptureId = 0;
        }
    }

    _updateFloatingPomodoroDrag(event) {
        const [stageX, stageY] = event.get_coords();
        const { width, height } = this._getFloatingPomodoroSize();
        const { monitor } = this._getMonitorForPoint(stageX, stageY);
        const [x, y] = this._clampFloatingPomodoroPosition(
            stageX - this._floatingPomodoroDragState.pointerOffsetX,
            stageY - this._floatingPomodoroDragState.pointerOffsetY,
            monitor,
            width,
            height
        );

        this._floatingPomodoroActor.set_position(x, y);
        this._raiseFloatingPomodoro();
    }

    _finishFloatingPomodoroDrag() {
        const wasDragging = !!this._floatingPomodoroDragState;

        if (this._floatingPomodoroActor) {
            this._floatingPomodoroActor.remove_style_pseudo_class('dragging');
        }

        this._floatingPomodoroDragState = null;
        this._disconnectFloatingPomodoroDragCapture();
        if (wasDragging) {
            this._saveFloatingPomodoroPosition();
        }
    }

    _togglePanelPeek() {
        if (this._panelPeekActive) {
            this._cancelPanelPeek(true);
        } else {
            this._startPanelPeek();
        }
    }

    _startPanelPeek() {
        if (!this._active || !this._pomodoroButton) return;

        this._panelPeekActive = true;
        this._stopPanelPeekTimer();
        this._setPanelPeekIcon('view-conceal-symbolic');

        try {
            this._resetPanelOverviewReveal();
            this._suppressPanelChromeStruts();
            this._forcePanelActorsVisible();
            this._queuePanelWorkAreaRefresh();
            this._applyPaperWMPanelWorkAreaBridge(true);
            this._schedulePanelRevealRefresh();
        } catch (e) {
            logError('Failed to show panel peek: ' + e.message);
        }

        this._syncFloatingPomodoroVisibility();
        this._schedulePanelPeekTimeout();
    }

    _getPanelPeekDurationSeconds() {
        try {
            const value = this._settings.get_int('deepwork-pomodoro-panel-peek-duration');
            const clamped = Math.max(2, Math.min(30, Math.floor(value)));
            if (clamped !== value) {
                this._settings.set_int('deepwork-pomodoro-panel-peek-duration', clamped);
            }
            return clamped;
        } catch (e) {
            return 10;
        }
    }

    _schedulePanelPeekTimeout() {
        this._stopPanelPeekTimer();
        this._panelPeekTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._getPanelPeekDurationSeconds() * 1000,
            () => {
                this._panelPeekTimerId = 0;
                this._cancelPanelPeek(true);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _stopPanelPeekTimer() {
        if (this._panelPeekTimerId > 0) {
            try {
                GLib.source_remove(this._panelPeekTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._panelPeekTimerId = 0;
        }
    }

    _cancelPanelPeek(reapplyFocusConfiguration) {
        const wasPeeking = this._panelPeekActive;

        this._stopPanelPeekTimer();
        this._panelPeekActive = false;
        this._setPanelPeekIcon('view-reveal-symbolic');

        if (wasPeeking && reapplyFocusConfiguration && this._active) {
            this._applyFocusConfigurations();
        } else {
            this._syncFloatingPomodoroVisibility();
        }
    }

    _setPanelPeekIcon(iconName) {
        if (this._floatingPomodoroPeekIcon) {
            this._floatingPomodoroPeekIcon.icon_name = iconName;
        }
    }

    _syncFloatingPomodoroVisibility() {
        const shouldShow = this._pomodoroButton &&
            this._isPomodoroControllerEnabled() &&
            this._isPomodoroSessionActive() &&
            !this._panelPeekActive &&
            !Main.overview.visible;

        if (shouldShow) {
            if (!this._floatingPomodoroActor) {
                this._createFloatingPomodoroIndicator();
            }
            if (!this._floatingPomodoroActor) return;

            if (!this._floatingPomodoroDragState) {
                this._positionFloatingPomodoro();
            }
            this._floatingPomodoroActor.show();
            this._queueFloatingPomodoroRaise();
        } else {
            if (this._floatingPomodoroActor) {
                this._floatingPomodoroActor.hide();
            }
        }
        this._ensureClockTimer();
    }

    _isDeepWorkEnabledSetting() {
        try {
            return this._settings.get_boolean('deepwork-enabled');
        } catch (e) {
            return this._active;
        }
    }

    _setPomodoroIcon(iconName) {
        if (this._pomodoroIcon) {
            this._pomodoroIcon.icon_name = iconName;
        }
        if (this._floatingPomodoroIcon) {
            const isIconOnly = this._settings.get_boolean('deepwork-pomodoro-floating-icon-only');
            const isMinimized = isIconOnly && !(this._floatingPomodoroActor && this._floatingPomodoroActor.hover);
            this._floatingPomodoroIcon.icon_name = isMinimized ? 'alarm-symbolic' : iconName;
        }
    }

    _getPomodoroClockTime() {
        try {
            const hour = clamp(Math.floor(this._settings.get_int('deepwork-pomodoro-clock-hour')), 0, 23);
            const minute = clamp(Math.floor(this._settings.get_int('deepwork-pomodoro-clock-minute')), 0, 59);
            return { hour, minute };
        } catch (e) {
            return { hour: 18, minute: 0 };
        }
    }

    _formatPomodoroClockTime() {
        const { hour, minute } = this._getPomodoroClockTime();
        return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    }

    _getPomodoroClockMenuTitle() {
        const enabled = this._settings.get_boolean('deepwork-pomodoro-clock-enabled');
        return `Auto Stop Clock: ${enabled ? this._formatPomodoroClockTime() : 'Off'}`;
    }

    _updatePomodoroClockMenu() {
        try {
            if (this._pomodoroClockMenuItem?.label) {
                this._pomodoroClockMenuItem.label.set_text(this._getPomodoroClockMenuTitle());
            }
            if (this._pomodoroClockToggleItem) {
                this._pomodoroClockToggleItem.setToggleState?.(
                    this._settings.get_boolean('deepwork-pomodoro-clock-enabled')
                );
            }
            const { hour, minute } = this._getPomodoroClockTime();
            if (this._pomodoroClockHourLabel) {
                this._pomodoroClockHourLabel.set_text(hour.toString().padStart(2, '0'));
            }
            if (this._pomodoroClockMinuteLabel) {
                this._pomodoroClockMinuteLabel.set_text(minute.toString().padStart(2, '0'));
            }
        } catch (e) {
            // Menu actors may already be destroyed during Shell reload.
        }
    }

    _setPomodoroClockTime(hour, minute) {
        const totalMinutes = ((Math.floor(hour) * 60 + Math.floor(minute)) % 1440 + 1440) % 1440;
        this._settings.set_int('deepwork-pomodoro-clock-hour', Math.floor(totalMinutes / 60));
        this._settings.set_int('deepwork-pomodoro-clock-minute', totalMinutes % 60);
        this._pomodoroClockLastTriggerKey = null;
        this._updatePomodoroClockMenu();
    }

    _setPomodoroClockFromNow(offsetMinutes) {
        const now = GLib.DateTime.new_now_local().add_minutes(offsetMinutes);
        this._setPomodoroClockTime(now.get_hour(), now.get_minute());
        this._settings.set_boolean('deepwork-pomodoro-clock-enabled', true);
    }

    _adjustPomodoroClockTime(deltaMinutes) {
        const { hour, minute } = this._getPomodoroClockTime();
        this._setPomodoroClockTime(hour, minute + deltaMinutes);
        this._settings.set_boolean('deepwork-pomodoro-clock-enabled', true);
    }

    _onPomodoroClockTimeChanged() {
        this._pomodoroClockLastTriggerKey = null;
        this._updatePomodoroClockMenu();
    }

    _syncPomodoroClockState() {
        this._updatePomodoroClockMenu();
        if (this._settings.get_boolean('deepwork-pomodoro-clock-enabled') && this._pomodoroButton) {
            this._startPomodoroClockMonitor();
        } else {
            this._stopPomodoroClockMonitor();
        }
    }

    _startPomodoroClockMonitor() {
        if (this._pomodoroClockTimerId > 0) return;

        this._pomodoroClockTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POMODORO_CLOCK_CHECK_SECONDS,
            () => {
                if (!this._pomodoroButton || !this._settings.get_boolean('deepwork-pomodoro-clock-enabled')) {
                    this._pomodoroClockTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                this._checkPomodoroClockStop();
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._checkPomodoroClockStop();
    }

    _stopPomodoroClockMonitor() {
        if (this._pomodoroClockTimerId > 0) {
            try {
                GLib.source_remove(this._pomodoroClockTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._pomodoroClockTimerId = 0;
        }
    }

    _checkPomodoroClockStop() {
        if (!this._isPomodoroSessionActive()) return;

        const now = GLib.DateTime.new_now_local();
        const { hour, minute } = this._getPomodoroClockTime();
        if (now.get_hour() !== hour || now.get_minute() !== minute) return;

        const triggerKey = `${now.format('%Y-%m-%d')}-${hour}:${minute}`;
        if (this._pomodoroClockLastTriggerKey === triggerKey) return;

        this._pomodoroClockLastTriggerKey = triggerKey;
        this._handlePomodoroClockReached();
    }

    _handlePomodoroClockReached() {
        const stopTime = this._formatPomodoroClockTime();
        const focusNotificationSummary = this._consumeFocusNotificationSummary();
        this._resetPomodoroState();
        this._setDeepWorkEnabledFromPomodoro(false);
        Main.notify(
            'Deep Work Auto Stop',
            `Stop clock reached ${stopTime}. Deep Work is off and the timer has been reset.`
        );
        this._scheduleFocusNotificationSummary(focusNotificationSummary);
    }

    _isFocusNotificationSummaryEnabled() {
        try {
            return this._settings.get_boolean('deepwork-focus-notification-summary-enabled');
        } catch (e) {
            return false;
        }
    }

    _shouldShowFocusNotificationCount() {
        try {
            return this._settings.get_boolean('deepwork-pomodoro-show-notification-count');
        } catch (e) {
            return false;
        }
    }

    _shouldTrackFocusNotifications() {
        return this._isFocusNotificationSummaryEnabled() || this._shouldShowFocusNotificationCount();
    }

    _isFocusNotificationSuppressionActive() {
        try {
            return this._active &&
                this._pomodoroState === 'focus' &&
                this._settings.get_boolean('deepwork-mute-notifications') &&
                !this._notificationSettings.get_boolean('show-banners');
        } catch (e) {
            return false;
        }
    }

    _startFocusNotificationSession() {
        if (this._focusNotificationSessionActive) return;

        this._focusNotificationSessionActive = true;
        this._focusNotificationCount = 0;
        this._focusNotificationHadSuppression = this._isFocusNotificationSuppressionActive();
        this._focusNotifications = [];
        this._updatePomodoroDisplay();
    }

    _clearFocusNotificationSession() {
        this._focusNotificationSessionActive = false;
        this._focusNotificationCount = 0;
        this._focusNotificationHadSuppression = false;
        this._focusNotifications = [];
        this._updatePomodoroDisplay();
    }

    _consumeFocusNotificationSummary() {
        const summary = this._isFocusNotificationSummaryEnabled() &&
            this._focusNotificationHadSuppression &&
            this._focusNotificationCount > 0
            ? { count: this._focusNotificationCount }
            : null;

        this._clearFocusNotificationSession();
        return summary;
    }

    _recordFocusNotification(notification, source) {
        if (!this._shouldTrackFocusNotifications() ||
            !this._focusNotificationSessionActive ||
            !this._isFocusNotificationSuppressionActive() ||
            this._isOwnFocusNotification(notification)) {
            return;
        }

        this._focusNotificationHadSuppression = true;
        this._focusNotificationCount++;

        let appName = 'System';
        if (source && source.title) {
            appName = source.title;
        }

        let title = '';
        let body = '';
        try {
            title = notification.title || notification._title || '';
        } catch (e) {}
        try {
            body = notification.body || notification._body || notification.banner || notification._banner || '';
        } catch (e) {}

        this._focusNotifications.push({
            appName,
            title,
            body
        });

        this._updatePomodoroDisplay();
    }

    _isOwnFocusNotification(notification) {
        const ownTitles = [
            'Focus Block Complete!',
            'Rest Over!',
            'Deep Work Auto Stop',
            'Focus Notification Summary'
        ];

        try {
            const title = notification?.title || notification?._title || '';
            return ownTitles.includes(title);
        } catch (e) {
            return false;
        }
    }

    _showMutedNotificationsPopup(sourceActor) {
        if (!sourceActor) return;

        // If a summary menu is already open, close it
        if (this._activeSummaryMenu) {
            const oldMenu = this._activeSummaryMenu;
            oldMenu.close();
            if (oldMenu.sourceActor === sourceActor) {
                return;
            }
        }

        // Determine dynamic arrow side for the floating panel vs top bar
        let side = St.Side.TOP;
        let isFloating = false;
        if (sourceActor === this._floatingPomodoroCountBadge) {
            isFloating = true;
            try {
                const [x, y] = sourceActor.get_transformed_position();
                const monitorIndex = Main.layoutManager.findIndexForActor(sourceActor);
                const currentMonitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
                const isVertical = this._settings.get_boolean('deepwork-pomodoro-floating-vertical');

                if (isVertical) {
                    // Vertical panel orientation: pop out to LEFT or RIGHT sides
                    if (x > currentMonitor.x + currentMonitor.width / 2) {
                        side = St.Side.RIGHT; // Pop out to the left
                    } else {
                        side = St.Side.LEFT; // Pop out to the right
                    }
                } else {
                    // Horizontal panel orientation: pop out to TOP or BOTTOM
                    if (y > currentMonitor.y + currentMonitor.height / 2) {
                        side = St.Side.BOTTOM; // Pop out above
                    } else {
                        side = St.Side.TOP; // Pop out below
                    }
                }
            } catch (e) {
                // Fallback to TOP if coordinate query fails
            }
        }

        // Create a new lightweight PopupMenu attached to the sourceActor
        const menu = new PopupMenu.PopupMenu(sourceActor, 0.5, side);
        menu.sourceActor = sourceActor;
        Main.uiGroup.add_child(menu.actor);

        menu.actor.add_style_class_name('pomodoro-summary-popover');
        if (isFloating) {
            menu.actor.add_style_class_name('pomodoro-summary-popover-floating');
        }

        // Add a Header Title
        const header = new PopupMenu.PopupMenuItem('Muted Notifications', { reactive: false });
        header.label.style = 'font-weight: bold; font-size: 9.5pt; color: #ffffff;';
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._focusNotifications.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No notifications silenced', { reactive: false });
            item.label.style = 'font-size: 9pt; color: rgba(255,255,255,0.7);';
            menu.addMenuItem(item);
        } else {
            for (const notif of this._focusNotifications) {
                let displayText = notif.appName;
                if (notif.title) {
                    displayText += `: ${notif.title}`;
                }
                if (notif.body) {
                    let bodyText = notif.body;
                    if (bodyText.length > 60) {
                        bodyText = bodyText.substring(0, 57) + '...';
                    }
                    displayText += ` - "${bodyText}"`;
                }

                const item = new PopupMenu.PopupMenuItem(displayText, { reactive: false });
                item.label.style = 'font-size: 8.5pt; color: rgba(255,255,255,0.95); text-align: left;';
                item.label.clutter_text.line_wrap = true;
                menu.addMenuItem(item);
            }
        }

        // Close and destroy the menu when it loses focus or is closed
        menu.connect('open-state-changed', (menuActor, isOpen) => {
            if (!isOpen) {
                menu.destroy();
                if (this._activeSummaryMenu === menu) {
                    this._activeSummaryMenu = null;
                }
            }
        });

        this._activeSummaryMenu = menu;
        menu.open();
        if (isFloating && typeof menu.actor.raise_top === 'function') {
            menu.actor.raise_top();
        }
    }

    _getFocusNotificationCountSuffix() {
        if (!this._shouldShowFocusNotificationCount() ||
            !this._focusNotificationSessionActive ||
            !this._focusNotificationHadSuppression ||
            this._focusNotificationCount <= 0) {
            return '';
        }

        return ` (${this._focusNotificationCount})`;
    }

    _scheduleFocusNotificationSummary(summary) {
        if (!summary || summary.count <= 0) return;

        this._stopFocusNotificationSummaryTimer();
        this._focusNotificationSummaryTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            3,
            () => {
                this._focusNotificationSummaryTimerId = 0;
                Main.notify(
                    'Focus Notification Summary',
                    `${summary.count} notification${summary.count === 1 ? '' : 's'} arrived while banners were silenced. Check the notification center.`
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _stopFocusNotificationSummaryTimer() {
        if (this._focusNotificationSummaryTimerId > 0) {
            try {
                GLib.source_remove(this._focusNotificationSummaryTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._focusNotificationSummaryTimerId = 0;
        }
    }

    _getPomodoroDurationMinutes(key, fallback, min, max) {
        try {
            const value = this._settings.get_int(key);
            const clamped = Math.max(min, Math.min(max, Math.floor(value)));
            if (clamped !== value) {
                this._settings.set_int(key, clamped);
            }
            return clamped;
        } catch (e) {
            return fallback;
        }
    }

    _isPomodoroControllerEnabled() {
        try {
            return this._settings.get_boolean('deepwork-pomodoro-timer-enabled');
        } catch (e) {
            return false;
        }
    }

    _isPomodoroSessionActive() {
        return this._pomodoroSessionActive || this._pomodoroTimer !== null;
    }

    _syncDeepWorkForPomodoroPhase() {
        if (!this._isPomodoroControllerEnabled()) return;

        this._setDeepWorkEnabledFromPomodoro(this._pomodoroState === 'focus');
    }

    _togglePomodoro() {
        if (this._pomodoroTimer) {
            // Pause
            this._pausePomodoro();
        } else {
            // Play
            this._startPomodoro();
        }
    }

    _startPomodoro() {
        if (this._pomodoroTimer) return;
        if (!this._isPomodoroControllerEnabled()) return;

        this._pomodoroSessionActive = true;
        this._syncDeepWorkForPomodoroPhase();
        if (this._pomodoroState === 'focus') {
            this._startFocusNotificationSession();
        }

        if (this._playPauseItem) {
            this._playPauseItem.label.set_text('Pause Session');
        }
        this._setPomodoroIcon('media-playback-pause-symbolic');
        this._syncFloatingPomodoroVisibility();

        this._pomodoroTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000,
            () => {
                if (!this._pomodoroButton || !this._isPomodoroControllerEnabled()) {
                    this._pomodoroTimer = null;
                    return GLib.SOURCE_REMOVE;
                }
                return this._tickPomodoro();
            }
        );
    }

    _pausePomodoro() {
        if (this._pomodoroTimer) {
            GLib.source_remove(this._pomodoroTimer);
            this._pomodoroTimer = null;
        }
        if (this._playPauseItem) {
            this._playPauseItem.label.set_text('Resume Session');
        }
        this._setPomodoroIcon('media-playback-start-symbolic');
        this._syncFloatingPomodoroVisibility();
    }

    _resetPomodoroState() {
        this._pomodoroSessionActive = false;
        this._wasActiveBeforeLock = false;
        this._pausePomodoro();
        this._pomodoroState = 'focus';
        this._clearFocusNotificationSession();
        
        const isInfinite = this._settings.get_boolean('deepwork-pomodoro-focus-infinite');
        const focusDuration = this._getPomodoroDurationMinutes(
            'deepwork-pomodoro-focus-time',
            25,
            POMODORO_FOCUS_MINUTES_MIN,
            POMODORO_FOCUS_MINUTES_MAX
        );
        
        if (isInfinite) {
            this._pomodoroRemaining = 0;
        } else {
            this._pomodoroRemaining = focusDuration * 60;
        }
        
        this._updatePomodoroDisplay();
        if (this._playPauseItem) {
            this._playPauseItem.label.set_text('Start Session');
        }
        this._setPomodoroIcon('alarm-symbolic');
        if (this._isPomodoroControllerEnabled()) {
            this._setDeepWorkEnabledFromPomodoro(false);
        }
        this._syncFloatingPomodoroVisibility();
    }

    _tickPomodoro() {
        const isInfinite = this._settings.get_boolean('deepwork-pomodoro-focus-infinite');
        const focusDuration = this._getPomodoroDurationMinutes(
            'deepwork-pomodoro-focus-time',
            25,
            POMODORO_FOCUS_MINUTES_MIN,
            POMODORO_FOCUS_MINUTES_MAX
        );

        if (this._pomodoroState === 'focus' && isInfinite) {
            this._pomodoroRemaining++;
            this._updatePomodoroDisplay();
            return GLib.SOURCE_CONTINUE;
        }

        if (this._pomodoroRemaining > 0) {
            this._pomodoroRemaining--;
            this._updatePomodoroDisplay();
            return GLib.SOURCE_CONTINUE;
        } else {
            this._pomodoroTimer = null;
            this._handleBlockCompleted();
            return GLib.SOURCE_REMOVE;
        }
    }

    _updatePomodoroDisplay() {
        const isInfinite = this._settings.get_boolean('deepwork-pomodoro-focus-infinite');
        const focusDuration = this._getPomodoroDurationMinutes(
            'deepwork-pomodoro-focus-time',
            25,
            POMODORO_FOCUS_MINUTES_MIN,
            POMODORO_FOCUS_MINUTES_MAX
        );

        let timeText;
        if (!this._pomodoroSessionActive && this._pomodoroState === 'focus' && isInfinite) {
            timeText = '∞';
        } else if (!this._pomodoroSessionActive) {
            const totalMins = Math.round(this._pomodoroRemaining / 60);
            const hours = Math.floor(totalMins / 60);
            const mins = totalMins % 60;
            const padHours = hours.toString().padStart(2, '0');
            const padMins = mins.toString().padStart(2, '0');
            timeText = `${padHours}:${padMins}`;
        } else {
            const totalSecs = this._pomodoroRemaining;
            const hours = Math.floor(totalSecs / 3600);
            const mins = Math.floor((totalSecs % 3600) / 60);
            const secs = totalSecs % 60;
            const padHours = hours.toString().padStart(2, '0');
            const padMins = mins.toString().padStart(2, '0');
            const padSecs = secs.toString().padStart(2, '0');
            timeText = `${padHours}:${padMins}:${padSecs}`;
        }

        if (this._pomodoroLabel) {
            this._pomodoroLabel.set_text(timeText);
        }

        const showCount = this._shouldShowFocusNotificationCount() &&
                          this._focusNotificationSessionActive &&
                          this._focusNotificationHadSuppression &&
                          this._focusNotificationCount > 0;

        if (this._pomodoroCountBadge) {
            this._pomodoroCountBadge.set_label(this._focusNotificationCount.toString());
            this._pomodoroCountBadge.visible = showCount;
        }
        if (this._floatingPomodoroCountBadge) {
            this._floatingPomodoroCountBadge.set_label(this._focusNotificationCount.toString());
        }

        const showTime = this._settings.get_boolean('deepwork-pomodoro-floating-show-time');
        const showClock = this._settings.get_boolean('deepwork-pomodoro-floating-show-clock');
        const isIconOnly = this._settings.get_boolean('deepwork-pomodoro-floating-icon-only');

        if (this._floatingPomodoroLabel) {
            if (showTime) {
                const isVertical = this._settings.get_boolean('deepwork-pomodoro-floating-vertical');
                const floatingTimeText = isVertical ? timeText.replace(/:/g, '\n') : timeText;
                this._floatingPomodoroLabel.set_text(floatingTimeText);
            }
        }

        if (this._floatingPomodoroClockLabel) {
            if (showClock) {
                let is24h = true;
                try {
                    const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                    is24h = interfaceSettings.get_string('clock-format') === '24h';
                } catch (e) {}
                const now = GLib.DateTime.new_now_local();
                const isVertical = this._settings.get_boolean('deepwork-pomodoro-floating-vertical');

                if (isVertical) {
                    const hour = is24h ? now.format('%H') : now.format('%I');
                    const min = now.format('%M');
                    if (is24h) {
                        this._floatingPomodoroClockLabel.set_text(`${hour}\n${min}`);
                    } else {
                        const ampm = now.format('%p'); // E.g., AM or PM
                        this._floatingPomodoroClockLabel.set_text(`${hour}\n${min}\n${ampm}`);
                    }
                } else {
                    const clockText = is24h ? now.format('%H:%M') : now.format('%I:%M %p').replace(/^0/, '');
                    this._floatingPomodoroClockLabel.set_text(clockText);
                }
            }
        }

        // Update visual colors depending on state
        let style;
        const isVertical = this._settings.get_boolean('deepwork-pomodoro-floating-vertical');
        let floatingStyle;

        if (!this._pomodoroSessionActive) {
            style = 'color: #ffffff; margin-left: 6px; font-weight: bold; font-family: monospace;'; // reset white
            floatingStyle = `color: #ffffff; margin-left: ${isVertical ? '0px' : '6px'}; font-weight: bold; font-family: monospace;`;
        } else if (this._pomodoroState === 'focus') {
            style = 'color: #F59E0B; margin-left: 6px; font-weight: bold; font-family: monospace;'; // focus amber
            floatingStyle = `color: #F59E0B; margin-left: ${isVertical ? '0px' : '6px'}; font-weight: bold; font-family: monospace;`;
        } else {
            style = 'color: #10B981; margin-left: 6px; font-weight: bold; font-family: monospace;'; // rest green
            floatingStyle = `color: #10B981; margin-left: ${isVertical ? '0px' : '6px'}; font-weight: bold; font-family: monospace;`;
        }

        if (this._pomodoroLabel) {
            this._pomodoroLabel.style = style;
        }
        if (this._floatingPomodoroLabel) {
            this._floatingPomodoroLabel.style = floatingStyle;
        }
        this._syncFloatingPomodoroVisibility();
    }

    _handleBlockCompleted() {
        try {
            if (this._pomodoroState === 'focus') {
                const focusNotificationSummary = this._consumeFocusNotificationSummary();
                // Focus completed -> rest starts
                this._pomodoroState = 'rest';
                const restDuration = this._getPomodoroDurationMinutes(
                    'deepwork-pomodoro-rest-time',
                    5,
                    POMODORO_REST_MINUTES_MIN,
                    POMODORO_REST_MINUTES_MAX
                );
                this._pomodoroRemaining = restDuration * 60;
                this._updatePomodoroDisplay();
                this._setDeepWorkEnabledFromPomodoro(false);
                
                // Native desktop notification
                Main.notify('Focus Block Complete!', 'Take a well-deserved recovery rest!');
                this._scheduleFocusNotificationSummary(focusNotificationSummary);
                this._startPomodoro(); // Start rest block automatically
            } else {
                // Rest completed -> focus starts
                this._pomodoroState = 'focus';
                const isInfinite = this._settings.get_boolean('deepwork-pomodoro-focus-infinite');
                const focusDuration = this._getPomodoroDurationMinutes(
                    'deepwork-pomodoro-focus-time',
                    25,
                    POMODORO_FOCUS_MINUTES_MIN,
                    POMODORO_FOCUS_MINUTES_MAX
                );
                if (isInfinite) {
                    this._pomodoroRemaining = 0;
                } else {
                    this._pomodoroRemaining = focusDuration * 60;
                }
                this._updatePomodoroDisplay();
                
                Main.notify('Rest Over!', 'Time to enter a deep work focus session!');
                this._startPomodoro(); // Start focus block automatically
            }
        } catch (e) {
            logError('Error completing Pomodoro block: ' + e.message);
        }
    }

    _cleanupPomodoro() {
        this._pomodoroSessionActive = false;
        this._wasActiveBeforeLock = false;
        this._pausePomodoro();
        this._stopPomodoroClockMonitor();
        this._stopFocusNotificationSummaryTimer();
        this._clearFocusNotificationSession();
        this._destroyFloatingPomodoroIndicator();
        
        if (this._activeSummaryMenu) {
            this._activeSummaryMenu.destroy();
            this._activeSummaryMenu = null;
        }
        
        if (this._pomodoroButton) {
            this._pomodoroButton.destroy();
            this._pomodoroButton = null;
            this._pomodoroLabel = null;
            this._pomodoroIcon = null;
            this._playPauseItem = null;
            this._pomodoroClockMenuItem = null;
            this._pomodoroClockToggleItem = null;
            this._pomodoroClockSetNowItem = null;
            this._pomodoroClockHourLabel = null;
            this._pomodoroClockMinuteLabel = null;
            this._pomodoroSettingsMenuItem = null;
            this._pomodoroFocusLabel = null;
            this._pomodoroFocusInfiniteToggle = null;
            this._pomodoroFocusMinus = null;
            this._pomodoroFocusPlus = null;
            this._pomodoroRestLabel = null;
            this._pomodoroRestMinus = null;
            this._pomodoroRestPlus = null;
            this._pomodoroCountBadge = null;
        }
    }

    _getCurrentPomodoroIconName() {
        if (!this._isPomodoroSessionActive()) {
            return 'alarm-symbolic';
        }
        return this._pomodoroTimer !== null ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    }

    _updateFloatingPomodoroMiniDotState(animate = true) {
        if (!this._floatingPomodoroActor) return;

        const isCollapsed = this._settings.get_boolean('deepwork-pomodoro-floating-collapsed');
        const isIconOnly = this._settings.get_boolean('deepwork-pomodoro-floating-icon-only');
        const showTime = this._settings.get_boolean('deepwork-pomodoro-floating-show-time');
        const showClock = this._settings.get_boolean('deepwork-pomodoro-floating-show-clock');
        const showCount = this._shouldShowFocusNotificationCount() &&
                          this._focusNotificationSessionActive &&
                          this._focusNotificationHadSuppression &&
                          this._focusNotificationCount > 0;

        const container = this._floatingPomodoroActor;
        if (!container) return;

        const isHovered = container.hover;
        const shouldBeDot = isIconOnly && !isHovered;
        const isShortened = isCollapsed || isIconOnly;

        if (shouldBeDot) {
            container.add_style_class_name('minimized');
            if (this._floatingPomodoroIcon) {
                this._floatingPomodoroIcon.icon_name = 'alarm-symbolic';
            }
        } else {
            container.remove_style_class_name('minimized');
            if (this._floatingPomodoroIcon) {
                this._floatingPomodoroIcon.icon_name = this._getCurrentPomodoroIconName();
            }
        }

        // Apply smooth ease transitions to all sub-elements
        this._easeActorOpacity(this._floatingPomodoroDragHandle, !shouldBeDot && !isShortened, 255, animate);
        
        const peekButton = this._floatingPomodoroPeekIcon?.get_parent();
        this._easeActorOpacity(peekButton, !shouldBeDot && !isShortened, 255, animate);
        
        this._easeActorOpacity(this._floatingPomodoroLabel, !shouldBeDot && showTime, 255, animate);
        this._easeActorOpacity(this._floatingPomodoroClockSeparator, !shouldBeDot && showTime && showClock, 255, animate);
        this._easeActorOpacity(this._floatingPomodoroClockLabel, !shouldBeDot && showClock, 255, animate);
        this._easeActorOpacity(this._floatingPomodoroCountBadge, !shouldBeDot && showCount, 255, animate);
        
        this._easeActorOpacity(this._floatingPomodoroCollapseButton, !shouldBeDot && !isIconOnly && isHovered, 255, animate);
        this._easeActorOpacity(this._floatingPomodoroExpandButton, !shouldBeDot && isShortened && isHovered, 255, animate);

        for (const child of container.get_children()) {
            const styleClass = child.style_class || '';
            if (styleClass.includes('pomodoro-floating-rotate-button') || 
                styleClass.includes('pomodoro-floating-reset-button')) {
                this._easeActorOpacity(child, !shouldBeDot && !isShortened, 255, animate);
            }
        }
    }

    _ensureClockTimer() {
        const showClock = this._settings.get_boolean('deepwork-pomodoro-floating-show-clock');
        const isVisible = this._floatingPomodoroActor && this._floatingPomodoroActor.visible;

        if (showClock && isVisible) {
            if (this._clockTimerId) return;

            this._clockTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                10000,
                () => {
                    if (!this._floatingPomodoroActor || !this._floatingPomodoroActor.visible) {
                        this._clockTimerId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    if (!this._pomodoroTimer) {
                        this._updatePomodoroDisplay();
                    }
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } else {
            if (this._clockTimerId) {
                GLib.source_remove(this._clockTimerId);
                this._clockTimerId = 0;
            }
        }
    }

    _destroyFloatingPomodoroIndicator() {
        this._finishFloatingPomodoroDrag();
        this._stopFloatingPomodoroRaiseTimer();
        this._cancelPanelPeek(false);
        if (this._clockTimerId) {
            GLib.source_remove(this._clockTimerId);
            this._clockTimerId = 0;
        }
        if (!this._floatingPomodoroActor) return;

        this._removeFloatingPomodoroActor(this._floatingPomodoroActor);
        this._floatingPomodoroActor.destroy();
        this._floatingPomodoroActor = null;
        this._floatingPomodoroLabel = null;
        this._floatingPomodoroClockSeparator = null;
        this._floatingPomodoroClockLabel = null;
        this._floatingPomodoroCountBadge = null;
        this._floatingPomodoroIcon = null;
        this._floatingPomodoroDragHandle = null;
        this._floatingPomodoroPeekIcon = null;
        this._floatingPomodoroChromeTracked = false;
        this._floatingPomodoroChromePlacement = null;
    }

    _easeActorOpacity(actor, visible, targetOpacity = 255, animate = true) {
        if (!actor) return;
        
        actor.remove_all_transitions();
        
        if (visible) {
            if (!animate) {
                actor.visible = true;
                actor.opacity = targetOpacity;
                return;
            }
            if (!actor.visible) {
                actor.opacity = 0;
                actor.visible = true;
            }
            actor.ease({
                opacity: targetOpacity,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        } else {
            if (!animate) {
                actor.visible = false;
                actor.opacity = 0;
                return;
            }
            if (actor.visible) {
                actor.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        actor.visible = false;
                    }
                });
            }
        }
    }

    _animateFloatingPomodoroRecreation(callback) {
        if (this._floatingPomodoroActor && this._floatingPomodoroActor.visible) {
            this._floatingPomodoroActor.set_pivot_point(0.5, 0.5);
            this._floatingPomodoroActor.ease({
                opacity: 0,
                scale_x: 0.9,
                scale_y: 0.9,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                onComplete: () => {
                    if (typeof callback === 'function') callback();
                    this._destroyFloatingPomodoroIndicator();
                    this._createFloatingPomodoroIndicator();
                    this._syncFloatingPomodoroVisibility();
                    
                    if (this._floatingPomodoroActor) {
                        this._floatingPomodoroActor.opacity = 0;
                        this._floatingPomodoroActor.scale_x = 0.9;
                        this._floatingPomodoroActor.scale_y = 0.9;
                        this._floatingPomodoroActor.set_pivot_point(0.5, 0.5);
                        this._floatingPomodoroActor.ease({
                            opacity: 255,
                            scale_x: 1.0,
                            scale_y: 1.0,
                            duration: 150,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                        });
                    }
                }
            });
        } else {
            if (typeof callback === 'function') callback();
            this._destroyFloatingPomodoroIndicator();
            this._createFloatingPomodoroIndicator();
            this._syncFloatingPomodoroVisibility();
        }
    }
}
