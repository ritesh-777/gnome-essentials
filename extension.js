// GNOME Essentials: Sleek, Modular Desktop Utilities
// Author: Ritesh Seth
// License: GPL v3
//
// extension.js (Modular Orchestrator Core)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEBUG = false;

/**
 * Log a message to the console with the GnomeEssentials prefix if DEBUG is enabled.
 * @param {string} msg - The log message.
 */
function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials] ' + msg);
}

/**
 * Log an error message to the console with the GnomeEssentials prefix.
 * @param {string} msg - The error log message.
 */
function logError(msg) {
    console.error('[GnomeEssentials] ERROR: ' + msg);
}

/**
 * Main Extension class that serves as the Orchestrator Core for GNOME Essentials.
 * Handles dynamic dynamic module import and lifecycle tracking based on GSettings.
 * @extends Extension
 */
export default class GnomeEssentialsExtension extends Extension {
    /**
     * Initializes and enables the extension. Connects setting listeners
     * and performs the initial evaluation of module states.
     * @async
     * @returns {Promise<void>}
     */
    async enable() {
        log('Initializing GNOME Essentials core...');

        this._enabled = true;
        this._loadGeneration = (this._loadGeneration || 0) + 1;
        this._settings = this.getSettings();
        this._activeModules = new Map(); // moduleName -> instance
        this._moduleLoadsInFlight = new Set();
        const generation = this._loadGeneration;

        // Watch settings changes to dynamically load/unload modules
        this._settingsChangedId = this._settings.connect('changed::deepwork-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._pomodoroSettingsChangedId = this._settings.connect('changed::deepwork-pomodoro-timer-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._profilesSettingsChangedId = this._settings.connect('changed::profiles-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._tweaksBatterySettingsChangedId = this._settings.connect('changed::tweaks-battery-health-sound-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._tweaksMenuSettingsChangedId = this._settings.connect('changed::tweaks-essential-menu-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._tweaksShelfSettingsChangedId = this._settings.connect('changed::tweaks-essential-shelf-enabled', () => {
            this._requestModuleStateEvaluation();
        });
        this._tweaksUninstallSettingsChangedId = this._settings.connect('changed::tweaks-essential-uninstall-enabled', () => {
            this._requestModuleStateEvaluation();
        });

        // Initial evaluation
        await this._evaluateModuleStates(generation);

        log('GNOME Essentials core successfully enabled.');
    }

    /**
     * Disables the extension. Disconnects settings listeners, unloads and disables
     * all dynamically active modules, and cleans up state values.
     * @returns {void}
     */
    disable() {
        log('Disabling GNOME Essentials core...');
        this._enabled = false;
        this._loadGeneration = (this._loadGeneration || 0) + 1;

        // Disconnect settings listener
        if (this._settingsChangedId > 0) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._pomodoroSettingsChangedId > 0) {
            this._settings.disconnect(this._pomodoroSettingsChangedId);
            this._pomodoroSettingsChangedId = 0;
        }
        if (this._profilesSettingsChangedId > 0) {
            this._settings.disconnect(this._profilesSettingsChangedId);
            this._profilesSettingsChangedId = 0;
        }
        if (this._tweaksBatterySettingsChangedId > 0) {
            this._settings.disconnect(this._tweaksBatterySettingsChangedId);
            this._tweaksBatterySettingsChangedId = 0;
        }
        if (this._tweaksMenuSettingsChangedId > 0) {
            this._settings.disconnect(this._tweaksMenuSettingsChangedId);
            this._tweaksMenuSettingsChangedId = 0;
        }
        if (this._tweaksShelfSettingsChangedId > 0) {
            this._settings.disconnect(this._tweaksShelfSettingsChangedId);
            this._tweaksShelfSettingsChangedId = 0;
        }
        if (this._tweaksUninstallSettingsChangedId > 0) {
            this._settings.disconnect(this._tweaksUninstallSettingsChangedId);
            this._tweaksUninstallSettingsChangedId = 0;
        }

        // Unload and disable all active modules unconditionally
        for (const [name, instance] of (this._activeModules || new Map()).entries()) {
            try {
                log(`Disabling module: ${name}`);
                instance.disable();
            } catch (e) {
                logError(`Failed to disable module ${name}: ${e.message}`);
            }
        }
        this._activeModules?.clear();
        this._activeModules = null;
        this._moduleLoadsInFlight = null;

        this._settings = null;
        log('GNOME Essentials core disabled and cleaned up.');
    }

    /**
     * Helper check to confirm whether module state changes are still valid for the current load generation.
     * Prevents race conditions from overlapping asynchronous imports.
     * @param {number} generation - The generation index recorded when the load process started.
     * @returns {boolean} True if the generation matches the current load state and the extension is active.
     */
    _canChangeModules(generation) {
        return this._enabled &&
            this._settings &&
            this._activeModules &&
            generation === this._loadGeneration;
    }

