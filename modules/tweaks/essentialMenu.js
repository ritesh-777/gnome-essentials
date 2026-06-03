// GNOME Essentials: Essential Menu quick launcher

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { classifyAppInstallSource } from './appInstallSource.js';

const DEBUG = true;
const LAUNCHER_WIDTH = 560;
const LAUNCHER_MAX_WIDTH_RATIO = 0.58;
const LAUNCHER_TOP_RATIO = 0.16;
const RESULTS_MAX_HEIGHT_RATIO = 0.58;
const SEARCH_RESULT_LIMIT = 10;
const RESULT_ICON_SIZE = 28;
const RESULT_ICON_SLOT_SIZE = 36;
const RESULT_ATTACHMENT_ICON_SIZE = 22;
const RESULT_ATTACHMENT_ICON_SLOT_SIZE = 28;
const RESULT_ATTACHMENT_INDENT = 14;
const SHORTCUT_KEY = 'tweaks-essential-menu-shortcut';
const CALCULATOR_PREFIX = '=';
const WEB_SEARCH_PREFIX = '?';
const FILE_SEARCH_PREFIX = '~';
const SHELF_PREFIX = '#';
const CALCULATOR_MAX_EXPRESSION_LENGTH = 120;
const WEB_SEARCH_URI_PREFIX = 'https://duckduckgo.com/?q=';
const FILE_SEARCH_RESULT_LIMIT = 12;
const FILE_SEARCH_DEBOUNCE_MS = 180;
const FILE_SEARCH_MIN_QUERY_LENGTH = 2;
const SCROLL_KEEP_VISIBLE_MARGIN = 12;
const SCROLL_EASING = 0.12;
const SHORTCUT_REFRESH_DELAY_MS = 650;
const SHORTCUT_LATE_REFRESH_DELAY_MS = 2000;
const PANEL_ICON_REPOSITION_DELAYS_MS = [0, 250, 1500, 4500];
const PANEL_ICON_SESSION_REPOSITION_DELAYS_MS = [120, 800, 2200, 5000];
const PANEL_ICON_PLACEMENT_BEFORE_WORKSPACES = 'before-workspaces';
const PANEL_ICON_PLACEMENT_AFTER_WORKSPACES = 'after-workspaces';
const CONTEXT_NOTES_DIR_NAME = 'context-notes';
const CONTEXT_DOUBLE_CLICK_MS = 420;
const INTERNAL_SHELF_DRAG_THRESHOLD = 8;
const SHELF_DRAG_AUTO_EXPAND_DELAY_MS = 520;
const SHELF_DRAG_AUTO_COLLAPSE_DELAY_MS = 700;
const SHELF_DRAG_AUTO_SCROLL_EDGE_PX = 46;
const SHELF_DRAG_AUTO_SCROLL_STEP = 24;
const FOLDER_TITLE_SEARCH_MAX_DEPTH = 4;
const FOLDER_TITLE_SEARCH_MAX_VISITS = 700;
const FOLDER_TITLE_SEARCH_MAX_MS = 120;
const FOLDER_TITLE_SEARCH_SKIP_NAMES = new Set([
    '.cache', '.config', '.git', '.local', '.var', 'node_modules'
]);
const OFFICE_DOCUMENT_EXTENSIONS = new Set([
    'abw', 'doc', 'docm', 'docx', 'dot', 'dotm', 'dotx', 'fodt', 'html',
    'htm', 'md', 'odt', 'ott', 'pages', 'rtf', 'sdw', 'stw', 'sxw', 'text',
    'txt', 'wpd'
]);
const OFFICE_SPREADSHEET_EXTENSIONS = new Set([
    'csv', 'fods', 'gnumeric', 'numbers', 'ods', 'ots', 'sdc', 'slk', 'stc',
    'sxc', 'tsv', 'xls', 'xlsm', 'xlsx', 'xlt', 'xltm', 'xltx'
]);
const OFFICE_PRESENTATION_EXTENSIONS = new Set([
    'fodp', 'key', 'odp', 'otp', 'pot', 'potm', 'potx', 'pps', 'ppsm',
    'ppsx', 'ppt', 'pptm', 'pptx', 'sdd', 'sti', 'sxi'
]);
const OFFICE_DRAWING_EXTENSIONS = new Set([
    'cdr', 'dia', 'drawio', 'fodg', 'odg', 'otg', 'pdf', 'sda', 'svg',
    'vsd', 'vsdx'
]);
const OFFICE_DATABASE_EXTENSIONS = new Set([
    'accdb', 'mdb', 'odb'
]);
const PDF_READER_EXTENSIONS = new Set([
    'cb7', 'cbr', 'cbt', 'cbz', 'djv', 'djvu', 'dvi', 'epub', 'eps',
    'oxps', 'pdf', 'ps', 'xps'
]);

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
     * @param {Object|null} shelf - Optional Essential Shelf storage module.
     */
    constructor(settings, shelf = null) {
        this._settings = settings;
        this._shelf = null;
        this._shelfChangedHandlerId = 0;
        this._appSystem = Shell.AppSystem.get_default();
        this._indicator = null;
        this._indicatorMenuOpenId = 0;
        this._panelClickConnections = [];
        this._floatingDropActor = null;
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
        this._panelIconRepositionTimeoutIds = [];
        this._fileSearchTimeoutId = 0;
        this._fileSearchGeneration = 0;
        this._fileSearchProcess = null;
        this._fileSearchCancellable = null;
        this._xdndDragBeginId = 0;
        this._xdndDragEndId = 0;
        this._externalDndMonitor = null;
        this._externalDndMonitoring = false;
        this._externalDndTarget = '';
        this._externalDndTargetRow = '';
        this._externalDndDropHandled = false;
        this._externalDndSelectionRequested = false;
        this._externalDndSelectionPending = false;
        this._externalDndCachedValues = [];
        this._externalDndCachedMimetype = '';
        this._externalDndPendingImportTarget = '';
        this._internalShelfDragMonitor = null;
        this._internalShelfDragMonitoring = false;
        this._internalShelfDragTarget = '';
        this._internalShelfDragSourceButton = null;
        this._internalShelfDragGraceUntilMs = 0;
        this._manualShelfDrag = null;
        this._shelfDragAutoExpandTimeoutId = 0;
        this._shelfDragAutoExpandTargetId = '';
        this._shelfDragAutoExpanded = new Map();
        this._shelfDragAutoCollapseTimeouts = new Map();
        this._suppressNextResultClick = false;
        this._suppressNextResultClickTimeoutId = 0;
        this._lastContextClickId = '';
        this._lastContextClickTimeMs = 0;
        this._scrollTargetValue = 0;
        this._scrollTimeline = null;
        this._themeSyncTimerId = 0;
        this._scrollIdleId = 0;
        this._isAnimatingOpen = false;

        this.setShelf(shelf);
    }

    /**
     * Enables the Essential Menu, binding key-press shortcuts, pre-warming launcher layouts,
     * loading settings, and caching desktop icons.
     * @returns {void}
     */
    enable() {
        global.gnome_essentials_menu = this;
        this._connectSettings();
        this._connectAppSignals();
        this._connectExternalDndSignals();
        this._rebuildAppIndex();
        this._syncPanelIcon();
        global.gnome_essentials_deepwork?._registerFloatingEssentialMenuDropActor?.();

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
        if (global.gnome_essentials_menu === this) {
            global.gnome_essentials_menu = null;
        }
        this.setFloatingDropActor(null);
        this.close(true);
        this.setShelf(null);
        this._cancelPanelIconReposition();
        this._cancelShortcutRefresh();
        this._unregisterShortcut();
        this._destroyLauncher();
        this._destroyPanelIcon();
        this._stopInternalShelfDragMonitor();
        this._disconnectExternalDndSignals();
        this._disconnectAppSignals();
        this._disconnectSettings();
        this._settings = null;
    }

    setFloatingDropActor(actor) {
        this._floatingDropActor = actor || null;
    }

    setShelf(shelf) {
        if (this._shelf && this._shelfChangedHandlerId > 0) {
            try {
                this._shelf.disconnectChanged(this._shelfChangedHandlerId);
            } catch (e) {
                // Shelf may already be disabled.
            }
        }

        this._shelf = shelf || null;
        this._shelfChangedHandlerId = 0;

        if (this._shelf && typeof this._shelf.connectChanged === 'function') {
            this._shelfChangedHandlerId = this._shelf.connectChanged(() => {
                if (this._isOpen) this._renderResults(this._getSearchText());
            });
        }

        if (this._isOpen) this._renderResults(this._getSearchText());
    }

    _shelfNotificationsEnabled() {
        try {
            return this._settings?.get_boolean('tweaks-essential-shelf-show-notifications') ?? true;
        } catch (e) {
            return true;
        }
    }

    _notifyShelf(message) {
        if (!this._shelfNotificationsEnabled()) return;
        Main.notify('Essential Shelf', message);
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
        if (!immediate && this._isInternalShelfDragActive()) {
            log('Ignoring menu close during internal Shelf drag');
            return;
        }

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
        this._cancelShelfDragAutoExpand();
        this._collapseAllShelfDragAutoExpanded();
        this._cancelManualShelfDrag(false);
        this._stopInternalShelfDragMonitor();
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
        bindKey('tweaks-essential-menu-panel-icon-placement', () => {
            this._syncPanelIconPlacement();
        });
        bindKey('tweaks-essential-menu-shortcut-enabled', () => this._syncShortcut());
        bindKey(SHORTCUT_KEY, () => this._syncShortcut());
        bindKey('tweaks-essential-menu-trigger', () => this._openFromTrigger());
        bindKey('tweaks-essential-shelf-show-in-menu', () => {
            if (this._isOpen) this._renderResults(this._getSearchText());
        });
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
                this._schedulePanelIconReposition([120, 800]);
                if (this._isOpen) this._positionLauncher();
            });
        } catch (e) {
            this._monitorsChangedId = 0;
        }

        try {
            this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
                if (this._isOpen && !this._isInternalShelfDragActive()) this.close();
            });
        } catch (e) {
            this._focusWindowChangedId = 0;
        }

        try {
            this._stageKeyFocusChangedId = global.stage.connect('notify::key-focus', () => {
                if (!this._isOpen) return;
                if (this._isInternalShelfDragActive()) return;

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

    _connectExternalDndSignals() {
        this._disconnectExternalDndSignals();

        if (!Main.xdndHandler) return;

        try {
            this._externalDndMonitor = {
                dragMotion: this._onExternalDndMotion.bind(this),
                dragDrop: this._onExternalDndDrop.bind(this),
            };
            this._xdndDragBeginId = Main.xdndHandler.connect('drag-begin', () => {
                this._startExternalDndMonitor();
            });
            this._xdndDragEndId = Main.xdndHandler.connect('drag-end', () => {
                this._finishExternalDndDrag();
            });
        } catch (e) {
            logError(`Failed to connect external drag-and-drop: ${e.message}`);
            this._xdndDragBeginId = 0;
            this._xdndDragEndId = 0;
            this._externalDndMonitor = null;
        }
    }

    _disconnectExternalDndSignals() {
        this._stopExternalDndMonitor();

        if (this._xdndDragBeginId > 0) {
            try {
                Main.xdndHandler?.disconnect(this._xdndDragBeginId);
            } catch (e) {
                // The Shell DND handler may already be gone during teardown.
            }
            this._xdndDragBeginId = 0;
        }

        if (this._xdndDragEndId > 0) {
            try {
                Main.xdndHandler?.disconnect(this._xdndDragEndId);
            } catch (e) {
                // The Shell DND handler may already be gone during teardown.
            }
            this._xdndDragEndId = 0;
        }

        this._externalDndMonitor = null;
        this._externalDndTarget = '';
        this._externalDndTargetRow = '';
    }

    _startExternalDndMonitor() {
        if (this._externalDndMonitoring || !this._externalDndMonitor) return;

        try {
            this._externalDndDropHandled = false;
            this._resetExternalDndSelectionCache();
            DND.addDragMonitor(this._externalDndMonitor);
            this._externalDndMonitoring = true;
        } catch (e) {
            logError(`Failed to start external drag monitor: ${e.message}`);
            this._externalDndMonitoring = false;
        }
    }

    _stopExternalDndMonitor() {
        if (!this._externalDndMonitoring || !this._externalDndMonitor) {
            this._externalDndTarget = '';
            this._externalDndTargetRow = '';
            this._externalDndDropHandled = false;
            if (!this._externalDndSelectionPending) {
                this._resetExternalDndSelectionCache();
            }
            this._syncExternalDndVisuals('');
            return;
        }

        try {
            DND.removeDragMonitor(this._externalDndMonitor);
        } catch (e) {
            // The monitor may already have been removed by Shell teardown.
        }

        this._externalDndMonitoring = false;
        this._externalDndTarget = '';
        this._externalDndTargetRow = '';
        this._externalDndDropHandled = false;
        if (!this._externalDndSelectionPending) {
            this._resetExternalDndSelectionCache();
        }
        this._syncExternalDndVisuals('');
    }

    _finishExternalDndDrag() {
        const target = this._externalDndTarget;
        const shouldImport = target && !this._externalDndDropHandled;
        if (shouldImport) {
            this._externalDndDropHandled = true;
            this._importExternalDndSelection(target);
        }

        this._stopExternalDndMonitor();
    }

    _onExternalDndMotion(dragEvent) {
        const target = this._getExternalDndTarget(dragEvent);
        this._externalDndTarget = target;
        this._syncExternalDndVisuals(target);
        if (target) this._primeExternalDndSelection();

        return target
            ? DND.DragMotionResult.COPY_DROP
            : DND.DragMotionResult.CONTINUE;
    }

    _onExternalDndDrop(dragEvent) {
        const target = this._getExternalDndTarget(dragEvent) || this._externalDndTarget;
        this._externalDndTarget = '';
        this._syncExternalDndVisuals('');

        if (!target) {
            return DND.DragDropResult?.CONTINUE ?? DND.DragMotionResult.CONTINUE;
        }

        this._externalDndDropHandled = true;
        this._importExternalDndSelection(target);
        // Let Shell finish its normal drag-end cleanup after we queue the import.
        return DND.DragDropResult?.CONTINUE ?? DND.DragMotionResult.CONTINUE;
    }

    _getExternalDndTarget(dragEvent) {
        const x = Number(dragEvent?.x ?? 0);
        const y = Number(dragEvent?.y ?? 0);

        if (this._isOpen && this._pointInsideActor(this._launcher, x, y)) {
            const rowTarget = this._getShelfDndTargetAt(x, y);
            if (rowTarget) return rowTarget;
            return 'menu';
        }

        if (this._pointInsideActor(this._indicator, x, y) ||
            this._pointInsideActor(this._floatingDropActor, x, y)) {
            return 'panel';
        }

        return '';
    }

    _getShelfDndTargetAt(x, y) {
        if (!this._isOpen || !Array.isArray(this._resultButtons)) return '';

        for (const button of this._resultButtons) {
            if (!button?.visible || !button._shelfDndTarget) continue;
            if (this._pointInsideActor(button, x, y)) {
                return button._shelfDndTarget;
            }
        }

        return '';
    }

    _syncExternalDndVisuals(target) {
        this._externalDndTargetRow = target && target !== 'menu' && target !== 'panel'
            ? target
            : '';

        try {
            if (target && target !== 'panel') {
                this._launcher?.add_style_pseudo_class?.('drop');
            } else {
                this._launcher?.remove_style_pseudo_class?.('drop');
            }
        } catch (e) {
            // Visual hint only.
        }

        try {
            if (target === 'panel') {
                this._indicator?.add_style_pseudo_class?.('active');
                this._floatingDropActor?.add_style_pseudo_class?.('active');
            } else {
                this._indicator?.remove_style_pseudo_class?.('active');
                this._floatingDropActor?.remove_style_pseudo_class?.('active');
            }
        } catch (e) {
            // Visual hint only.
        }

        try {
            for (const button of this._resultButtons || []) {
                if (button?._shelfDndTarget && button._shelfDndTarget === this._externalDndTargetRow) {
                    button.add_style_pseudo_class?.('drop');
                } else {
                    button?.remove_style_pseudo_class?.('drop');
                }
            }
        } catch (e) {
            // Per-row visual hint only.
        }
    }

    _syncPanelIcon() {
        const showIcon = this._settings?.get_boolean('tweaks-essential-menu-show-panel-icon') ?? true;

        if (showIcon) this._ensurePanelIcon();
        else {
            this.close(true);
            this._cancelPanelIconReposition();
            this._destroyPanelIcon();
        }
    }

    _syncPanelIconPlacement() {
        const showIcon = this._settings?.get_boolean('tweaks-essential-menu-show-panel-icon') ?? true;
        if (!showIcon) return;

        log(`Panel icon placement changed to ${this._getPanelIconPlacement()}; rebuilding panel indicator`);

        if (!this._indicator) {
            this._ensurePanelIcon();
            return;
        }

        this._destroyPanelIcon();
        this._ensurePanelIcon();
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
        this._syncPanelIcon();
        this._schedulePanelIconReposition(PANEL_ICON_SESSION_REPOSITION_DELAYS_MS);
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

        this._clearPanelStatusAreaRole();

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

        Main.panel.addToStatusArea('gnome-essential-menu', this._indicator, this._getPanelIconInitialPosition(), 'left');
        this._schedulePanelIconReposition(PANEL_ICON_REPOSITION_DELAYS_MS);
        global.gnome_essentials_deepwork?._registerFloatingEssentialMenuDropActor?.();
        log('Panel icon added');
    }

    _destroyPanelIcon() {
        if (!this._indicator) return;

        try {
            const indicator = this._indicator;
            this._cancelPanelIconReposition();
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
            this._clearPanelStatusAreaRole(indicator);
            this._indicator.destroy();
        } catch (e) {
            // Indicator may already be gone during Shell teardown.
        }
        this._indicator = null;
        this._indicatorMenuOpenId = 0;
    }

    _clearPanelStatusAreaRole(indicator = null) {
        try {
            const statusArea = Main.panel?.statusArea;
            if (!statusArea?.['gnome-essential-menu']) return;
            if (indicator && statusArea['gnome-essential-menu'] !== indicator) return;
            delete statusArea['gnome-essential-menu'];
        } catch (e) {
            // Status area bookkeeping is best-effort during Shell teardown.
        }
    }

    _schedulePanelIconReposition(delaysMs = [0]) {
        this._cancelPanelIconReposition();

        const delays = Array.isArray(delaysMs) ? delaysMs : [delaysMs];
        for (const delay of delays) {
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delay), () => {
                this._panelIconRepositionTimeoutIds = this._panelIconRepositionTimeoutIds
                    .filter(id => id !== timeoutId);
                this._repositionPanelIcon();
                return GLib.SOURCE_REMOVE;
            });
            this._panelIconRepositionTimeoutIds.push(timeoutId);
        }
    }

    _cancelPanelIconReposition() {
        for (const id of this._panelIconRepositionTimeoutIds || []) {
            try {
                GLib.source_remove(id);
            } catch (e) {
                // Source may already have fired.
            }
        }
        this._panelIconRepositionTimeoutIds = [];
    }

    _repositionPanelIcon() {
        const actor = this._indicator?.container || this._indicator;
        const leftBox = Main.panel?._leftBox;
        if (!actor || !leftBox || typeof leftBox.get_children !== 'function') return;

        const parent = actor.get_parent?.();
        if (parent !== leftBox) return;

        const children = leftBox.get_children();
        const currentIndex = children.indexOf(actor);
        if (currentIndex < 0) return;

        const siblings = children.filter(child => child !== actor);
        const workspaceActor = this._findWorkspacePanelActor(leftBox, actor);
        const workspaceIndex = workspaceActor ? siblings.indexOf(workspaceActor) : -1;
        const placement = this._getPanelIconPlacement();
        let targetIndex;

        if (placement === PANEL_ICON_PLACEMENT_AFTER_WORKSPACES) {
            targetIndex = workspaceIndex >= 0 ? workspaceIndex + 1 : Math.min(1, siblings.length);
        } else {
            targetIndex = workspaceIndex >= 0 ? workspaceIndex : 0;
        }

        targetIndex = Math.max(0, Math.min(targetIndex, siblings.length));

        if (currentIndex === targetIndex) return;

        try {
            leftBox.remove_child(actor);
            if (targetIndex >= siblings.length) {
                leftBox.add_child(actor);
            } else {
                leftBox.insert_child_at_index(actor, targetIndex);
            }
            log(`Panel icon positioned ${placement}; current=${currentIndex}, target=${targetIndex}, workspace=${workspaceIndex}`);
        } catch (e) {
            logError(`Failed to pin panel icon position: ${e.message}`);
        }
    }

    _getPanelIconPlacement() {
        try {
            const placement = this._settings?.get_string('tweaks-essential-menu-panel-icon-placement') || '';
            return placement === PANEL_ICON_PLACEMENT_AFTER_WORKSPACES
                ? PANEL_ICON_PLACEMENT_AFTER_WORKSPACES
                : PANEL_ICON_PLACEMENT_BEFORE_WORKSPACES;
        } catch (e) {
            return PANEL_ICON_PLACEMENT_BEFORE_WORKSPACES;
        }
    }

    _getPanelIconInitialPosition() {
        return this._getPanelIconPlacement() === PANEL_ICON_PLACEMENT_AFTER_WORKSPACES ? 1 : 0;
    }

    _findWorkspacePanelActor(leftBox, skipActor = null) {
        const statusArea = Main.panel?.statusArea || {};
        const preferredRoles = [
            'WorkspaceMenu',
            'workspaceIndicator',
            'workspace-indicator',
            'workspaceMenu',
            'workspacesMenu'
        ];

        for (const role of preferredRoles) {
            const actor = this._panelActorFromIndicator(statusArea[role]);
            if (actor && actor !== skipActor && actor.get_parent?.() === leftBox) return actor;
        }

        for (const [role, indicator] of Object.entries(statusArea)) {
            if (!/workspace/i.test(role)) continue;
            const actor = this._panelActorFromIndicator(indicator);
            if (actor && actor !== skipActor && actor.get_parent?.() === leftBox) return actor;
        }

        try {
            return leftBox.get_children()
                .find(child => child !== skipActor && this._actorLooksLikeWorkspaceIndicator(child)) || null;
        } catch (e) {
            return null;
        }
    }

    _panelActorFromIndicator(indicator) {
        if (!indicator) return null;
        return indicator.container || indicator.actor || indicator;
    }

    _actorLooksLikeWorkspaceIndicator(actor) {
        try {
            const name = String(actor?.name || actor?.get_name?.() || '').toLowerCase();
            const styleClass = String(actor?.style_class || actor?.get_style_class_name?.() || '').toLowerCase();
            return name.includes('workspace') ||
                styleClass.includes('workspace-indicator') ||
                styleClass.includes('space-workspace-indicator');
        } catch (e) {
            return false;
        }
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
        this._cancelShelfDragAutoExpand();
        this._collapseAllShelfDragAutoExpanded();

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

        const createHelpBadge = (prefix, labelText, searchPrefix) => {
            const normalStyle = this._isDark
                ? 'padding: 2px 8px; background-color: rgba(255, 255, 255, 0.06); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.08);'
                : 'padding: 2px 8px; background-color: rgba(0, 0, 0, 0.04); border-radius: 6px; border: 1px solid rgba(0, 0, 0, 0.06);';
            const hoverStyle = this._isDark
                ? 'padding: 2px 8px; background-color: rgba(255, 255, 255, 0.12); border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16);'
                : 'padding: 2px 8px; background-color: rgba(0, 0, 0, 0.08); border-radius: 6px; border: 1px solid rgba(0, 0, 0, 0.10);';

            const button = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                accessible_name: `${labelText} mode`,
                style: normalStyle
            });
            const badgeBox = new St.BoxLayout({
                vertical: false,
                style: 'spacing: 6px'
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
            button.set_child(badgeBox);
            button.connect('clicked', () => this._activateSearchMode(searchPrefix));
            button.connect('notify::hover', () => {
                button.style = button.hover ? hoverStyle : normalStyle;
            });
            return button;
        };

        helpRow.add_child(createHelpBadge(' = ', 'Calculator', CALCULATOR_PREFIX));
        helpRow.add_child(createHelpBadge(' ? ', 'Web Search', WEB_SEARCH_PREFIX));
        helpRow.add_child(createHelpBadge(' ~ ', 'File Search', FILE_SEARCH_PREFIX));
        helpRow.add_child(createHelpBadge(' # ', 'Shelf', SHELF_PREFIX));
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
                const appInfo = app.get_app_info?.();
                const desktopPath = appInfo?.get_filename?.() || '';
                const installSource = classifyAppInstallSource(id, desktopPath, appInfo);
                const sourceLabel = installSource.sourceLabel || 'Native package';
                records.push({
                    app,
                    id,
                    name,
                    description,
                    iconName,
                    installSource,
                    favorite: this._favoriteIds.includes(id),
                    haystack: normalize([
                        name,
                        description,
                        id,
                        sourceLabel,
                        installSource.details,
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

        if (rawQuery.startsWith(SHELF_PREFIX)) {
            this._renderShelfResult(rawQuery.slice(SHELF_PREFIX.length).trim());
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
            this._setSectionSeparatorLabel('All apps');
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
            uri: this._buildWebSearchUri(query),
            shelfLabel: `${engineName}: ${query}`,
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
            const info = this._queryFileInfo(file);
            const previewGIcon = this._getFilePreviewGIcon(file, info);
            const description = isFolder
                ? `Folder - ${this._shortenHomePath(path || uri)}`
                : this._shortenHomePath(path || uri);

            const record = {
                kind: 'file',
                id: uri,
                name,
                description,
                iconName: isFolder ? 'folder-symbolic' : 'text-x-generic-symbolic',
                gicon: this._getFileGIcon(file, isFolder, info),
                contentType: this._getContentType(info),
                uri
            };
            if (previewGIcon) {
                record.previewGIcon = previewGIcon;
                record.hasThumbnail = true;
            }
            return record;
        } catch (e) {
            logError(`Failed to read file search result ${uri}: ${e.message}`);
            return null;
        }
    }

    _queryFileInfo(file) {
        try {
            return file.query_info(
                'standard::icon,standard::content-type,thumbnail::path,thumbnail::is-valid',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            return null;
        }
    }

    _getFileGIcon(file, isFolder, info = null) {
        try {
            if (!info) info = this._queryFileInfo(file);
            return info.get_icon();
        } catch (e) {
            return isFolder
                ? Gio.ThemedIcon.new('folder-symbolic')
                : Gio.ThemedIcon.new('text-x-generic-symbolic');
        }
    }

    _getFilePreviewGIcon(file, info = null) {
        try {
            if (!info) info = this._queryFileInfo(file);
            const thumbnailPath = this._getThumbnailPath(info);
            if (thumbnailPath) {
                const thumbnailFile = Gio.File.new_for_path(thumbnailPath);
                if (thumbnailFile.query_exists(null)) {
                    return Gio.FileIcon.new(thumbnailFile);
                }
            }

            const contentType = this._getContentType(info);
            if (this._isImageContentType(contentType) && file.query_exists(null)) {
                return Gio.FileIcon.new(file);
            }
        } catch (e) {
            // Generic icons remain available through _getFileGIcon().
        }

        return null;
    }

    _getThumbnailPath(info) {
        if (!info) return '';

        try {
            if (typeof info.has_attribute === 'function' &&
                info.has_attribute('thumbnail::is-valid') &&
                !info.get_attribute_boolean('thumbnail::is-valid')) {
                return '';
            }
        } catch (e) {
            // Missing thumbnail metadata is normal.
        }

        try {
            if (typeof info.has_attribute === 'function' &&
                !info.has_attribute('thumbnail::path')) {
                return '';
            }
            if (typeof info.get_attribute_type === 'function' &&
                info.get_attribute_type('thumbnail::path') !== Gio.FileAttributeType.STRING) {
                return '';
            }
            return String(info.get_attribute_string('thumbnail::path') ?? '').trim();
        } catch (e) {
            return '';
        }
    }

    _getContentType(info) {
        try {
            return String(info?.get_content_type?.() ?? '').trim();
        } catch (e) {
            return '';
        }
    }

    _isImageContentType(contentType) {
        return String(contentType ?? '').startsWith('image/');
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

    _renderShelfResult(query) {
        if (!this._isShelfAvailable()) {
            this._showInfoLabel('Essential Shelf is disabled');
            this._updateResultsHeight();
            return;
        }

        const normalizedQuery = normalize(query).trim();
        const items = this._shelf.getItems();
        const filteredItems = normalizedQuery
            ? items.filter(item => this._shelfItemMatchesQuery(item, normalizedQuery))
            : items;

        let poolIndex = 0;

        if (query) {
            this._populatePoolButton(poolIndex, this._createShelfAddRecord(query));
            poolIndex++;
        }

        for (const item of filteredItems) {
            const record = this._shelf.createRecord(item);
            if (!record) continue;
            this._decorateShelfTreeRecord(record, {
                depth: 0,
                collapsible: this._shelfItemHasChildren(item),
                collapsed: !!item.collapsed,
                dndTarget: item.type === 'app'
                    ? `app:${item.id}`
                    : item.type === 'workspace'
                        ? `workspace:${item.id}`
                        : ''
            });
            this._populatePoolButton(poolIndex, record);
            poolIndex++;

            if (item.type === 'app' && Array.isArray(item.attachments)) {
                const attachments = normalizedQuery
                    ? item.attachments.filter(attachment => this._shelfItemMatchesQuery(attachment, normalizedQuery))
                    : item.attachments;

                if (normalizedQuery || !item.collapsed) {
                    for (const attachment of attachments) {
                        const attachmentRecord = this._shelf.createAttachmentRecord(item, attachment);
                        if (!attachmentRecord) continue;
                        this._decorateShelfTreeRecord(attachmentRecord, { depth: 1 });
                        this._populatePoolButton(poolIndex, attachmentRecord);
                        poolIndex++;
                    }
                }
            }

            if (item.type === 'workspace' && Array.isArray(item.contexts)) {
                const contexts = normalizedQuery
                    ? item.contexts.filter(context => this._shelfItemMatchesQuery(context, normalizedQuery))
                    : item.contexts;

                if (normalizedQuery || !item.collapsed) {
                    for (const context of contexts) {
                        const contextRecord = this._shelf.createWorkspaceAppRecord(item, context);
                        if (!contextRecord) continue;
                        this._decorateShelfTreeRecord(contextRecord, {
                            depth: 1,
                            collapsible: this._shelfItemHasChildren(context),
                            collapsed: !!context.collapsed,
                            dndTarget: `workspace-app:${item.id}:${context.id}`
                        });
                        this._populatePoolButton(poolIndex, contextRecord);
                        poolIndex++;

                        const attachments = Array.isArray(context.attachments)
                            ? (normalizedQuery
                                ? context.attachments.filter(attachment => this._shelfItemMatchesQuery(attachment, normalizedQuery))
                                : context.attachments)
                            : [];
                        if (normalizedQuery || !context.collapsed) {
                            for (const attachment of attachments) {
                                const attachmentRecord = this._shelf.createWorkspaceContextAttachmentRecord(item, context, attachment);
                                if (!attachmentRecord) continue;
                                this._decorateShelfTreeRecord(attachmentRecord, { depth: 2 });
                                this._populatePoolButton(poolIndex, attachmentRecord);
                                poolIndex++;
                            }
                        }
                    }
                }
            }
        }

        if (!query && this._sectionSeparator) {
            this._setSectionSeparatorLabel('Shelf actions');
            this._sectionSeparator.visible = true;
            this._setSeparatorIndex(poolIndex);

            this._populatePoolButton(poolIndex, {
                kind: 'shelf-capture-workspace',
                id: 'shelf-capture-workspace',
                name: 'Capture Current Workspace',
                description: 'Save the current layout with app contexts',
                iconName: 'view-grid-symbolic'
            });
            poolIndex++;

            this._populatePoolButton(poolIndex, {
                kind: 'shelf-add-clipboard',
                id: 'shelf-add-clipboard',
                name: 'Keep Clipboard Text',
                description: 'Store the current clipboard text as a snippet',
                iconName: 'edit-paste-symbolic'
            });
            poolIndex++;

            if (items.length > 0) {
                this._populatePoolButton(poolIndex, {
                    kind: 'shelf-clear',
                    id: 'shelf-clear',
                    name: 'Clear Shelf',
                    description: `${items.length} temporary item${items.length === 1 ? '' : 's'} will be removed`,
                    iconName: 'edit-clear-all-symbolic'
                });
                poolIndex++;
            }
        }

        if (poolIndex === 0) {
            this._showInfoLabel('Shelf is empty');
        }

        this._updateSelection();
        this._updateResultsHeight();
    }

    _decorateShelfTreeRecord(record, options = {}) {
        if (!record) return record;

        record.depth = Math.max(0, Math.floor(Number(options.depth ?? 0)));
        record.collapsible = !!options.collapsible;
        record.collapsed = !!options.collapsed;
        record.dndTarget = String(options.dndTarget || '');
        return record;
    }

    _shelfItemHasChildren(item) {
        if (!item || typeof item !== 'object') return false;
        if (Array.isArray(item.attachments) && item.attachments.length > 0) return true;
        if (Array.isArray(item.contexts) && item.contexts.length > 0) return true;
        return false;
    }

    _shelfItemMatchesQuery(item, normalizedQuery) {
        if (!normalizedQuery) return true;

        const attachmentText = Array.isArray(item.attachments)
            ? item.attachments.map(attachment => [
                attachment.label,
                attachment.value,
                attachment.path,
                attachment.uri
            ].join(' ')).join(' ')
            : '';
        const contextText = Array.isArray(item.contexts)
            ? item.contexts.map(context => [
                context.label,
                context.value,
                context.appId,
                ...(Array.isArray(context.attachments)
                    ? context.attachments.map(attachment => [
                        attachment.label,
                        attachment.value,
                        attachment.path,
                        attachment.uri
                    ].join(' '))
                    : [])
            ].join(' ')).join(' ')
            : '';

        return normalize([
            item.label,
            item.value,
            item.path,
            item.uri,
            item.appId,
            item.profileName,
            attachmentText,
            contextText
        ].join(' ')).includes(normalizedQuery);
    }

    _createShelfAddRecord(query) {
        const value = String(query ?? '').trim();
        let itemType = 'Text';
        let iconName = 'list-add-symbolic';

        if (/^https?:\/\//i.test(value)) {
            itemType = 'Link';
            iconName = 'web-browser-symbolic';
        } else if (value.startsWith('file://') || GLib.path_is_absolute(value)) {
            itemType = 'File';
            iconName = 'document-open-symbolic';
        }

        return {
            kind: 'shelf-add-text',
            id: `shelf-add:${value}`,
            name: `Keep ${itemType}`,
            description: value,
            iconName,
            value
        };
    }

    _isCurrentFileSearch(query, generation) {
        if (!this._isOpen || generation !== this._fileSearchGeneration) return false;

        const currentQuery = String(this._getSearchText() ?? '').trim();
        return currentQuery.startsWith(FILE_SEARCH_PREFIX) &&
            currentQuery.slice(FILE_SEARCH_PREFIX.length).trim() === query;
    }

    _isShelfAvailable() {
        const showInMenu = this._settings?.get_boolean('tweaks-essential-shelf-show-in-menu') ?? true;
        return showInMenu && !!this._shelf;
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

    _createInlineActionButton(iconName, accessibleName, callback, options = {}) {
        const colorStyle = options.destructive
            ? 'background-color: rgba(192, 28, 40, 0.16); border: 1px solid rgba(192, 28, 40, 0.38); color: #ffb4b8;'
            : this._isDark
                ? 'background-color: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.86);'
                : 'background-color: rgba(0, 0, 0, 0.05); border: 1px solid rgba(0, 0, 0, 0.08); color: rgba(0, 0, 0, 0.78);';

        const button = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            visible: false,
            accessible_name: accessibleName,
            style: `padding: 5px; border-radius: 8px; margin-left: 2px; min-width: 24px; min-height: 24px; ${colorStyle}`
        });
        button.set_child(new St.Icon({
            icon_name: iconName,
            icon_size: 14
        }));

        let pointerPressed = false;
        let pointerHandled = false;
        const runAction = () => {
            try {
                callback();
            } catch (e) {
                logError(`${accessibleName} failed: ${e.message}`);
            }
        };

        button.connect('button-press-event', () => {
            pointerPressed = true;
            pointerHandled = false;
            return Clutter.EVENT_STOP;
        });
        button.connect('button-release-event', () => {
            if (pointerPressed) {
                pointerHandled = true;
                pointerPressed = false;
                runAction();
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    pointerHandled = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_STOP;
        });
        button.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                pointerPressed = true;
                pointerHandled = false;
                return Clutter.EVENT_STOP;
            }
            if (event.type() === Clutter.EventType.TOUCH_END) {
                if (pointerPressed) {
                    pointerHandled = true;
                    pointerPressed = false;
                    runAction();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        pointerHandled = false;
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            if (pointerHandled) return;
            runAction();
        });
        return button;
    }

    _installSourceBadgeStyle(sourceType = '') {
        const palette = {
            flatpak: this._isDark
                ? ['rgba(28, 113, 216, 0.28)', 'rgba(98, 160, 234, 0.52)', '#d7e8ff']
                : ['rgba(28, 113, 216, 0.13)', 'rgba(28, 113, 216, 0.28)', '#1a5fb4'],
            snap: this._isDark
                ? ['rgba(145, 65, 172, 0.28)', 'rgba(192, 97, 203, 0.52)', '#f4d7ff']
                : ['rgba(145, 65, 172, 0.13)', 'rgba(145, 65, 172, 0.28)', '#813d9c'],
            webapp: this._isDark
                ? ['rgba(38, 162, 105, 0.24)', 'rgba(87, 227, 137, 0.46)', '#d9ffe8']
                : ['rgba(38, 162, 105, 0.12)', 'rgba(38, 162, 105, 0.28)', '#1b8553'],
            local: this._isDark
                ? ['rgba(229, 165, 10, 0.22)', 'rgba(245, 194, 17, 0.46)', '#fff0c2']
                : ['rgba(229, 165, 10, 0.13)', 'rgba(229, 165, 10, 0.30)', '#8f5d00'],
            native: this._isDark
                ? ['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.86)']
                : ['rgba(0, 0, 0, 0.05)', 'rgba(0, 0, 0, 0.12)', 'rgba(0, 0, 0, 0.74)']
        };
        const [bg, border, text] = palette[sourceType] || palette.native;

        return [
            'padding: 1px 7px',
            'border-radius: 999px',
            `background-color: ${bg}`,
            `border: 1px solid ${border}`,
            `color: ${text}`
        ].join('; ');
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
        button._delegate = button;
        button._shelfDragSource = true;
        button._shelfMenu = this;
        button.getDragActor = () => this._createInternalShelfDragActor(button._currentRecord);
        button.getDragActorSource = () => button;
        button._draggable = DND.makeDraggable(button);
        const maybeStartDrag = button._draggable._maybeStartDrag;
        button._draggable._maybeStartDrag = event => {
            if (false && this._isInternalShelfDragSourceRecord(button._currentRecord)) {
                return maybeStartDrag.call(button._draggable, event);
            }
            return false;
        };
        button._draggable.connect('drag-begin', () => {
            if (!this._isInternalShelfDragSourceRecord(button._currentRecord)) return;
            this._extendInternalShelfDragGrace(1400);
            this._suppressNextResultActivationBriefly(1600);
            log(`Internal Shelf drag started: ${button._currentRecord?.name || button._currentRecord?.id || 'item'}`);
            this._startInternalShelfDragMonitor(button);
        });
        button._draggable.connect('drag-cancelled', () => {
            log('Internal Shelf drag cancelled');
            this._stopInternalShelfDragMonitor();
        });
        button._draggable.connect('drag-end', () => {
            log('Internal Shelf drag ended');
            this._stopInternalShelfDragMonitor();
        });
        button.connect('button-press-event', (_actor, event) => {
            const record = this._visibleRecords[index];
            if (this._isInternalShelfDragSourceRecord(record) &&
                (event?.get_button?.() ?? 1) === 1) {
                this._beginManualShelfDrag(button, record, event);
                return Clutter.EVENT_STOP;
            }

            if (!record || !this._requiresDoubleClickActivation(record)) {
                return Clutter.EVENT_PROPAGATE;
            }

            if (this._selectedIndex !== index) {
                this._selectedIndex = index;
                this._updateSelection();
            }

            const clickCount = event?.get_click_count?.() ?? 1;
            const nowMs = Math.floor(GLib.get_monotonic_time() / 1000);
            const sameContext = this._lastContextClickId === record.id;
            const isFastSecondClick = sameContext &&
                nowMs - this._lastContextClickTimeMs <= CONTEXT_DOUBLE_CLICK_MS;

            this._lastContextClickId = record.id;
            this._lastContextClickTimeMs = nowMs;

            if (clickCount >= 2 || isFastSecondClick) {
                this._lastContextClickId = '';
                this._lastContextClickTimeMs = 0;
                this._launchRecord(record);
            }

            return Clutter.EVENT_STOP;
        });
        button.connect('clicked', () => {
            const record = this._visibleRecords[index];
            if (this._suppressNextResultClick) {
                this._suppressNextResultClick = false;
                if (this._suppressNextResultClickTimeoutId > 0) {
                    try {
                        GLib.source_remove(this._suppressNextResultClickTimeoutId);
                    } catch (e) {
                        // It may already have fired.
                    }
                    this._suppressNextResultClickTimeoutId = 0;
                }
                return;
            }
            if (this._requiresDoubleClickActivation(record)) return;
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

        const collapseBtn = this._createInlineActionButton('pan-end-symbolic', 'Expand or Collapse', () => {
            const record = this._visibleRecords[index];
            this._toggleShelfCollapse(record);
        });
        row.add_child(collapseBtn);

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
            style: 'min-width: 0px'
        });
        const titleRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            style: 'spacing: 8px; min-width: 0px'
        });
        const nameLabel = new St.Label({
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            style: 'font-size: 13px; font-weight: 700; color: inherit'
        });
        const sourceBadge = new St.Bin({
            visible: false,
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER
        });
        const sourceBadgeLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER
        });
        sourceBadge.set_child(sourceBadgeLabel);
        const detailLabel = new St.Label({
            x_align: Clutter.ActorAlign.START,
            style: `font-size: 11px; color: ${this._isDark ? 'rgba(255, 255, 255, 0.62)' : 'rgba(0, 0, 0, 0.54)'}`
        });
        try {
            nameLabel.clutter_text.set_x_align(Clutter.ActorAlign.START);
            sourceBadgeLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
            detailLabel.clutter_text.set_x_align(Clutter.ActorAlign.START);
            nameLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            sourceBadgeLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            detailLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            nameLabel.clutter_text.set_line_wrap(false);
            sourceBadgeLabel.clutter_text.set_line_wrap(false);
            detailLabel.clutter_text.set_line_wrap(false);
        } catch (e) {
            // Label behavior is best-effort across Shell versions.
        }
        titleRow.add_child(nameLabel);
        textBox.add_child(titleRow);
        textBox.add_child(detailLabel);
        row.add_child(textBox);
        const actionBox = new St.BoxLayout({
            vertical: false,
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px'
        });
        actionBox.add_child(sourceBadge);
        row.add_child(actionBox);

        const shelfAddBtn = this._createInlineActionButton('list-add-symbolic', 'Add to Shelf', () => {
            const record = this._visibleRecords[index];
            this._addRecordToShelf(record);
        });
        actionBox.add_child(shelfAddBtn);

        const shelfCopyBtn = this._createInlineActionButton('edit-copy-symbolic', 'Copy Shelf Item', () => {
            const record = this._visibleRecords[index];
            this._copyShelfRecord(record);
        });
        actionBox.add_child(shelfCopyBtn);

        const shelfRevealBtn = this._createInlineActionButton('folder-open-symbolic', 'Reveal Shelf Item', () => {
            const record = this._visibleRecords[index];
            this._revealShelfRecord(record);
        });
        actionBox.add_child(shelfRevealBtn);

        const shelfAttachBtn = this._createInlineActionButton('mail-attachment-symbolic', 'Attach To App Context', () => {
            const record = this._visibleRecords[index];
            this._attachShelfRecord(record);
        });
        actionBox.add_child(shelfAttachBtn);

        const shelfRenameBtn = this._createInlineActionButton('document-edit-symbolic', 'Rename Workspace Context', () => {
            const record = this._visibleRecords[index];
            this._renameShelfWorkspaceRecord(record);
        });
        actionBox.add_child(shelfRenameBtn);

        const shelfOverrideBtn = this._createInlineActionButton('document-save-symbolic', 'Override Workspace Context', () => {
            const record = this._visibleRecords[index];
            this._overrideShelfWorkspaceRecord(record);
        });
        actionBox.add_child(shelfOverrideBtn);

        const openNewWindowBtn = this._createInlineActionButton('window-new-symbolic', 'Open New Window', () => {
            const record = this._visibleRecords[index];
            this._openNewWindowForRecord(record);
        });
        actionBox.add_child(openNewWindowBtn);

        const shelfRemoveBtn = this._createInlineActionButton('user-trash-symbolic', 'Remove From Shelf', () => {
            const record = this._visibleRecords[index];
            this._removeShelfRecord(record);
        }, { destructive: true });
        actionBox.add_child(shelfRemoveBtn);

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

        actionBox.add_child(uninstallBtn);

        button.set_child(row);
        
        button._collapseBtn = collapseBtn;
        button._iconSlot = iconSlot;
        button._resultRow = row;
        button._actionBox = actionBox;
        button._textBox = textBox;
        button._titleRow = titleRow;
        button._nameLabel = nameLabel;
        button._sourceBadge = sourceBadge;
        button._sourceBadgeLabel = sourceBadgeLabel;
        button._detailLabel = detailLabel;
        button._shelfAddBtn = shelfAddBtn;
        button._shelfCopyBtn = shelfCopyBtn;
        button._shelfRevealBtn = shelfRevealBtn;
        button._shelfAttachBtn = shelfAttachBtn;
        button._shelfRenameBtn = shelfRenameBtn;
        button._shelfOverrideBtn = shelfOverrideBtn;
        button._openNewWindowBtn = openNewWindowBtn;
        button._shelfRemoveBtn = shelfRemoveBtn;
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
        const isShelfAttachment = record?.kind === 'shelf-attachment';
        const isWorkspaceAttachment = record?.kind === 'shelf-workspace-attachment';
        const isWorkspaceAppContext = record?.kind === 'shelf-workspace-app';
        const isNestedShelfRecord = isShelfAttachment || isWorkspaceAttachment || isWorkspaceAppContext;
        const iconSlotSize = (isShelfAttachment || isWorkspaceAttachment) ? RESULT_ATTACHMENT_ICON_SLOT_SIZE : RESULT_ICON_SLOT_SIZE;
        const iconSize = (isShelfAttachment || isWorkspaceAttachment) ? RESULT_ATTACHMENT_ICON_SIZE : RESULT_ICON_SIZE;

        button._iconSlot.width = iconSlotSize;
        button._iconSlot.height = iconSlotSize;
        button._iconSlot.style = `min-width: ${iconSlotSize}px; min-height: ${iconSlotSize}px`;
        button._iconSlot.set_child(this._createAppIcon(record, iconSize));

        if (button._resultRow) {
            const depth = Math.max(0, Math.floor(Number(record.depth || 0)));
            const spacing = isNestedShelfRecord ? 8 : 10;
            button._resultRow.style = `spacing: ${spacing}px; margin-left: ${depth * RESULT_ATTACHMENT_INDENT}px`;
        }

        if (button._textBox) {
            button._textBox.style = 'min-width: 0px';
        }
        if (button._titleRow) {
            button._titleRow.style = 'spacing: 8px; min-width: 0px';
        }
        if (button._sourceBadge && button._sourceBadgeLabel) {
            const source = record?.installSource || null;
            const sourceLabel = source?.sourceLabel || '';
            button._sourceBadge.visible = !!sourceLabel;
            if (sourceLabel) {
                button._sourceBadge.style = this._installSourceBadgeStyle(source.sourceType);
                button._sourceBadgeLabel.text = sourceLabel;
                button._sourceBadgeLabel.style = 'font-size: 9.5px; font-weight: 800; color: inherit; text-align: center';
            } else {
                button._sourceBadgeLabel.text = '';
            }
        }
        
        const isShelfItem = record?.kind === 'shelf-item';
        const isShelfLike = isShelfItem || isShelfAttachment || isWorkspaceAttachment;
        const shelfItemType = record?.shelfItem?.type || '';
        const isWorkspaceShelfItem = isShelfItem && shelfItemType === 'workspace';
        const isAppShelfItem = isShelfItem && shelfItemType === 'app';
        const canCopyShelfItem = isShelfLike && shelfItemType !== 'workspace';
        const canAddToShelf = this._isShelfAvailable() &&
            (record?.app || record?.kind === 'file' || (record?.kind === 'web-search' && record.uri));
        const canRevealShelfItem = isShelfLike &&
            (shelfItemType === 'file' || shelfItemType === 'folder');
        const canAttachShelfItem = isAppShelfItem || isWorkspaceShelfItem || isWorkspaceAppContext ||
            (isShelfItem && this._hasAppShelfContext(record.shelfItem?.id));
        const canOpenNewWindow = !!record?.app || isAppShelfItem || isWorkspaceAppContext;
        if (button._collapseBtn) {
            button._collapseBtn.visible = !!record.collapsible;
            button._collapseBtn.set_child(new St.Icon({
                icon_name: record.collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic',
                icon_size: 14
            }));
        }
        if (button._shelfAddBtn) {
            button._shelfAddBtn.visible = canAddToShelf;
        }
        if (button._shelfCopyBtn) {
            button._shelfCopyBtn.visible = canCopyShelfItem;
        }
        if (button._shelfRevealBtn) {
            button._shelfRevealBtn.visible = canRevealShelfItem;
        }
        if (button._shelfAttachBtn) {
            button._shelfAttachBtn.visible = canAttachShelfItem;
        }
        if (button._shelfRenameBtn) {
            button._shelfRenameBtn.visible = isWorkspaceShelfItem;
        }
        if (button._shelfOverrideBtn) {
            button._shelfOverrideBtn.visible = isWorkspaceShelfItem;
        }
        if (button._openNewWindowBtn) {
            button._openNewWindowBtn.visible = canOpenNewWindow;
        }
        if (button._shelfRemoveBtn) {
            button._shelfRemoveBtn.visible = isShelfLike;
        }

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
        button._currentRecord = record;
        button._shelfDndTarget = record.dndTarget || '';
        const activeDropTarget = this._internalShelfDragTarget || this._externalDndTargetRow;
        if (!button._shelfDndTarget || button._shelfDndTarget !== activeDropTarget) {
            button.remove_style_pseudo_class?.('drop');
        } else {
            button.add_style_pseudo_class?.('drop');
        }

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

    _setSectionSeparatorLabel(labelText) {
        try {
            if (this._sectionSeparator?._label) {
                this._sectionSeparator._label.text = labelText;
            }
        } catch (e) {
            // Cosmetic only.
        }
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
        const label = new St.Label({
            text: labelText,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 10px; font-weight: 700; color: ${this._isDark ? 'rgba(255, 255, 255, 0.58)' : 'rgba(0, 0, 0, 0.48)'}; text-transform: uppercase`
        });
        row.add_child(label);
        row.add_child(new St.Widget({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: lineStyle
        }));
        row._label = label;
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
        if (record?.previewGIcon) {
            try {
                return this._createPreviewIcon(record.previewGIcon, size);
            } catch (e) {
                // Fall through to normal icon handling.
            }
        }

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

    _createPreviewIcon(gicon, size) {
        const previewSize = Math.max(size + 8, RESULT_ICON_SLOT_SIZE);
        const bin = new St.Bin({
            width: previewSize,
            height: previewSize,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: this._isDark
                ? 'border-radius: 7px; background-color: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.16);'
                : 'border-radius: 7px; background-color: rgba(0, 0, 0, 0.04); border: 1px solid rgba(0, 0, 0, 0.10);'
        });
        bin.set_child(new St.Icon({
            gicon,
            icon_size: Math.max(size, previewSize - 6)
        }));
        return bin;
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
        if (this._isInternalShelfDragActive() || this._suppressNextResultClick) return;

        const keepOpen = this._shouldKeepMenuOpenForRecord(record);
        if (!keepOpen) this.close();

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                this._activateRecord(record);
                if (keepOpen && this._isOpen) {
                    this._renderResults(this._getSearchText());
                }
            } catch (e) {
                logError(`Failed to activate ${record.name}: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _shouldKeepMenuOpenForRecord(record) {
        return [
            'shelf-add-text',
            'shelf-add-clipboard',
            'shelf-capture-workspace',
            'shelf-clear'
        ].includes(record?.kind);
    }

    _requiresDoubleClickActivation(record) {
        return false;
    }

    _isInternalShelfDragSourceRecord(record) {
        if (!record?.shelfItem) return false;
        if (record.kind === 'shelf-attachment' || record.kind === 'shelf-workspace-attachment') return true;
        return record.kind === 'shelf-item' &&
            ['file', 'folder', 'url', 'text'].includes(record.shelfItem.type);
    }

    _isInternalShelfDragActive() {
        const nowMs = Math.floor(GLib.get_monotonic_time() / 1000);
        return !!this._internalShelfDragMonitoring ||
            !!this._internalShelfDragSourceButton ||
            !!this._manualShelfDrag ||
            nowMs < this._internalShelfDragGraceUntilMs;
    }

    _beginManualShelfDrag(sourceButton, sourceRecord, event) {
        if (!sourceButton || !sourceRecord) return;

        const [x, y] = event.get_coords();
        this._cancelManualShelfDrag(false);
        this._manualShelfDrag = {
            sourceButton,
            sourceRecord,
            startX: x,
            startY: y,
            x,
            y,
            active: false,
            actor: null,
            target: ''
        };
        this._extendInternalShelfDragGrace(1400);
    }

    _handleManualShelfDragCapturedEvent(event) {
        const drag = this._manualShelfDrag;
        if (!drag) return false;

        const eventType = event.type();
        if (eventType === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            drag.x = x;
            drag.y = y;

            if (!drag.active) {
                const dx = x - drag.startX;
                const dy = y - drag.startY;
                if (Math.sqrt(dx * dx + dy * dy) < INTERNAL_SHELF_DRAG_THRESHOLD) {
                    return true;
                }
                this._activateManualShelfDrag(drag);
            }

            this._updateManualShelfDrag(drag, x, y);
            return true;
        }

        if (eventType === Clutter.EventType.BUTTON_RELEASE ||
            eventType === Clutter.EventType.TOUCH_END) {
            const [x, y] = event.get_coords();
            const wasActive = !!drag.active;
            const target = wasActive
                ? (drag.target || this._getInternalShelfDropTargetAt(x, y, drag.sourceButton))
                : '';
            const sourceRecord = drag.sourceRecord;
            this._cancelManualShelfDrag(false);

            if (wasActive) {
                if (target && this._moveInternalShelfRecordToTarget(sourceRecord, target)) {
                    if (this._isOpen) this._renderResults(this._getSearchText());
                }
                return true;
            }

            this._internalShelfDragGraceUntilMs = 0;
            this._suppressNextResultClick = false;
            this._launchRecord(sourceRecord);
            return true;
        }

        if (eventType === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this._cancelManualShelfDrag(true);
            return true;
        }

        return false;
    }

    _activateManualShelfDrag(drag) {
        if (!drag || drag.active) return;

        drag.active = true;
        drag.actor = this._createInternalShelfDragActor(drag.sourceRecord);
        drag.actor.opacity = 230;
        Main.uiGroup.add_child(drag.actor);
        this._raiseActor(drag.actor);
        drag.sourceButton?.add_style_pseudo_class?.('active');
        this._suppressNextResultActivationBriefly(1600);
        this._extendInternalShelfDragGrace(1600);
        log(`Manual Shelf drag started: ${drag.sourceRecord?.name || drag.sourceRecord?.id || 'item'}`);
    }

    _updateManualShelfDrag(drag, x, y) {
        if (!drag?.active) return;

        if (drag.actor) {
            drag.actor.set_position(Math.round(x + 12), Math.round(y + 12));
        }

        drag.target = this._getInternalShelfDropTargetAt(x, y, drag.sourceButton);
        this._internalShelfDragTarget = drag.target;
        this._syncInternalShelfDragVisuals(drag.target);
        this._updateShelfDragAutoScroll(y);
    }

    _cancelManualShelfDrag(extendGrace = true) {
        const drag = this._manualShelfDrag;
        if (!drag) return;

        drag.actor?.destroy?.();
        drag.sourceButton?.remove_style_pseudo_class?.('active');
        this._manualShelfDrag = null;
        this._internalShelfDragTarget = '';
        this._cancelShelfDragAutoExpand();
        this._collapseAllShelfDragAutoExpanded();
        this._syncInternalShelfDragVisuals('');

        if (extendGrace) {
            this._extendInternalShelfDragGrace(900);
            this._suppressNextResultActivationBriefly(900);
        }
    }

    _extendInternalShelfDragGrace(durationMs = 900) {
        const nowMs = Math.floor(GLib.get_monotonic_time() / 1000);
        this._internalShelfDragGraceUntilMs = Math.max(
            this._internalShelfDragGraceUntilMs,
            nowMs + Math.max(0, durationMs)
        );
    }

    _suppressNextResultActivationBriefly(durationMs = 700) {
        this._suppressNextResultClick = true;
        if (this._suppressNextResultClickTimeoutId > 0) {
            try {
                GLib.source_remove(this._suppressNextResultClickTimeoutId);
            } catch (e) {
                // It may already have fired.
            }
        }

        this._suppressNextResultClickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
            this._suppressNextResultClick = false;
            this._suppressNextResultClickTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _createInternalShelfDragActor(record) {
        const label = String(record?.name || 'Shelf Item');
        const row = new St.BoxLayout({
            vertical: false,
            style_class: 'essential-menu-result',
            style: 'spacing: 8px; padding: 9px 12px; border-radius: 10px;'
        });

        row.add_child(this._createAppIcon(record || {
            iconName: 'mail-attachment-symbolic'
        }, RESULT_ATTACHMENT_ICON_SIZE));
        row.add_child(new St.Label({
            text: label.length > 42 ? `${label.slice(0, 39)}...` : label,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-weight: 700;'
        }));
        return row;
    }

    _startInternalShelfDragMonitor(sourceButton) {
        if (!sourceButton || this._internalShelfDragMonitoring) return;

        this._internalShelfDragSourceButton = sourceButton;
        this._internalShelfDragTarget = '';
        this._internalShelfDragMonitor = {
            dragMotion: this._onInternalShelfDragMotion.bind(this),
            dragDrop: this._onInternalShelfDragDrop.bind(this)
        };

        try {
            DND.addDragMonitor(this._internalShelfDragMonitor);
            this._internalShelfDragMonitoring = true;
            sourceButton.add_style_pseudo_class?.('active');
        } catch (e) {
            logError(`Failed to start internal Shelf drag monitor: ${e.message}`);
            this._internalShelfDragMonitor = null;
            this._internalShelfDragSourceButton = null;
            this._internalShelfDragMonitoring = false;
        }
    }

    _stopInternalShelfDragMonitor() {
        const hadInternalDrag = !!this._internalShelfDragMonitoring ||
            !!this._internalShelfDragSourceButton ||
            !!this._internalShelfDragTarget;

        if (this._internalShelfDragMonitoring && this._internalShelfDragMonitor) {
            try {
                DND.removeDragMonitor(this._internalShelfDragMonitor);
            } catch (e) {
                // The monitor may already be gone during Shell teardown.
            }
        }

        this._internalShelfDragMonitoring = false;
        this._internalShelfDragMonitor = null;
        this._internalShelfDragTarget = '';
        this._internalShelfDragSourceButton?.remove_style_pseudo_class?.('active');
        this._internalShelfDragSourceButton = null;
        this._cancelShelfDragAutoExpand();
        this._collapseAllShelfDragAutoExpanded();
        if (hadInternalDrag) {
            this._extendInternalShelfDragGrace(1100);
            this._suppressNextResultActivationBriefly(1100);
        }
        this._syncInternalShelfDragVisuals('');
    }

    _onInternalShelfDragMotion(dragEvent) {
        const sourceButton = this._getInternalShelfDragSourceButton(dragEvent?.source);
        if (!sourceButton) return DND.DragMotionResult.CONTINUE;

        const target = this._getInternalShelfDropTargetAt(
            Number(dragEvent?.x ?? 0),
            Number(dragEvent?.y ?? 0),
            sourceButton
        );
        this._internalShelfDragTarget = target;
        this._syncInternalShelfDragVisuals(target);
        return target ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
    }

    _onInternalShelfDragDrop(dropEvent) {
        const sourceButton = this._getInternalShelfDragSourceButton(dropEvent?.source) ||
            this._getInternalShelfDragSourceButton(dropEvent?.dropActor?.source);
        if (!sourceButton) return DND.DragDropResult.CONTINUE;

        const target = this._internalShelfDragTarget ||
            this._getInternalShelfDropTargetAt(
                Number(dropEvent?.x ?? 0),
                Number(dropEvent?.y ?? 0),
                sourceButton
            );
        const sourceRecord = sourceButton._currentRecord;
        const moved = target ? this._moveInternalShelfRecordToTarget(sourceRecord, target) : false;

        if (moved) {
            dropEvent?.dropActor?.destroy?.();
            log(`Internal Shelf drag completed: ${sourceRecord?.name || sourceRecord?.id || 'item'} -> ${target}`);
            this._stopInternalShelfDragMonitor();
            if (this._isOpen) this._renderResults(this._getSearchText());
        }

        return DND.DragDropResult.CONTINUE;
    }

    _getInternalShelfDragSourceButton(source) {
        if (source?._shelfDragSource) return source;
        if (source?._delegate?._shelfDragSource) return source._delegate;
        if (this._internalShelfDragSourceButton?._currentRecord) return this._internalShelfDragSourceButton;
        return null;
    }

    _getInternalShelfDropTargetAt(x, y, sourceButton) {
        if (!this._isOpen || !this._pointInsideActor(this._launcher, x, y)) return '';

        const sourceRecord = sourceButton?._currentRecord;
        const hoverKeys = this._getShelfTreeHoverKeysAt(x, y);
        this._collapseShelfDragAutoExpandedOutside(hoverKeys);
        let hoveredExpandableTarget = null;
        for (const button of this._resultButtons || []) {
            if (!button?.visible || button === sourceButton || !button._shelfDndTarget) continue;
            if (!this._pointInsideActor(button, x, y)) continue;

            const target = this._parseShelfDndTarget(button._shelfDndTarget);
            if (this._targetCanAutoExpand(target)) {
                hoveredExpandableTarget = target;
                this._scheduleShelfDragAutoExpand(target);
            }

            if (this._canAcceptInternalShelfDrop(sourceRecord, target)) {
                return button._shelfDndTarget;
            }
        }

        if (!hoveredExpandableTarget) this._cancelShelfDragAutoExpand();
        return '';
    }

    _syncInternalShelfDragVisuals(target) {
        try {
            for (const button of this._resultButtons || []) {
                if (button?._shelfDndTarget && button._shelfDndTarget === target) {
                    button.add_style_pseudo_class?.('drop');
                } else if (button?._shelfDndTarget && button._shelfDndTarget !== this._externalDndTargetRow) {
                    button.remove_style_pseudo_class?.('drop');
                }
            }
        } catch (e) {
            // Visual hint only.
        }
    }

    _canAcceptInternalShelfDrop(sourceRecord, target) {
        if (!this._isInternalShelfDragSourceRecord(sourceRecord) || !target) return false;

        if (target.type === 'app') {
            return sourceRecord.kind !== 'shelf-attachment' ||
                sourceRecord.parentAppItem?.id !== target.appItemId;
        }

        if (target.type === 'workspace-app') {
            return sourceRecord.kind !== 'shelf-workspace-attachment' ||
                sourceRecord.parentWorkspaceItem?.id !== target.workspaceItemId ||
                sourceRecord.parentWorkspaceContext?.id !== target.contextId;
        }

        if (target.type === 'workspace') {
            const workspaceItem = this._shelf?.getItem?.(target.workspaceItemId);
            return !!this._getWorkspaceDropContext(workspaceItem)?.id;
        }

        return false;
    }

    _moveInternalShelfRecordToTarget(sourceRecord, targetValue) {
        if (!this._shelf || !sourceRecord) return false;

        const target = this._parseShelfDndTarget(targetValue);
        if (!this._canAcceptInternalShelfDrop(sourceRecord, target)) return false;

        let attached = null;
        if (target.type === 'app') {
            attached = this._attachShelfRecordValueToApp(sourceRecord, target.appItemId);
        } else if (target.type === 'workspace-app') {
            attached = this._attachShelfRecordValueToWorkspaceContext(
                sourceRecord,
                target.workspaceItemId,
                target.contextId
            );
        } else if (target.type === 'workspace') {
            const workspaceItem = this._shelf.getItem?.(target.workspaceItemId);
            const context = this._getWorkspaceDropContext(workspaceItem);
            if (context?.id) {
                attached = this._attachShelfRecordValueToWorkspaceContext(
                    sourceRecord,
                    target.workspaceItemId,
                    context.id
                );
            }
        }

        if (!attached) return false;

        this._removeInternalShelfDragSource(sourceRecord);
        this._notifyShelf(`Moved "${sourceRecord.name || 'context'}" into Shelf context.`);
        return true;
    }

    _getShelfTreeHoverKeysAt(x, y) {
        const keys = new Set();

        for (const button of this._resultButtons || []) {
            if (!button?.visible || !this._pointInsideActor(button, x, y)) continue;

            const record = button._currentRecord;
            const target = this._parseShelfDndTarget(button._shelfDndTarget || '');

            if (target?.type === 'app') {
                keys.add(`app:${target.appItemId}`);
            } else if (target?.type === 'workspace') {
                keys.add(`workspace:${target.workspaceItemId}`);
            } else if (target?.type === 'workspace-app') {
                keys.add(`workspace:${target.workspaceItemId}`);
                keys.add(`workspace-app:${target.workspaceItemId}:${target.contextId}`);
            }

            if (record?.kind === 'shelf-attachment' && record.parentAppItem?.id) {
                keys.add(`app:${record.parentAppItem.id}`);
            }

            if (record?.kind === 'shelf-workspace-app' && record.parentWorkspaceItem?.id && record.shelfItem?.id) {
                keys.add(`workspace:${record.parentWorkspaceItem.id}`);
                keys.add(`workspace-app:${record.parentWorkspaceItem.id}:${record.shelfItem.id}`);
            }

            if (record?.kind === 'shelf-workspace-attachment' &&
                record.parentWorkspaceItem?.id &&
                record.parentWorkspaceContext?.id) {
                keys.add(`workspace:${record.parentWorkspaceItem.id}`);
                keys.add(`workspace-app:${record.parentWorkspaceItem.id}:${record.parentWorkspaceContext.id}`);
            }
        }

        return keys;
    }

    _scheduleShelfDragAutoExpand(target) {
        const expandable = this._getShelfAutoExpandableTarget(target);
        if (!expandable || !this._shelf) {
            this._cancelShelfDragAutoExpand();
            return;
        }

        if (this._shelfDragAutoExpandTargetId === expandable.key && this._shelfDragAutoExpandTimeoutId > 0) return;
        this._cancelShelfDragAutoExpand();

        this._shelfDragAutoExpandTargetId = expandable.key;
        this._shelfDragAutoExpandTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SHELF_DRAG_AUTO_EXPAND_DELAY_MS,
            () => {
                this._shelfDragAutoExpandTimeoutId = 0;
                const current = this._getShelfAutoExpandableTarget(target);
                if (current) {
                    current.expand();
                    this._shelfDragAutoExpanded.set(current.key, current);
                    if (this._isOpen) this._renderResults(this._getSearchText());
                }
                this._shelfDragAutoExpandTargetId = '';
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _targetCanAutoExpand(target) {
        return !!this._getShelfAutoExpandableTarget(target);
    }

    _getShelfAutoExpandableTarget(target) {
        if (!target || !this._shelf) return null;

        if (target.type === 'app') {
            const item = this._shelf.getItem?.(target.appItemId);
            const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
            if (item?.type !== 'app' || !item.collapsed || attachments.length === 0) return null;
            const key = `app:${item.id}`;
            return {
                key,
                collapse: () => this._shelf?.setItemCollapsed?.(item.id, true),
                expand: () => this._shelf?.setItemCollapsed?.(item.id, false)
            };
        }

        if (target.type === 'workspace') {
            const item = this._shelf.getItem?.(target.workspaceItemId);
            const contexts = Array.isArray(item?.contexts) ? item.contexts : [];
            if (item?.type !== 'workspace' || !item.collapsed || contexts.length === 0) return null;
            const key = `workspace:${item.id}`;
            return {
                key,
                collapse: () => this._shelf?.setItemCollapsed?.(item.id, true),
                expand: () => this._shelf?.setItemCollapsed?.(item.id, false)
            };
        }

        if (target.type === 'workspace-app') {
            const workspace = this._shelf.getItem?.(target.workspaceItemId);
            const context = (workspace?.contexts || []).find(item => item.id === target.contextId);
            const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
            if (!workspace || !context || !context.collapsed || attachments.length === 0) return null;
            const key = `workspace-app:${workspace.id}:${context.id}`;
            return {
                key,
                collapse: () => this._shelf?.setWorkspaceContextCollapsed?.(workspace.id, context.id, true),
                expand: () => this._shelf?.setWorkspaceContextCollapsed?.(workspace.id, context.id, false)
            };
        }

        return null;
    }

    _cancelShelfDragAutoExpand() {
        if (this._shelfDragAutoExpandTimeoutId > 0) {
            try {
                GLib.source_remove(this._shelfDragAutoExpandTimeoutId);
            } catch (e) {
                // It may already have fired.
            }
        }

        this._shelfDragAutoExpandTimeoutId = 0;
        this._shelfDragAutoExpandTargetId = '';
    }

    _cancelShelfDragAutoCollapse(key = '') {
        if (!this._shelfDragAutoCollapseTimeouts) return;

        if (key) {
            const timeoutId = this._shelfDragAutoCollapseTimeouts.get(key) || 0;
            if (timeoutId > 0) {
                try {
                    GLib.source_remove(timeoutId);
                } catch (e) {
                    // It may already have fired.
                }
            }
            this._shelfDragAutoCollapseTimeouts.delete(key);
            return;
        }

        for (const timeoutId of this._shelfDragAutoCollapseTimeouts.values()) {
            if (timeoutId > 0) {
                try {
                    GLib.source_remove(timeoutId);
                } catch (e) {
                    // It may already have fired.
                }
            }
        }
        this._shelfDragAutoCollapseTimeouts.clear();
    }

    _scheduleShelfDragAutoCollapse(key, target) {
        if (!key || !target || !this._shelfDragAutoCollapseTimeouts) return;
        if (this._shelfDragAutoCollapseTimeouts.has(key)) return;

        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SHELF_DRAG_AUTO_COLLAPSE_DELAY_MS,
            () => {
                this._shelfDragAutoCollapseTimeouts.delete(key);
                if (!this._shelfDragAutoExpanded.has(key)) {
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    target.collapse?.();
                } catch (e) {
                    logError(`Failed to auto-collapse Shelf target ${key}: ${e.message}`);
                }
                this._shelfDragAutoExpanded.delete(key);
                if (this._isOpen) this._renderResults(this._getSearchText());
                return GLib.SOURCE_REMOVE;
            }
        );

        this._shelfDragAutoCollapseTimeouts.set(key, timeoutId);
    }

    _collapseShelfDragAutoExpandedOutside(activeKeys = new Set(), immediate = false) {
        if (!(activeKeys instanceof Set)) activeKeys = new Set();
        if (this._shelfDragAutoExpanded.size === 0) {
            if (immediate) this._cancelShelfDragAutoCollapse();
            return;
        }

        let changed = false;
        for (const [key, target] of [...this._shelfDragAutoExpanded.entries()]) {
            if (activeKeys.has(key)) {
                this._cancelShelfDragAutoCollapse(key);
                continue;
            }

            if (!immediate) {
                this._scheduleShelfDragAutoCollapse(key, target);
                continue;
            }

            this._cancelShelfDragAutoCollapse(key);
            try {
                target.collapse?.();
                changed = true;
            } catch (e) {
                logError(`Failed to auto-collapse Shelf target ${key}: ${e.message}`);
            }
            this._shelfDragAutoExpanded.delete(key);
        }

        if (changed && this._isOpen) this._renderResults(this._getSearchText());
    }

    _collapseAllShelfDragAutoExpanded() {
        this._cancelShelfDragAutoCollapse();
        this._collapseShelfDragAutoExpandedOutside(new Set(), true);
    }

    _updateShelfDragAutoScroll(stageY) {
        if (!this._resultsScrollView || !this._resultsBox) return;

        const adjustment = this._getResultsVAdjustment();
        if (!adjustment) return;

        try {
            const [, viewY] = this._resultsScrollView.get_transformed_position();
            let viewHeight = 0;
            if (typeof this._resultsScrollView.get_transformed_size === 'function') {
                [, viewHeight] = this._resultsScrollView.get_transformed_size();
            } else {
                const box = this._resultsScrollView.get_allocation_box();
                viewHeight = box.y2 - box.y1;
            }
            if (!Number.isFinite(viewY) || !Number.isFinite(viewHeight) || viewHeight <= 0) return;

            const localY = Number(stageY) - viewY;
            let direction = 0;
            let strength = 0;

            if (localY < SHELF_DRAG_AUTO_SCROLL_EDGE_PX) {
                direction = -1;
                strength = 1 - Math.max(0, localY) / SHELF_DRAG_AUTO_SCROLL_EDGE_PX;
            } else if (localY > viewHeight - SHELF_DRAG_AUTO_SCROLL_EDGE_PX) {
                direction = 1;
                strength = 1 - Math.max(0, viewHeight - localY) / SHELF_DRAG_AUTO_SCROLL_EDGE_PX;
            }

            if (direction === 0 || strength <= 0) return;

            const currentTarget = this._scrollTimeline && this._scrollTimeline.is_playing()
                ? this._scrollTargetValue
                : adjustment.get_value();
            const delta = direction * SHELF_DRAG_AUTO_SCROLL_STEP * Math.max(0.35, strength);
            const next = this._clampScrollValue(adjustment, currentTarget + delta);
            if (Math.abs(next - adjustment.get_value()) < 0.2) return;

            this._scrollTargetValue = next;
            this._ensureScrollTimeline();
        } catch (e) {
            logError(`Shelf drag auto-scroll failed: ${e.message}`);
        }
    }

    _attachShelfRecordValueToApp(sourceRecord, appItemId) {
        const item = sourceRecord?.shelfItem;
        if (!item || !appItemId) return null;

        if (item.type === 'text') {
            return this._shelf.attachTextToApp?.(appItemId, item.value || item.label || '', item.label || '');
        }

        return this._shelf.attachValueToApp?.(
            appItemId,
            item.uri || item.value || item.path || '',
            item.label || '',
            item.iconName || ''
        );
    }

    _attachShelfRecordValueToWorkspaceContext(sourceRecord, workspaceItemId, contextId) {
        const item = sourceRecord?.shelfItem;
        if (!item || !workspaceItemId || !contextId) return null;

        if (item.type === 'text') {
            return this._shelf.attachTextToWorkspaceContext?.(
                workspaceItemId,
                contextId,
                item.value || item.label || '',
                item.label || ''
            );
        }

        return this._shelf.attachValueToWorkspaceContext?.(
            workspaceItemId,
            contextId,
            item.uri || item.value || item.path || '',
            item.label || '',
            item.iconName || ''
        );
    }

    _removeInternalShelfDragSource(sourceRecord) {
        const item = sourceRecord?.shelfItem;
        if (!item?.id) return;

        if (sourceRecord.kind === 'shelf-item') {
            if (!['app', 'workspace'].includes(item.type)) {
                this._shelf?.remove?.(item.id);
            }
            return;
        }

        if (sourceRecord.kind === 'shelf-attachment') {
            const parent = sourceRecord.parentAppItem;
            if (parent?.id) this._shelf?.removeAttachment?.(parent.id, item.id);
            return;
        }

        if (sourceRecord.kind === 'shelf-workspace-attachment') {
            const workspace = sourceRecord.parentWorkspaceItem;
            const context = sourceRecord.parentWorkspaceContext;
            if (workspace?.id && context?.id) {
                this._shelf?.removeWorkspaceContextAttachment?.(workspace.id, context.id, item.id);
            }
        }
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
            case 'shelf-add-text':
                this._addTextToShelf(record.value);
                return;
            case 'shelf-add-clipboard':
                this._addClipboardToShelf();
                return;
            case 'shelf-capture-workspace':
                this._captureWorkspaceContextToShelf();
                return;
            case 'shelf-clear':
                this._clearShelf();
                return;
            case 'shelf-item':
                this._openShelfRecord(record);
                return;
            case 'shelf-workspace-app':
                this._openShelfWorkspaceAppRecord(record);
                return;
            case 'shelf-workspace-attachment':
                this._openShelfRecord(record);
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
        const uri = this._buildWebSearchUri(query);
        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(uri, context);
        log(`Opened web search using ${engine}: ${query}`);
    }

    _buildWebSearchUri(query) {
        const engine = this._settings?.get_string('tweaks-essential-menu-default-search-engine') ?? 'duckduckgo';
        let prefix = WEB_SEARCH_URI_PREFIX;
        if (engine === 'google') prefix = 'https://www.google.com/search?q=';
        else if (engine === 'bing') prefix = 'https://www.bing.com/search?q=';

        return prefix + encodeURIComponent(String(query ?? '').trim());
    }

    _openFile(uri) {
        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(uri, context);
        log(`Opened file search result: ${uri}`);
    }

    _openUri(uri) {
        const value = String(uri ?? '').trim();
        if (!value) return;

        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(value, context);
    }

    _addRecordToShelf(record) {
        if (!this._isShelfAvailable() || !record) return;

        const item = this._shelf.addFromRecord(this._prepareShelfRecord(record));
        if (item) {
            const linkedProfile = item.type === 'app' && item.profileName
                ? ` with "${item.profileName}" layout`
                : '';
            this._notifyShelf(`Added "${item.label}"${linkedProfile} to Shelf.`);
        }
    }

    _prepareShelfRecord(record) {
        if (!record?.app || !record?.id) return record;

        const profileName = this._getShelfProfileForApp(record.id, record.profileName || '');
        return {
            ...record,
            profileName
        };
    }

    _getShelfProfileForApp(appId, preferredProfileName = '') {
        const candidates = [
            String(preferredProfileName ?? '').trim(),
            this._getActiveWorkspaceProfileName()
        ].filter(Boolean);

        for (const profileName of candidates) {
            if (this._profileContainsApp(profileName, appId)) return profileName;
        }

        return '';
    }

    _getActiveWorkspaceProfileName() {
        try {
            return String(this._settings?.get_string('profiles-active-profile') || '').trim();
        } catch (e) {
            return '';
        }
    }

    _hasAppShelfContext(excludeId = '') {
        return !!this._shelf?.getMostRecentAppItem?.(excludeId || '');
    }

    _attachShelfRecord(record) {
        if (!this._isShelfAvailable()) return;

        if (record?.kind === 'shelf-workspace-app') {
            const context = record.shelfItem;
            const workspace = record.parentWorkspaceItem;
            if (!context?.id || !workspace?.id) return;

            this._readClipboardText(text => {
                const value = String(text ?? '').trim();
                if (!value) {
                    this._notifyShelf('Clipboard is empty.');
                    return;
                }

                const attachment = this._shelf?.attachTextToWorkspaceContext?.(workspace.id, context.id, value);
                if (attachment) {
                    this._notifyShelf(`Attached clipboard text to ${context.label}.`);
                    if (this._isOpen) this._renderResults(this._getSearchText());
                }
            });
            return;
        }

        if (record?.kind !== 'shelf-item') return;

        const item = record.shelfItem;
        if (!item) return;

        if (item.type === 'workspace') {
            const context = this._getWorkspaceDropContext(item);
            if (!context?.id) {
                this._notifyShelf('Expand the workspace and use an app row.');
                return;
            }

            this._readClipboardText(text => {
                const value = String(text ?? '').trim();
                if (!value) {
                    this._notifyShelf('Clipboard is empty.');
                    return;
                }

                const attachment = this._shelf?.attachTextToWorkspaceContext?.(item.id, context.id, value);
                if (attachment) {
                    this._notifyShelf(`Attached clipboard text to ${context.label}.`);
                    if (this._isOpen) this._renderResults(this._getSearchText());
                }
            });
            return;
        }

        if (item.type === 'app') {
            this._readClipboardText(text => {
                const value = String(text ?? '').trim();
                if (!value) {
                    this._notifyShelf('Clipboard is empty.');
                    return;
                }

                const attachment = this._shelf?.attachTextToApp?.(item.id, value);
                if (attachment) {
                    this._notifyShelf(`Attached clipboard text to ${item.label}.`);
                    if (this._isOpen) this._renderResults(this._getSearchText());
                }
            });
            return;
        }

        const appItem = this._shelf?.getMostRecentAppItem?.(item.id);
        if (!appItem) {
            this._notifyShelf('Add an app to Shelf first.');
            return;
        }

        const attachment = this._shelf?.attachItemToApp?.(appItem.id, item.id);
        if (attachment) {
            this._notifyShelf(`Attached "${item.label}" to ${appItem.label}.`);
            if (this._isOpen) this._renderResults(this._getSearchText());
        }
    }

    _toggleShelfCollapse(record) {
        if (!this._isShelfAvailable() || !record?.collapsible) return;

        const nextCollapsed = !record.collapsed;
        if (record.kind === 'shelf-item') {
            const item = record.shelfItem;
            if (item?.id) {
                this._shelf?.setItemCollapsed?.(item.id, nextCollapsed);
            }
        } else if (record.kind === 'shelf-workspace-app') {
            const workspace = record.parentWorkspaceItem;
            const context = record.shelfItem;
            if (workspace?.id && context?.id) {
                this._shelf?.setWorkspaceContextCollapsed?.(workspace.id, context.id, nextCollapsed);
            }
        }

        if (this._isOpen) this._renderResults(this._getSearchText());
    }

    _renameShelfWorkspaceRecord(record) {
        if (!this._isShelfAvailable() || record?.kind !== 'shelf-item') return;

        const item = record.shelfItem;
        if (!item || item.type !== 'workspace') return;

        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'profiles-rename-dialog'
        });
        const title = new St.Label({
            text: 'Rename Workspace Context',
            style_class: 'headline'
        });
        const entry = new St.Entry({
            text: item.label || item.profileName || item.value || '',
            can_focus: true,
            x_expand: true
        });

        const submit = () => {
            const newName = String(entry.get_text?.() || '').trim();
            if (!newName) {
                this._notifyShelf('Workspace name cannot be empty.');
                return;
            }

            const oldName = item.profileName || item.value || item.label || '';
            if (oldName !== newName && !this._renameWorkspaceProfile(oldName, newName)) {
                return;
            }

            const updated = this._shelf?.renameWorkspaceContext?.(item.id, newName, newName);
            if (updated) {
                this._notifyShelf(`Renamed workspace context to "${newName}".`);
                dialog.close();
                if (this._isOpen) this._renderResults(this._getSearchText());
            }
        };

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
                action: submit,
                default: true
            }
        ]);
        dialog.open();
        entry.grab_key_focus();
        entry.clutter_text?.set_selection?.(0, entry.get_text().length);
        entry.clutter_text?.connect?.('activate', submit);
    }

    _overrideShelfWorkspaceRecord(record) {
        if (!this._isShelfAvailable() || record?.kind !== 'shelf-item') return;

        const item = record.shelfItem;
        if (!item || item.type !== 'workspace') return;

        const profileName = item.profileName || item.value || '';
        if (!profileName) return;

        const profiles = this._getProfilesService();
        if (!profiles || typeof profiles.saveCurrentLayout !== 'function') {
            this._notifyShelf('Workspace Profiles is not available.');
            return;
        }

        const result = profiles.saveCurrentLayout(profileName, {
            source: 'shelf-context',
            overwrite: true,
            operation: 'modify'
        });

        if (!result?.ok) {
            this._notifyShelf(result?.message || `Could not update "${profileName}".`);
            return;
        }

        const profile = this._getWorkspaceProfileEntry(profileName);
        const contexts = this._buildWorkspaceContextsFromProfile(profile);
        const updated = this._shelf?.updateWorkspaceContext?.(item.id, profileName, item.label || profileName, contexts, {
            preserveExistingAttachments: true
        });

        if (updated) {
            this._notifyShelf(`Updated workspace context "${updated.label || profileName}".`);
        } else {
            this._notifyShelf(`Updated "${profileName}", but could not refresh its Shelf context.`);
        }

        if (this._isOpen) this._renderResults(this._getSearchText());
    }

    _renameWorkspaceProfile(oldName, newName) {
        const profiles = this._getProfilesService();
        if (!oldName || oldName === newName) return true;

        try {
            if (profiles && typeof profiles.renameProfile === 'function') {
                return !!profiles.renameProfile(oldName, newName);
            }
        } catch (e) {
            logError(`Workspace profile rename failed: ${e.message}`);
        }

        this._notifyShelf('Workspace Profiles is not available.');
        return false;
    }

    _deleteWorkspaceProfile(profileName) {
        const profiles = this._getProfilesService();
        if (!profileName) return false;

        try {
            if (profiles && typeof profiles.deleteProfile === 'function') {
                return !!profiles.deleteProfile(profileName);
            }
        } catch (e) {
            logError(`Workspace profile delete failed: ${e.message}`);
        }

        return false;
    }

    _getProfilesService() {
        return global.gnome_essentials_profiles || null;
    }

    _importExternalDndSelection(target = '') {
        if (!this._shelf) {
            this._notifyShelf('Enable Essential Shelf to accept dropped files.');
            return;
        }

        if (this._externalDndCachedValues.length > 0) {
            const values = [...this._externalDndCachedValues];
            this._resetExternalDndSelectionCache();
            this._finishExternalDndImport(values, target);
            return;
        }

        if (this._externalDndSelectionPending) {
            this._externalDndPendingImportTarget = target;
            return;
        }

        this._externalDndPendingImportTarget = target;
        this._primeExternalDndSelection(true);
    }

    _finishExternalDndImport(values, target = '') {
        if (!values || values.length === 0) {
            this._notifyShelf('Dropped item did not expose file, link, or text data.');
            return;
        }

        let added = 0;
        const rowTarget = this._parseShelfDndTarget(target);
        for (const value of values) {
            if (rowTarget
                ? this._addExternalDndValueToTarget(value, rowTarget)
                : this._addExternalDndValueToShelf(value)) {
                added += 1;
            }
        }

        if (added > 0) {
            const action = rowTarget ? 'Attached' : 'Added';
            const destination = rowTarget ? 'context' : 'Shelf';
            this._notifyShelf(`${action} ${added} dropped item${added === 1 ? '' : 's'} to ${destination}.`);
            this._showShelfAfterDrop(target);
        } else {
            this._notifyShelf('Dropped items were already stored or could not be added.');
        }
    }

    _addExternalDndValueToShelf(value) {
        if (!this._shelf) return null;

        const text = String(value ?? '').trim();
        if (!text) return null;

        if (/^(file|https?):\/\//i.test(text) || GLib.path_is_absolute(text)) {
            return this._shelf.addUri(text);
        }

        return this._shelf.addText(text);
    }

    _parseShelfDndTarget(target) {
        const value = String(target || '');
        if (value.startsWith('app:')) {
            const appItemId = value.slice('app:'.length);
            return appItemId ? { type: 'app', appItemId } : null;
        }

        if (value.startsWith('workspace-app:')) {
            const parts = value.split(':');
            const workspaceItemId = parts[1] || '';
            const contextId = parts[2] || '';
            return workspaceItemId && contextId
                ? { type: 'workspace-app', workspaceItemId, contextId }
                : null;
        }

        if (value.startsWith('workspace:')) {
            const workspaceItemId = value.slice('workspace:'.length);
            return workspaceItemId ? { type: 'workspace', workspaceItemId } : null;
        }

        return null;
    }

    _addExternalDndValueToTarget(value, target) {
        if (!this._shelf || !target) return null;

        const text = String(value ?? '').trim();
        if (!text) return null;

        if (target.type === 'app') {
            return this._shelf.attachValueToApp?.(target.appItemId, text);
        }

        if (target.type === 'workspace-app') {
            return this._shelf.attachValueToWorkspaceContext?.(target.workspaceItemId, target.contextId, text);
        }

        if (target.type === 'workspace') {
            const workspaceItem = this._shelf.getItem?.(target.workspaceItemId);
            const context = this._getWorkspaceDropContext(workspaceItem);
            if (!context?.id) return null;
            return this._shelf.attachValueToWorkspaceContext?.(target.workspaceItemId, context.id, text);
        }

        return null;
    }

    _primeExternalDndSelection(notifyOnError = false) {
        if (this._externalDndSelectionRequested || this._externalDndSelectionPending) return;

        this._externalDndSelectionRequested = true;
        this._externalDndSelectionPending = true;

        this._readExternalDndText((text, mimetype, mimetypes) => {
            const values = this._parseExternalDndValues(text, mimetype);
            this._externalDndSelectionPending = false;
            this._externalDndCachedValues = values;
            this._externalDndCachedMimetype = mimetype;
            log(`External DND payload ${values.length} item(s), mimetype=${mimetype}, offered=${mimetypes.join(', ') || '(none)'}`);

            if (this._externalDndPendingImportTarget) {
                const target = this._externalDndPendingImportTarget;
                this._externalDndPendingImportTarget = '';
                this._resetExternalDndSelectionCache();
                this._finishExternalDndImport(values, target);
            }
        }, (message, mimetypes = []) => {
            this._externalDndSelectionPending = false;
            log(`External DND unreadable: ${message}; offered=${mimetypes.join(', ') || '(none)'}`);

            if (notifyOnError || this._externalDndPendingImportTarget) {
                this._notifyShelf(message);
            }

            this._externalDndPendingImportTarget = '';
            this._resetExternalDndSelectionCache();
        });
    }

    _resetExternalDndSelectionCache() {
        this._externalDndSelectionRequested = false;
        this._externalDndSelectionPending = false;
        this._externalDndCachedValues = [];
        this._externalDndCachedMimetype = '';
        this._externalDndPendingImportTarget = '';
    }

    _showShelfAfterDrop(target = '') {
        if (target === 'panel' && !this._isOpen) {
            try {
                this.open();
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this._isOpen) this._activateSearchMode(SHELF_PREFIX);
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                logError(`Could not open Shelf after drop: ${e.message}`);
            }
            return;
        }

        if (this._isOpen || target === 'menu') {
            this._activateSearchMode(SHELF_PREFIX);
        }
    }

    _readExternalDndText(callback, onError = null) {
        let selection = null;
        try {
            selection = global.display.get_selection();
        } catch (e) {
            onError?.('External drag data is not available in this Shell session.', []);
            return;
        }

        const selectionType = Meta.SelectionType?.SELECTION_DND;
        if (selectionType === undefined) {
            onError?.('This GNOME Shell build does not expose DND selection data.', []);
            return;
        }

        let mimetypes = [];
        try {
            mimetypes = selection.get_mimetypes(selectionType) || [];
        } catch (e) {
            logError(`Could not read DND mimetypes: ${e.message}`);
        }

        const mimetype = this._chooseExternalDndMimetype(mimetypes);

        if (!mimetype) {
            onError?.('Dropped item did not provide readable URI data.', mimetypes);
            return;
        }

        try {
            const stream = Gio.MemoryOutputStream.new_resizable();
            selection.transfer_async(selectionType, mimetype, -1, stream, null, (selectionObject, result) => {
                try {
                    selectionObject.transfer_finish(result);
                    const bytes = stream.steal_as_bytes();
                    const data = bytes.get_data();
                    const text = new TextDecoder().decode(data);
                    callback(text, mimetype, mimetypes);
                } catch (e) {
                    logError(`Could not transfer DND data: ${e.message}`);
                    onError?.('Could not read dropped item data.', mimetypes);
                }
            });
        } catch (e) {
            logError(`Could not start DND transfer: ${e.message}`);
            onError?.('Could not read dropped item data.', mimetypes);
        }
    }

    _chooseExternalDndMimetype(mimetypes) {
        const offered = Array.isArray(mimetypes) ? mimetypes : [];
        const lowerToOriginal = new Map(offered.map(type => [String(type).toLowerCase(), type]));
        const preferred = [
            'text/uri-list',
            'x-special/gnome-copied-files',
            'x-special/gnome-icon-list',
            'text/x-moz-url',
            'text/plain;charset=utf-8',
            'text/plain',
            'utf8_string',
            'string',
        ];

        for (const type of preferred) {
            if (lowerToOriginal.has(type)) return lowerToOriginal.get(type);
        }

        return offered.find(type => /uri|url|gnome.*icon|copied-files/i.test(type)) ||
            offered.find(type => /^text\//i.test(type)) ||
            '';
    }

    _parseExternalDndValues(text, mimetype = '') {
        const payload = String(text ?? '').replace(/\0/g, '\n');
        const uriMatches = payload.match(/\b(?:file|https?):\/\/[^\s"'<>]+/gi) || [];
        const lines = payload
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        const normalizedMimetype = String(mimetype ?? '').toLowerCase();

        if (normalizedMimetype === 'x-special/gnome-copied-files' &&
            lines.length > 0 &&
            ['copy', 'cut'].includes(lines[0].toLowerCase())) {
            lines.shift();
        }

        let lineValues = lines;
        if (normalizedMimetype === 'text/x-moz-url') {
            lineValues = lines.slice(0, 1);
        } else if (normalizedMimetype === 'x-special/gnome-icon-list') {
            lineValues = lines.map(line => {
                const token = line.split(/\s+/).find(part => /^(file|https?):\/\//i.test(part));
                return token || line;
            });
        }

        const normalizedValues = [...uriMatches, ...lineValues]
            .filter(line => !line.startsWith('#'))
            .map(line => this._normalizeDroppedValue(line))
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index);

        if (normalizedValues.length > 0) return normalizedValues;

        if (this._isPlainTextExternalDndMimetype(normalizedMimetype)) {
            const droppedText = payload.trim();
            return droppedText ? [droppedText] : [];
        }

        return [];
    }

    _isPlainTextExternalDndMimetype(mimetype) {
        const normalized = String(mimetype ?? '').toLowerCase();
        return normalized === 'text/plain' ||
            normalized.startsWith('text/plain;') ||
            normalized === 'utf8_string' ||
            normalized === 'string';
    }

    _normalizeDroppedValue(value) {
        const text = String(value ?? '').trim();
        if (!text) return '';

        if (/^file:\/\//i.test(text) || /^https?:\/\//i.test(text)) return text;

        if (GLib.path_is_absolute(text)) {
            try {
                return Gio.File.new_for_path(text).get_uri();
            } catch (e) {
                return text;
            }
        }

        return '';
    }

    _addTextToShelf(text) {
        if (!this._isShelfAvailable()) return;

        const item = this._shelf.addText(text);
        if (item) {
            this._notifyShelf(`Added "${item.label}" to Shelf.`);
        }
    }

    _addClipboardToShelf() {
        if (!this._isShelfAvailable()) return;

        this._readClipboardText(text => {
            const value = String(text ?? '').trim();
            if (!value) {
                this._notifyShelf('Clipboard is empty.');
                return;
            }

            const item = this._shelf?.addText(value);
            if (item) {
                this._notifyShelf(`Added "${item.label}" to Shelf.`);
            }
        });
    }

    _readClipboardText(callback) {
        try {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
                callback(text || '');
            });
            return;
        } catch (e) {
            // Fall through to global clipboard fallback where available.
        }

        try {
            global.clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
                callback(text || '');
            });
        } catch (e) {
            callback('');
        }
    }

    _clearShelf() {
        if (!this._isShelfAvailable()) return;

        this._shelf.clear();
        this._notifyShelf('Shelf cleared.');
    }

    _captureWorkspaceContextToShelf() {
        if (!this._isShelfAvailable()) return;

        const profiles = global.gnome_essentials_profiles;
        if (!profiles || typeof profiles.saveCurrentLayout !== 'function') {
            this._notifyShelf('Enable Workspace Profiles before capturing a workspace context.');
            return;
        }

        const profileName = this._generateWorkspaceContextProfileName();
        const result = profiles.saveCurrentLayout(profileName, {
            source: 'shelf-context',
            overwrite: false
        });

        if (!result?.ok) {
            this._notifyShelf(result?.message || 'Could not capture workspace context.');
            return;
        }

        const profile = this._getWorkspaceProfileEntry(profileName);
        const contexts = this._buildWorkspaceContextsFromProfile(profile);
        const item = this._shelf.addWorkspaceContext(profileName, profileName, contexts);
        if (!item) {
            this._notifyShelf('Captured layout, but could not add it to Shelf.');
            return;
        }

        const contextCount = Array.isArray(item.contexts) ? item.contexts.length : 0;
        const attachmentCount = (item.contexts || []).reduce((total, context) => {
            const attachments = Array.isArray(context.attachments) ? context.attachments.length : 0;
            return total + attachments;
        }, 0);
        const contextText = `${contextCount} app${contextCount === 1 ? '' : 's'}`;
        const attachmentText = attachmentCount > 0
            ? ` and ${attachmentCount} context item${attachmentCount === 1 ? '' : 's'}`
            : '';
        this._notifyShelf(`Captured "${item.label}" with ${contextText}${attachmentText}.`);

        if (this._isOpen) this._renderResults(this._getSearchText());
    }

    _generateWorkspaceContextProfileName() {
        const now = new Date();
        const stamp = now.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const baseName = `Profile at ${stamp}`;

        let name = baseName;
        let suffix = 2;
        while (this._getWorkspaceProfileEntry(name)) {
            name = `${baseName} ${suffix}`;
            suffix++;
        }

        return name;
    }

    _buildWorkspaceContextsFromProfile(profile) {
        const windows = Array.isArray(profile?.windows) ? profile.windows : [];
        if (windows.length === 0) return [];

        const recentFiles = this._loadRecentFileCandidates();
        const contexts = new Map();

        for (const config of windows) {
            const appId = String(config?.app_id || '').trim();
            if (!appId) continue;

            const key = this._normalizeAppIdForMatch(appId);
            if (!key) continue;

            if (!contexts.has(key)) {
                const app = this._appSystem.lookup_app(appId);
                const label = app?.get_name?.() || config.wm_class || appId;
                contexts.set(key, {
                    type: 'app',
                    label,
                    value: appId,
                    appId,
                    iconName: app ? this._getAppIconName(app, appId) : this._getDesktopIconName(appId),
                    attachments: [],
                    _attachmentKeys: new Set()
                });
            }

            const context = contexts.get(key);
            const attachment = this._inferWindowContextAttachment(config, context, recentFiles);
            const attachmentKey = attachment ? `${attachment.type}:${attachment.uri || attachment.path || attachment.value}`.toLowerCase() : '';
            if (attachment && attachmentKey && !context._attachmentKeys.has(attachmentKey)) {
                context.attachments.push(attachment);
                context._attachmentKeys.add(attachmentKey);
            }
        }

        this._fillFileManagerContextFallbacks(contexts);

        return [...contexts.values()].map(context => {
            const { _attachmentKeys, ...cleanContext } = context;
            return cleanContext;
        });
    }

    _inferWindowContextAttachment(config, context, recentFiles) {
        const title = String(config?.title || '').trim();
        if (!title) return null;
        const recentFileList = Array.isArray(recentFiles) ? recentFiles : [];

        const appItem = {
            appId: context?.appId || config?.app_id || '',
            value: context?.appId || config?.app_id || '',
            label: context?.label || config?.wm_class || ''
        };

        if (this._isFileManagerApp(appItem)) {
            const folderAttachment = this._inferFolderContextAttachment(config, recentFileList);
            if (folderAttachment && !this._isGenericFileManagerTitle(title)) return folderAttachment;
            const titleFolderAttachment = this._inferFolderContextAttachmentFromTitle(config);
            if (titleFolderAttachment) return titleFolderAttachment;
            const searchedFolderAttachment = this._inferFolderContextAttachmentByTitleSearch(config, recentFileList);
            if (searchedFolderAttachment) return searchedFolderAttachment;
        }

        if (!this._canCaptureFileContextForApp(appItem)) return null;

        const titlePathAttachment = this._inferContextAttachmentFromTitle(config, appItem);
        if (titlePathAttachment) return titlePathAttachment;

        if (recentFileList.length === 0) return null;

        const matches = recentFileList.filter(candidate => this._recentFileMatchesWindowTitle(candidate, title));
        if (matches.length === 0) return null;

        const candidate = this._selectRecentFileContextMatch(matches, title);
        if (!candidate) return null;

        return this._createCapturedContextAttachmentForApp(candidate.path, appItem, {
            label: candidate.basename,
            uri: candidate.uri,
            contentType: candidate.contentType || ''
        });
    }

    _canCaptureFileContextForApp(appItem) {
        return this._isOfficeApp(appItem) ||
            this._isPdfReaderApp(appItem) ||
            this._isTextEditorApp(appItem) ||
            this._isCodeLikeApp(appItem);
    }

    _inferFolderContextAttachment(config, recentFiles) {
        const title = String(config?.title || '').trim();
        const candidates = this._loadFolderContextCandidates(recentFiles);
        const matches = candidates.filter(candidate => this._folderCandidateMatchesWindowTitle(candidate, title));
        if (matches.length === 0) return null;

        const uniqueByPath = new Map();
        for (const candidate of matches) {
            uniqueByPath.set(candidate.path, candidate);
        }
        if (uniqueByPath.size !== 1) return null;

        const candidate = [...uniqueByPath.values()][0];
        return {
            type: 'folder',
            label: candidate.basename,
            value: candidate.uri,
            uri: candidate.uri,
            path: candidate.path,
            iconName: 'folder-symbolic',
            contentType: 'inode/directory',
            source: 'captured'
        };
    }

    _inferContextAttachmentFromTitle(config, appItem) {
        const title = String(config?.title || '').trim();
        if (!title) return null;

        const pathCandidates = this._extractContextPathCandidatesFromTitle(title);
        for (const path of pathCandidates) {
            const attachment = this._createCapturedContextAttachmentForApp(path, appItem);
            if (attachment) return attachment;
        }

        return null;
    }

    _inferFolderContextAttachmentFromTitle(config) {
        const title = String(config?.title || '').trim();
        if (!title) return null;

        const pathCandidates = this._extractContextPathCandidatesFromTitle(title);
        for (const path of pathCandidates) {
            const attachment = this._createCapturedFolderAttachment(path);
            if (attachment) return attachment;
        }

        return null;
    }

    _inferFolderContextAttachmentByTitleSearch(config, recentFiles) {
        const title = String(config?.title || '').trim();
        if (!title || this._isGenericFileManagerTitle(title)) return null;

        const titleKey = this._normalizeContextTitle(title);
        if (!titleKey || titleKey.length < 3) return null;

        const matches = this._findFolderPathsByTitleKey(titleKey, recentFiles);
        if (matches.length !== 1) return null;

        return this._createCapturedFolderAttachment(matches[0], {
            label: title
        });
    }

    _findFolderPathsByTitleKey(titleKey, recentFiles) {
        const roots = this._folderTitleSearchRoots(recentFiles);
        const matches = new Map();
        let visited = 0;
        const startedAtUs = GLib.get_monotonic_time();
        const timedOut = () => {
            const elapsedMs = (GLib.get_monotonic_time() - startedAtUs) / 1000;
            return elapsedMs >= FOLDER_TITLE_SEARCH_MAX_MS;
        };

        const visit = (path, depth) => {
            if (!path ||
                depth > FOLDER_TITLE_SEARCH_MAX_DEPTH ||
                visited >= FOLDER_TITLE_SEARCH_MAX_VISITS ||
                timedOut()) {
                return;
            }

            let file = null;
            try {
                file = Gio.File.new_for_path(path);
                if (!file.query_exists(null)) return;
                if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) return;
            } catch (e) {
                return;
            }

            visited++;
            const basename = file.get_basename?.() || '';
            if (basename && this._normalizeContextTitle(basename) === titleKey) {
                matches.set(path, path);
            }

            if (depth >= FOLDER_TITLE_SEARCH_MAX_DEPTH ||
                visited >= FOLDER_TITLE_SEARCH_MAX_VISITS ||
                timedOut()) {
                return;
            }

            let enumerator = null;
            try {
                enumerator = file.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                let info = null;
                while ((info = enumerator.next_file(null)) !== null &&
                    visited < FOLDER_TITLE_SEARCH_MAX_VISITS &&
                    !timedOut()) {
                    if (info.get_file_type?.() !== Gio.FileType.DIRECTORY) continue;

                    const name = info.get_name?.() || '';
                    if (!name ||
                        name.startsWith('.') ||
                        FOLDER_TITLE_SEARCH_SKIP_NAMES.has(name)) {
                        continue;
                    }

                    visit(GLib.build_filenamev([path, name]), depth + 1);
                }
            } catch (e) {
                // Directory title search is best-effort.
            } finally {
                try {
                    enumerator?.close(null);
                } catch (e) {
                    // Enumerator may already be closed.
                }
            }
        };

        for (const root of roots) {
            visit(root, 0);
            if (matches.size > 1) break;
            if (visited >= FOLDER_TITLE_SEARCH_MAX_VISITS) break;
            if (timedOut()) break;
        }

        return [...matches.values()];
    }

    _folderTitleSearchRoots(recentFiles) {
        const roots = new Map();
        const addRoot = path => {
            const value = String(path ?? '').trim();
            if (value) roots.set(value, value);
        };

        for (const recent of recentFiles || []) {
            try {
                const file = Gio.File.new_for_path(recent.path);
                const parentPath = file.get_parent?.()?.get_path?.() || '';
                if (parentPath) addRoot(parentPath);
            } catch (e) {
                // Ignore invalid recent entries.
            }
        }

        const home = GLib.get_home_dir();
        addRoot(GLib.build_filenamev([home, 'Projects']));
        addRoot(GLib.build_filenamev([home, 'Project']));
        addRoot(GLib.build_filenamev([home, 'Code']));
        addRoot(GLib.build_filenamev([home, 'Development']));
        addRoot(GLib.build_filenamev([home, 'Workspace']));
        addRoot(GLib.build_filenamev([home, 'workspace']));

        const specialDirs = [
            GLib.UserDirectory.DIRECTORY_DESKTOP,
            GLib.UserDirectory.DIRECTORY_DOCUMENTS,
            GLib.UserDirectory.DIRECTORY_DOWNLOAD,
            GLib.UserDirectory.DIRECTORY_MUSIC,
            GLib.UserDirectory.DIRECTORY_PICTURES,
            GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE,
            GLib.UserDirectory.DIRECTORY_TEMPLATES,
            GLib.UserDirectory.DIRECTORY_VIDEOS
        ];

        for (const directory of specialDirs) {
            try {
                addRoot(GLib.get_user_special_dir(directory));
            } catch (e) {
                // Some systems do not configure every special directory.
            }
        }

        return [...roots.values()];
    }

    _extractContextPathCandidatesFromTitle(title) {
        const candidates = [];
        const addCandidate = path => {
            const expanded = this._expandContextPath(path);
            if (expanded && !candidates.includes(expanded)) candidates.push(expanded);
        };
        const text = String(title ?? '').trim();
        if (!text) return candidates;

        const parenthesizedPathRe = /\(([^)]*(?:~|\/)[^)]*)\)/g;
        let match = null;
        while ((match = parenthesizedPathRe.exec(text)) !== null) {
            const folderPath = this._expandContextPath(match[1]);
            if (!folderPath) continue;

            addCandidate(folderPath);

            const before = text.slice(0, match.index)
                .replace(/\s+[-–—]\s*$/u, '')
                .trim();
            const basename = before.split(/[\\/]/).pop()?.trim() || '';
            if (basename && !/[\\/]/.test(basename)) {
                addCandidate(GLib.build_filenamev([folderPath, basename]));
            }
        }

        const pathLikeRe = /(?:file:\/\/|~\/|\/)[^\s"'<>]+(?:\s[^\s"'<>()[\]{}|]+)*/g;
        while ((match = pathLikeRe.exec(text)) !== null) {
            addCandidate(match[0]);
        }

        return candidates;
    }

    _expandContextPath(value) {
        let text = String(value ?? '').trim();
        if (!text) return '';

        text = text
            .replace(/^["']|["']$/g, '')
            .replace(/[),.;:]+$/g, '')
            .trim();

        try {
            if (text.startsWith('file://')) {
                return Gio.File.new_for_uri(text).get_path?.() || '';
            }
        } catch (e) {
            return '';
        }

        if (text === '~') return GLib.get_home_dir();
        if (text.startsWith('~/')) {
            return GLib.build_filenamev([GLib.get_home_dir(), text.slice(2)]);
        }

        return GLib.path_is_absolute(text) ? text : '';
    }

    _createCapturedFileAttachment(path, options = {}) {
        const value = String(path ?? '').trim();
        if (!value) return null;

        try {
            const file = options.uri ? Gio.File.new_for_uri(options.uri) : Gio.File.new_for_path(value);
            if (!file.query_exists(null)) return null;
            if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.REGULAR) return null;

            const info = this._queryFileInfo(file);
            return {
                type: 'file',
                label: options.label || file.get_basename?.() || value,
                value: file.get_uri(),
                uri: file.get_uri(),
                path: file.get_path?.() || value,
                iconName: options.iconName || 'text-x-generic-symbolic',
                contentType: options.contentType || this._getContentType(info),
                source: 'captured'
            };
        } catch (e) {
            return null;
        }
    }

    _createCapturedFolderAttachment(path, options = {}) {
        const value = String(path ?? '').trim();
        if (!value) return null;

        try {
            const file = options.uri ? Gio.File.new_for_uri(options.uri) : Gio.File.new_for_path(value);
            if (!file.query_exists(null)) return null;
            if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) return null;

            return {
                type: 'folder',
                label: options.label || file.get_basename?.() || this._shortenHomePath(file.get_path?.() || value),
                value: file.get_uri(),
                uri: file.get_uri(),
                path: file.get_path?.() || value,
                iconName: options.iconName || 'folder-symbolic',
                contentType: 'inode/directory',
                source: 'captured'
            };
        } catch (e) {
            return null;
        }
    }

    _createCapturedContextAttachmentForApp(path, appItem, options = {}) {
        const fileAttachment = this._createCapturedFileAttachment(path, options);
        if (fileAttachment) return fileAttachment;

        if (this._isCodeLikeApp(appItem)) {
            return this._createCapturedFolderAttachment(path, options);
        }

        return null;
    }

    _selectRecentFileContextMatch(matches, title) {
        const uniqueByUri = new Map();
        for (const candidate of matches || []) {
            if (candidate?.uri) uniqueByUri.set(candidate.uri, candidate);
        }

        if (uniqueByUri.size === 0) return null;
        if (uniqueByUri.size === 1) return [...uniqueByUri.values()][0];

        const titleText = this._normalizeContextTitle(title);
        const scored = [...uniqueByUri.values()]
            .map(candidate => ({
                candidate,
                score: this._scoreRecentFileTitleMatch(candidate, titleText)
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (b.candidate.timestamp || 0) - (a.candidate.timestamp || 0);
            });

        if (scored.length === 0) return null;
        if (scored.length === 1) return scored[0].candidate;

        const [best, second] = scored;
        if (best.score > second.score) return best.candidate;

        return null;
    }

    _scoreRecentFileTitleMatch(candidate, titleText) {
        const title = String(titleText ?? '');
        if (!title) return 0;

        const basename = this._normalizeContextTitle(candidate?.basename);
        const stem = this._normalizeContextTitle(candidate?.stem);
        let score = 0;

        if (basename && title.includes(basename)) {
            score = Math.max(score, title === basename ? 80 : 60);
        }
        if (stem && title.includes(stem)) {
            score = Math.max(score, title === stem ? 50 : 35);
        }

        const parentPath = this._shortenHomePath(this._parentPath(candidate?.path || ''));
        const normalizedParent = this._normalizeContextTitle(parentPath);
        if (normalizedParent && title.includes(normalizedParent)) {
            score += 30;
        }

        return score;
    }

    _fillFileManagerContextFallbacks(contexts) {
        if (!(contexts instanceof Map) || contexts.size === 0) return;

        const inferredFolders = new Map();
        const addFolderPath = path => {
            const folder = this._createCapturedFolderAttachment(path);
            if (folder?.path) inferredFolders.set(folder.path, folder);
        };

        for (const context of contexts.values()) {
            const appItem = {
                appId: context?.appId || '',
                value: context?.appId || '',
                label: context?.label || ''
            };
            if (this._isFileManagerApp(appItem)) continue;

            for (const attachment of context?.attachments || []) {
                if (attachment?.type === 'folder') {
                    addFolderPath(attachment.path || '');
                } else if (attachment?.type === 'file') {
                    addFolderPath(this._parentPath(attachment.path || ''));
                }
            }
        }

        if (inferredFolders.size !== 1) return;
        const folderAttachment = [...inferredFolders.values()][0];

        for (const context of contexts.values()) {
            const appItem = {
                appId: context?.appId || '',
                value: context?.appId || '',
                label: context?.label || ''
            };
            if (!this._isFileManagerApp(appItem)) continue;
            if (Array.isArray(context.attachments) && context.attachments.length > 0) continue;

            const key = `${folderAttachment.type}:${folderAttachment.uri || folderAttachment.path}`.toLowerCase();
            context.attachments.push(folderAttachment);
            context._attachmentKeys?.add?.(key);
        }
    }

    _parentPath(path) {
        const value = String(path ?? '').trim();
        if (!value) return '';

        try {
            const file = Gio.File.new_for_path(value);
            return file.get_parent?.()?.get_path?.() || '';
        } catch (e) {
            return '';
        }
    }

    _loadFolderContextCandidates(recentFiles) {
        const candidates = new Map();
        const addDir = (path, aliases = []) => {
            const dirPath = String(path ?? '').trim();
            if (!dirPath || candidates.has(dirPath)) return;

            try {
                const file = Gio.File.new_for_path(dirPath);
                if (!file.query_exists(null)) return;
                if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) return;

                candidates.set(dirPath, {
                    path: dirPath,
                    uri: file.get_uri(),
                    basename: file.get_basename?.() || dirPath,
                    aliases
                });
            } catch (e) {
                // Directory context inference is best-effort.
            }
        };

        const home = GLib.get_home_dir();
        addDir(home, ['home']);

        const specialDirs = [
            ['desktop', GLib.UserDirectory.DIRECTORY_DESKTOP],
            ['documents', GLib.UserDirectory.DIRECTORY_DOCUMENTS],
            ['downloads', GLib.UserDirectory.DIRECTORY_DOWNLOAD],
            ['music', GLib.UserDirectory.DIRECTORY_MUSIC],
            ['pictures', GLib.UserDirectory.DIRECTORY_PICTURES],
            ['public', GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE],
            ['templates', GLib.UserDirectory.DIRECTORY_TEMPLATES],
            ['videos', GLib.UserDirectory.DIRECTORY_VIDEOS]
        ];

        for (const [alias, directory] of specialDirs) {
            try {
                addDir(GLib.get_user_special_dir(directory), [alias]);
            } catch (e) {
                // Some systems do not configure every special directory.
            }
        }

        for (const recent of recentFiles || []) {
            try {
                const file = Gio.File.new_for_path(recent.path);
                const parent = file.get_parent?.();
                const parentPath = parent?.get_path?.() || '';
                if (parentPath) addDir(parentPath);
            } catch (e) {
                // Ignore invalid recent entries.
            }
        }

        return [...candidates.values()];
    }

    _folderCandidateMatchesWindowTitle(candidate, title) {
        const titleText = this._normalizeContextTitle(title);
        if (!titleText) return false;

        const names = [
            candidate?.basename,
            ...(Array.isArray(candidate?.aliases) ? candidate.aliases : [])
        ].map(name => this._normalizeContextTitle(name))
            .filter(name => name.length >= 3);

        return names.some(name => titleText.includes(name));
    }

    _isGenericFileManagerTitle(title) {
        const titleText = this._normalizeContextTitle(title);
        return [
            'home',
            'files',
            'recent',
            'starred',
            'trash',
            'network',
            'computer',
            'other locations'
        ].includes(titleText);
    }

    _loadRecentFileCandidates() {
        const recentPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
        const recentFile = Gio.File.new_for_path(recentPath);
        if (!recentFile.query_exists(null)) return [];

        try {
            const [, contents] = recentFile.load_contents(null);
            const text = imports.byteArray.toString(contents);
            const candidates = [];
            const bookmarkRe = /<bookmark\b([^>]*)>([\s\S]*?)<\/bookmark>/g;
            let match = null;

            while ((match = bookmarkRe.exec(text)) !== null) {
                const attrs = match[1] || '';
                const body = match[2] || '';
                const href = this._decodeXmlEntities(this._extractXmlAttribute(attrs, 'href'));
                if (!href || !href.startsWith('file://')) continue;

                const file = Gio.File.new_for_uri(href);
                if (!file.query_exists(null)) continue;

                const path = file.get_path?.() || '';
                const basename = file.get_basename?.() || '';
                if (!path || !basename) continue;

                const contentType = this._decodeXmlEntities(
                    this._extractXmlAttribute(body, 'type')
                );
                const modified = this._extractXmlAttribute(attrs, 'modified') ||
                    this._extractXmlAttribute(attrs, 'visited') ||
                    this._extractXmlAttribute(body, 'modified') ||
                    this._extractXmlAttribute(body, 'visited');

                candidates.push({
                    uri: href,
                    path,
                    basename,
                    stem: this._fileStem(basename),
                    contentType,
                    timestamp: Date.parse(modified || '') || 0
                });
            }

            candidates.sort((a, b) => b.timestamp - a.timestamp);
            return candidates;
        } catch (e) {
            logError(`Failed to read recent files for workspace capture: ${e.message}`);
            return [];
        }
    }

    _recentFileMatchesWindowTitle(candidate, title) {
        const titleText = this._normalizeContextTitle(title);
        if (!titleText) return false;

        const names = [candidate?.basename, candidate?.stem]
            .map(name => this._normalizeContextTitle(name))
            .filter(name => name.length >= 3);

        return names.some(name => titleText.includes(name));
    }

    _normalizeContextTitle(value) {
        return normalize(String(value ?? '')
            .replace(/\.[A-Za-z0-9]{1,8}\b/g, match => match.toLowerCase())
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim());
    }

    _fileStem(basename) {
        const value = String(basename ?? '').trim();
        const dot = value.lastIndexOf('.');
        if (dot > 0) return value.slice(0, dot);
        return value;
    }

    _extractXmlAttribute(text, name) {
        const pattern = new RegExp(`${name}="([^"]*)"`);
        return String(text ?? '').match(pattern)?.[1] || '';
    }

    _decodeXmlEntities(value) {
        return String(value ?? '')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
    }

    _openShelfRecord(record) {
        const item = record?.shelfItem;
        if (!item) return;

        this._touchShelfRecord(record);

        if (item.type === 'url') {
            this._openUri(item.value || item.uri);
            return;
        }

        if (item.type === 'file' || item.type === 'folder') {
            this._openUri(item.uri || (item.path ? Gio.File.new_for_path(item.path).get_uri() : ''));
            return;
        }

        if (item.type === 'app') {
            this._openShelfAppItem(item);
            return;
        }

        if (item.type === 'workspace') {
            this._openShelfWorkspaceItem(item);
            return;
        }

        this._copyText(item.value);
        this._notifyShelf('Copied shelf text to clipboard.');
    }

    _openShelfWorkspaceAppRecord(record) {
        const context = record?.shelfItem;
        if (!context) return;

        const parent = record?.parentWorkspaceItem;
        if (parent?.id) this._shelf?.touch?.(parent.id);
        this._openShelfAppItem(context);
    }

    _openShelfWorkspaceItem(item) {
        const profileName = item.profileName || item.value || '';
        const contexts = Array.isArray(item.contexts)
            ? item.contexts.map(context => ({ ...context }))
            : [];
        const restoreContexts = this._workspaceRestoreContexts(contexts);
        const additiveContexts = this._workspaceAdditiveContexts(contexts);

        this._shelf?.touch?.(item.id);
        const hasRestoreContextAttachments = restoreContexts.some(context =>
            Array.isArray(context.attachments) && context.attachments.length > 0);
        const hasAdditiveContextAttachments = additiveContexts.some(context =>
            Array.isArray(context.attachments) && context.attachments.length > 0);
        const overridesSet = hasRestoreContextAttachments
            ? this._setWorkspaceContextLaunchOverrides(profileName, restoreContexts)
            : false;
        const restored = profileName ? this._applyWorkspaceProfile(profileName) : false;
        const autoLaunchesProfileApps = restored && this._workspaceProfilesAutoLaunchEnabled();
        const profileEngineWillOpenContexts = autoLaunchesProfileApps && overridesSet;
        const additiveDelay = restored && autoLaunchesProfileApps ? 1700 : 250;

        if (restored) {
            this._notifyShelf(`Restoring workspace context "${item.label || profileName}".`);
        } else if (profileName) {
            this._notifyShelf(`Opening context apps for "${item.label || profileName}".`);
        }

        if (profileEngineWillOpenContexts) {
            if (hasAdditiveContextAttachments) {
                this._openWorkspaceAdditiveContexts(additiveContexts, additiveDelay);
            }
            return;
        }

        if (restored && autoLaunchesProfileApps) {
            const followUpContexts = hasRestoreContextAttachments && !overridesSet
                ? contexts
                : additiveContexts;
            if (followUpContexts.length > 0) {
                this._openWorkspaceAdditiveContexts(followUpContexts, additiveDelay);
            }
            return;
        }

        const baseDelay = restored && autoLaunchesProfileApps ? 1300 : 120;
        contexts.forEach((context, index) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, baseDelay + index * 180, () => {
                if (autoLaunchesProfileApps) {
                    if (Array.isArray(context.attachments) && context.attachments.length > 0) {
                        this._openShelfAppAttachments(context, 0, { preferAppSpecific: true });
                    }
                } else {
                    this._openShelfAppItem(context);
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        if (restored && !autoLaunchesProfileApps && (hasRestoreContextAttachments || hasAdditiveContextAttachments) && profileName) {
            const settleDelay = baseDelay + contexts.length * 220 + 1400;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, settleDelay, () => {
                this._applyWorkspaceProfileWithAutoLaunch(profileName, false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _workspaceRestoreContexts(contexts) {
        return this._workspaceContextsWithAttachments(contexts, attachment =>
            !this._isManualWorkspaceAttachment(attachment));
    }

    _workspaceAdditiveContexts(contexts) {
        return this._workspaceContextsWithAttachments(contexts, attachment =>
            this._isManualWorkspaceAttachment(attachment));
    }

    _workspaceContextsWithAttachments(contexts, predicate) {
        return (Array.isArray(contexts) ? contexts : [])
            .map(context => {
                const attachments = Array.isArray(context.attachments)
                    ? context.attachments.filter(predicate)
                    : [];
                return {
                    ...context,
                    attachments
                };
            })
            .filter(context => context.attachments.length > 0);
    }

    _isManualWorkspaceAttachment(attachment) {
        return String(attachment?.source || '').toLowerCase() === 'manual';
    }

    _openWorkspaceAdditiveContexts(contexts, baseDelay = 250) {
        const withAttachments = (Array.isArray(contexts) ? contexts : [])
            .filter(context => Array.isArray(context.attachments) && context.attachments.length > 0);

        withAttachments.forEach((context, index) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, baseDelay + index * 220), () => {
                this._openShelfAppAttachments(context, 0, { preferAppSpecific: true });
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _setWorkspaceContextLaunchOverrides(profileName, contexts) {
        if (!profileName || !global.gnome_essentials_profiles) return false;

        try {
            const profiles = global.gnome_essentials_profiles;
            if (typeof profiles.setContextLaunchOverrides === 'function') {
                return profiles.setContextLaunchOverrides(profileName, contexts);
            }
        } catch (e) {
            logError(`Failed to set workspace context launch overrides: ${e.message}`);
        }

        return false;
    }

    _openShelfAppItem(item) {
        const appId = item.appId || item.value;
        const profileName = item.profileName || '';

        if (!appId) return;

        this._shelf?.touch?.(item.id);
        const profileHasApp = profileName && this._profileContainsApp(profileName, appId);

        if (profileHasApp && this._workspaceProfilesAutoLaunchEnabled()) {
            if (this._applyWorkspaceProfile(profileName)) {
                this._notifyShelf(`Restoring "${profileName}" for ${item.label}.`);
                this._openShelfAppAttachments(item, 1200);
                return;
            }
        }

        const contextWillLaunchApp = this._openShelfAppAttachments(item, profileHasApp ? 1300 : 120, {
            preferAppSpecific: true
        });
        if (contextWillLaunchApp) {
            if (profileHasApp) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                    this._applyWorkspaceProfile(profileName);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        if (!this._launchAppById(appId, item.label)) {
            this._notifyShelf(`"${item.label || appId}" is not installed.`);
            return;
        }

        if (profileHasApp) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                this._applyWorkspaceProfile(profileName);
                return GLib.SOURCE_REMOVE;
            });
        }

        this._openShelfAppAttachments(item, profileHasApp ? 1300 : 450, {
            preferAppSpecific: false
        });
    }

    _openShelfAppAttachments(item, delayMs = 500, options = {}) {
        const attachments = Array.isArray(item?.attachments)
            ? item.attachments.map(attachment => ({ ...attachment }))
            : [];
        if (attachments.length === 0) return false;

        const preferAppSpecific = options.preferAppSpecific ?? true;
        const actions = preferAppSpecific
            ? attachments.map(attachment => this._createAppSpecificAttachmentAction(item, attachment))
            : attachments.map(() => null);
        const handledAttachments = new Set();
        const willLaunchApp = actions.some(action => action?.launchesApp);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
            let opened = 0;
            let notes = 0;
            let appSpecificOpened = 0;

            for (const action of actions) {
                if (!action) continue;

                try {
                    if (action.run()) {
                        appSpecificOpened++;
                        handledAttachments.add(action.attachmentId);
                    }
                } catch (e) {
                    logError(`Failed to open app-specific attachment "${action.label}": ${e.message}`);
                }
            }

            for (const attachment of attachments) {
                if (handledAttachments.has(attachment.id)) continue;

                try {
                    if (attachment.type === 'url') {
                        this._openUri(attachment.value || attachment.uri);
                        opened++;
                    } else if (attachment.type === 'file' || attachment.type === 'folder') {
                        this._openUri(attachment.uri || (attachment.path ? Gio.File.new_for_path(attachment.path).get_uri() : ''));
                        opened++;
                    } else if (attachment.type === 'text') {
                        notes++;
                    }
                } catch (e) {
                    logError(`Failed to open app context attachment "${attachment.label}": ${e.message}`);
                }
            }

            if (appSpecificOpened > 0 || opened > 0 || notes > 0) {
                const parts = [];
                if (appSpecificOpened > 0) parts.push(`${appSpecificOpened} context item${appSpecificOpened === 1 ? '' : 's'} opened in ${item.label}`);
                if (opened > 0) parts.push(`${opened} item${opened === 1 ? '' : 's'} opened`);
                if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'} available in Shelf`);
                this._notifyShelf(parts.join(', ') + '.');
            }

            return GLib.SOURCE_REMOVE;
        });

        return willLaunchApp;
    }

    _createAppSpecificAttachmentAction(appItem, attachment) {
        const appId = appItem?.appId || appItem?.value || '';
        const label = attachment?.label || attachment?.value || 'Attachment';
        const attachmentId = attachment?.id || `${attachment?.type}:${attachment?.value || attachment?.uri || attachment?.path || label}`;

        if (this._isBrowserApp(appItem) && attachment?.type === 'url') {
            return {
                attachmentId,
                label,
                launchesApp: true,
                run: () => this._launchAppWithUris(appId, [attachment.value || attachment.uri])
            };
        }

        if (this._isCodeLikeApp(appItem)) {
            const path = this._pathFromAttachment(attachment) ||
                (attachment?.type === 'text' ? this._createContextNoteFile(appItem, attachment)?.get_path?.() : '');
            const command = this._getCodeLikeCommand(appItem);
            if (path && command.length > 0) {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => this._spawnCommand([...command, path])
                };
            }
        }

        if (this._isTextEditorApp(appItem)) {
            if (attachment?.type === 'text') {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => {
                        const file = this._createContextNoteFile(appItem, attachment);
                        return file ? this._launchAppWithFiles(appId, [file]) : false;
                    }
                };
            }

            if (attachment?.type === 'file') {
                const file = this._fileFromAttachment(attachment);
                if (file) {
                    return {
                        attachmentId,
                        label,
                        launchesApp: true,
                        run: () => this._launchAppWithFiles(appId, [file])
                    };
                }
            }
        }

        if (this._isFileManagerApp(appItem) && (attachment?.type === 'folder' || attachment?.type === 'file')) {
            const file = this._fileFromAttachment(attachment);
            const target = attachment?.type === 'folder'
                ? file
                : file?.get_parent?.();
            if (target) {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => this._launchAppWithFiles(appId, [target])
                };
            }
        }

        if (this._isPdfReaderApp(appItem) && this._pdfReaderCanOpenAttachment(attachment)) {
            const file = this._fileFromAttachment(attachment);
            if (file) {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => this._launchAppWithFiles(appId, [file])
                };
            }
        }

        if (this._isOfficeApp(appItem)) {
            if (attachment?.type === 'text' && this._officeAppAcceptsText(appItem)) {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => {
                        const file = this._createContextNoteFile(appItem, attachment);
                        return file ? this._launchAppWithFiles(appId, [file]) : false;
                    }
                };
            }

            if (attachment?.type === 'file' && this._officeAppCanOpenAttachment(appItem, attachment)) {
                const file = this._fileFromAttachment(attachment);
                if (file) {
                    return {
                        attachmentId,
                        label,
                        launchesApp: true,
                        run: () => this._launchAppWithFiles(appId, [file])
                    };
                }
            }
        }

        if (this._isTerminalApp(appItem)) {
            const cwd = this._folderPathFromAttachment(attachment);
            const command = this._getTerminalCommand(appItem, cwd);
            if (cwd && command.length > 0) {
                return {
                    attachmentId,
                    label,
                    launchesApp: true,
                    run: () => this._spawnCommand(command, cwd)
                };
            }
        }

        return null;
    }

    _isBrowserApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /chrome|chromium|firefox|browser|brave|vivaldi|librewolf|edge|opera/.test(identity);
    }

    _isCodeLikeApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /visual studio code|vscode|code\.desktop|code-oss|codium|cursor/.test(identity);
    }

    _isTextEditorApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /texteditor|text editor|gedit|kate|mousepad|xed|pluma/.test(identity);
    }

    _isTerminalApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /ptyxis|terminal|console|kgx|konsole|alacritty|kitty|ghostty|tilix|wezterm|xterm/.test(identity);
    }

    _isFileManagerApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /nautilus|org\.gnome\.files|org\.gnome\.nautilus|file manager|files\.desktop|nemo|thunar|dolphin|caja|pcmanfm/.test(identity);
    }

    _isPdfReaderApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /zotero|evince|papers|document viewer|okular|xournal|mupdf|zathura|atril|qpdfview|sioyek|foxit|acrobat|masterpdf|pdf arranger|pdfarranger|pdf viewer|pdf reader/.test(identity);
    }

    _pdfReaderCanOpenAttachment(attachment) {
        if (attachment?.type !== 'file') return false;

        const extension = this._attachmentExtension(attachment);
        return PDF_READER_EXTENSIONS.has(extension);
    }

    _isOfficeApp(appItem) {
        const identity = this._appIdentityText(appItem);
        return /libreoffice|openoffice|onlyoffice|wps-office|wpsoffice|wps writer|wps spreadsheet|wps presentation|freeoffice|softmaker|calligra|abiword|gnumeric|office writer|office calc|office impress|word processor|wordprocessor/.test(identity);
    }

    _officeAppRole(appItem) {
        const identity = this._appIdentityText(appItem);

        if (/calc|spreadsheet|spreadsheets|excel|gnumeric|scalc|et\.desktop|office-et|sheets/.test(identity)) {
            return 'spreadsheet';
        }

        if (/impress|presentation|presentations|powerpoint|stage|simpress|wpp\.desktop|office-wpp/.test(identity)) {
            return 'presentation';
        }

        if (/draw|diagram|sdraw/.test(identity)) {
            return 'drawing';
        }

        if (/base|database|sbase/.test(identity)) {
            return 'database';
        }

        if (/writer|word|document|abiword|swriter|wps\.desktop|office-wps/.test(identity)) {
            return 'document';
        }

        return 'suite';
    }

    _officeAppAcceptsText(appItem) {
        const role = this._officeAppRole(appItem);
        return role === 'suite' || role === 'document';
    }

    _officeAppCanOpenAttachment(appItem, attachment) {
        const extension = this._attachmentExtension(attachment);
        const role = this._officeAppRole(appItem);

        if (!extension) return role === 'suite';

        if (role === 'document') return OFFICE_DOCUMENT_EXTENSIONS.has(extension);
        if (role === 'spreadsheet') return OFFICE_SPREADSHEET_EXTENSIONS.has(extension);
        if (role === 'presentation') return OFFICE_PRESENTATION_EXTENSIONS.has(extension);
        if (role === 'drawing') return OFFICE_DRAWING_EXTENSIONS.has(extension);
        if (role === 'database') return OFFICE_DATABASE_EXTENSIONS.has(extension);

        return OFFICE_DOCUMENT_EXTENSIONS.has(extension) ||
            OFFICE_SPREADSHEET_EXTENSIONS.has(extension) ||
            OFFICE_PRESENTATION_EXTENSIONS.has(extension) ||
            OFFICE_DRAWING_EXTENSIONS.has(extension) ||
            OFFICE_DATABASE_EXTENSIONS.has(extension);
    }

    _appIdentityText(appItem) {
        return normalize([
            appItem?.appId,
            appItem?.value,
            appItem?.label
        ].join(' '));
    }

    _launchAppWithFiles(appId, files) {
        const appInfo = this._getAppInfoById(appId);
        if (!appInfo || !Array.isArray(files) || files.length === 0) return false;

        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        appInfo.launch(files, context);
        return true;
    }

    _launchAppWithUris(appId, uris) {
        const appInfo = this._getAppInfoById(appId);
        const values = Array.isArray(uris)
            ? uris.map(uri => String(uri ?? '').trim()).filter(Boolean)
            : [];
        if (!appInfo || values.length === 0) return false;

        const timestamp = global.get_current_time?.() ?? 0;
        const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
        if (typeof appInfo.launch_uris === 'function') {
            appInfo.launch_uris(values, context);
            return true;
        }

        return false;
    }

    _getAppInfoById(appId) {
        try {
            const app = this._appSystem.lookup_app(appId);
            return app?.get_app_info?.() || app?.appInfo || null;
        } catch (e) {
            return null;
        }
    }

    _getCodeLikeCommand(appItem) {
        const identity = this._appIdentityText(appItem);
        const appId = appItem?.appId || appItem?.value || '';
        const candidates = [];

        if (/cursor/.test(identity)) candidates.push('cursor');
        if (/codium/.test(identity)) candidates.push('codium');
        if (/code-oss/.test(identity)) candidates.push('code-oss');
        if (/code|visual studio code|vscode/.test(identity)) candidates.push('code');
        candidates.push('code', 'codium', 'code-oss', 'cursor');

        for (const candidate of candidates) {
            const path = GLib.find_program_in_path(candidate);
            if (path) return [path];
        }

        const flatpakId = this._flatpakIdFromDesktopId(appId);
        const flatpak = GLib.find_program_in_path('flatpak');
        if (flatpak && flatpakId && /(code|codium|cursor)/i.test(flatpakId)) {
            return [flatpak, 'run', flatpakId];
        }

        return [];
    }

    _getTerminalCommand(appItem, cwd) {
        const identity = this._appIdentityText(appItem);
        const candidates = [];

        if (/ptyxis/.test(identity)) candidates.push(['ptyxis', '--working-directory', cwd]);
        if (/gnome-terminal|terminal/.test(identity)) candidates.push(['gnome-terminal', '--working-directory', cwd]);
        if (/kgx|console/.test(identity)) candidates.push(['kgx', '--working-directory', cwd]);
        if (/konsole/.test(identity)) candidates.push(['konsole', '--workdir', cwd]);
        if (/alacritty/.test(identity)) candidates.push(['alacritty', '--working-directory', cwd]);
        if (/kitty/.test(identity)) candidates.push(['kitty', '--directory', cwd]);
        if (/ghostty/.test(identity)) candidates.push(['ghostty', `--working-directory=${cwd}`]);
        if (/tilix/.test(identity)) candidates.push(['tilix', '--working-directory', cwd]);
        if (/wezterm/.test(identity)) candidates.push(['wezterm', 'start', '--cwd', cwd]);
        if (/xterm/.test(identity)) candidates.push(['xterm']);

        candidates.push(
            ['ptyxis', '--working-directory', cwd],
            ['gnome-terminal', '--working-directory', cwd],
            ['kgx', '--working-directory', cwd]
        );

        for (const candidate of candidates) {
            const path = GLib.find_program_in_path(candidate[0]);
            if (path) return [path, ...candidate.slice(1)];
        }

        return [];
    }

    _spawnCommand(argv, cwd = '') {
        const args = Array.isArray(argv)
            ? argv.map(arg => String(arg ?? '')).filter(Boolean)
            : [];
        if (args.length === 0) return false;

        const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);
        if (cwd) {
            try {
                launcher.set_cwd(cwd);
            } catch (e) {
                // Some launchers do not need cwd support if arguments carry it.
            }
        }
        launcher.spawnv(args);
        return true;
    }

    _flatpakIdFromDesktopId(appId) {
        return String(appId ?? '')
            .trim()
            .replace(/\.desktop$/i, '');
    }

    _fileFromAttachment(attachment) {
        try {
            if (attachment?.uri) return Gio.File.new_for_uri(attachment.uri);
            if (attachment?.path) return Gio.File.new_for_path(attachment.path);
            if (attachment?.value?.startsWith?.('file://')) return Gio.File.new_for_uri(attachment.value);
            if (GLib.path_is_absolute(attachment?.value || '')) return Gio.File.new_for_path(attachment.value);
        } catch (e) {
            logError(`Could not resolve attachment file: ${e.message}`);
        }

        return null;
    }

    _pathFromAttachment(attachment) {
        try {
            const file = this._fileFromAttachment(attachment);
            return file?.get_path?.() || '';
        } catch (e) {
            return '';
        }
    }

    _folderPathFromAttachment(attachment) {
        try {
            const file = this._fileFromAttachment(attachment);
            if (!file) return '';

            const path = file.get_path?.() || '';
            if (!path) return '';

            if (attachment?.type === 'folder') return path;

            const parent = file.get_parent?.();
            return parent?.get_path?.() || '';
        } catch (e) {
            return '';
        }
    }

    _attachmentExtension(attachment) {
        const candidates = [];

        try {
            const file = this._fileFromAttachment(attachment);
            const basename = file?.get_basename?.();
            if (basename) candidates.push(basename);
        } catch (e) {
            // Fall through to text candidates below.
        }

        candidates.push(
            attachment?.path,
            attachment?.uri,
            attachment?.value,
            attachment?.label
        );

        for (const candidate of candidates) {
            let text = String(candidate ?? '').trim();
            if (!text) continue;

            try {
                text = decodeURIComponent(text);
            } catch (e) {
                // Keep the original text if it is not URI-escaped cleanly.
            }

            const cleaned = text.split(/[?#]/)[0];
            const basename = cleaned.split('/').pop() || cleaned;
            const dot = basename.lastIndexOf('.');
            if (dot > 0 && dot < basename.length - 1) {
                return basename.slice(dot + 1).toLowerCase();
            }
        }

        return '';
    }

    _createContextNoteFile(appItem, attachment) {
        const text = String(attachment?.value ?? '').trim();
        if (!text) return null;

        try {
            const dirPath = GLib.build_filenamev([
                GLib.get_user_data_dir(),
                'gnome-essentials',
                CONTEXT_NOTES_DIR_NAME
            ]);
            const dir = Gio.File.new_for_path(dirPath);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            const fileName = `${Date.now()}-${this._sanitizeFileName(appItem?.label || 'context')}-${this._sanitizeFileName(attachment?.label || 'note')}.txt`;
            const file = Gio.File.new_for_path(GLib.build_filenamev([dirPath, fileName]));
            file.replace_contents(
                text + '\n',
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            return file;
        } catch (e) {
            logError(`Failed to create context note file: ${e.message}`);
            return null;
        }
    }

    _sanitizeFileName(value) {
        const text = String(value ?? '')
            .trim()
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return (text || 'note').slice(0, 48);
    }

    _launchAppById(appId, label = '') {
        try {
            const app = this._appSystem.lookup_app(appId);
            if (!app) return false;

            this._launchApp({
                app,
                id: appId,
                name: label || app.get_name?.() || appId
            });
            return true;
        } catch (e) {
            logError(`Failed to launch shelf app ${appId}: ${e.message}`);
            return false;
        }
    }

    _openNewWindowForRecord(record) {
        let app = record?.app || null;
        let appId = record?.id || '';
        let label = record?.name || '';

        if (!app && record?.kind === 'shelf-item' && record.shelfItem?.type === 'app') {
            appId = record.shelfItem.appId || record.shelfItem.value || '';
            label = record.shelfItem.label || appId;
            app = appId ? this._appSystem.lookup_app(appId) : null;
        }

        if (!app && record?.kind === 'shelf-workspace-app') {
            appId = record.shelfItem?.appId || record.shelfItem?.value || '';
            label = record.shelfItem?.label || appId;
            app = appId ? this._appSystem.lookup_app(appId) : null;
        }

        if (!app) {
            Main.notify('Essential Menu', `"${label || appId || 'App'}" is not installed.`);
            return false;
        }

        this._launchApp({
            app,
            id: appId || app.get_id?.() || '',
            name: label || app.get_name?.() || appId
        }, { forceNewWindow: true });
        return true;
    }

    _profileContainsApp(profileName, appId) {
        const profile = this._getWorkspaceProfileEntry(profileName);
        const windows = Array.isArray(profile?.windows) ? profile.windows : [];
        const target = this._normalizeAppIdForMatch(appId);

        return windows.some(config => this._normalizeAppIdForMatch(config?.app_id) === target);
    }

    _getWorkspaceContextForFocusedApp(workspaceItem) {
        const contexts = Array.isArray(workspaceItem?.contexts) ? workspaceItem.contexts : [];
        if (contexts.length === 0) return null;

        const focusedAppId = this._getFocusedAppId();
        if (!focusedAppId) return null;

        const target = this._normalizeAppIdForMatch(focusedAppId);
        return contexts.find(context =>
            this._normalizeAppIdForMatch(context?.appId || context?.value) === target
        ) || null;
    }

    _getWorkspaceDropContext(workspaceItem) {
        const contexts = Array.isArray(workspaceItem?.contexts) ? workspaceItem.contexts : [];
        if (contexts.length === 0) return null;

        const focusedContext = this._getWorkspaceContextForFocusedApp(workspaceItem);
        if (focusedContext?.id) return focusedContext;

        return contexts.length === 1 ? contexts[0] : null;
    }

    _getFocusedAppId() {
        try {
            const win = global.display.get_focus_window?.();
            if (!win) return '';

            const tracker = Shell.WindowTracker.get_default?.();
            const app = tracker?.get_window_app?.(win);
            return app?.get_id?.() || '';
        } catch (e) {
            return '';
        }
    }

    _workspaceProfilesAutoLaunchEnabled() {
        try {
            return this._settings?.get_boolean('profiles-auto-launch') ?? true;
        } catch (e) {
            return true;
        }
    }

    _getWorkspaceProfileEntry(profileName) {
        if (!profileName) return null;

        try {
            const data = JSON.parse(this._settings?.get_string('profiles-saved-data') || '{}');
            const profiles = data?.version === 2 && data.profiles ? data.profiles : data;
            const entry = profiles?.[profileName];
            if (Array.isArray(entry)) {
                return { name: profileName, windows: entry };
            }
            if (entry && typeof entry === 'object' && Array.isArray(entry.windows)) {
                return entry;
            }
        } catch (e) {
            logError(`Failed to read linked workspace profile "${profileName}": ${e.message}`);
        }

        return null;
    }

    _normalizeAppIdForMatch(appId) {
        const value = String(appId ?? '').trim().toLowerCase();
        if (!value) return '';
        return value.endsWith('.desktop') ? value : `${value}.desktop`;
    }

    _applyWorkspaceProfile(profileName) {
        if (!profileName) return false;

        try {
            if (global.gnome_essentials_profiles &&
                typeof global.gnome_essentials_profiles.applyProfile === 'function') {
                global.gnome_essentials_profiles.applyProfile(profileName);
                return true;
            }
        } catch (e) {
            logError(`Direct workspace profile restore failed: ${e.message}`);
        }

        try {
            this._settings?.set_boolean('profiles-enabled', true);
            const current = this._settings?.get_string('profiles-active-profile') || '';
            if (current === profileName) {
                this._settings.set_string('profiles-active-profile', '');
            }
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                try {
                    this._settings?.set_string('profiles-active-profile', profileName);
                } catch (e) {
                    logError(`Deferred workspace profile restore failed: ${e.message}`);
                }
                return GLib.SOURCE_REMOVE;
            });
            return true;
        } catch (e) {
            logError(`Workspace profile restore trigger failed: ${e.message}`);
            return false;
        }
    }

    _applyWorkspaceProfileWithAutoLaunch(profileName, autoLaunch) {
        if (!profileName) return false;

        let hadSetting = false;
        let previousValue = false;
        try {
            previousValue = this._settings?.get_boolean('profiles-auto-launch') ?? true;
            hadSetting = true;
            if (previousValue !== autoLaunch) {
                this._settings?.set_boolean('profiles-auto-launch', autoLaunch);
            }
        } catch (e) {
            hadSetting = false;
        }

        try {
            return this._applyWorkspaceProfile(profileName);
        } finally {
            if (hadSetting && previousValue !== autoLaunch) {
                try {
                    this._settings?.set_boolean('profiles-auto-launch', previousValue);
                } catch (e) {
                    logError(`Failed to restore profile auto-launch setting: ${e.message}`);
                }
            }
        }
    }

    _copyShelfRecord(record) {
        const item = record?.shelfItem;
        if (!item) return;

        this._copyText(item.path || item.uri || item.value || '');
        this._touchShelfRecord(record);
        this._notifyShelf(`Copied "${item.label}".`);
    }

    _revealShelfRecord(record) {
        const item = record?.shelfItem;
        if (!item || (item.type !== 'file' && item.type !== 'folder')) return;

        try {
            const file = item.uri
                ? Gio.File.new_for_uri(item.uri)
                : Gio.File.new_for_path(item.path);
            const target = item.type === 'folder' ? file : file.get_parent();
            if (target) {
                this._openUri(target.get_uri());
                this._touchShelfRecord(record);
                const action = item.type === 'folder' ? 'Opened folder' : 'Opened containing folder for';
                this._notifyShelf(`${action} "${item.label}".`);
            } else {
                this._notifyShelf(`Could not reveal "${item.label}".`);
            }
        } catch (e) {
            logError(`Failed to reveal shelf item: ${e.message}`);
            this._notifyShelf(`Could not reveal "${item.label}".`);
        }
    }

    _removeShelfRecord(record) {
        const item = record?.shelfItem;
        if (!item || !this._isShelfAvailable()) return;

        let removed = false;
        let message = '';

        if (record.kind === 'shelf-attachment') {
            const parent = record.parentAppItem;
            if (parent?.id) {
                removed = !!this._shelf.removeAttachment(parent.id, item.id);
                message = `Removed "${item.label}" from ${parent.label || 'app context'}.`;
            }
        } else if (record.kind === 'shelf-workspace-attachment') {
            const workspace = record.parentWorkspaceItem;
            const context = record.parentWorkspaceContext;
            if (workspace?.id && context?.id) {
                removed = !!this._shelf.removeWorkspaceContextAttachment?.(workspace.id, context.id, item.id);
                message = `Removed "${item.label}" from ${context.label || 'workspace app context'}.`;
            }
        } else {
            const label = item.label || item.value || 'Shelf item';
            if (item.type === 'workspace') {
                const profileDeleted = this._deleteWorkspaceProfile(item.profileName || item.value || item.label || '');
                removed = !!this._shelf.remove(item.id);
                message = profileDeleted
                    ? `Deleted workspace context "${label}".`
                    : `Removed "${label}" from Shelf, but the linked Workspace Profile was not deleted.`;
            } else {
                removed = !!this._shelf.remove(item.id);
                message = `Removed "${label}" from Shelf.`;
            }
        }

        if (removed) {
            this._notifyShelf(message);
        } else {
            this._notifyShelf(`Could not remove "${item.label || 'Shelf item'}".`);
        }

        if (this._isOpen) this._renderResults(this._getSearchText());
    }

    _touchShelfRecord(record) {
        if (record?.kind === 'shelf-attachment') {
            const parent = record.parentAppItem;
            if (parent?.id) this._shelf?.touch?.(parent.id);
            return;
        }

        if (record?.kind === 'shelf-workspace-attachment' || record?.kind === 'shelf-workspace-app') {
            const parent = record.parentWorkspaceItem;
            if (parent?.id) this._shelf?.touch?.(parent.id);
            return;
        }

        const item = record?.shelfItem;
        if (item?.id) this._shelf?.touch?.(item.id);
    }

    _launchApp(record, options = {}) {
        const app = record?.app;
        if (!app) throw new Error('missing Shell app');

        const forceNewWindow = !!options.forceNewWindow;
        const timestamp = this._getLaunchTimestamp();

        if (forceNewWindow && typeof app.open_new_window === 'function') {
            app.open_new_window(-1);
            log(`Launched ${record.name} via Shell.App.open_new_window`);
            return;
        }

        if (!forceNewWindow && typeof app.activate === 'function') {
            app.activate();
            log(`Activated ${record.name} via Shell.App.activate`);
            return;
        }

        if (!forceNewWindow && typeof app.activate_full === 'function') {
            app.activate_full(timestamp, -1);
            log(`Activated ${record.name} via Shell.App.activate_full`);
            return;
        }

        const appInfo = app.appInfo ?? app.get_app_info?.();
        if (appInfo && typeof appInfo.launch === 'function') {
            const context = global.create_app_launch_context?.(timestamp, -1) ?? null;
            appInfo.launch([], context);
            log(`Launched ${record.name} via Gio.AppInfo.launch`);
            return;
        }

        throw new Error('no supported launch method');
    }

    _getLaunchTimestamp() {
        try {
            const displayTime = global.display?.get_current_time_roundtrip?.();
            if (Number.isFinite(displayTime) && displayTime >= 0 && displayTime <= 0xffffffff) {
                return displayTime >>> 0;
            }
        } catch (e) {
            // Fall back below.
        }

        try {
            const eventTime = Clutter.get_current_event_time?.();
            if (Number.isFinite(eventTime) && eventTime >= 0 && eventTime <= 0xffffffff) {
                return eventTime >>> 0;
            }
        } catch (e) {
            // Fall back below.
        }

        return 0;
    }

    _uninstallAppRecord(record) {
        if (!record || !record.app) return;

        try {
            // Close the Essential Menu quick launcher first
            this.close(true);

            // Resolve absolute import URI relative to the current module's absolute file path to work reliably in GJS ESM
            const currentDir = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));
            const importUri = `${currentDir}/appUninstallUtility.js?v=20260603-install-source`;

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

    _activateSearchMode(prefix) {
        if (!this._searchEntry) return;

        const text = `${prefix} `;
        const previousText = this._getSearchText();
        this._setSearchText(text);
        this._moveSearchCursorToEnd();
        this._grabSearchFocus();
        if (previousText === text) {
            this._renderResults(text);
        }
    }

    _getSearchText() {
        if (!this._searchEntry) return '';

        if (typeof this._searchEntry.get_text === 'function') {
            return this._searchEntry.get_text();
        }

        return this._searchEntry.clutter_text?.get_text() ?? '';
    }

    _moveSearchCursorToEnd() {
        try {
            const textLength = this._getSearchText().length;
            this._searchEntry.clutter_text?.set_cursor_position(textLength);
            this._searchEntry.clutter_text?.set_selection_bound(textLength);
        } catch (e) {
            // Cursor placement is cosmetic; focus still works without it.
        }
    }

    _grabSearchFocus() {
        try {
            if (!this._searchEntry) return;

            if (typeof this._searchEntry.grab_key_focus === 'function') {
                this._searchEntry.grab_key_focus();
            } else {
                this._searchEntry.clutter_text?.grab_key_focus();
            }
        } catch (e) {
            // The launcher is still usable by clicking the search field.
        }
    }

    _scheduleSearchFocus() {
        this._cancelSearchFocus();

        // Attempt synchronous grab-focus immediately so the search entry renders
        // in its focused state from the very first frame, preventing any visual style transition flash.
        this._grabSearchFocus();

        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusIdleId = 0;
            if (!this._isOpen || !this._searchEntry) return GLib.SOURCE_REMOVE;

            this._grabSearchFocus();
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
            if (this._handleManualShelfDragCapturedEvent(event)) return Clutter.EVENT_STOP;

            if (eventType === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            if (this._isInternalShelfDragActive()) return Clutter.EVENT_PROPAGATE;

            if (eventType === Clutter.EventType.BUTTON_PRESS ||
                eventType === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                if (!this._pointInsideActor(this._launcher, x, y) &&
                    !this._pointInsideActor(this._indicator, x, y) &&
                    !this._pointInsideActor(this._floatingDropActor, x, y)) {
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
