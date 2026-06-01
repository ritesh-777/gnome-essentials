// GNOME Essentials: Essential Menu quick launcher

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const DEBUG = true;
const LAUNCHER_WIDTH = 560;
const LAUNCHER_MAX_WIDTH_RATIO = 0.58;
const LAUNCHER_TOP_RATIO = 0.16;
const RESULTS_MAX_HEIGHT_RATIO = 0.58;
const SEARCH_RESULT_LIMIT = 10;
const RESULT_ICON_SIZE = 28;
const RESULT_ICON_SLOT_SIZE = 36;
const RESULT_TEXT_COLUMN_MIN_WIDTH = 320;
const SHORTCUT_KEY = 'tweaks-essential-menu-shortcut';
const CALCULATOR_PREFIX = '=';
const WEB_SEARCH_PREFIX = '?';
const FILE_SEARCH_PREFIX = '~';
const CALCULATOR_MAX_EXPRESSION_LENGTH = 120;
const WEB_SEARCH_URI_PREFIX = 'https://duckduckgo.com/?q=';
const FILE_SEARCH_RESULT_LIMIT = 12;
const FILE_SEARCH_DEBOUNCE_MS = 180;
const FILE_SEARCH_MIN_QUERY_LENGTH = 2;
const SCROLL_KEEP_VISIBLE_MARGIN = 12;
const SCROLL_EASING = 0.12;
const SHORTCUT_REFRESH_DELAY_MS = 650;
const SHORTCUT_LATE_REFRESH_DELAY_MS = 2000;

const LAUNCHER_STYLE = [
    'background-color: rgba(24, 24, 28, 0.82)',
    'border: 1px solid rgba(255, 255, 255, 0.20)',
    'border-radius: 16px',
    'padding: 12px 12px 18px 12px',
    'color: #f6f6f6'
].join('; ');

const LAUNCHER_LIGHT_STYLE = [
    'background-color: rgba(255, 255, 255, 0.78)',
    'border: 1px solid rgba(255, 255, 255, 0.85)',
    'border-radius: 16px',
    'padding: 12px 12px 18px 12px',
    'color: #1c1c1e'
].join('; ');



const RESULT_STYLE = [
    'background-color: transparent',
    'border-radius: 10px',
    'padding: 8px 10px',
    'color: #ededed'
].join('; ');

const RESULT_SELECTED_STYLE = [
    'background-color: rgba(53, 132, 228, 0.32)',
    'border-radius: 10px',
    'padding: 8px 10px',
    'color: #ffffff'
].join('; ');

function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][EssentialMenu] ' + msg);
}

function logError(msg) {
    console.error('[GnomeEssentials][EssentialMenu] ERROR: ' + msg);
}

function normalize(text) {
    return String(text ?? '').toLowerCase();
}

function clearChildren(actor) {
    for (const child of actor.get_children()) {
        child.destroy();
    }
}

function formatCalculatorResult(value) {
    if (!Number.isFinite(value)) throw new Error('Result is not finite');
    if (Math.abs(value) < 1e-12) return '0';

    const rounded = Number.parseFloat(value.toPrecision(12));
    return String(rounded);
}

function evaluateCalculatorExpression(expression) {
    const parser = new CalculatorParser(expression);
    return formatCalculatorResult(parser.parse());
}

class CalculatorParser {
    constructor(expression) {
        this._expression = String(expression ?? '');
        this._index = 0;
    }

    parse() {
        if (!this._expression.trim()) throw new Error('Missing expression');
        if (this._expression.length > CALCULATOR_MAX_EXPRESSION_LENGTH) {
            throw new Error('Expression is too long');
        }

        const value = this._parseExpression();
        this._skipWhitespace();
        if (this._index < this._expression.length) {
            throw new Error(`Unexpected "${this._expression[this._index]}"`);
        }
        if (!Number.isFinite(value)) throw new Error('Result is not finite');
        return value;
    }

    _parseExpression() {
        return this._parseAdditive();
    }

    _parseAdditive() {
        let value = this._parseMultiplicative();

        while (true) {
            this._skipWhitespace();
            if (this._match('+')) value += this._parseMultiplicative();
            else if (this._match('-')) value -= this._parseMultiplicative();
            else return value;
        }
    }

    _parseMultiplicative() {
        let value = this._parsePower();

        while (true) {
            this._skipWhitespace();
            if (this._match('*')) {
                value *= this._parsePower();
            } else if (this._match('/')) {
                const divisor = this._parsePower();
                if (divisor === 0) throw new Error('Division by zero');
                value /= divisor;
            } else if (this._match('%')) {
                const divisor = this._parsePower();
                if (divisor === 0) throw new Error('Modulo by zero');
                value %= divisor;
            } else {
                return value;
            }
        }
    }

    _parsePower() {
        let value = this._parseUnary();
        this._skipWhitespace();
        if (this._match('^')) {
            value = Math.pow(value, this._parsePower());
        }
        return value;
    }

    _parseUnary() {
        this._skipWhitespace();
        if (this._match('+')) return this._parseUnary();
        if (this._match('-')) return -this._parseUnary();
        return this._parsePrimary();
    }

    _parsePrimary() {
        this._skipWhitespace();

        if (this._match('(')) {
            const value = this._parseExpression();
            this._skipWhitespace();
            if (!this._match(')')) throw new Error('Missing closing parenthesis');
            return value;
        }

        const identifier = this._readIdentifier();
        if (identifier) return this._parseIdentifier(identifier);

        return this._parseNumber();
    }

    _parseIdentifier(identifier) {
        if (identifier === 'pi') return Math.PI;
        if (identifier === 'e') return Math.E;

        this._skipWhitespace();
        if (!this._match('(')) throw new Error(`Unknown identifier "${identifier}"`);

        const value = this._parseExpression();
        this._skipWhitespace();
        if (!this._match(')')) throw new Error('Missing closing parenthesis');

        switch (identifier) {
            case 'abs':
                return Math.abs(value);
            case 'ceil':
                return Math.ceil(value);
            case 'cos':
                return Math.cos(value);
            case 'floor':
                return Math.floor(value);
            case 'ln':
                return Math.log(value);
            case 'log':
                return Math.log10(value);
            case 'round':
                return Math.round(value);
            case 'sin':
                return Math.sin(value);
            case 'sqrt':
                return Math.sqrt(value);
            case 'tan':
                return Math.tan(value);
            default:
                throw new Error(`Unknown function "${identifier}"`);
        }
    }

    _parseNumber() {
        this._skipWhitespace();
        const start = this._index;
        let sawDigit = false;

        while (this._isDigit(this._peek())) {
            sawDigit = true;
            this._index += 1;
        }

        if (this._peek() === '.') {
            this._index += 1;
            while (this._isDigit(this._peek())) {
                sawDigit = true;
                this._index += 1;
            }
        }

        if (!sawDigit) throw new Error('Expected number');

        if (this._peek()?.toLowerCase() === 'e') {
            const exponentStart = this._index;
            this._index += 1;
            if (this._peek() === '+' || this._peek() === '-') this._index += 1;

            let sawExponentDigit = false;
            while (this._isDigit(this._peek())) {
                sawExponentDigit = true;
                this._index += 1;
            }

            if (!sawExponentDigit) this._index = exponentStart;
        }

        const value = Number(this._expression.slice(start, this._index));
        if (!Number.isFinite(value)) throw new Error('Number is not finite');
        return value;
    }

    _readIdentifier() {
        this._skipWhitespace();
        const start = this._index;
        const first = this._peek();
        if (!first || !/[A-Za-z]/.test(first)) return '';

        this._index += 1;
        while (/[A-Za-z]/.test(this._peek() ?? '')) this._index += 1;
        return this._expression.slice(start, this._index).toLowerCase();
    }

    _match(char) {
        if (this._peek() !== char) return false;
        this._index += 1;
        return true;
    }

    _peek() {
        return this._expression[this._index];
    }

    _skipWhitespace() {
        while (/\s/.test(this._peek() ?? '')) this._index += 1;
    }

    _isDigit(char) {
        return char >= '0' && char <= '9';
    }
}

/**
 * EssentialMenu class.
 * Centered Quick Launcher Menu module for GNOME Essentials.
 * Renders a highly tactile centered floating entry overlay on the screen,
 * supporting fuzzy application search, filesystem indexing, backdrop screen dimming,
 * and a fully integrated fast calculator parser.
 */
export default class EssentialMenu {
    /**
     * Constructs the EssentialMenu instance.
     * @param {Gio.Settings} settings - The GSettings manager object.
     */
    constructor(settings) {
        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();
        this._indicator = null;
        this._indicatorMenuOpenId = 0;
        this._panelClickConnections = [];
        this._launcher = null;
        this._searchEntry = null;
        this._resultsScrollView = null;
        this._resultsBox = null;
        this._appRecords = [];
        this._favoriteIds = [];
        this._desktopIconCache = new Map();
        this._visibleRecords = [];
        this._resultButtons = [];
        this._buttonPool = [];
        this._sectionSeparator = null;
        this._selectedIndex = 0;
        this._isOpen = false;
        this._settingsHandlers = [];
        this._appSystemChangedId = 0;
        this._favoritesChangedId = 0;
        this._monitorsChangedId = 0;
        this._focusWindowChangedId = 0;
        this._stageKeyFocusChangedId = 0;
        this._stageCapturedEventId = 0;
        this._sessionModeUpdatedId = 0;
        this._focusIdleId = 0;
        this._shortcutRegistered = false;
        this._shortcutRefreshTimeoutId = 0;
        this._shortcutLateRefreshTimeoutId = 0;
        this._fileSearchTimeoutId = 0;
        this._fileSearchGeneration = 0;
        this._fileSearchProcess = null;
        this._fileSearchCancellable = null;
        this._scrollTargetValue = 0;
        this._scrollTimeline = null;
        this._themeSyncTimerId = 0;
        this._scrollIdleId = 0;
        this._isAnimatingOpen = false;
    }

