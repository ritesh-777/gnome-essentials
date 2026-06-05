// GNOME Essentials: Battery Health Sound tweak
// Author: Ritesh Seth
// License: GPL v3
//
// batteryHealthSound.js (UPower Bus Charger Sound Monitor)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DEBUG = false;
const POLL_INTERVAL_SECONDS = 30;
const THRESHOLD_HYSTERESIS = 3;
const FULL_CHARGE_THRESHOLD = 100;
const CRITICAL_CHARGE_THRESHOLD = 10;
const GOOD_TING_INTERVAL_MS = 1000;
const WARNING_DOUBLE_TING_INTERVAL_MS = 250;
const CRITICAL_REPEAT_MIN_INTERVAL_MS = 1000;
const CRITICAL_REPEAT_MAX_INTERVAL_MS = 5000;
const SOUND_EXTENSIONS = ['oga', 'ogg', 'wav'];
const SOUND_SUBDIRS = ['stereo', ''];

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

/**
 * UPower battery charging states enum mapping.
 * @enum {number}
 */
const BATTERY_STATE = Object.freeze({
    CHARGING: 1,
    DISCHARGING: 2,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6
});

/**
 * Log a message to the console with the battery monitor tag if DEBUG is enabled.
 * @param {string} msg - The message to log.
 */
function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][BatteryHealthSound] ' + msg);
}

/**
 * Log an error to the console with the battery monitor tag.
 * @param {string} msg - The error message.
 */
function logError(msg) {
    console.error('[GnomeEssentials][BatteryHealthSound] ERROR: ' + msg);
}

/**
 * Clamp a number to be between min and max bounds.
 * @param {number} value - The input value.
 * @param {number} min - The lower bound.
 * @param {number} max - The upper bound.
 * @returns {number} The clamped value.
 */
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * BatteryHealthSound Module.
 * Connects to UPower over system DBus to poll and monitor device battery states,
 * and plays audio/visual notifications to preserve device battery lifespan.
 */
export default class BatteryHealthSound {
    /**
     * Constructs the BatteryHealthSound instance.
     * @param {Gio.Settings} settings - The GSettings manager object.
     */
    constructor(settings) {
        this._settings = settings;
        this._active = false;
        this._displayDeviceProxy = null;
        this._notificationSettings = null;
        this._batteryPropertiesChangedId = 0;
        this._notificationSettingsChangedId = 0;
        this._settingsHandlers = [];
        this._pollTimerId = 0;
        this._highAlertArmed = true;
        this._lowAlertArmed = true;
        this._fullAlertArmed = true;
        this._criticalAlertArmed = true;
        this._soundPatternTimerIds = new Set();
        this._criticalRepeatTimerId = 0;
        this._criticalRepeatIntervalMs = 0;
        this._soundAvailabilityCache = new Map();
    }

    /**
     * Enables UPower state monitoring, connects signals, and triggers the initial poll.
     * @returns {void}
     */
    enable() {
        this._active = true;
        this._connectSettings();
        this._connectNotificationSettings();
        this._connectUPower();
        this._refreshBatteryState(true);
        this._startPolling();
    }

    /**
     * Disables the module, clears timeouts, disconnects DBus interfaces, and releases resources.
     * @returns {void}
     */
    disable() {
        this._active = false;
        this._stopCriticalRepeatAlert();
        this._stopSoundPatternTimers();
        this._stopPolling();
        this._disconnectUPower();
        this._disconnectNotificationSettings();
        this._disconnectSettings();
        this._displayDeviceProxy = null;
        this._notificationSettings = null;
    }

    /**
     * Connects GSettings listeners to immediately evaluate battery states upon threshold adjustments.
     * @private
     * @returns {void}
     */
    _connectSettings() {
        const keys = [
            'tweaks-battery-health-sound-enabled',
            'tweaks-battery-health-sound-upper-threshold',
            'tweaks-battery-health-sound-lower-threshold',
            'tweaks-battery-health-sound-full-charge-enabled',
            'tweaks-battery-health-sound-critical-charge-enabled',
            'tweaks-battery-health-sound-play-sound',
            'tweaks-battery-health-sound-respect-dnd',
            'tweaks-battery-health-sound-show-notification'
        ];

        for (const key of keys) {
            const id = this._settings.connect('changed::' + key, () => {
                const snapshot = this._readBatterySnapshot();
                if (snapshot) this._primeAlertArming(snapshot);
                this._refreshBatteryState(true);
            });
            this._settingsHandlers.push(id);
        }
    }

