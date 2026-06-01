// GNOME Essentials: Essential Tweaks Module

import BatteryHealthSound from './tweaks/batteryHealthSound.js?v=20260529';
import EssentialMenu from './tweaks/essentialMenu.js?v=20260531-3d-tactile-depth';
import AppUninstallUtility from './tweaks/appUninstallUtility.js?v=20260530-autoremove-deps';

const DEBUG = false;

/**
 * Log a message to the console with the GnomeEssentials Tweaks prefix if DEBUG is enabled.
 * @param {string} msg - The log message.
 */
function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][Tweaks] ' + msg);
}

/**
 * Log an error message to the console with the GnomeEssentials Tweaks prefix.
 * @param {string} msg - The error log message.
 */
function logError(msg) {
    console.error('[GnomeEssentials][Tweaks] ERROR: ' + msg);
}

/**
 * Aggregates and acts as an orchestrator for all "Essential Tweaks" sub-modules
 * including Centered Quick Menu Launcher, App Context Grid Uninstaller, and UPower Battery sound tracker.
 */
export default class EssentialTweaksModule {
    /**
     * Constructs the Essential Tweaks module.
     * @param {Object} extensionContext - The core orchestrator context instance.
     */
    constructor(extensionContext) {
        this.context = extensionContext;
        this._settings = extensionContext.getSettings();
        this._batteryHealthSound = null;
        this._batteryHealthSoundActive = false;
        this._essentialMenu = null;
        this._essentialMenuActive = false;
        this._appUninstallUtility = null;
        this._appUninstallUtilityActive = false;
        this._settingsHandlers = [];
    }

    /**
     * Enables the tweak aggregator. Starts settings listeners and syncs sub-module states.
     * @returns {void}
     */
    enable() {
        log('Enabling Essential Tweaks module...');

        this._connectSettings();
        this._syncBatteryHealthSound();
        this._syncEssentialMenu();
        this._syncAppUninstallUtility();

        log('Essential Tweaks module enabled successfully.');
    }

    /**
     * Disables the tweak aggregator. Disconnects settings and tears down all sub-modules.
     * @returns {void}
     */
    disable() {
        log('Disabling Essential Tweaks module...');

        this._disconnectSettings();
        this._disableEssentialMenu();
        this._disableBatteryHealthSound();
        this._disableAppUninstallUtility();

        this._settings = null;
        log('Essential Tweaks module disabled and cleaned up.');
    }

    /**
     * Connects GSettings listeners for all relevant tweaks keys to dynamically sync sub-modules on change.
     * @private
     * @returns {void}
     */
    _connectSettings() {
        this._disconnectSettings();

        const bindKey = (key, callback) => {
            const id = this._settings.connect('changed::' + key, callback);
            this._settingsHandlers.push(id);
        };

        bindKey('tweaks-battery-health-sound-enabled', () => this._syncBatteryHealthSound());
        bindKey('tweaks-essential-menu-enabled', () => this._syncEssentialMenu());
        bindKey('tweaks-essential-uninstall-enabled', () => this._syncAppUninstallUtility());
    }

    /**
     * Disconnects GSettings handlers to prevent leaks during disable steps.
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
     * Synchronizes and toggles the Battery Health Sound sub-module based on settings.
     * @private
     * @returns {void}
     */
    _syncBatteryHealthSound() {
        const shouldEnable = this._settings?.get_boolean('tweaks-battery-health-sound-enabled') ?? false;

        if (shouldEnable) {
            if (this._batteryHealthSoundActive) return;

            try {
                this._batteryHealthSound = new BatteryHealthSound(this._settings);
                this._batteryHealthSound.enable();
                this._batteryHealthSoundActive = true;
            } catch (e) {
                this._batteryHealthSoundActive = false;
                try {
                    this._batteryHealthSound?.disable();
                } catch (disableError) {
                    logError('Failed to clean up Battery Health Sound: ' + disableError.message);
                }
                this._batteryHealthSound = null;
                logError('Failed to enable Battery Health Sound: ' + e.message);
            }
        } else {
            this._disableBatteryHealthSound();
        }
    }

    /**
     * Deactivates and destroys the Battery Health Sound sub-module.
     * @private
     * @returns {void}
     */
    _disableBatteryHealthSound() {
        try {
            this._batteryHealthSound?.disable();
        } catch (e) {
            logError('Failed to disable Battery Health Sound: ' + e.message);
        }

        this._batteryHealthSound = null;
        this._batteryHealthSoundActive = false;
    }

    /**
     * Synchronizes and toggles the Essential Menu quick launcher overlay based on settings.
     * @private
     * @returns {void}
     */
    _syncEssentialMenu() {
        const shouldEnable = this._settings?.get_boolean('tweaks-essential-menu-enabled') ?? false;

        if (shouldEnable) {
            if (this._essentialMenuActive) return;

            try {
                this._essentialMenu = new EssentialMenu(this._settings);
                this._essentialMenu.enable();
                this._essentialMenuActive = true;
            } catch (e) {
                this._essentialMenuActive = false;
                try {
                    this._essentialMenu?.disable();
                } catch (disableError) {
                    logError('Failed to clean up Essential Menu: ' + disableError.message);
                }
                this._essentialMenu = null;
                logError('Failed to enable Essential Menu: ' + e.message);
            }
        } else {
            this._disableEssentialMenu();
        }
    }

    /**
     * Deactivates and destroys the Essential Menu quick launcher.
     * @private
     * @returns {void}
     */
    _disableEssentialMenu() {
        try {
            this._essentialMenu?.disable();
        } catch (e) {
            logError('Failed to disable Essential Menu: ' + e.message);
        }

        this._essentialMenu = null;
        this._essentialMenuActive = false;
    }

    /**
     * Synchronizes and toggles the Context Menu Uninstallation Utility based on settings.
     * @private
     * @returns {void}
     */
    _syncAppUninstallUtility() {
        const shouldEnable = this._settings?.get_boolean('tweaks-essential-uninstall-enabled') ?? false;

        if (shouldEnable) {
            if (this._appUninstallUtilityActive) return;

            try {
                this._appUninstallUtility = new AppUninstallUtility(this._settings);
                this._appUninstallUtility.enable();
                this._appUninstallUtilityActive = true;
            } catch (e) {
                this._appUninstallUtilityActive = false;
                try {
                    this._appUninstallUtility?.disable();
                } catch (disableError) {
                    logError('Failed to clean up App Uninstall Utility: ' + disableError.message);
                }
                this._appUninstallUtility = null;
                logError('Failed to enable App Uninstall Utility: ' + e.message);
            }
        } else {
            this._disableAppUninstallUtility();
        }
    }

    /**
     * Deactivates and unhooks the context uninstallation hooks in the Shell App Grid.
     * @private
     * @returns {void}
     */
    _disableAppUninstallUtility() {
        try {
            this._appUninstallUtility?.disable();
        } catch (e) {
            logError('Failed to disable App Uninstall Utility: ' + e.message);
        }

        this._appUninstallUtility = null;
        this._appUninstallUtilityActive = false;
    }
}