    /**
     * Triggers a re-evaluation of module states. If new modules need to be loaded
     * or existing modules disabled, it increments the load generation and invokes
     * the async evaluator.
     * @returns {void}
     */
    _requestModuleStateEvaluation() {
        if (!this._enabled || !this._settings || !this._activeModules) return;

        const deepWorkModuleNeeded =
            this._settings.get_boolean('deepwork-enabled') ||
            this._settings.get_boolean('deepwork-pomodoro-timer-enabled');
        const profilesEnabled = this._settings.get_boolean('profiles-enabled');
        const tweaksEnabled =
            this._settings.get_boolean('tweaks-battery-health-sound-enabled') ||
            this._settings.get_boolean('tweaks-essential-menu-enabled') ||
            this._settings.get_boolean('tweaks-essential-shelf-enabled') ||
            this._settings.get_boolean('tweaks-essential-uninstall-enabled');
        const deepWorkPresent =
            this._activeModules.has('deepwork') ||
            this._isModuleLoadInFlight('deepwork');
        const profilesPresent =
            this._activeModules.has('profiles') ||
            this._isModuleLoadInFlight('profiles');
        const tweaksPresent =
            this._activeModules.has('tweaks') ||
            this._isModuleLoadInFlight('tweaks');

        if (deepWorkModuleNeeded === deepWorkPresent &&
            profilesEnabled === profilesPresent &&
            tweaksEnabled === tweaksPresent) {
            return;
        }

        this._loadGeneration = (this._loadGeneration || 0) + 1;
        this._evaluateModuleStates(this._loadGeneration);
    }

    /**
     * Check if a module is currently loading in the background.
     * @param {string} name - The name of the module.
     * @returns {boolean} True if a load is currently active for this module.
     */
    _isModuleLoadInFlight(name) {
        return this._moduleLoadsInFlight?.has(name) ?? false;
    }

    /**
     * Mark a module as loading in the background.
     * @param {string} name - The name of the module.
     * @returns {void}
     */
    _beginModuleLoad(name) {
        this._moduleLoadsInFlight?.add(name);
    }

    /**
     * Remove the loading marker from a module and trigger re-evaluation if the load generation changed.
     * @param {string} name - The name of the module.
     * @param {number} generation - The generation index recorded when the load process started.
     * @returns {void}
     */
    _finishModuleLoad(name, generation) {
        this._moduleLoadsInFlight?.delete(name);

        if (this._enabled &&
            this._settings &&
            this._activeModules &&
            generation !== this._loadGeneration) {
            this._evaluateModuleStates(this._loadGeneration).catch(e => {
                logError(`Failed to re-evaluate modules after ${name} load: ${e.message}`);
            });
        }
    }

    /**
     * Formats a local module import path with an absolute file URI and a dynamic version query parameter.
     * The query parameter forces GJS to bypass dynamic ES module caching during live reload events.
     * @param {string} filename - The module filename.
     * @param {number} generation - The load generation index.
     * @returns {string} The fully formed import query URI.
     */
    _getModuleImportUri(filename, generation) {
        const modulePath = GLib.build_filenamev([this.dir.get_path(), 'modules', filename]);
        const version = `${generation}-${GLib.get_monotonic_time()}`;
        return `${GLib.filename_to_uri(modulePath, null)}?v=${version}`;
    }