    /**
     * Disconnects GSettings listeners.
     * @private
     * @returns {void}
     */
    _disconnectSettings() {
        for (const id of this._settingsHandlers) {
            try {
                this._settings.disconnect(id);
            } catch (e) {
                // Settings may already be gone during Shell teardown.
            }
        }
        this._settingsHandlers = [];
    }

    /**
     * Connects to the UPower system DBus proxy to subscribe to properties changes.
     * @private
     * @returns {void}
     */
    _connectUPower() {
        try {
            const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            this._displayDeviceProxy = Gio.DBusProxy.new_sync(
                connection,
                Gio.DBusProxyFlags.NONE,
                null,
                UPOWER_NAME,
                DISPLAY_DEVICE_PATH,
                UPOWER_DEVICE_IFACE,
                null
            );

            this._batteryPropertiesChangedId = this._displayDeviceProxy.connect(
                'g-properties-changed',
                () => this._refreshBatteryState(false)
            );
        } catch (e) {
            logError('Failed to connect to UPower display battery: ' + e.message);
        }
    }

    /**
     * Disconnects from the UPower DBus proxy.
     * @private
     * @returns {void}
     */
    _disconnectUPower() {
        if (this._batteryPropertiesChangedId > 0 && this._displayDeviceProxy) {
            try {
                this._displayDeviceProxy.disconnect(this._batteryPropertiesChangedId);
            } catch (e) {
                // Proxy may already be gone.
            }
            this._batteryPropertiesChangedId = 0;
        }
    }

    /**
     * Binds listeners to org.gnome.desktop.notifications to track the Do Not Disturb (DND) status.
     * @private
     * @returns {void}
     */
    _connectNotificationSettings() {
        try {
            this._notificationSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
            this._notificationSettingsChangedId = this._notificationSettings.connect(
                'changed::show-banners',
                () => this._handleDNDChanged()
            );
        } catch (e) {
            this._notificationSettings = null;
            logError('Failed to connect to notification settings: ' + e.message);
        }
    }

    /**
     * Disconnects from GNOME's desktop notification settings.
     * @private
     * @returns {void}
     */
    _disconnectNotificationSettings() {
        if (this._notificationSettingsChangedId > 0 && this._notificationSettings) {
            try {
                this._notificationSettings.disconnect(this._notificationSettingsChangedId);
            } catch (e) {
                // Settings may already be gone during Shell teardown.
            }
            this._notificationSettingsChangedId = 0;
        }
    }

    /**
     * Handles DND status alterations, deactivating sounds immediately if DND turns active.
     * @private
     * @returns {void}
     */
    _handleDNDChanged() {
        if (this._isDNDActive() && this._shouldRespectDND()) {
            this._stopCriticalRepeatAlert();
            this._stopSoundPatternTimers();
            return;
        }

        this._refreshBatteryState(false);
    }