    /**
     * Enables the Essential Menu, binding key-press shortcuts, pre-warming launcher layouts,
     * loading settings, and caching desktop icons.
     * @returns {void}
     */
    enable() {
        this._connectSettings();
        this._connectAppSignals();
        this._rebuildAppIndex();
        this._syncPanelIcon();

        // Eagerly pre-create and warm up the launcher layout in the background
        try {
            this._ensureLauncher();
            this._renderResults('');
        } catch (e) {
            logError('Failed to pre-warm launcher layout: ' + e.message);
        }

        this._syncShortcut();
    }

    /**
     * Disables the menu, hiding indicators, removing hotkeys, and destroying overlay elements.
     * @returns {void}
     */
    disable() {
        this.close(true);
        this._cancelShortcutRefresh();
        this._unregisterShortcut();
        this._destroyLauncher();
        this._destroyPanelIcon();
        this._disconnectAppSignals();
        this._disconnectSettings();
        this._settings = null;
    }

    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    }

    open() {
        if (this._isOpen) return;

        try {
            // Check for theme change and recreate launcher if necessary
            try {
                const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                const isDark = interfaceSettings.get_string('color-scheme') === 'prefer-dark';
                if (this._launcher && this._isDark !== isDark) {
                    this._destroyLauncher();
                }
            } catch (themeErr) {
                // Keep current theme settings
            }

            if (this._appRecords.length === 0) {
                this._rebuildAppIndex();
            }
            this._ensureLauncher();
            this._positionLauncher();
            this._setSearchText('');
            this._renderResults('');
        } catch (e) {
            logError('Failed to prepare quick launcher: ' + e.message);
            return;
        }

        this._isOpen = true;

        if (this._themeSyncTimerId > 0) {
            try {
                GLib.source_remove(this._themeSyncTimerId);
            } catch (e) {}
            this._themeSyncTimerId = 0;
        }
        this._themeSyncTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._isOpen) {
                if (this._blurBackground) this._blurBackground.queue_redraw();
                if (this._blurTopTape) this._blurTopTape.queue_redraw();
                if (this._blurBottomTape) this._blurBottomTape.queue_redraw();
                return GLib.SOURCE_CONTINUE;
            }
            this._themeSyncTimerId = 0;
            return GLib.SOURCE_REMOVE;
        });

        if (this._blurBackground) {
            this._blurBackground.show();
            this._blurBackground.opacity = 255;
            this._blurBackground.remove_all_transitions();
        }
        if (this._blurTopTape) {
            this._blurTopTape.show();
            this._blurTopTape.opacity = 255;
            this._blurTopTape.remove_all_transitions();
        }
        if (this._blurBottomTape) {
            this._blurBottomTape.show();
            this._blurBottomTape.opacity = 255;
            this._blurBottomTape.remove_all_transitions();
        }
        this._launcher.show();
        this._updateResultsHeight();
        this._launcher.remove_all_transitions();

        const dimEnabled = this._settings?.get_boolean('tweaks-essential-menu-backdrop-dim-enabled') ?? true;

        if (this._scrim) {
            if (dimEnabled) {
                this._scrim.show();
                this._scrim.remove_all_transitions();
            } else {
                this._scrim.hide();
            }
        }

        this._raiseActor(this._scrim);
        if (this._blurBackground) {
            this._raiseActor(this._blurBackground);
        }
        if (this._blurTopTape) {
            this._raiseActor(this._blurTopTape);
        }
        if (this._blurBottomTape) {
            this._raiseActor(this._blurBottomTape);
        }
        this._raiseActor(this._launcher);
        if (global.gnome_essentials_deepwork && typeof global.gnome_essentials_deepwork._queueFloatingPomodoroRaise === 'function') {
            global.gnome_essentials_deepwork._queueFloatingPomodoroRaise();
        }
        this._connectStageCapture();
        this._scheduleSearchFocus();

        const [x, targetY] = this._launcher.get_position();
        const animEnabled = this._settings?.get_boolean('tweaks-essential-menu-animations-enabled') ?? true;

        if (!animEnabled) {
            this._isAnimatingOpen = false;
            this._launcher.opacity = 255;
            this._launcher.scale_x = 1.0;
            this._launcher.scale_y = 1.0;
            this._launcher.set_position(x, targetY);
            if (this._blurBackground) {
                this._blurBackground.opacity = 255;
                this._blurBackground.scale_x = 1.0;
                this._blurBackground.scale_y = 1.0;
            }
            if (this._scrim) {
                if (dimEnabled) {
                    this._scrim.opacity = 255;
                } else {
                    this._scrim.opacity = 0;
                }
            }
        } else {
            this._isAnimatingOpen = true;
            this._launcher.opacity = 0;
            this._launcher.scale_x = 0.94;
            this._launcher.scale_y = 0.94;
            this._launcher.set_position(x, targetY - 16);
            this._launcher.set_pivot_point(0.5, 0.0);

            this._launcher.ease({
                opacity: 255,
                y: targetY,
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => {
                    this._isAnimatingOpen = false;
                    this._resetResultsScroll();
                }
            });

            if (this._blurBackground) {
                this._blurBackground.opacity = 255;
                this._blurBackground.scale_x = 1.0;
                this._blurBackground.scale_y = 1.0;
            }

            if (this._scrim) {
                if (dimEnabled) {
                    this._scrim.opacity = 0;
                    this._scrim.ease({
                        opacity: 255,
                        duration: 200,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                    });
                } else {
                    this._scrim.opacity = 0;
                }
            }
        }

        log(`Opened quick launcher with ${this._visibleRecords.length} visible results`);
    }

    close(immediate = false) {
        if (!this._isOpen && !immediate) return;
        if (!this._launcher) return;

        this._isOpen = false;
        if (this._themeSyncTimerId > 0) {
            try {
                GLib.source_remove(this._themeSyncTimerId);
            } catch (e) {}
            this._themeSyncTimerId = 0;
        }
        this._stableResultsHeight = 0;
        this._isAnimatingOpen = false;
        this._disconnectStageCapture();
        this._cancelSearchFocus();
        this._cancelFileSearch();
        this._cancelScrollAnimation();
        this._cancelScrollIdle();
        this._launcher.remove_all_transitions();

        if (this._blurBackground) {
            this._blurBackground.remove_all_transitions();
        }

        if (this._scrim) {
            this._scrim.remove_all_transitions();
        }

        if (this._buttonPool) {
            this._buttonPool.forEach(b => { b._currentRecordId = null; });
        }

        const animEnabled = this._settings?.get_boolean('tweaks-essential-menu-animations-enabled') ?? true;
        const dimEnabled = this._settings?.get_boolean('tweaks-essential-menu-backdrop-dim-enabled') ?? true;

        if (immediate || !animEnabled) {
            this._launcher.hide();
            this._launcher.opacity = 0;
            if (this._blurBackground) {
                this._blurBackground.hide();
                this._blurBackground.opacity = 0;
            }
            if (this._blurTopTape) {
                this._blurTopTape.hide();
                this._blurTopTape.opacity = 0;
            }
            if (this._blurBottomTape) {
                this._blurBottomTape.hide();
                this._blurBottomTape.opacity = 0;
            }
            if (this._scrim) {
                this._scrim.hide();
                this._scrim.opacity = 0;
            }
            return;
        }

        const [x, currentY] = this._launcher.get_position();
        this._launcher.ease({
            opacity: 0,
            y: currentY - 12,
            scale_x: 0.95,
            scale_y: 0.95,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._isOpen && this._launcher) {
                    this._launcher.hide();
                }
            }
        });

        if (this._blurBackground) {
            this._blurBackground.hide();
            this._blurBackground.opacity = 0;
            this._blurBackground.scale_x = 1.0;
            this._blurBackground.scale_y = 1.0;
        }
        if (this._blurTopTape) {
            this._blurTopTape.hide();
            this._blurTopTape.opacity = 0;
        }
        if (this._blurBottomTape) {
            this._blurBottomTape.hide();
            this._blurBottomTape.opacity = 0;
        }

        if (this._scrim) {
            if (dimEnabled) {
                this._scrim.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (!this._isOpen && this._scrim) {
                            this._scrim.hide();
                        }
                    }
                });
            } else {
                this._scrim.hide();
                this._scrim.opacity = 0;
            }
        }
    }

    _connectSettings() {
        this._disconnectSettings();

        const bindKey = (key, callback) => {
            const id = this._settings.connect('changed::' + key, callback);
            this._settingsHandlers.push(id);
        };

        bindKey('tweaks-essential-menu-show-panel-icon', () => this._syncPanelIcon());
        bindKey('tweaks-essential-menu-shortcut-enabled', () => this._syncShortcut());
        bindKey(SHORTCUT_KEY, () => this._syncShortcut());
        bindKey('tweaks-essential-menu-trigger', () => this._openFromTrigger());
    }

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

    _connectAppSignals() {
        this._disconnectAppSignals();

        try {
            this._appSystemChangedId = this._appSystem.connect('installed-changed', () => {
                this._rebuildAppIndex();
                if (this._isOpen) this._renderResults(this._getSearchText());
            });
        } catch (e) {
            this._appSystemChangedId = 0;
        }

        try {
            this._favoritesChangedId = global.settings.connect('changed::favorite-apps', () => {
                this._rebuildAppIndex();
                if (this._isOpen) this._renderResults(this._getSearchText());
            });
        } catch (e) {
            this._favoritesChangedId = 0;
        }

        try {
            this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
                if (this._isOpen) this._positionLauncher();
            });
        } catch (e) {
            this._monitorsChangedId = 0;
        }

        try {
            this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
                if (this._isOpen) this.close();
            });
        } catch (e) {
            this._focusWindowChangedId = 0;
        }

        try {
            this._stageKeyFocusChangedId = global.stage.connect('notify::key-focus', () => {
                if (!this._isOpen) return;

                const focusActor = this._getStageKeyFocus();
                if (!focusActor ||
                    (!this._isActorOrDescendant(focusActor, this._launcher) &&
                     !this._isActorOrDescendant(focusActor, this._indicator))) {
                    this.close();
                }
            });
        } catch (e) {
            this._stageKeyFocusChangedId = 0;
        }

        try {
            this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
                this._handleSessionModeUpdated();
            });
        } catch (e) {
            this._sessionModeUpdatedId = 0;
        }
    }

    _disconnectAppSignals() {
        if (this._appSystemChangedId > 0) {
            try {
                this._appSystem.disconnect(this._appSystemChangedId);
            } catch (e) {
                // App system may already be gone.
            }
            this._appSystemChangedId = 0;
        }

        if (this._favoritesChangedId > 0) {
            try {
                global.settings.disconnect(this._favoritesChangedId);
            } catch (e) {
                // Global settings may already be gone.
            }
            this._favoritesChangedId = 0;
        }

        if (this._monitorsChangedId > 0) {
            try {
                Main.layoutManager.disconnect(this._monitorsChangedId);
            } catch (e) {
                // Layout manager may already be gone.
            }
            this._monitorsChangedId = 0;
        }

        if (this._focusWindowChangedId > 0) {
            try {
                global.display.disconnect(this._focusWindowChangedId);
            } catch (e) {
                // Display may already be gone.
            }
            this._focusWindowChangedId = 0;
        }

        if (this._stageKeyFocusChangedId > 0) {
            try {
                global.stage.disconnect(this._stageKeyFocusChangedId);
            } catch (e) {
                // Stage may already be gone during Shell teardown.
            }
            this._stageKeyFocusChangedId = 0;
        }

        if (this._sessionModeUpdatedId > 0) {
            try {
                Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            } catch (e) {
                // Session mode may already be gone during Shell teardown.
            }
            this._sessionModeUpdatedId = 0;
        }
    }

    _syncPanelIcon() {
        const showIcon = this._settings?.get_boolean('tweaks-essential-menu-show-panel-icon') ?? true;

        if (showIcon) this._ensurePanelIcon();
        else {
            this.close(true);
            this._destroyPanelIcon();
        }
    }

    _openFromTrigger() {
        if (!this._settings?.get_boolean('tweaks-essential-menu-enabled')) return;

        log('Open requested from settings trigger');
        this.open();
    }

    _syncShortcut() {
        const enabled = this._settings?.get_boolean('tweaks-essential-menu-shortcut-enabled') ?? false;

        if (enabled) this._scheduleShortcutRefresh(0);
        else {
            this._cancelShortcutRefresh();
            this._unregisterShortcut();
        }
    }

    _registerShortcut() {
        if (this._shortcutRegistered || !this._settings) return;

        try {
            const actionMode = Shell.ActionMode.ALL ??
                (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
            Main.wm.addKeybinding(
                SHORTCUT_KEY,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                actionMode,
                () => {
                    if (this._canOpenFromShortcut()) this.toggle();
                }
            );
            this._shortcutRegistered = true;
            log('Registered Super+Space quick launcher shortcut');
        } catch (e) {
            this._shortcutRegistered = false;
            logError('Failed to register quick launcher shortcut: ' + e.message);
        }
    }

    _unregisterShortcut() {
        if (!this._shortcutRegistered) return;

        try {
            Main.wm.removeKeybinding(SHORTCUT_KEY);
        } catch (e) {
            logError('Failed to unregister quick launcher shortcut: ' + e.message);
        }
        this._shortcutRegistered = false;
    }

    _refreshShortcut() {
        if (!this._settings?.get_boolean('tweaks-essential-menu-shortcut-enabled')) {
            this._unregisterShortcut();
            return;
        }

        if (this._isSessionLocked()) {
            this.close(true);
            this._unregisterShortcut();
            return;
        }

        this._unregisterShortcut();
        this._registerShortcut();
    }

    _scheduleShortcutRefresh(delayMs = SHORTCUT_REFRESH_DELAY_MS, includeLateRetry = false) {
        this._cancelShortcutRefresh();

        this._shortcutRefreshTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(0, delayMs),
            () => {
                this._shortcutRefreshTimeoutId = 0;
                this._refreshShortcut();
                return GLib.SOURCE_REMOVE;
            }
        );

        if (includeLateRetry) {
            this._shortcutLateRefreshTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                SHORTCUT_LATE_REFRESH_DELAY_MS,
                () => {
                    this._shortcutLateRefreshTimeoutId = 0;
                    this._refreshShortcut();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _cancelShortcutRefresh() {
        if (this._shortcutRefreshTimeoutId > 0) {
            GLib.source_remove(this._shortcutRefreshTimeoutId);
            this._shortcutRefreshTimeoutId = 0;
        }

        if (this._shortcutLateRefreshTimeoutId > 0) {
            GLib.source_remove(this._shortcutLateRefreshTimeoutId);
            this._shortcutLateRefreshTimeoutId = 0;
        }
    }

    _handleSessionModeUpdated() {
        if (this._isSessionLocked()) {
            this.close(true);
            this._cancelShortcutRefresh();
            this._unregisterShortcut();
            return;
        }

        this._rebuildAppIndex();

        // Eagerly pre-warm after unlock to ensure first-open is instant!
        try {
            this._ensureLauncher();
            this._renderResults('');
        } catch (e) {}

        this._scheduleShortcutRefresh(SHORTCUT_REFRESH_DELAY_MS, true);
    }

    _canOpenFromShortcut() {
        return this._settings?.get_boolean('tweaks-essential-menu-enabled') &&
            this._settings?.get_boolean('tweaks-essential-menu-shortcut-enabled') &&
            !this._isSessionLocked();
    }

    _isSessionLocked() {
        try {
            const mode = Main.sessionMode;
            return mode?.isLocked ||
                mode?.currentMode === 'lock-screen' ||
                mode?.currentMode === 'unlock-dialog';
        } catch (e) {
            return false;
        }
    }

    _ensurePanelIcon() {
        if (this._indicator) return;

        this._indicator = new PanelMenu.Button(0.0, 'Essentials Quick Launcher', false);
        const box = new St.BoxLayout({
            reactive: true,
            track_hover: true,
            can_focus: true,
            style_class: 'panel-status-menu-box'
        });
        box.add_child(new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            style_class: 'system-status-icon'
        }));
        this._indicator.add_child(box);
        this._connectPanelClickActor(this._indicator, 'indicator');
        this._connectPanelClickActor(this._indicator.container, 'container');
        this._connectPanelClickActor(box, 'icon-box');

        this._indicatorMenuOpenId = this._indicator.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen) return;

            log('Panel menu open-state requested quick launcher');
            this._indicator.menu.close();
            this.toggle();
        });

        Main.panel.addToStatusArea('gnome-essential-menu', this._indicator, 1, 'left');
        log('Panel icon added');
    }

    _destroyPanelIcon() {
        if (!this._indicator) return;

        try {
            for (const [actor, id] of this._panelClickConnections) {
                try {
                    actor.disconnect(id);
                } catch (e) {
                    // Actor may already be gone with the indicator.
                }
            }
            this._panelClickConnections = [];

            if (this._indicatorMenuOpenId > 0) {
                this._indicator.menu.disconnect(this._indicatorMenuOpenId);
            }
            this._indicator.destroy();
        } catch (e) {
            // Indicator may already be gone during Shell teardown.
        }
        this._indicator = null;
        this._indicatorMenuOpenId = 0;
    }

    _connectPanelClickActor(actor, label) {
        if (!actor || typeof actor.connect !== 'function') return;

        const pressId = actor.connect('button-press-event', () => {
            log(`Panel ${label} press requested quick launcher`);
            this.toggle();
            return Clutter.EVENT_STOP;
        });
        const releaseId = actor.connect('button-release-event', () => {
            return Clutter.EVENT_STOP;
        });
        const touchId = actor.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                log(`Panel ${label} touch requested quick launcher`);
                this.toggle();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this._panelClickConnections.push([actor, pressId], [actor, releaseId], [actor, touchId]);
    }

    _ensureLauncher() {
        if (this._launcher) return;

        try {
            const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._isDark = interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        } catch (e) {
            this._isDark = true;
        }

        this._scrim = new St.Widget({
            reactive: true,
            visible: false,
            opacity: 0,
            style: 'background-color: rgba(0, 0, 0, 0.28)'
        });

        this._scrim.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._scrim.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.uiGroup.add_child(this._scrim);

        this._blurBackground = new St.Widget({
            style_class: 'essential-menu-blur-background',
            reactive: false,
            visible: false,
            opacity: 0,
            style: 'background-color: transparent; border: none; border-radius: 16px; margin: 16px 0px;'
        });

        this._blurTopTape = new St.Widget({
            style_class: 'essential-menu-blur-background',
            reactive: false,
            visible: false,
            opacity: 0,
            style: 'background-color: transparent; border: none; border-radius: 0px;'
        });

        this._blurBottomTape = new St.Widget({
            style_class: 'essential-menu-blur-background',
            reactive: false,
            visible: false,
            opacity: 0,
            style: 'background-color: transparent; border: none; border-radius: 0px;'
        });

        // Add a beautiful native background blur effect (glassmorphism)
        try {
            const blurEffect = new Shell.BlurEffect({
                brightness: this._isDark ? 0.90 : 1.0,
                radius: 36,
                mode: Shell.BlurMode.BACKGROUND
            });
            this._blurBackground.add_effect(blurEffect);

            const blurEffectTop = new Shell.BlurEffect({
                brightness: this._isDark ? 0.90 : 1.0,
                radius: 36,
                mode: Shell.BlurMode.BACKGROUND
            });
            this._blurTopTape.add_effect(blurEffectTop);

            const blurEffectBottom = new Shell.BlurEffect({
                brightness: this._isDark ? 0.90 : 1.0,
                radius: 36,
                mode: Shell.BlurMode.BACKGROUND
            });
            this._blurBottomTape.add_effect(blurEffectBottom);
        } catch (blurErr) {
            // Fallback if blur effect fails
        }

        Main.layoutManager.uiGroup.add_child(this._blurBackground);
        Main.layoutManager.uiGroup.add_child(this._blurTopTape);
        Main.layoutManager.uiGroup.add_child(this._blurBottomTape);

        this._launcher = new St.BoxLayout({
            style_class: 'essential-menu-launcher',
            vertical: true,
            reactive: true,
            visible: false,
            opacity: 0,
            style: this._isDark ? LAUNCHER_STYLE : LAUNCHER_LIGHT_STYLE
        });

        // Bind the blur background to dynamically track the launcher's size and position
        this._blurBackground.add_constraint(new Clutter.BindConstraint({
            source: this._launcher,
            coordinate: Clutter.BindCoordinate.ALL
        }));

        this._launcher.connect('notify::x', () => this._updateBlurTapes());
        this._launcher.connect('notify::y', () => this._updateBlurTapes());
        this._launcher.connect('notify::width', () => this._updateBlurTapes());
        this._launcher.connect('notify::height', () => this._updateBlurTapes());

        if (!this._isDark) {
            this._launcher.add_style_class_name('essential-menu-light');
            this._blurBackground.add_style_class_name('essential-menu-light');
            this._blurTopTape.add_style_class_name('essential-menu-light');
            this._blurBottomTape.add_style_class_name('essential-menu-light');
        }

        this._buildLauncherChrome();
        Main.layoutManager.uiGroup.add_child(this._launcher);
    }

    _destroyLauncher() {
        if (!this._launcher) return;

        this._disconnectStageCapture();
        this._cancelSearchFocus();
        this._cancelFileSearch();
        this._cancelScrollAnimation();
        this._cancelScrollIdle();

        if (this._themeSyncTimerId > 0) {
            try {
                GLib.source_remove(this._themeSyncTimerId);
            } catch (e) {}
            this._themeSyncTimerId = 0;
        }
        this._stableResultsHeight = 0;

        if (this._scrim) {
            try {
                this._scrim.destroy();
            } catch (e) {}
            this._scrim = null;
        }

        if (this._blurBackground) {
            try {
                this._blurBackground.destroy();
            } catch (e) {}
            this._blurBackground = null;
        }

        if (this._blurTopTape) {
            try {
                this._blurTopTape.destroy();
            } catch (e) {}
            this._blurTopTape = null;
        }

        if (this._blurBottomTape) {
            try {
                this._blurBottomTape.destroy();
            } catch (e) {}
            this._blurBottomTape = null;
        }

        try {
            this._launcher.destroy();
        } catch (e) {
            // Launcher may already be gone.
        }

        this._launcher = null;
        this._searchEntry = null;
        this._resultsScrollView = null;
        this._resultsBox = null;
        this._visibleRecords = [];
        this._resultButtons = [];
        this._buttonPool = [];
        this._sectionSeparator = null;
        this._topSpacer = null;
        this._blurTopTape = null;
        this._blurBottomTape = null;
    }

    _buildLauncherChrome() {
        const searchRow = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 8px; margin-bottom: 10px'
        });

        this._searchEntry = new St.Entry({
            style_class: 'essential-menu-search-entry',
            hint_text: 'Search applications',
            can_focus: true,
            track_hover: true,
            x_expand: true
        });
        try {
            this._searchEntry.set_primary_icon(new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: 18,
                style: `color: ${this._isDark ? 'rgba(255, 255, 255, 0.74)' : 'rgba(0, 0, 0, 0.64)'}`
            }));
        } catch (e) {
            // Primary icon support differs between Shell versions.
        }
        this._searchEntry.clutter_text.connect('text-changed', () => {
            if (this._blurBackground) {
                this._blurBackground.queue_redraw();
            }
            this._renderResults(this._getSearchText());
        });
        this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            return this._handleSearchKeyPress(event);
        });
        searchRow.add_child(this._searchEntry);
        this._launcher.add_child(searchRow);

        this._resultsScrollView = new St.ScrollView({
            reactive: true,
            overlay_scrollbars: true,
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER
        });
        try {
            this._resultsScrollView.set_mouse_scrolling(true);
        } catch (e) {
            // Mouse scrolling is enabled by default on some Shell versions.
        }
        this._resultsScrollView.connect('scroll-event', (_actor, event) => {
            return this._handleResultsScrollEvent(event);
        });
        this._launcher.connect('scroll-event', (_actor, event) => {
            return this._handleResultsScrollEvent(event);
        });
        this._resultsBox = new St.BoxLayout({
            style_class: 'essential-menu-results-box',
            vertical: true,
            x_expand: true
        });
        this._setScrollViewChild(this._resultsScrollView, this._resultsBox);
        this._launcher.add_child(this._resultsScrollView);

        // Create top spacer to protect top selection from clipping during vertical translation/scaling transitions
        this._topSpacer = new St.Widget({
            height: 10,
            visible: false,
            style: 'min-height: 10px; height: 10px; background-color: transparent;'
        });
        this._resultsBox.add_child(this._topSpacer);

        // Force a full redraw of the background blur during scrolling to bypass compositor cropped-redraw glitches
        try {
            const adj = this._resultsScrollView.get_vadjustment();
            if (adj) {
                adj.connect('notify::value', () => {
                    if (this._blurBackground) {
                        this._blurBackground.queue_redraw();
                    }
                });
            }
        } catch (e) {
            // Best effort
        }

        // Pre-create the button pool and the section separator
        this._buttonPool = [];
        const initialSize = Math.max(16, this._appRecords.length);
        for (let i = 0; i < initialSize; i++) {
            this._buttonPool.push(this._createPoolButton(i));
        }
        this._sectionSeparator = this._createSectionSeparator('All apps');
        this._sectionSeparator.visible = false;
        this._resultsBox.add_child(this._sectionSeparator);

        this._infoLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
            style: `font-size: 13px; color: ${this._isDark ? 'rgba(255, 255, 255, 0.62)' : 'rgba(0, 0, 0, 0.54)'}; padding: 18px 4px`
        });
        this._resultsBox.add_child(this._infoLabel);

        // Add the footer badges for tips
        const helpRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: `spacing: 16px; padding-top: 8px; border-top: 1px solid ${this._isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)'}; margin-top: 6px`
        });

        const createHelpBadge = (prefix, labelText) => {
            const badgeBox = new St.BoxLayout({
                vertical: false,
                style: this._isDark
                    ? 'spacing: 6px; padding: 2px 8px; background-color: rgba(255, 255, 255, 0.06); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08)'
                    : 'spacing: 6px; padding: 2px 8px; background-color: rgba(0, 0, 0, 0.04); border-radius: 6px; border: 1px solid rgba(0, 0, 0, 0.06)'
            });
            const prefixLabel = new St.Label({
                text: prefix,
                style: 'font-weight: bold; color: #3584e4; font-size: 11px'
            });
            const textLabel = new St.Label({
                text: labelText,
                style: `color: ${this._isDark ? 'rgba(255, 255, 255, 0.64)' : 'rgba(0, 0, 0, 0.58)'}; font-size: 11px`
            });
            badgeBox.add_child(prefixLabel);
            badgeBox.add_child(textLabel);
            return badgeBox;
        };

        helpRow.add_child(createHelpBadge(' = ', 'Calculator'));
        helpRow.add_child(createHelpBadge(' ? ', 'Web Search'));
        helpRow.add_child(createHelpBadge(' ~ ', 'File Search'));
        this._launcher.add_child(helpRow);
    }

    _setScrollViewChild(scrollView, child) {
        if (typeof scrollView.set_child === 'function') {
            scrollView.set_child(child);
        } else if (typeof scrollView.add_actor === 'function') {
            scrollView.add_actor(child);
        } else {
            scrollView.add_child(child);
        }
    }

    _positionLauncher() {
        if (!this._launcher) return;

        const monitor = this._getTargetMonitor();
        const width = Math.max(
            420,
            Math.min(LAUNCHER_WIDTH, Math.floor(monitor.width * LAUNCHER_MAX_WIDTH_RATIO))
        );
        const x = Math.floor(monitor.x + (monitor.width - width) / 2);
        const y = Math.floor(monitor.y + Math.max(72, monitor.height * LAUNCHER_TOP_RATIO));

        this._launcher.set_width(width);
        this._launcher.set_position(x, y);

        if (this._scrim) {
            this._scrim.set_position(monitor.x, monitor.y);
            this._scrim.set_size(monitor.width, monitor.height);
        }

        this._updateResultsHeight();
    }

    _updateResultsHeight() {
        if (!this._resultsScrollView || !this._resultsBox) return;

        if (this._topSpacer) {
            this._topSpacer.visible = (this._visibleRecords.length > 0);
        }

        if (this._visibleRecords.length <= 1) {
            const adjustment = this._getResultsVAdjustment();
            if (adjustment) {
                adjustment.set_value(0);
            }
            this._scrollTargetValue = 0;
        }

        try {
            const monitor = this._getTargetMonitor();
            const maxResultsHeight = Math.max(260, Math.floor(monitor.height * RESULTS_MAX_HEIGHT_RATIO));
            
            // Query the natural preferred height of the results box in real-time
            let [, naturalHeight] = this._resultsBox.get_preferred_height(-1);
            if (naturalHeight <= 0 && this._visibleRecords.length > 0) {
                naturalHeight = this._visibleRecords.length * 48;
            }
            
            // Set the scroll view height dynamically to fit the contents perfectly
            const targetHeight = Math.min(maxResultsHeight, naturalHeight);
            this._resultsScrollView.set_height(targetHeight);
        } catch (e) {
            logError(`Failed to update results height: ${e.message}`);
        }

        // Force a full background repaint
        if (this._blurBackground) this._blurBackground.queue_redraw();
        if (this._blurTopTape) this._blurTopTape.queue_redraw();
        if (this._blurBottomTape) this._blurBottomTape.queue_redraw();
    }

    _updateBlurTapes() {
        if (!this._launcher || !this._blurTopTape || !this._blurBottomTape) return;

        const [x, y] = this._launcher.get_position();
        const [width, height] = this._launcher.get_size();

        // Top tape: width = width - 32 (16px margins), height = 16, x = x + 16, y = y
        this._blurTopTape.set_position(x + 16, y);
        this._blurTopTape.set_size(Math.max(0, width - 32), 16);

        // Bottom tape: width = width - 32 (16px margins), height = 16, x = x + 16, y = y + height - 16
        this._blurBottomTape.set_position(x + 16, y + height - 16);
        this._blurBottomTape.set_size(Math.max(0, width - 32), 16);
    }

    _getTargetMonitor() {
        try {
            const focusWindow = global.display.focus_window;
            const monitorIndex = focusWindow?.get_monitor?.();
            if (monitorIndex !== undefined && Main.layoutManager.monitors[monitorIndex]) {
                return Main.layoutManager.monitors[monitorIndex];
            }
        } catch (e) {
            // Fall through to pointer/primary monitor.
        }

        try {
            const [x, y] = global.get_pointer();
            for (const monitor of Main.layoutManager.monitors) {
                if (x >= monitor.x &&
                    x < monitor.x + monitor.width &&
                    y >= monitor.y &&
                    y < monitor.y + monitor.height) {
                    return monitor;
                }
            }
        } catch (e) {
            // Fall through to primary monitor.
        }

        return Main.layoutManager.primaryMonitor;
    }

    _rebuildAppIndex() {
        const records = [];
        const seen = new Set();
        this._favoriteIds = this._getFavoriteIds();

        try {
            for (const installedApp of this._appSystem.get_installed()) {
                const id = installedApp.get_id?.();
                if (!id || seen.has(id)) continue;

                const app = this._resolveShellApp(installedApp, id);
                if (!app || !this._shouldShowApp(app)) continue;

                seen.add(id);

                const name = app.get_name() ?? id;
                const description = this._getAppDescription(app);
                const keywords = this._getAppKeywords(app);
                const iconName = this._getAppIconName(app, id);
                records.push({
                    app,
                    id,
                    name,
                    description,
                    iconName,
                    favorite: this._favoriteIds.includes(id),
                    haystack: normalize([
                        name,
                        description,
                        id,
                        ...keywords
                    ].join(' '))
                });
            }
        } catch (e) {
            logError('Failed to rebuild app index: ' + e.message);
        }

        records.sort((a, b) => {
            if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        this._appRecords = records;
        log(`Indexed ${records.length} launchable apps`);
    }

    _resolveShellApp(installedApp, id) {
        try {
            const app = this._appSystem.lookup_app(id);
            if (app) return app;
        } catch (e) {
            // Fall back below.
        }

        try {
            const appInfo = installedApp.get_app_info?.() ?? installedApp;
            if (appInfo) return new Shell.App({ app_info: appInfo });
        } catch (e) {
            logError(`Failed to create Shell.App for ${id}: ${e.message}`);
        }

        return null;
    }

    _getFavoriteIds() {
        try {
            return global.settings.get_strv('favorite-apps');
        } catch (e) {
            return [];
        }
    }

    _shouldShowApp(app) {
        try {
            const appInfo = app.get_app_info?.();
            return !appInfo || appInfo.should_show();
        } catch (e) {
            return true;
        }
    }

    _getAppDescription(app) {
        try {
            return app.get_description?.() ?? app.get_app_info?.()?.get_description?.() ?? '';
        } catch (e) {
            return '';
        }
    }

    _getAppKeywords(app) {
        try {
            return app.get_app_info?.()?.get_keywords?.() ?? [];
        } catch (e) {
            return [];
        }
    }

    _renderResults(query) {
        if (!this._resultsBox) return;

        const rawQuery = String(query ?? '').trim();
        const normalizedQuery = normalize(rawQuery).trim();
        this._cancelFileSearch();
        this._resetResultsScroll();
        
        // Hide all pooled elements
        if (this._buttonPool) {
            this._buttonPool.forEach(b => { b.visible = false; });
        }
        if (this._sectionSeparator) {
            this._sectionSeparator.visible = false;
        }
        if (this._infoLabel) {
            this._infoLabel.visible = false;
        }
        
        this._resultButtons = [];
        this._visibleRecords = [];
        this._selectedIndex = 0;

        if (rawQuery.startsWith(CALCULATOR_PREFIX)) {
            this._renderCalculatorResult(rawQuery.slice(CALCULATOR_PREFIX.length).trim());
            return;
        }

        if (rawQuery.startsWith(WEB_SEARCH_PREFIX)) {
            this._renderWebSearchResult(rawQuery.slice(WEB_SEARCH_PREFIX.length).trim());
            return;
        }

        if (rawQuery.startsWith(FILE_SEARCH_PREFIX)) {
            this._renderFileSearchResult(rawQuery.slice(FILE_SEARCH_PREFIX.length).trim());
            return;
        }

        if (normalizedQuery) {
            const results = this._searchAppRecords(normalizedQuery).slice(0, SEARCH_RESULT_LIMIT);
            
            log(`[GnomeEssentials] Search query: "${normalizedQuery}", results length: ${results.length}`);
            results.forEach((r, idx) => {
                log(`[GnomeEssentials]   Result ${idx}: "${r.name}" (${r.id})`);
            });

            if (results.length === 0) {
                this._showInfoLabel('No matching applications');
                this._updateResultsHeight();
                return;
            }

            let poolIndex = 0;
            for (const record of results) {
                this._populatePoolButton(poolIndex, record);
                poolIndex++;
            }
            this._updateSelection();
            this._updateResultsHeight();

            log(`[GnomeEssentials] _resultsBox visible children count: ${this._resultsBox.get_children().filter(c => c.visible).length}`);
            this._resultsBox.get_children().forEach((c, idx) => {
                if (c.visible) {
                    log(`[GnomeEssentials]   Visible Child ${idx}: margin_top=${c.margin_top}, height=${c.height}, y=${c.get_position()[1]}`);
                }
            });
            return;
        }

        const { favorites, remaining } = this._getDefaultSections();
        if (favorites.length === 0 && remaining.length === 0) {
            this._showInfoLabel('Start typing to search applications');
            this._updateResultsHeight();
            return;
        }

        let poolIndex = 0;
        for (const record of favorites) {
            this._populatePoolButton(poolIndex, record);
            poolIndex++;
        }

        const showSeparator = (favorites.length > 0 && remaining.length > 0);
        if (this._sectionSeparator) {
            this._sectionSeparator.visible = showSeparator;
            if (showSeparator) {
                this._setSeparatorIndex(favorites.length);
            }
        }

        for (const record of remaining) {
            this._populatePoolButton(poolIndex, record);
            poolIndex++;
        }

        this._updateSelection();
        this._updateResultsHeight();
    }

    _renderCalculatorResult(expression) {
        if (!expression) {
            this._showInfoLabel('Type a calculation after =');
            this._updateResultsHeight();
            return;
        }

        try {
            const result = evaluateCalculatorExpression(expression);
            this._populatePoolButton(0, {
                kind: 'calculator',
                id: 'calculator-result',
                name: result,
                description: `${expression} = ${result}  |  Press Enter to copy`,
                iconName: 'accessories-calculator-symbolic',
                result
            });
            this._updateSelection();
            this._updateResultsHeight();
        } catch (e) {
            this._showInfoLabel(`Invalid calculation: ${e.message}`);
            this._updateResultsHeight();
        }
    }

    _renderWebSearchResult(query) {
        if (!query) {
            this._showInfoLabel('Type a web search after ?');
            this._updateResultsHeight();
            return;
        }

        const engine = this._settings?.get_string('tweaks-essential-menu-default-search-engine') ?? 'duckduckgo';
        let engineName = 'DuckDuckGo';
        if (engine === 'google') engineName = 'Google';
        else if (engine === 'bing') engineName = 'Bing';

        this._populatePoolButton(0, {
            kind: 'web-search',
            id: 'web-search',
            name: `Search with ${engineName} for "${query}"`,
            description: `Open query in default browser using ${engineName}`,
            iconName: 'web-browser-symbolic',
            query
        });
        this._updateSelection();
        this._updateResultsHeight();
    }

    _renderFileSearchResult(query) {
        if (!query) {
            this._showInfoLabel('Type a file search after ~');
            this._updateResultsHeight();
            return;
        }

        if (query.length < FILE_SEARCH_MIN_QUERY_LENGTH) {
            this._showInfoLabel(`Type at least ${FILE_SEARCH_MIN_QUERY_LENGTH} characters after ~`);
            this._updateResultsHeight();
            return;
        }

        const localsearch = GLib.find_program_in_path('localsearch');
        if (!localsearch) {
            this._showInfoLabel('GNOME LocalSearch is not available');
            this._updateResultsHeight();
            return;
        }

        this._showInfoLabel('Searching files...');
        this._updateResultsHeight();
        const generation = ++this._fileSearchGeneration;
        this._fileSearchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILE_SEARCH_DEBOUNCE_MS, () => {
            this._fileSearchTimeoutId = 0;
            this._startFileSearch(localsearch, query, generation);
            return GLib.SOURCE_REMOVE;
        });
    }

    _startFileSearch(localsearch, query, generation) {
        if (!this._isCurrentFileSearch(query, generation)) return;

        const terms = query.split(/\s+/).filter(Boolean);
        const argv = [
            localsearch,
            'search',
            '--files',
            '--folders',
            '--limit',
            String(FILE_SEARCH_RESULT_LIMIT),
            ...terms
        ];

        try {
            this._fileSearchCancellable = new Gio.Cancellable();
            this._fileSearchProcess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            this._fileSearchProcess.communicate_utf8_async(null, this._fileSearchCancellable, (process, result) => {
                let stdout = '';
                let stderr = '';

                try {
                    [, stdout, stderr] = process.communicate_utf8_finish(result);
                } catch (e) {
                    if (generation === this._fileSearchGeneration) {
                        this._renderFileSearchRecords(query, generation, [], e.message);
                    }
                    return;
                } finally {
                    if (generation === this._fileSearchGeneration) {
                        this._fileSearchProcess = null;
                        this._fileSearchCancellable = null;
                    }
                }

                if (!this._isCurrentFileSearch(query, generation)) return;

                const records = this._parseFileSearchOutput(stdout);
                const errorMessage = records.length === 0 && stderr?.trim()
                    ? stderr.trim().split('\n')[0]
                    : '';
                this._renderFileSearchRecords(query, generation, records, errorMessage);
            });
        } catch (e) {
            this._fileSearchProcess = null;
            this._fileSearchCancellable = null;
            this._renderFileSearchRecords(query, generation, [], e.message);
        }
    }

    _parseFileSearchOutput(stdout) {
        const records = [];
        const seen = new Set();

        for (const line of String(stdout ?? '').split('\n')) {
            const uri = line.trim();
            if (!uri.startsWith('file://') || seen.has(uri)) continue;

            seen.add(uri);
            const record = this._createFileRecord(uri);
            if (record) records.push(record);
            if (records.length >= FILE_SEARCH_RESULT_LIMIT) break;
        }

        return records;
    }

    _createFileRecord(uri) {
        try {
            const file = Gio.File.new_for_uri(uri);
            const path = file.get_path();
            const name = file.get_basename() || uri;
            const fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
            const isFolder = fileType === Gio.FileType.DIRECTORY;
            const description = isFolder
                ? `Folder - ${this._shortenHomePath(path || uri)}`
                : this._shortenHomePath(path || uri);

            return {
                kind: 'file',
                id: uri,
                name,
                description,
                iconName: isFolder ? 'folder-symbolic' : 'text-x-generic-symbolic',
                gicon: this._getFileGIcon(file, isFolder),
                uri
            };
        } catch (e) {
            logError(`Failed to read file search result ${uri}: ${e.message}`);
            return null;
        }
    }

    _getFileGIcon(file, isFolder) {
        try {
            const info = file.query_info(
                'standard::icon',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            return info.get_icon();
        } catch (e) {
            return isFolder
                ? Gio.ThemedIcon.new('folder-symbolic')
                : Gio.ThemedIcon.new('text-x-generic-symbolic');
        }
    }

    _renderFileSearchRecords(query, generation, records, errorMessage = '') {
        if (!this._isCurrentFileSearch(query, generation) || !this._resultsBox) return;

        this._resetResultsScroll();
        
        // Hide all pooled elements
        if (this._buttonPool) {
            this._buttonPool.forEach(b => { b.visible = false; });
        }
        if (this._sectionSeparator) {
            this._sectionSeparator.visible = false;
        }
        if (this._infoLabel) {
            this._infoLabel.visible = false;
        }

        this._resultButtons = [];
        this._visibleRecords = [];
        this._selectedIndex = 0;

        if (errorMessage) {
            this._showInfoLabel(`File search failed: ${errorMessage}`);
            this._updateResultsHeight();
            return;
        }

        if (records.length === 0) {
            this._showInfoLabel('No matching files');
            this._updateResultsHeight();
            return;
        }

        let poolIndex = 0;
        for (const record of records) {
            this._populatePoolButton(poolIndex, record);
            poolIndex++;
        }
        this._updateSelection();
        this._updateResultsHeight();
    }

    _isCurrentFileSearch(query, generation) {
        if (!this._isOpen || generation !== this._fileSearchGeneration) return false;

        const currentQuery = String(this._getSearchText() ?? '').trim();
        return currentQuery.startsWith(FILE_SEARCH_PREFIX) &&
            currentQuery.slice(FILE_SEARCH_PREFIX.length).trim() === query;
    }

    _cancelFileSearch() {
        if (this._fileSearchTimeoutId > 0) {
            GLib.source_remove(this._fileSearchTimeoutId);
            this._fileSearchTimeoutId = 0;
        }

        if (this._fileSearchCancellable) {
            try {
                this._fileSearchCancellable.cancel();
            } catch (e) {
                // The search may already have completed.
            }
        }

        if (this._fileSearchProcess) {
            try {
                this._fileSearchProcess.force_exit();
            } catch (e) {
                // The process may already have exited.
            }
        }

        this._fileSearchProcess = null;
        this._fileSearchCancellable = null;
        this._fileSearchGeneration += 1;
    }

    _shortenHomePath(path) {
        const value = String(path ?? '');
        const home = GLib.get_home_dir();

        if (value === home) return '~';
        if (value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
        return value;
    }



    _getDefaultSections() {
        const favorites = this._favoriteIds
            .map(id => this._appRecords.find(record => record.id === id))
            .filter(Boolean);
        const favoriteIds = new Set(favorites.map(record => record.id));
        const remaining = this._appRecords.filter(record => !favoriteIds.has(record.id));

        return { favorites, remaining };
    }

    _searchAppRecords(query) {
        const scored = [];

        for (const record of this._appRecords) {
            const name = normalize(record.name);
            let score = -1;

            if (name === query) score = 0;
            else if (name.startsWith(query)) score = 1;
            else if (record.haystack.includes(query)) score = 2;

            if (score >= 0) scored.push({ record, score });
        }

        scored.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            if (a.record.favorite !== b.record.favorite) return a.record.favorite ? -1 : 1;
            return a.record.name.localeCompare(b.record.name);
        });

        return scored.map(item => item.record);
    }

    _createPoolButton(index) {
        const button = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            visible: false,
            style_class: 'essential-menu-result'
        });
        button.connect('clicked', () => {
            const record = this._visibleRecords[index];
            if (record) this._launchRecord(record);
        });
        button.connect('motion-event', (_actor, _event) => {
            if (this._selectedIndex !== index) {
                this._selectedIndex = index;
                this._updateSelection();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            style: 'spacing: 10px'
        });

        const iconSlot = new St.Bin({
            width: RESULT_ICON_SLOT_SIZE,
            height: RESULT_ICON_SLOT_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `min-width: ${RESULT_ICON_SLOT_SIZE}px; min-height: ${RESULT_ICON_SLOT_SIZE}px`
        });
        row.add_child(iconSlot);

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: `min-width: ${RESULT_TEXT_COLUMN_MIN_WIDTH}px`
        });
        const nameLabel = new St.Label({
            x_align: Clutter.ActorAlign.START,
            style: 'font-size: 13px; font-weight: 700; color: inherit'
        });
        const detailLabel = new St.Label({
            x_align: Clutter.ActorAlign.START,
            style: `font-size: 11px; color: ${this._isDark ? 'rgba(255, 255, 255, 0.62)' : 'rgba(0, 0, 0, 0.54)'}`
        });
        try {
            nameLabel.clutter_text.set_x_align(Clutter.ActorAlign.START);
            detailLabel.clutter_text.set_x_align(Clutter.ActorAlign.START);
            nameLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            detailLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            nameLabel.clutter_text.set_line_wrap(false);
            detailLabel.clutter_text.set_line_wrap(false);
        } catch (e) {
            // Label behavior is best-effort across Shell versions.
        }
        textBox.add_child(nameLabel);
        textBox.add_child(detailLabel);
        row.add_child(textBox);

        // Premium Red Oval Uninstall Button (using official Adwaita destructive colors)
        const uninstallBtn = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            visible: false,
            style: 'padding: 1px 8px; border-radius: 8px; background-color: #c01c28; border: 1px solid #a81620; color: #ffffff; margin-left: auto; margin-right: 4px; y-align: align-center; min-width: 58px;'
        });

        const uninstallLabel = new St.Label({
            text: 'Uninstall',
            style: 'font-size: 9.5px; font-weight: bold; color: #ffffff; text-align: center;'
        });
        uninstallBtn.set_child(uninstallLabel);

        uninstallBtn.connect('notify::hover', () => {
            if (uninstallBtn.hover) {
                uninstallBtn.style = 'padding: 1px 8px; border-radius: 8px; background-color: #e01b24; border: 1px solid #c01c28; color: #ffffff; margin-left: auto; margin-right: 4px; y-align: align-center; box-shadow: 0 1.5px 4px rgba(0, 0, 0, 0.24); min-width: 58px;';
            } else {
                uninstallBtn.style = 'padding: 1px 8px; border-radius: 8px; background-color: #c01c28; border: 1px solid #a81620; color: #ffffff; margin-left: auto; margin-right: 4px; y-align: align-center; min-width: 58px;';
            }
        });


        uninstallBtn.connect('clicked', () => {
            const record = this._visibleRecords[index];
            if (record && record.app) {
                this._uninstallAppRecord(record);
            }
        });

        row.add_child(uninstallBtn);

        button.set_child(row);
        
        button._iconSlot = iconSlot;
        button._nameLabel = nameLabel;
        button._detailLabel = detailLabel;
        button._uninstallBtn = uninstallBtn;

        this._resultsBox.add_child(button);
        return button;
    }

    _getPoolButton(poolIndex) {
        if (!this._buttonPool) this._buttonPool = [];

        while (poolIndex >= this._buttonPool.length) {
            const nextIndex = this._buttonPool.length;
            this._buttonPool.push(this._createPoolButton(nextIndex));
        }

        return this._buttonPool[poolIndex];
    }

    _populatePoolButton(poolIndex, record) {
        this._visibleRecords.push(record);
        const button = this._getPoolButton(poolIndex);
        this._resultButtons.push(button);

        button.margin_top = 0;

        button._nameLabel.text = record.name;
        button._detailLabel.text = record.description || record.id;
        button._iconSlot.set_child(this._createAppIcon(record, RESULT_ICON_SIZE));
        
        // Dynamically toggle visibility of the uninstallation button
        const uninstallEnabled = this._settings?.get_boolean('tweaks-essential-uninstall-enabled') ?? false;
        const uninstallInMenu = this._settings?.get_boolean('tweaks-essential-uninstall-in-menu') ?? true;
        const isApp = record && record.app !== undefined;
        const isProtected = record && record.id && (record.id.startsWith('org.gnome.Shell') || record.id === 'gnome-shell.desktop');
        
        if (button._uninstallBtn) {
            button._uninstallBtn.visible = (uninstallEnabled && uninstallInMenu && isApp && !isProtected);
        }

        const isSame = (button._currentRecordId === record.id);
        button._currentRecordId = record.id;

        const animEnabled = this._settings?.get_boolean('tweaks-essential-menu-animations-enabled') ?? true;

        if (isSame || !animEnabled) {
            button.translation_x = 0;
            button.visible = true;
        } else {
            button.remove_all_transitions();
            button.translation_x = 12;
            button.visible = true;
            button.ease({
                translation_x: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
    }

    _setSeparatorIndex(index) {
        const targetIndex = index + 1; // Shift by 1 to account for _topSpacer at index 0
        try {
            if (typeof this._resultsBox.set_child_at_index === 'function') {
                this._resultsBox.set_child_at_index(this._sectionSeparator, targetIndex);
                return;
            }
        } catch (e) {}

        try {
            this._resultsBox.remove_child(this._sectionSeparator);
            this._resultsBox.insert_child_at_index(this._sectionSeparator, targetIndex);
        } catch (e) {}
    }

    _showInfoLabel(text) {
        if (this._infoLabel) {
            this._infoLabel.text = text;
            this._infoLabel.visible = true;
        }
    }

    _createSectionSeparator(labelText) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px; margin: 8px 4px 6px'
        });
        const lineStyle = `height: 1px; background-color: ${this._isDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.10)'}`;
        row.add_child(new St.Widget({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: lineStyle
        }));
        row.add_child(new St.Label({
            text: labelText,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 10px; font-weight: 700; color: ${this._isDark ? 'rgba(255, 255, 255, 0.58)' : 'rgba(0, 0, 0, 0.48)'}; text-transform: uppercase`
        }));
        row.add_child(new St.Widget({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: lineStyle
        }));
        return row;
    }

    _getAppIconName(app, id) {
        try {
            const appInfo = app.get_app_info?.();
            const icon = appInfo?.get_string?.('Icon');
            if (icon) return icon;
        } catch (e) {
            // Fall back to reading the desktop file directly.
        }

        return this._getDesktopIconName(id);
    }

    _getDesktopIconName(appId) {
        if (!appId) return 'application-x-executable';
        if (this._desktopIconCache.has(appId)) return this._desktopIconCache.get(appId);

        const fileName = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
        const appDirs = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']),
            ...GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, 'applications']))
        ];

        for (const dir of appDirs) {
            const desktopFile = GLib.build_filenamev([dir, fileName]);
            if (!Gio.File.new_for_path(desktopFile).query_exists(null)) continue;

            const keyFile = new GLib.KeyFile();
            try {
                keyFile.load_from_file(desktopFile, GLib.KeyFileFlags.NONE);
                const icon = keyFile.get_string('Desktop Entry', 'Icon');
                if (icon) {
                    this._desktopIconCache.set(appId, icon);
                    return icon;
                }
            } catch (e) {
                // Try the next data dir.
            }
        }

        this._desktopIconCache.set(appId, 'application-x-executable');
        return 'application-x-executable';
    }

    _createAppIcon(record, size) {
        if (record?.gicon) {
            try {
                return new St.Icon({
                    gicon: record.gicon,
                    icon_size: size
                });
            } catch (e) {
                // Fall through to icon name handling.
            }
        }

        const iconName = record?.iconName || 'application-x-executable';

        try {
            if (GLib.path_is_absolute(iconName) &&
                Gio.File.new_for_path(iconName).query_exists(null)) {
                return new St.Icon({
                    gicon: Gio.FileIcon.new(Gio.File.new_for_path(iconName)),
                    icon_size: size
                });
            }
        } catch (e) {
            // Fall through to icon theme lookup.
        }

        try {
            if (iconName) {
                return new St.Icon({
                    icon_name: iconName,
                    icon_size: size
                });
            }
        } catch (e) {
            // Fall back below.
        }

        try {
            const icon = record?.app?.create_icon_texture(size);
            if (icon) {
                try {
                    icon.set_size(size, size);
                } catch (e) {
                    // Some icon actors expose their own sizing only.
                }
                return icon;
            }
        } catch (e) {
            // Fall back below.
        }

        return new St.Icon({
            icon_name: 'application-x-executable-symbolic',
            icon_size: size
        });
    }

    _handleSearchKeyPress(event) {
        const symbol = event.get_key_symbol();

        switch (symbol) {
            case Clutter.KEY_Escape:
                this.close();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                this._launchSelected();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._moveSelection(1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._moveSelection(-1);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _moveSelection(delta) {
        if (this._visibleRecords.length === 0) return;

        this._selectedIndex =
            (this._selectedIndex + delta + this._visibleRecords.length) %
            this._visibleRecords.length;
        this._updateSelection();
        this._scrollSelectedIntoView();
    }

    _updateSelection() {
        this._resultButtons.forEach((button, index) => {
            button.set_pivot_point(0.5, 0.5);

            if (index === this._selectedIndex) {
                button.add_style_class_name('essential-menu-result-selected');
                button.ease({
                    scale_x: 1.0, // Lock horizontal scale to keep width exactly inside container
                    scale_y: 1.03, // Subtle vertical 3D scale pop
                    translation_y: -2, // Physical vertical elevation
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                });
            } else {
                button.remove_style_class_name('essential-menu-result-selected');
                button.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    translation_y: 0,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                });
            }
        });

        if (this._blurBackground) {
            this._blurBackground.queue_redraw();
        }
    }

    _scrollSelectedIntoView() {
        this._cancelScrollIdle();

        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollIdleId = 0;
            this._scrollSelectedIntoViewDeferred();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scrollSelectedIntoViewDeferred() {
        if (this._isAnimatingOpen) return;

        const button = this._resultButtons[this._selectedIndex];
        const adjustment = this._getResultsVAdjustment();
        if (!button || !this._resultsScrollView || !adjustment) return;

        try {
            const viewBox = this._resultsScrollView.get_allocation_box();
            const buttonBox = button.get_allocation_box();
            const viewHeight = viewBox.y2 - viewBox.y1;
            const buttonHeight = buttonBox.y2 - buttonBox.y1;

            log(`[GnomeEssentials] Scroll calculation. selectedIndex: ${this._selectedIndex}, viewBox height: ${viewHeight}, buttonBox: y1=${buttonBox.y1}, y2=${buttonBox.y2}, buttonHeight: ${buttonHeight}`);

            // If the layout is not fully allocated yet, abort to prevent bad scroll targets
            if (viewHeight <= 0 || buttonHeight <= 0) return;

            const current = adjustment.get_value();
            let target = current;

            // Get the up-to-date preferred height of the results container
            let [, naturalHeight] = this._resultsBox.get_preferred_height(-1);

            log(`[GnomeEssentials] naturalHeight: ${naturalHeight}, current scroll: ${current}`);

            if (naturalHeight <= viewHeight) {
                target = 0;
            } else if (this._selectedIndex === 0) {
                target = 0;
            } else {
                if (current > buttonBox.y1 - SCROLL_KEEP_VISIBLE_MARGIN) {
                    target = buttonBox.y1 - SCROLL_KEEP_VISIBLE_MARGIN;
                }
                if (current + viewHeight < buttonBox.y2 + SCROLL_KEEP_VISIBLE_MARGIN) {
                    target = buttonBox.y2 - viewHeight + SCROLL_KEEP_VISIBLE_MARGIN;
                }
            }

            log(`[GnomeEssentials] Calculated scroll target: ${target}`);

            target = this._clampScrollValue(adjustment, target);
            if (Math.abs(target - current) > 0.1) {
                log(`[GnomeEssentials] Animating scroll to target: ${target}`);
                this._scrollTargetValue = target;
                this._ensureScrollTimeline();
            }
        } catch (e) {
            log(`[GnomeEssentials] Scroll deferred error: ${e.message}`);
        }
    }

    _cancelScrollIdle() {
        if (this._scrollIdleId > 0) {
            GLib.source_remove(this._scrollIdleId);
            this._scrollIdleId = 0;
        }
    }

    _handleResultsScrollEvent(event) {
        const adjustment = this._getResultsVAdjustment();
        if (!adjustment) return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        let delta = 0;

        if (direction === Clutter.ScrollDirection.UP) {
            delta = -16;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            delta = 16;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const values = event.get_scroll_delta();
            let dy = 0;
            if (Array.isArray(values)) {
                dy = typeof values[0] === 'boolean' ? Number(values[2] ?? 0) : Number(values[1] ?? 0);
            }
            delta = dy * 16;
        }

        if (delta !== 0 && !Number.isNaN(delta)) {
            const currentTarget = this._scrollTimeline && this._scrollTimeline.is_playing()
                ? this._scrollTargetValue
                : adjustment.get_value();
            this._scrollTargetValue = this._clampScrollValue(adjustment, currentTarget + delta);
            this._ensureScrollTimeline();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _ensureScrollTimeline() {
        if (!this._scrollTimeline) {
            this._scrollTimeline = new Clutter.Timeline({
                duration: 3600000,
                actor: this._resultsScrollView,
            });
            this._scrollTimeline.connect('new-frame', () => this._advanceScrollAnimation());
        }

        if (!this._scrollTimeline.is_playing()) {
            this._scrollTimeline.start();
        }
    }

    _advanceScrollAnimation() {
        const adjustment = this._getResultsVAdjustment();
        if (!this._isOpen || !adjustment) {
            if (this._scrollTimeline) this._scrollTimeline.stop();
            return;
        }

        const target = this._scrollTargetValue;
        const current = adjustment.get_value();
        const diff = target - current;

        if (Math.abs(diff) < 0.08) {
            adjustment.set_value(target);
            if (this._scrollTimeline) this._scrollTimeline.stop();
            return;
        }

        adjustment.set_value(current + diff * SCROLL_EASING);
    }

    _cancelScrollAnimation() {
        if (this._scrollTimeline) {
            this._scrollTimeline.stop();
        }
    }

    _resetResultsScroll() {
        this._cancelScrollAnimation();
        this._cancelScrollIdle();
        const adjustment = this._getResultsVAdjustment();
        if (adjustment) {
            log(`[GnomeEssentials] Resetting scroll to 0. Current value: ${adjustment.get_value()}`);
            adjustment.set_value(this._clampScrollValue(adjustment, 0));
        }
        this._scrollTargetValue = 0;
    }

    _getResultsVAdjustment() {
        if (!this._resultsScrollView) return null;

        try {
            if (typeof this._resultsScrollView.get_vadjustment === 'function') {
                return this._resultsScrollView.get_vadjustment();
            }
        } catch (e) {
            // Fall through to property access.
        }

        try {
            return this._resultsScrollView.vadjustment;
        } catch (e) {
            return null;
        }
    }

    _clampScrollValue(adjustment, value) {
        const lower = adjustment.get_lower?.() ?? adjustment.lower ?? 0;
        const upper = adjustment.get_upper?.() ?? adjustment.upper ?? 0;
        const pageSize = adjustment.get_page_size?.() ?? adjustment.page_size ?? 0;
        const max = Math.max(lower, upper - pageSize);
        const numericValue = Number(value);

        if (!Number.isFinite(numericValue)) return lower;
        return Math.max(lower, Math.min(max, numericValue));
    }

    _launchSelected() {
        const record = this._visibleRecords[this._selectedIndex] ?? this._visibleRecords[0];
        if (record) this._launchRecord(record);
    }

    _launchRecord(record) {
        this.close();

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                this._activateRecord(record);
            } catch (e) {
                logError(`Failed to activate ${record.name}: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _activateRecord(record) {
        switch (record?.kind) {
            case 'calculator':
                this._copyText(record.result);
                log(`Copied calculator result: ${record.result}`);
                return;
            case 'web-search':
                this._openWebSearch(record.query);
                return;
            case 'file':
                this._openFile(record.uri);
                return;
            default:
                this._launchApp(record);
        }
    }

    _copyText(text) {
        const value = String(text ?? '');

        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value);
            return;
        } catch (e) {
            // GNOME Shell's clipboard API is version-specific; try the global fallback.
        }

        try {
            global.clipboard.set_text(St.ClipboardType.CLIPBOARD, value);
        } catch (e) {
            throw new Error('could not copy result to clipboard');
        }
    }

    _openWebSearch(query) {
        const engine = this._settings?.get_string('tweaks-essential-menu-default-search-engine') ?? 'duckduckgo';
        let prefix = 'https://duckduckgo.com/?q=';
        if (engine === 'google') prefix = 'https://www.google.com/search?q=';
        else if (engine === 'bing') prefix = 'https://www.bing.com/search?q=';

        const uri = prefix + encodeURIComponent(String(query ?? '').trim());
        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(uri, context);
        log(`Opened web search using ${engine}: ${query}`);
    }

    _openFile(uri) {
        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(uri, context);
        log(`Opened file search result: ${uri}`);
    }

    _launchApp(record) {
        const app = record?.app;
        if (!app) throw new Error('missing Shell app');

        if (typeof app.open_new_window === 'function') {
            app.open_new_window(-1);
            log(`Launched ${record.name} via Shell.App.open_new_window`);
            return;
        }

        const appInfo = app.appInfo ?? app.get_app_info?.();
        if (appInfo && typeof appInfo.launch === 'function') {
            const timestamp = global.get_current_time?.() ?? 0;
            const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
            appInfo.launch([], context);
            log(`Launched ${record.name} via Gio.AppInfo.launch`);
            return;
        }

        throw new Error('no supported launch method');
    }

    _uninstallAppRecord(record) {
        if (!record || !record.app) return;

        try {
            // Close the Essential Menu quick launcher first
            this.close(true);

            // Resolve absolute import URI relative to the current module's absolute file path to work reliably in GJS ESM
            const currentDir = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));
            const importUri = `${currentDir}/appUninstallUtility.js?v=20260530-autoremove-deps`;

            // Dynamically import uninstallation utility to run uninstallation dialogue
            import(importUri).then(Module => {
                if (Module.default) {
                    const utility = new Module.default(this._settings);
                    utility._confirmAndUninstall(record.app);
                }
            }).catch(err => {
                logError(`Failed to load uninstallation utility: ${err.message}`);
            });
        } catch (e) {
            logError(`Failed to trigger uninstallation: ${e.message}`);
        }
    }

    _setSearchText(text) {
        if (!this._searchEntry) return;

        if (typeof this._searchEntry.set_text === 'function') {
            this._searchEntry.set_text(text);
            return;
        }

        this._searchEntry.clutter_text?.set_text(text);
    }

    _getSearchText() {
        if (!this._searchEntry) return '';

        if (typeof this._searchEntry.get_text === 'function') {
            return this._searchEntry.get_text();
        }

        return this._searchEntry.clutter_text?.get_text() ?? '';
    }

    _scheduleSearchFocus() {
        this._cancelSearchFocus();

        // Attempt synchronous grab-focus immediately so the search entry renders
        // in its focused state from the very first frame, preventing any visual style transition flash.
        try {
            if (this._searchEntry) {
                if (typeof this._searchEntry.grab_key_focus === 'function') {
                    this._searchEntry.grab_key_focus();
                } else {
                    this._searchEntry.clutter_text?.grab_key_focus();
                }
            }
        } catch (e) {
            // Synchronous grab-focus may be deferred, which is handled by the idle fallback.
        }

        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusIdleId = 0;
            if (!this._isOpen || !this._searchEntry) return GLib.SOURCE_REMOVE;

            try {
                if (typeof this._searchEntry.grab_key_focus === 'function') {
                    this._searchEntry.grab_key_focus();
                } else {
                    this._searchEntry.clutter_text?.grab_key_focus();
                }
            } catch (e) {
                // The launcher is still usable by clicking the search field.
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearchFocus() {
        if (this._focusIdleId === 0) return;

        GLib.source_remove(this._focusIdleId);
        this._focusIdleId = 0;
    }

    _connectStageCapture() {
        if (this._stageCapturedEventId > 0) return;

        this._stageCapturedEventId = global.stage.connect('captured-event', (_stage, event) => {
            if (!this._isOpen) return Clutter.EVENT_PROPAGATE;

            const eventType = event.type();
            if (eventType === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            if (eventType === Clutter.EventType.BUTTON_PRESS ||
                eventType === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                if (!this._pointInsideActor(this._launcher, x, y) &&
                    !this._pointInsideActor(this._indicator, x, y)) {
                    this.close();
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _disconnectStageCapture() {
        if (this._stageCapturedEventId <= 0) return;

        try {
            global.stage.disconnect(this._stageCapturedEventId);
        } catch (e) {
            // Stage may already be gone during Shell teardown.
        }
        this._stageCapturedEventId = 0;
    }

    _pointInsideActor(actor, x, y) {
        if (!actor || !actor.visible) return false;

        try {
            const [actorX, actorY] = actor.get_transformed_position();
            const [width, height] =
                typeof actor.get_transformed_size === 'function'
                    ? actor.get_transformed_size()
                    : [actor.width, actor.height];
            return x >= actorX &&
                x <= actorX + width &&
                y >= actorY &&
                y <= actorY + height;
        } catch (e) {
            return false;
        }
    }

    _getStageKeyFocus() {
        try {
            if (typeof global.stage.get_key_focus === 'function') {
                return global.stage.get_key_focus();
            }
        } catch (e) {
            // Fall through to property access.
        }

        try {
            return global.stage.key_focus;
        } catch (e) {
            return null;
        }
    }

    _isActorOrDescendant(actor, parent) {
        if (!actor || !parent) return false;

        for (let current = actor; current; current = current.get_parent?.()) {
            if (current === parent) return true;
        }

        return false;
    }

    _raiseActor(actor) {
        if (!actor) return;

        try {
            if (typeof actor.raise_top === 'function') {
                actor.raise_top();
            } else {
                const parent = actor.get_parent?.();
                if (parent && typeof parent.set_child_above_sibling === 'function') {
                    parent.set_child_above_sibling(actor, null);
                }
            }
        } catch (e) {
            // Ignore ordering races
        }

        // Keep floating Pomodoro panel above all menu elements
        try {
            if (global.gnome_essentials_deepwork && typeof global.gnome_essentials_deepwork._raiseFloatingPomodoro === 'function') {
                global.gnome_essentials_deepwork._raiseFloatingPomodoro();
            }
        } catch (e) {
            // Safe fallback
        }
    }
}