    /**
     * Core state machine that asynchronously evaluates, imports, enables, or unloads
     * modules depending on active settings.
     * @async
     * @param {number} [generation=this._loadGeneration] - The load generation index.
     * @returns {Promise<void>}
     */
    async _evaluateModuleStates(generation = this._loadGeneration) {
        try {
            if (!this._canChangeModules(generation)) return;

            const deepWorkEnabled = this._settings.get_boolean('deepwork-enabled');
            const pomodoroEnabled = this._settings.get_boolean('deepwork-pomodoro-timer-enabled');
            const deepWorkModuleNeeded = deepWorkEnabled || pomodoroEnabled;
            const profilesEnabled = this._settings.get_boolean('profiles-enabled');
            const tweaksEnabled =
                this._settings.get_boolean('tweaks-battery-health-sound-enabled') ||
                this._settings.get_boolean('tweaks-essential-menu-enabled') ||
                this._settings.get_boolean('tweaks-essential-shelf-enabled') ||
                this._settings.get_boolean('tweaks-essential-uninstall-enabled');

            // --- Flagship Module: Deep Work ---
            if (deepWorkModuleNeeded) {
                if (!this._activeModules.has('deepwork') && !this._isModuleLoadInFlight('deepwork')) {
                    log('Dynamically loading Deep Work module...');
                    this._beginModuleLoad('deepwork');
                    try {
                        // Dynamic ES6 import inside GJS
                        const { default: DeepWorkModule } = await import(this._getModuleImportUri('deepwork.js', generation));
                        if (!this._canChangeModules(generation)) return;
                        
                        const instance = new DeepWorkModule(this);
                        let enabled = false;
                        try {
                            instance.enable();
                            enabled = true;
                        } catch (e) {
                            try {
                                instance.disable();
                            } catch (disableError) {
                                logError(`Failed to clean up Deep Work after enable error: ${disableError.message}`);
                            }
                            logError(`Failed to enable Deep Work module: ${e.message}`);
                        }
                        if (enabled) {
                            if (!this._canChangeModules(generation)) {
                                instance.disable();
                                return;
                            }
                            this._activeModules.set('deepwork', instance);
                            log('Deep Work module successfully enabled.');
                        }
                    } catch (e) {
                        logError(`Failed to load Deep Work module: ${e.message}`);
                    } finally {
                        this._finishModuleLoad('deepwork', generation);
                    }
                }
            } else {
                if (this._activeModules.has('deepwork')) {
                    log('Disabling and unloading Deep Work module...');
                    const instance = this._activeModules.get('deepwork');
                    instance.disable();
                    this._activeModules.delete('deepwork');
                    log('Deep Work module unloaded.');
                }
            }

            // --- Module: Workspace Profiles ---
            if (profilesEnabled) {
                if (!this._activeModules.has('profiles') && !this._isModuleLoadInFlight('profiles')) {
                    log('Dynamically loading Workspace Profiles module...');
                    this._beginModuleLoad('profiles');
                    try {
                        const { default: ProfilesModule } = await import(this._getModuleImportUri('profiles.js', generation));
                        if (!this._canChangeModules(generation)) return;
                        
                        const instance = new ProfilesModule(this);
                        let enabled = false;
                        try {
                            instance.enable();
                            enabled = true;
                        } catch (e) {
                            try {
                                instance.disable();
                            } catch (disableError) {
                                logError(`Failed to clean up Workspace Profiles after enable error: ${disableError.message}`);
                            }
                            logError(`Failed to enable Workspace Profiles module: ${e.message}`);
                        }
                        if (enabled) {
                            if (!this._canChangeModules(generation)) {
                                instance.disable();
                                return;
                            }
                            this._activeModules.set('profiles', instance);
                            log('Workspace Profiles module successfully enabled.');
                        }
                    } catch (e) {
                        logError(`Failed to load Workspace Profiles module: ${e.message}`);
                    } finally {
                        this._finishModuleLoad('profiles', generation);
                    }
                }
            } else {
                if (this._activeModules.has('profiles')) {
                    log('Disabling and unloading Workspace Profiles module...');
                    const instance = this._activeModules.get('profiles');
                    instance.disable();
                    this._activeModules.delete('profiles');
                    log('Workspace Profiles module unloaded.');
                }
            }

            // --- Module: Essential Tweaks ---
            if (tweaksEnabled) {
                if (!this._activeModules.has('tweaks') && !this._isModuleLoadInFlight('tweaks')) {
                    log('Dynamically loading Essential Tweaks module...');
                    this._beginModuleLoad('tweaks');
                    try {
                        const { default: EssentialTweaksModule } = await import(this._getModuleImportUri('tweaks.js', generation));
                        if (!this._canChangeModules(generation)) return;

                        const instance = new EssentialTweaksModule(this);
                        let enabled = false;
                        try {
                            instance.enable();
                            enabled = true;
                        } catch (e) {
                            try {
                                instance.disable();
                            } catch (disableError) {
                                logError(`Failed to clean up Essential Tweaks after enable error: ${disableError.message}`);
                            }
                            logError(`Failed to enable Essential Tweaks module: ${e.message}`);
                        }
                        if (enabled) {
                            if (!this._canChangeModules(generation)) {
                                instance.disable();
                                return;
                            }
                            this._activeModules.set('tweaks', instance);
                            log('Essential Tweaks module successfully enabled.');
                        }
                    } catch (e) {
                        logError(`Failed to load Essential Tweaks module: ${e.message}`);
                    } finally {
                        this._finishModuleLoad('tweaks', generation);
                    }
                }
            } else {
                if (this._activeModules.has('tweaks')) {
                    log('Disabling and unloading Essential Tweaks module...');
                    const instance = this._activeModules.get('tweaks');
                    instance.disable();
                    this._activeModules.delete('tweaks');
                    log('Essential Tweaks module unloaded.');
                }
            }
        } catch (e) {
            logError('Error evaluating module states: ' + e.message);
        }
    }
}