    /**
     * Starts the periodic fallback battery status poller.
     * @private
     * @returns {void}
     */
    _startPolling() {
        this._stopPolling();
        this._pollTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                if (!this._active) {
                    this._pollTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._refreshBatteryState(false);
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    /**
     * Stops the periodic fallback battery status poller.
     * @private
     * @returns {void}
     */
    _stopPolling() {
        if (this._pollTimerId > 0) {
            try {
                GLib.source_remove(this._pollTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._pollTimerId = 0;
        }
    }

    /**
     * Checks if the battery monitor is globally active.
     * @private
     * @returns {boolean} True if active.
     */
    _isEnabled() {
        try {
            return this._settings.get_boolean('tweaks-battery-health-sound-enabled');
        } catch (e) {
            return false;
        }
    }

    /**
     * Reads the configured upper threshold for maximum charge.
     * @private
     * @returns {number} The clamped integer threshold.
     */
    _getUpperThreshold() {
        try {
            return clamp(this._settings.get_int('tweaks-battery-health-sound-upper-threshold'), 50, 100);
        } catch (e) {
            return 80;
        }
    }

    /**
     * Reads the configured lower threshold for minimum charge.
     * @private
     * @returns {number} The clamped integer threshold.
     */
    _getLowerThreshold() {
        try {
            return clamp(this._settings.get_int('tweaks-battery-health-sound-lower-threshold'), 5, 50);
        } catch (e) {
            return 20;
        }
    }

    /**
     * Resolves settings to see if sounds are allowed to play.
     * @private
     * @returns {boolean} True if sounds should play.
     */
    _shouldPlaySound() {
        try {
            if (!this._settings.get_boolean('tweaks-battery-health-sound-play-sound')) {
                return false;
            }

            return !(this._shouldRespectDND() && this._isDNDActive());
        } catch (e) {
            return true;
        }
    }

    /**
     * Resolves settings to see if the monitor must respect DND.
     * @private
     * @returns {boolean} True if DND is respected.
     */
    _shouldRespectDND() {
        try {
            return this._settings.get_boolean('tweaks-battery-health-sound-respect-dnd');
        } catch (e) {
            return false;
        }
    }

    /**
     * Checks if GNOME Shell Do Not Disturb is active.
     * @private
     * @returns {boolean} True if DND active.
     */
    _isDNDActive() {
        try {
            return this._notificationSettings
                ? !this._notificationSettings.get_boolean('show-banners')
                : false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Resolves settings to see if the desktop notification alert must show.
     * @private
     * @returns {boolean} True if notifications should show.
     */
    _shouldShowNotification() {
        try {
            return this._settings.get_boolean('tweaks-battery-health-sound-show-notification');
        } catch (e) {
            return true;
        }
    }

    /**
     * Checks if the 100% full charge notification toggle is enabled.
     * @private
     * @returns {boolean} True if enabled.
     */
    _isFullChargeReminderEnabled() {
        try {
            return this._settings.get_boolean('tweaks-battery-health-sound-full-charge-enabled');
        } catch (e) {
            return true;
        }
    }

    /**
     * Checks if the critical low-battery (10%) recurring alarm toggle is enabled.
     * @private
     * @returns {boolean} True if enabled.
     */
    _isCriticalChargeReminderEnabled() {
        try {
            return this._settings.get_boolean('tweaks-battery-health-sound-critical-charge-enabled');
        } catch (e) {
            return true;
        }
    }

    /**
     * Helper to retrieve and unpack properties from the DBus display device interface proxy.
     * @private
     * @param {string} name - Property identifier.
     * @param {*} [fallback=null] - Default value if property fetch errors.
     * @returns {*} The unpacked property value.
     */
    _getCachedProperty(name, fallback = null) {
        try {
            const variant = this._displayDeviceProxy?.get_cached_property(name);
            return variant ? variant.deep_unpack() : fallback;
        } catch (e) {
            return fallback;
        }
    }

    /**
     * Queries UPower and packages the current system battery state into a structured snapshot object.
     * @private
     * @returns {Object|null} The battery state snapshot, or null if no battery is present.
     */
    _readBatterySnapshot() {
        if (!this._displayDeviceProxy) return null;

        const percentage = Number(this._getCachedProperty('Percentage', -1));
        const state = Number(this._getCachedProperty('State', 0));
        const isPresent = this._getCachedProperty('IsPresent', true);

        if (!isPresent || !Number.isFinite(percentage) || percentage < 0) {
            return null;
        }

        return {
            percentage,
            roundedPercentage: Math.round(percentage),
            state,
            isCharging: state === BATTERY_STATE.CHARGING ||
                state === BATTERY_STATE.PENDING_CHARGE ||
                state === BATTERY_STATE.FULLY_CHARGED,
            isDischarging: state === BATTERY_STATE.DISCHARGING ||
                state === BATTERY_STATE.PENDING_DISCHARGE
        };
    }

    /**
     * Set armed states based on current battery charge levels, preventing repeat
     * sound triggers until charge levels cross boundary thresholds.
     * @private
     * @param {Object} snapshot - The active battery state snapshot.
     * @returns {void}
     */
    _primeAlertArming(snapshot) {
        const upperThreshold = this._getUpperThreshold();
        const lowerThreshold = this._getLowerThreshold();

        this._highAlertArmed = !(snapshot.isCharging && snapshot.percentage >= upperThreshold);
        this._lowAlertArmed = !(snapshot.isDischarging && snapshot.percentage <= lowerThreshold);
        this._fullAlertArmed = !(this._isFullChargeReminderEnabled() && this._isFullChargeSnapshot(snapshot));
        this._criticalAlertArmed = !(this._isCriticalChargeReminderEnabled() && this._isCriticalChargeSnapshot(snapshot));
    }

    /**
     * Helper to verify if the snapshot represents a full charge condition.
     * @private
     * @param {Object} snapshot - The active battery snapshot.
     * @returns {boolean}
     */
    _isFullChargeSnapshot(snapshot) {
        return snapshot.isCharging &&
            (snapshot.state === BATTERY_STATE.FULLY_CHARGED ||
                snapshot.roundedPercentage >= FULL_CHARGE_THRESHOLD);
    }

    /**
     * Helper to verify if the snapshot represents a critical low charge condition.
     * @private
     * @param {Object} snapshot - The active battery snapshot.
     * @returns {boolean}
     */
    _isCriticalChargeSnapshot(snapshot) {
        return snapshot.isDischarging &&
            snapshot.roundedPercentage <= CRITICAL_CHARGE_THRESHOLD;
    }

    /**
     * Evaluates current battery properties, manages hysteresis boundary resets,
     * and triggers alerts if a charging limit has been newly crossed.
     * @private
     * @param {boolean} initial - True if this is the first evaluation run.
     * @returns {void}
     */
    _refreshBatteryState(initial) {
        if (!this._isEnabled()) {
            this._stopCriticalRepeatAlert();
            this._stopSoundPatternTimers();
            return;
        }

        const snapshot = this._readBatterySnapshot();
        if (!snapshot) {
            this._stopCriticalRepeatAlert();
            return;
        }

        const upperThreshold = this._getUpperThreshold();
        const lowerThreshold = this._getLowerThreshold();
        const criticalReminderEnabled = this._isCriticalChargeReminderEnabled();
        const criticalSnapshot = criticalReminderEnabled && this._isCriticalChargeSnapshot(snapshot);

        // Hysteresis boundary check - prevents flickering boundary triggers.
        if (snapshot.percentage <= upperThreshold - THRESHOLD_HYSTERESIS || !snapshot.isCharging) {
            this._highAlertArmed = true;
        }
        if (snapshot.percentage >= lowerThreshold + THRESHOLD_HYSTERESIS || !snapshot.isDischarging) {
            this._lowAlertArmed = true;
        }
        if (snapshot.percentage <= FULL_CHARGE_THRESHOLD - THRESHOLD_HYSTERESIS || !snapshot.isCharging) {
            this._fullAlertArmed = true;
        }
        if (snapshot.percentage >= CRITICAL_CHARGE_THRESHOLD + THRESHOLD_HYSTERESIS || !snapshot.isDischarging) {
            this._criticalAlertArmed = true;
        }
        if (!criticalSnapshot || !this._shouldPlaySound()) {
            this._stopCriticalRepeatAlert();
        }

        if (initial) {
            this._primeAlertArming(snapshot);
            if (criticalSnapshot && this._shouldPlaySound()) {
                this._startOrUpdateCriticalRepeatAlert(snapshot);
            }
            return;
        }

        // 1. Full Charge Alerts
        if (this._isFullChargeReminderEnabled() &&
            this._isFullChargeSnapshot(snapshot) &&
            this._fullAlertArmed) {
            this._fullAlertArmed = false;
            this._highAlertArmed = false;
            this._emitBatteryAlert(
                'full-charge',
                'Battery fully charged',
                'Battery reached 100%. You can unplug now.'
            );
            return;
        }

        // 2. High Health Limit Charge Alerts (e.g. 80%)
        if (snapshot.isCharging &&
            snapshot.percentage >= upperThreshold &&
            this._highAlertArmed) {
            this._highAlertArmed = false;
            this._emitBatteryAlert(
                'charge-limit',
                `Battery reached ${snapshot.roundedPercentage}%`,
                `Unplug around ${upperThreshold}% to reduce time spent at high charge.`
            );
            return;
        }

        // 3. Critical Low Battery Alarm (10% and lower)
        if (criticalSnapshot) {
            if (this._criticalAlertArmed) {
                this._criticalAlertArmed = false;
                this._lowAlertArmed = false;
                this._emitBatteryAlert(
                    'critical-battery',
                    `Battery critical at ${snapshot.roundedPercentage}%`,
                    'Plug in now to avoid an unexpected shutdown.',
                    snapshot
                );
            } else if (this._shouldPlaySound()) {
                this._startOrUpdateCriticalRepeatAlert(snapshot);
            }
            return;
        }

        // 4. Low Health Limit Battery Alerts (e.g. 20%)
        if (snapshot.isDischarging &&
            snapshot.percentage <= lowerThreshold &&
            this._lowAlertArmed) {
            this._lowAlertArmed = false;
            this._emitBatteryAlert(
                'low-battery',
                `Battery dropped to ${snapshot.roundedPercentage}%`,
                `Plug in soon to avoid deep discharge below ${lowerThreshold}%.`
            );
        }
    }

    /**
     * Dispatches the alarm sound patterns and displays shell notifications.
     * @private
     * @param {string} kind - The alert classification.
     * @param {string} title - The notification title.
     * @param {string} message - The notification body.
     * @param {Object} [snapshot=null] - Optional battery state snapshot.
     * @returns {void}
     */
    _emitBatteryAlert(kind, title, message, snapshot = null) {
        log(`${kind}: ${title} - ${message}`);

        if (this._shouldPlaySound()) {
            this._playAlertSound(kind, snapshot);
        }

        if (this._shouldShowNotification()) {
            Main.notify(title, message);
        }
    }

    /**
     * Initiates the sound sequences matching the alert classification.
     * @private
     * @param {string} kind - The alert classification.
     * @param {Object} [snapshot=null] - Optional battery state snapshot.
     * @returns {void}
     */
    _playAlertSound(kind, snapshot = null) {
        if (kind === 'critical-battery') {
            this._startOrUpdateCriticalRepeatAlert(snapshot);
            return;
        }

        this._playSoundPattern(kind);
    }

    /**
     * Executes the sound pattern loop based on delays.
     * @private
     * @param {string} kind - The alert classification.
     * @returns {void}
     */
    _playSoundPattern(kind) {
        const pattern = this._getSoundPattern(kind);
        if (!pattern) return;

        this._stopSoundPatternTimers();

        for (let i = 0; i < pattern.count; i++) {
            const delayMs = i * pattern.intervalMs;
            if (delayMs <= 0) {
                this._playSoundOnce(kind);
            } else {
                this._scheduleSoundTimer(delayMs, () => this._playSoundOnce(kind));
            }
        }
    }

    /**
     * Resolves sound assets and plays a single beep.
     * @private
     * @param {string} kind - The alert classification.
     * @returns {void}
     */
    _playSoundOnce(kind) {
        const soundNames = this._getSoundNames(kind);
        const soundName = this._getFirstAvailableSoundName(soundNames);
        if (!soundName) return;

        log(`${kind}: playing sound event ${soundName}`);
        this._playSoundFromTheme(soundName);
    }

    /**
     * Resolves the delay and repetition pattern matching the alert.
     * @private
     * @param {string} kind - The alert classification.
     * @returns {Object} Delays pattern configuration.
     */
    _getSoundPattern(kind) {
        switch (kind) {
            case 'full-charge':
                return { count: 3, intervalMs: GOOD_TING_INTERVAL_MS };
            case 'charge-limit':
                return { count: 1, intervalMs: 0 };
            case 'low-battery':
                return { count: 2, intervalMs: WARNING_DOUBLE_TING_INTERVAL_MS };
            case 'critical-battery':
                return { count: 1, intervalMs: 0 };
            default:
                return { count: 1, intervalMs: 0 };
        }
    }

    /**
     * Resolves standard Freedesktop warning system sound keys based on priority.
     * @private
     * @param {string} kind - The alert classification.
     * @returns {Array<string>} List of sound indicators.
     */
    _getSoundNames(kind) {
        switch (kind) {
            case 'full-charge':
            case 'charge-limit':
                return ['battery-full', 'complete', 'bell', 'dialog-information', 'message-new-instant'];
            case 'critical-battery':
                return ['battery-low', 'dialog-warning', 'bell', 'suspend-error', 'message-new-instant'];
            case 'low-battery':
                return ['battery-caution', 'dialog-warning', 'battery-low', 'suspend-error', 'bell', 'message-new-instant'];
            default:
                return ['dialog-information', 'bell', 'message-new-instant'];
        }
    }

    /**
     * Schedules a single delayed sound beep.
     * @private
     * @param {number} delayMs - Delay before invoking.
     * @param {Function} callback - Execution callback.
     * @returns {number} The scheduled source timer identifier.
     */
    _scheduleSoundTimer(delayMs, callback) {
        let timerId = 0;
        timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._soundPatternTimerIds.delete(timerId);
                if (!this._active || !this._isEnabled()) {
                    return GLib.SOURCE_REMOVE;
                }
                callback();
                return GLib.SOURCE_REMOVE;
            }
        );
        this._soundPatternTimerIds.add(timerId);
        return timerId;
    }

    /**
     * Deactivates all queued sound timers.
     * @private
     * @returns {void}
     */
    _stopSoundPatternTimers() {
        for (const timerId of this._soundPatternTimerIds) {
            try {
                GLib.source_remove(timerId);
            } catch (e) {
                // Source may already have fired.
            }
        }
        this._soundPatternTimerIds.clear();
    }

    /**
     * Starts or reschedules the recurring critical battery alert (beeping frequently as battery drops lower).
     * @private
     * @param {Object} snapshot - The active battery snapshot.
     * @returns {void}
     */
    _startOrUpdateCriticalRepeatAlert(snapshot) {
        if (!snapshot || !this._shouldContinueCriticalRepeat(snapshot)) {
            this._stopCriticalRepeatAlert();
            return;
        }

        const intervalMs = this._getCriticalRepeatIntervalMs(snapshot.roundedPercentage);
        if (this._criticalRepeatTimerId > 0 && this._criticalRepeatIntervalMs === intervalMs) {
            return;
        }

        this._stopCriticalRepeatAlert();
        this._criticalRepeatIntervalMs = intervalMs;
        this._playSoundPattern('critical-battery');
        this._scheduleNextCriticalRepeat(intervalMs);
    }

    /**
     * Recursively schedules the critical battery alert loop.
     * @private
     * @param {number} intervalMs - Timeout in milliseconds.
     * @returns {void}
     */
    _scheduleNextCriticalRepeat(intervalMs) {
        this._criticalRepeatTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => {
                this._criticalRepeatTimerId = 0;
                if (!this._active) {
                    this._criticalRepeatIntervalMs = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const snapshot = this._readBatterySnapshot();
                if (!this._shouldContinueCriticalRepeat(snapshot)) {
                    this._criticalRepeatIntervalMs = 0;
                    return GLib.SOURCE_REMOVE;
                }

                const nextIntervalMs = this._getCriticalRepeatIntervalMs(snapshot.roundedPercentage);
                this._criticalRepeatIntervalMs = nextIntervalMs;
                this._playSoundPattern('critical-battery');
                this._scheduleNextCriticalRepeat(nextIntervalMs);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Verifies if the critical low-battery sound loop should continue playing.
     * @private
     * @param {Object} snapshot - Active battery snapshot.
     * @returns {boolean}
     */
    _shouldContinueCriticalRepeat(snapshot) {
        return this._isEnabled() &&
            this._shouldPlaySound() &&
            this._isCriticalChargeReminderEnabled() &&
            snapshot &&
            this._isCriticalChargeSnapshot(snapshot);
    }

    /**
     * Computes the recurring alert interval based on remaining battery (beeps speed up as battery approaches 0).
     * @private
     * @param {number} percentage - Remaining battery charge percentage.
     * @returns {number} Delay interval in milliseconds.
     */
    _getCriticalRepeatIntervalMs(percentage) {
        const criticalPercentage = clamp(Math.round(percentage), 0, CRITICAL_CHARGE_THRESHOLD);

        if (criticalPercentage <= 2) return CRITICAL_REPEAT_MIN_INTERVAL_MS;
        if (criticalPercentage === 3) return 1500;
        if (criticalPercentage === 4) return 2000;
        if (criticalPercentage === 5) return 2500;
        if (criticalPercentage === 6) return 3000;
        if (criticalPercentage === 7) return 3500;
        if (criticalPercentage === 8) return 4000;
        if (criticalPercentage === 9) return 4500;

        return CRITICAL_REPEAT_MAX_INTERVAL_MS;
    }

    /**
     * Stops the recurring critical battery low alert.
     * @private
     * @returns {void}
     */
    _stopCriticalRepeatAlert() {
        const wasCriticalActive = this._criticalRepeatTimerId > 0 || this._criticalRepeatIntervalMs > 0;

        if (this._criticalRepeatTimerId > 0) {
            try {
                GLib.source_remove(this._criticalRepeatTimerId);
            } catch (e) {
                // Source may already have fired.
            }
            this._criticalRepeatTimerId = 0;
        }

        this._criticalRepeatIntervalMs = 0;
        if (wasCriticalActive) {
            this._stopSoundPatternTimers();
        }
    }

    /**
     * Iterates over a priority list of sounds, returning the first one present on the system.
     * @private
     * @param {Array<string>} soundNames - List of potential sound indicator keys.
     * @returns {string|null} The resolved sound name, or null.
     */
    _getFirstAvailableSoundName(soundNames) {
        for (const soundName of soundNames) {
            if (this._soundNameExists(soundName)) {
                return soundName;
            }
        }

        return soundNames[0] ?? null;
    }

    /**
     * Verifies if a sound file exists on disk inside standard Freedesktop sound theme hierarchies.
     * Caches search results to ensure zero disk access on repeat sound calls.
     * @private
     * @param {string} soundName - Sound asset indicator key.
     * @returns {boolean} True if file exists.
     */
    _soundNameExists(soundName) {
        const themeNames = this._getSoundThemeNames();
        const cacheKey = `${themeNames.join(',')}::${soundName}`;

        if (this._soundAvailabilityCache.has(cacheKey)) {
            return this._soundAvailabilityCache.get(cacheKey);
        }

        for (const root of this._getSoundThemeRoots()) {
            for (const themeName of themeNames) {
                for (const subdir of SOUND_SUBDIRS) {
                    for (const extension of SOUND_EXTENSIONS) {
                        const pathParts = subdir
                            ? [root, themeName, subdir, `${soundName}.${extension}`]
                            : [root, themeName, `${soundName}.${extension}`];
                        const file = Gio.File.new_for_path(GLib.build_filenamev(pathParts));

                        if (file.query_exists(null)) {
                            this._soundAvailabilityCache.set(cacheKey, true);
                            return true;
                        }
                    }
                }
            }
        }

        this._soundAvailabilityCache.set(cacheKey, false);
        return false;
    }

    /**
     * Resolves active desktop Sound Theme names from GSettings.
     * @private
     * @returns {Array<string>} Array of sound theme identifier strings.
     */
    _getSoundThemeNames() {
        const themeNames = [];

        try {
            const soundSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.sound' });
            const themeName = soundSettings.get_string('theme-name');
            if (themeName) themeNames.push(themeName);
        } catch (e) {
            // Fall back to freedesktop below.
        }

        if (!themeNames.includes('freedesktop')) {
            themeNames.push('freedesktop');
        }

        return themeNames;
    }

    /**
     * Returns standard system sound theme root search paths.
     * @private
     * @returns {Array<string>} Sound directory paths.
     */
    _getSoundThemeRoots() {
        return [
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'sounds']),
            '/usr/share/sounds'
        ];
    }

    /**
     * Dispatches sound play events using GNOME Shell's native sound player or canberra backends.
     * @private
     * @param {string} soundName - Sound asset key to play.
     * @returns {boolean} True if successfully triggered.
     */
    _playSoundFromTheme(soundName) {
        try {
            const player = global.display?.get_sound_player?.();
            if (player?.play_from_theme) {
                player.play_from_theme(soundName, 'GNOME Essentials battery health alert', null);
                return true;
            }
        } catch (e) {
            // Try canberra fallback below.
        }

        try {
            Gio.Subprocess.new(
                ['canberra-gtk-play', '-i', soundName],
                Gio.SubprocessFlags.NONE
            );
            return true;
        } catch (e) {
            return false;
        }
    }
}
