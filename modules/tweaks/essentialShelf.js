// GNOME Essentials: Essential Shelf storage module

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEBUG = false;
const DATA_DIR_NAME = 'gnome-essentials';
const SHELF_FILE_NAME = 'shelf.json';
const SHELF_INBOX_FILE_NAME = 'shelf-inbox.jsonl';
const DEFAULT_MAX_ITEMS = 24;
const MAX_ATTACHMENTS_PER_APP = 24;
const INBOX_PROCESS_DELAY_MS = 250;

function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][EssentialShelf] ' + msg);
}

function logError(msg) {
    console.error('[GnomeEssentials][EssentialShelf] ERROR: ' + msg);
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function isUrl(value) {
    return /^https?:\/\//i.test(String(value ?? '').trim());
}

function looksLikeFileUri(value) {
    return String(value ?? '').trim().startsWith('file://');
}

function makeId() {
    return `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

/**
 * Holds user-selected temporary shelf items for Essential Menu.
 */
export default class EssentialShelf {
    constructor(settings) {
        this._settings = settings;
        this._items = [];
        this._settingsHandlers = [];
        this._changedHandlers = new Map();
        this._nextChangedHandlerId = 1;
        this._clearTriggerValue = '';
        this._inboxMonitor = null;
        this._inboxProcessTimeoutId = 0;
        this._processingInbox = false;
        this._fileInfoCache = new Map();
        this._enabled = false;
    }

    enable() {
        this._enabled = true;
        this._connectSettings();
        this._load();
        this._processInbox();
        this._startInboxMonitor();
    }

    disable() {
        this._stopInboxMonitor();
        this._cancelInboxProcess();
        this._disconnectSettings();
        this._changedHandlers.clear();
        this._enabled = false;
        this._settings = null;
    }

    connectChanged(callback) {
        const id = this._nextChangedHandlerId++;
        this._changedHandlers.set(id, callback);
        return id;
    }

    disconnectChanged(id) {
        this._changedHandlers.delete(id);
    }

    getItems() {
        return this._items.map(item => this._cloneItem(item));
    }

    getItem(id) {
        const item = this._items.find(candidate => candidate.id === id);
        return item ? this._cloneItem(item) : null;
    }

    getCount() {
        return this._items.length;
    }

    addText(text, label = '') {
        const value = normalizeText(text);
        if (!value) return null;

        return this._addNormalizedItem(this._itemFromText(value, label));
    }

    addFromRecord(record) {
        if (!record) return null;

        if (record.app && record.id) {
            return this.addApp(
                record.id,
                record.name || record.id,
                record.iconName || '',
                record.profileName || ''
            );
        }

        if (record.kind === 'file' && record.uri) {
            return this.addUri(record.uri, record.name || '', record.iconName || '');
        }

        if (record.kind === 'web-search' && record.uri) {
            return this.addUri(record.uri, record.shelfLabel || record.query || record.name || '', record.iconName || '');
        }

        return null;
    }

    addApp(appId, label = '', iconName = '', profileName = '') {
        const id = normalizeText(appId);
        if (!id) return null;

        return this._addNormalizedItem(this._itemFromApp(id, label, iconName, profileName));
    }

    addWorkspaceContext(profileName, label = '', contexts = []) {
        const name = normalizeText(profileName);
        if (!name) return null;

        return this._addNormalizedItem(this._itemFromWorkspaceContext(name, label, contexts));
    }

    renameWorkspaceContext(id, profileName, label = '') {
        const item = this._items.find(candidate => candidate.id === id && candidate.type === 'workspace');
        const name = normalizeText(profileName);
        if (!item || !name) return null;

        item.label = normalizeText(label) || name;
        item.value = name;
        item.profileName = name;
        item.last_used_at = new Date().toISOString();
        this._save();
        this._emitChanged();
        return this._cloneItem(item);
    }

    updateWorkspaceContext(id, profileName, label = '', contexts = [], options = {}) {
        const item = this._items.find(candidate => candidate.id === id && candidate.type === 'workspace');
        const name = normalizeText(profileName);
        if (!item || !name) return null;

        const oldContexts = Array.isArray(item.contexts) ? item.contexts : [];
        const oldByApp = new Map();
        for (const context of oldContexts) {
            const key = this._normalizeAppIdForMatch(context?.appId || context?.value);
            if (key && !oldByApp.has(key)) oldByApp.set(key, context);
        }

        const preserveExistingAttachments = options.preserveExistingAttachments ??
            options.preserveManualAttachments ??
            true;
        const normalizedContexts = this._normalizeWorkspaceContexts(contexts)
            .map(context => {
                const key = this._normalizeAppIdForMatch(context.appId || context.value);
                const oldContext = oldByApp.get(key);
                const existingAttachments = preserveExistingAttachments
                    ? this._workspaceContextAttachments(oldContext)
                    : [];
                const attachments = this._mergeAttachments(context.attachments, existingAttachments);

                return {
                    ...context,
                    id: oldContext?.id || context.id,
                    attachments,
                    collapsed: oldContext ? !!oldContext.collapsed : !!context.collapsed,
                    created_at: oldContext?.created_at || context.created_at,
                    last_used_at: new Date().toISOString()
                };
            })
            .slice(0, 48);

        item.label = normalizeText(label) || name;
        item.value = name;
        item.profileName = name;
        item.contexts = normalizedContexts;
        item.last_used_at = new Date().toISOString();
        this._save();
        this._emitChanged();
        return this._cloneItem(item);
    }

    setItemCollapsed(id, collapsed) {
        const item = this._items.find(candidate => candidate.id === id);
        if (!item || !['app', 'workspace'].includes(item.type)) return false;

        item.collapsed = !!collapsed;
        item.last_used_at = new Date().toISOString();
        this._save();
        this._emitChanged();
        return true;
    }

    setWorkspaceContextCollapsed(workspaceItemId, contextId, collapsed) {
        const context = this._getWorkspaceContext(workspaceItemId, contextId);
        if (!context) return false;

        context.collapsed = !!collapsed;
        context.last_used_at = new Date().toISOString();
        this._touchWorkspaceItem(workspaceItemId);
        this._save();
        this._emitChanged();
        return true;
    }

    addUri(uri, label = '', iconName = '') {
        const value = normalizeText(uri);
        if (!value) return null;

        return this._addNormalizedItem(this._itemFromUriValue(value, label, iconName));
    }

    _itemFromUriValue(value, label = '', iconName = '') {
        if (isUrl(value)) {
            return {
                type: 'url',
                label: label || value,
                value,
                uri: value,
                iconName: iconName || 'web-browser-symbolic'
            };
        }

        if (looksLikeFileUri(value)) {
            return this._itemFromFile(Gio.File.new_for_uri(value), label, iconName);
        }

        return this._itemFromText(value, label);
    }

    remove(id) {
        const before = this._items.length;
        const item = this._items.find(candidate => candidate.id === id);
        this._items = this._items.filter(item => item.id !== id);
        if (this._items.length !== before) {
            if (item) {
                const key = item.uri || item.path || item.value;
                if (key) this._fileInfoCache.delete(key);
            }
            this._save();
            this._emitChanged();
            return true;
        }

        return false;
    }

    clear() {
        if (this._items.length === 0) return;

        this._items = [];
        this._fileInfoCache.clear();
        this._save();
        this._emitChanged();
    }

    touch(id) {
        const item = this._items.find(candidate => candidate.id === id);
        if (!item) return;

        item.last_used_at = new Date().toISOString();
        this._save();
    }

    getMostRecentAppItem(excludeId = '') {
        const appItem = this._items
            .filter(item => item.type === 'app' && item.id !== excludeId)
            .sort((a, b) => Date.parse(b.last_used_at || b.created_at || 0) -
                Date.parse(a.last_used_at || a.created_at || 0))[0];
        return appItem ? this._cloneItem(appItem) : null;
    }

    attachItemToApp(appItemId, sourceItemId) {
        const appItem = this._items.find(item => item.id === appItemId && item.type === 'app');
        const sourceItem = this._items.find(item => item.id === sourceItemId);
        if (!appItem || !sourceItem || sourceItem.type === 'app') return null;

        return this._attachToAppItem(appItem, this._itemToAttachment(sourceItem));
    }

    attachValueToApp(appItemId, value, label = '', iconName = '') {
        const appItem = this._items.find(item => item.id === appItemId && item.type === 'app');
        if (!appItem) return null;

        return this._attachToAppItem(appItem, this._itemToAttachment(this._itemFromUriValue(value, label, iconName)));
    }

    attachTextToApp(appItemId, text, label = '') {
        const appItem = this._items.find(item => item.id === appItemId && item.type === 'app');
        if (!appItem) return null;

        return this._attachToAppItem(appItem, this._itemToAttachment(this._itemFromText(text, label)));
    }

    attachItemToWorkspaceContext(workspaceItemId, contextId, sourceItemId) {
        const sourceItem = this._items.find(item => item.id === sourceItemId);
        if (!sourceItem || sourceItem.type === 'app' || sourceItem.type === 'workspace') return null;

        return this._attachToWorkspaceContext(
            workspaceItemId,
            contextId,
            this._itemToAttachment(sourceItem)
        );
    }

    attachValueToWorkspaceContext(workspaceItemId, contextId, value, label = '', iconName = '') {
        return this._attachToWorkspaceContext(
            workspaceItemId,
            contextId,
            this._itemToAttachment(this._itemFromUriValue(value, label, iconName))
        );
    }

    attachTextToWorkspaceContext(workspaceItemId, contextId, text, label = '') {
        return this._attachToWorkspaceContext(
            workspaceItemId,
            contextId,
            this._itemToAttachment(this._itemFromText(text, label))
        );
    }

    removeAttachment(appItemId, attachmentId) {
        const appItem = this._items.find(item => item.id === appItemId && item.type === 'app');
        if (!appItem || !Array.isArray(appItem.attachments)) return false;

        const before = appItem.attachments.length;
        appItem.attachments = appItem.attachments.filter(item => item.id !== attachmentId);
        if (appItem.attachments.length === before) return false;

        appItem.last_used_at = new Date().toISOString();
        this._save();
        this._emitChanged();
        return true;
    }

    removeWorkspaceContextAttachment(workspaceItemId, contextId, attachmentId) {
        const context = this._getWorkspaceContext(workspaceItemId, contextId);
        if (!context || !Array.isArray(context.attachments)) return false;

        const before = context.attachments.length;
        context.attachments = context.attachments.filter(item => item.id !== attachmentId);
        if (context.attachments.length === before) return false;

        context.last_used_at = new Date().toISOString();
        this._touchWorkspaceItem(workspaceItemId);
        this._save();
        this._emitChanged();
        return true;
    }

    clearAttachments(appItemId) {
        const appItem = this._items.find(item => item.id === appItemId && item.type === 'app');
        if (!appItem || !Array.isArray(appItem.attachments) || appItem.attachments.length === 0) return false;

        appItem.attachments = [];
        appItem.last_used_at = new Date().toISOString();
        this._save();
        this._emitChanged();
        return true;
    }

    createRecord(item) {
        const normalized = item ? { ...item } : null;
        if (!normalized) return null;

        const description = this._describeItem(normalized);
        const record = {
            kind: 'shelf-item',
            id: `shelf:${normalized.id}`,
            name: normalized.label || normalized.value || 'Shelf Item',
            description,
            iconName: normalized.iconName || this._iconNameForType(normalized.type),
            shelfItem: normalized
        };

        if (normalized.type === 'file' || normalized.type === 'folder') {
            const cacheKey = normalized.uri || normalized.path || normalized.value;
            if (cacheKey) {
                if (this._fileInfoCache.has(cacheKey)) {
                    const cached = this._fileInfoCache.get(cacheKey);
                    record.gicon = cached.gicon;
                    record.contentType = cached.contentType;
                    if (cached.previewGIcon) {
                        record.previewGIcon = cached.previewGIcon;
                        record.hasThumbnail = cached.hasThumbnail;
                    }
                    return record;
                }
            }

            try {
                const file = normalized.uri
                    ? Gio.File.new_for_uri(normalized.uri)
                    : Gio.File.new_for_path(normalized.path);
                const info = this._queryFileInfo(file);
                const previewGIcon = this._getFilePreviewGIcon(file, info);
                record.gicon = this._getFileGIcon(file, normalized.type === 'folder', info);
                record.contentType = normalized.contentType || this._getContentType(info);
                if (previewGIcon) {
                    record.previewGIcon = previewGIcon;
                    record.hasThumbnail = true;
                }

                if (cacheKey) {
                    this._fileInfoCache.set(cacheKey, {
                        gicon: record.gicon,
                        contentType: record.contentType,
                        previewGIcon: record.previewGIcon,
                        hasThumbnail: record.hasThumbnail
                    });
                }
            } catch (e) {
                // Fall back to iconName.
            }
        }

        return record;
    }

    createWorkspaceAppRecord(workspaceItem, context) {
        const normalizedWorkspace = workspaceItem ? this._normalizeStoredItem(workspaceItem) : null;
        const normalizedContext = context ? this._normalizeWorkspaceContext(context) : null;
        if (!normalizedWorkspace || normalizedWorkspace.type !== 'workspace' || !normalizedContext) return null;

        const attachmentCount = Array.isArray(normalizedContext.attachments)
            ? normalizedContext.attachments.length
            : 0;
        const record = {
            kind: 'shelf-workspace-app',
            id: `shelf-workspace-app:${normalizedWorkspace.id}:${normalizedContext.id}`,
            name: normalizedContext.label || normalizedContext.appId || 'App Context',
            description: attachmentCount > 0
                ? `${attachmentCount} captured context item${attachmentCount === 1 ? '' : 's'}`
                : 'Captured app context',
            iconName: normalizedContext.iconName || this._iconNameForType('app'),
            shelfItem: normalizedContext,
            parentWorkspaceItem: normalizedWorkspace
        };

        return record;
    }

    createAttachmentRecord(appItem, attachment) {
        const normalizedApp = appItem ? this._normalizeStoredItem(appItem) : null;
        const normalizedAttachment = attachment ? this._normalizeAttachment(attachment) : null;
        if (!normalizedApp || normalizedApp.type !== 'app' || !normalizedAttachment) return null;

        const record = {
            kind: 'shelf-attachment',
            id: `shelf-attachment:${normalizedApp.id}:${normalizedAttachment.id}`,
            name: normalizedAttachment.label || normalizedAttachment.value || 'Attachment',
            description: `Attached to ${normalizedApp.label}`,
            iconName: normalizedAttachment.iconName || this._iconNameForType(normalizedAttachment.type),
            shelfItem: normalizedAttachment,
            parentAppItem: normalizedApp
        };

        if (normalizedAttachment.type === 'file' || normalizedAttachment.type === 'folder') {
            const cacheKey = normalizedAttachment.uri || normalizedAttachment.path || normalizedAttachment.value;
            if (cacheKey) {
                if (this._fileInfoCache.has(cacheKey)) {
                    const cached = this._fileInfoCache.get(cacheKey);
                    record.gicon = cached.gicon;
                    record.contentType = cached.contentType;
                    if (cached.previewGIcon) {
                        record.previewGIcon = cached.previewGIcon;
                        record.hasThumbnail = cached.hasThumbnail;
                    }
                    return record;
                }
            }

            try {
                const file = normalizedAttachment.uri
                    ? Gio.File.new_for_uri(normalizedAttachment.uri)
                    : Gio.File.new_for_path(normalizedAttachment.path);
                const info = this._queryFileInfo(file);
                const previewGIcon = this._getFilePreviewGIcon(file, info);
                record.gicon = this._getFileGIcon(file, normalizedAttachment.type === 'folder', info);
                record.contentType = normalizedAttachment.contentType || this._getContentType(info);
                if (previewGIcon) {
                    record.previewGIcon = previewGIcon;
                    record.hasThumbnail = true;
                }

                if (cacheKey) {
                    this._fileInfoCache.set(cacheKey, {
                        gicon: record.gicon,
                        contentType: record.contentType,
                        previewGIcon: record.previewGIcon,
                        hasThumbnail: record.hasThumbnail
                    });
                }
            } catch (e) {
                // Fall back to iconName.
            }
        }

        return record;
    }

    createWorkspaceContextAttachmentRecord(workspaceItem, context, attachment) {
        const normalizedWorkspace = workspaceItem ? this._normalizeStoredItem(workspaceItem) : null;
        const normalizedContext = context ? this._normalizeWorkspaceContext(context) : null;
        const normalizedAttachment = attachment ? this._normalizeAttachment(attachment) : null;
        if (!normalizedWorkspace || normalizedWorkspace.type !== 'workspace' || !normalizedContext || !normalizedAttachment) return null;

        const record = {
            kind: 'shelf-workspace-attachment',
            id: `shelf-workspace-attachment:${normalizedWorkspace.id}:${normalizedContext.id}:${normalizedAttachment.id}`,
            name: normalizedAttachment.label || normalizedAttachment.value || 'Attachment',
            description: `Attached to ${normalizedContext.label}`,
            iconName: normalizedAttachment.iconName || this._iconNameForType(normalizedAttachment.type),
            shelfItem: normalizedAttachment,
            parentWorkspaceItem: normalizedWorkspace,
            parentWorkspaceContext: normalizedContext
        };

        if (normalizedAttachment.type === 'file' || normalizedAttachment.type === 'folder') {
            const cacheKey = normalizedAttachment.uri || normalizedAttachment.path || normalizedAttachment.value;
            if (cacheKey) {
                if (this._fileInfoCache.has(cacheKey)) {
                    const cached = this._fileInfoCache.get(cacheKey);
                    record.gicon = cached.gicon;
                    record.contentType = cached.contentType;
                    if (cached.previewGIcon) {
                        record.previewGIcon = cached.previewGIcon;
                        record.hasThumbnail = cached.hasThumbnail;
                    }
                    return record;
                }
            }

            try {
                const file = normalizedAttachment.uri
                    ? Gio.File.new_for_uri(normalizedAttachment.uri)
                    : Gio.File.new_for_path(normalizedAttachment.path);
                const info = this._queryFileInfo(file);
                const previewGIcon = this._getFilePreviewGIcon(file, info);
                record.gicon = this._getFileGIcon(file, normalizedAttachment.type === 'folder', info);
                record.contentType = normalizedAttachment.contentType || this._getContentType(info);
                if (previewGIcon) {
                    record.previewGIcon = previewGIcon;
                    record.hasThumbnail = true;
                }

                if (cacheKey) {
                    this._fileInfoCache.set(cacheKey, {
                        gicon: record.gicon,
                        contentType: record.contentType,
                        previewGIcon: record.previewGIcon,
                        hasThumbnail: record.hasThumbnail
                    });
                }
            } catch (e) {
                // Fall back to iconName.
            }
        }

        return record;
    }

    _connectSettings() {
        this._disconnectSettings();
        if (!this._settings) return;

        const bindKey = (key, callback) => {
            try {
                const id = this._settings.connect('changed::' + key, callback);
                this._settingsHandlers.push(id);
            } catch (e) {
                logError(`Failed to bind ${key}: ${e.message}`);
            }
        };

        bindKey('tweaks-essential-shelf-persist', () => {
            if (this._shouldPersist()) this._save();
            else this._deleteStorageFile();
        });
        bindKey('tweaks-essential-shelf-max-items', () => {
            this._trimToLimit();
            this._save();
            this._emitChanged();
        });
        bindKey('tweaks-essential-shelf-trigger-clear', () => this._processClearTrigger());
    }

    _disconnectSettings() {
        for (const id of this._settingsHandlers) {
            try {
                this._settings?.disconnect(id);
            } catch (e) {
                // Settings may already be disposed.
            }
        }
        this._settingsHandlers = [];
    }

    _startInboxMonitor() {
        this._stopInboxMonitor();

        try {
            const dir = Gio.File.new_for_path(this._getStorageDirPath());
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            this._inboxMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._inboxMonitor.connect('changed', (_monitor, file) => {
                if (file?.get_basename?.() === SHELF_INBOX_FILE_NAME) {
                    this._queueProcessInbox();
                }
            });
        } catch (e) {
            logError('Failed to monitor shelf inbox: ' + e.message);
            this._inboxMonitor = null;
        }
    }

    _stopInboxMonitor() {
        if (!this._inboxMonitor) return;

        try {
            this._inboxMonitor.cancel();
        } catch (e) {
            // Monitor may already be cancelled during Shell teardown.
        }
        this._inboxMonitor = null;
    }

    _queueProcessInbox() {
        this._cancelInboxProcess();

        this._inboxProcessTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INBOX_PROCESS_DELAY_MS, () => {
            this._inboxProcessTimeoutId = 0;
            this._processInbox();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelInboxProcess() {
        if (this._inboxProcessTimeoutId <= 0) return;

        GLib.source_remove(this._inboxProcessTimeoutId);
        this._inboxProcessTimeoutId = 0;
    }

    async _processInbox() {
        if (this._processingInbox) return;

        this._processingInbox = true;
        let claimedFile = null;

        try {
            claimedFile = await this._claimInboxFileAsync();
            if (!claimedFile) {
                this._processingInbox = false;
                return;
            }

            const contents = await new Promise((resolve, reject) => {
                claimedFile.load_contents_async(null, (f, res) => {
                    try {
                        const [, data] = f.load_contents_finish(res);
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            let text;
            if (typeof TextDecoder !== 'undefined') {
                text = new TextDecoder('utf-8').decode(contents);
            } else {
                text = imports.byteArray.toString(contents);
            }

            const values = this._parseInboxValues(text);
            let added = 0;

            for (const value of values) {
                const item = this._itemFromUriValue(value);
                if (this._addNormalizedItem(item, { save: false, emit: false })) {
                    added += 1;
                }
            }

            if (added > 0) {
                this._save();
                this._emitChanged();
                log(`Imported ${added} item${added === 1 ? '' : 's'} from shelf inbox`);
            }
        } catch (e) {
            logError('Failed to process shelf inbox: ' + e.message);
        } finally {
            if (claimedFile) {
                try {
                    const exists = await new Promise((resolve) => {
                        claimedFile.query_info_async(
                            'standard::name',
                            Gio.FileQueryInfoFlags.NONE,
                            GLib.PRIORITY_DEFAULT,
                            null,
                            (f, res) => {
                                try {
                                    f.query_info_finish(res);
                                    resolve(true);
                                } catch (err) {
                                    resolve(false);
                                }
                            }
                        );
                    });
                    if (exists) {
                        await new Promise((resolve, reject) => {
                            claimedFile.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
                                try {
                                    resolve(f.delete_finish(res));
                                } catch (err) {
                                    reject(err);
                                }
                            });
                        });
                    }
                } catch (e) {
                    logError('Failed to remove processed shelf inbox: ' + e.message);
                }
            }
            this._processingInbox = false;
        }
    }

    async _claimInboxFileAsync() {
        const inbox = this._getInboxFile();
        const exists = await new Promise((resolve) => {
            inbox.query_info_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (f, res) => {
                    try {
                        f.query_info_finish(res);
                        resolve(true);
                    } catch (err) {
                        resolve(false);
                    }
                }
            );
        });
        if (!exists) return null;

        const processingPath = `${this._getInboxFilePath()}.${Date.now()}.${Math.floor(Math.random() * 100000)}.processing`;
        const processingFile = Gio.File.new_for_path(processingPath);

        const moved = await new Promise((resolve) => {
            inbox.move_async(
                processingFile,
                Gio.FileCopyFlags.OVERWRITE,
                GLib.PRIORITY_DEFAULT,
                null,
                null,
                (f, res) => {
                    try {
                        resolve(f.move_finish(res));
                    } catch (err) {
                        resolve(false);
                    }
                }
            );
        });

        return moved ? processingFile : null;
    }

    _parseInboxValues(text) {
        const values = [];

        for (const rawLine of String(text ?? '').split('\n')) {
            const line = normalizeText(rawLine);
            if (!line) continue;

            if (line.startsWith('{')) {
                const parsed = this._parseInboxJsonLine(line);
                values.push(...parsed);
            } else {
                values.push(line);
            }
        }

        return values
            .map(value => normalizeText(value))
            .filter(Boolean);
    }

    _parseInboxJsonLine(line) {
        try {
            const record = JSON.parse(line);
            if (!record || typeof record !== 'object') return [];

            if (Array.isArray(record.uris)) return record.uris;
            if (Array.isArray(record.paths)) return record.paths;
            if (record.uri) return [record.uri];
            if (record.path) return [record.path];
            if (record.value) return [record.value];
        } catch (e) {
            logError('Ignoring malformed shelf inbox line: ' + e.message);
        }

        return [];
    }

    _processClearTrigger() {
        if (!this._settings) return;

        const value = this._settings.get_string('tweaks-essential-shelf-trigger-clear') || '';
        if (!value || value === this._clearTriggerValue) return;

        this._clearTriggerValue = value;
        this.clear();
    }

    _load() {
        this._items = [];

        if (!this._shouldPersist()) {
            this._emitChanged();
            return;
        }

        try {
            const file = this._getStorageFile();
            if (!file.query_exists(null)) {
                this._emitChanged();
                return;
            }

            const [, contents] = file.load_contents(null);
            const text = imports.byteArray.toString(contents);
            const parsed = JSON.parse(text || '{}');
            const source = Array.isArray(parsed) ? parsed : parsed.items;
            this._items = Array.isArray(source)
                ? source.map(item => this._normalizeStoredItem(item)).filter(Boolean)
                : [];
            this._trimToLimit();
        } catch (e) {
            logError('Failed to load shelf storage: ' + e.message);
            this._items = [];
        }

        this._emitChanged();
    }

    _save() {
        if (!this._shouldPersist()) return;

        try {
            const dir = Gio.File.new_for_path(this._getStorageDirPath());
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            const payload = JSON.stringify({
                version: 1,
                updated_at: new Date().toISOString(),
                items: this._items
            }, null, 2);

            const file = this._getStorageFile();
            const bytes = new GLib.Bytes(
                typeof TextEncoder !== 'undefined'
                    ? new TextEncoder().encode(payload)
                    : imports.byteArray.fromString(payload)
            );
            file.replace_contents_async(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (err) {
                        logError('Failed to save shelf storage asynchronously: ' + err.message);
                    }
                }
            );
        } catch (e) {
            logError('Failed to save shelf storage: ' + e.message);
        }
    }

    _deleteStorageFile() {
        try {
            const file = this._getStorageFile();
            if (file.query_exists(null)) {
                file.delete(null);
            }
        } catch (e) {
            logError('Failed to remove shelf storage: ' + e.message);
        }
    }

    _shouldPersist() {
        try {
            return this._settings?.get_boolean('tweaks-essential-shelf-persist') ?? true;
        } catch (e) {
            return true;
        }
    }

    _maxItems() {
        try {
            const value = this._settings?.get_int('tweaks-essential-shelf-max-items') ?? DEFAULT_MAX_ITEMS;
            return Math.max(4, Math.min(80, value));
        } catch (e) {
            return DEFAULT_MAX_ITEMS;
        }
    }

    _getStorageDirPath() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), DATA_DIR_NAME]);
    }

    _getStorageFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([this._getStorageDirPath(), SHELF_FILE_NAME]));
    }

    _getInboxFilePath() {
        return GLib.build_filenamev([this._getStorageDirPath(), SHELF_INBOX_FILE_NAME]);
    }

    _getInboxFile() {
        return Gio.File.new_for_path(this._getInboxFilePath());
    }

    _addNormalizedItem(item, options = {}) {
        if (!item) return null;

        const save = options.save ?? true;
        const emit = options.emit ?? true;
        const now = new Date().toISOString();
        const normalized = this._normalizeStoredItem({
            ...item,
            id: item.id || makeId(),
            created_at: item.created_at || now,
            last_used_at: now
        });
        if (!normalized) return null;

        const duplicateKey = this._duplicateKey(normalized);
        this._items = this._items.filter(candidate => this._duplicateKey(candidate) !== duplicateKey);
        this._items.unshift(normalized);
        this._trimToLimit();
        if (save) this._save();
        if (emit) this._emitChanged();
        log(`Added shelf item: ${normalized.label}`);
        return { ...normalized };
    }

    _attachToAppItem(appItem, attachment) {
        const normalizedAttachment = this._normalizeAttachment(attachment);
        if (!appItem || appItem.type !== 'app' || !normalizedAttachment) return null;

        const now = new Date().toISOString();
        const duplicateKey = this._duplicateKey(normalizedAttachment);
        const currentAttachments = Array.isArray(appItem.attachments) ? appItem.attachments : [];
        appItem.attachments = currentAttachments
            .filter(candidate => this._duplicateKey(candidate) !== duplicateKey);
        appItem.attachments.unshift({
            ...normalizedAttachment,
            id: normalizedAttachment.id || makeId(),
            created_at: normalizedAttachment.created_at || now,
            last_used_at: now
        });
        appItem.attachments = appItem.attachments
            .map(item => this._normalizeAttachment(item))
            .filter(Boolean)
            .slice(0, MAX_ATTACHMENTS_PER_APP);
        appItem.last_used_at = now;
        this._save();
        this._emitChanged();
        return this._cloneItem(appItem.attachments[0]);
    }

    _attachToWorkspaceContext(workspaceItemId, contextId, attachment) {
        const workspaceItem = this._items.find(item => item.id === workspaceItemId && item.type === 'workspace');
        const context = this._getWorkspaceContext(workspaceItemId, contextId);
        const normalizedAttachment = this._normalizeAttachment(attachment);
        if (!workspaceItem || !context || !normalizedAttachment) return null;

        const now = new Date().toISOString();
        const duplicateKey = this._duplicateKey(normalizedAttachment);
        const currentAttachments = Array.isArray(context.attachments) ? context.attachments : [];
        context.attachments = currentAttachments
            .filter(candidate => this._duplicateKey(candidate) !== duplicateKey);
        context.attachments.unshift({
            ...normalizedAttachment,
            id: normalizedAttachment.id || makeId(),
            source: normalizedAttachment.source || 'manual',
            created_at: normalizedAttachment.created_at || now,
            last_used_at: now
        });
        context.attachments = context.attachments
            .map(item => this._normalizeAttachment(item))
            .filter(Boolean)
            .slice(0, MAX_ATTACHMENTS_PER_APP);
        context.last_used_at = now;
        workspaceItem.last_used_at = now;
        this._save();
        this._emitChanged();
        return this._cloneItem(context.attachments[0]);
    }

    _getWorkspaceContext(workspaceItemId, contextId) {
        const workspaceItem = this._items.find(item => item.id === workspaceItemId && item.type === 'workspace');
        if (!workspaceItem || !Array.isArray(workspaceItem.contexts)) return null;

        return workspaceItem.contexts.find(context => context.id === contextId) || null;
    }

    _touchWorkspaceItem(workspaceItemId) {
        const workspaceItem = this._items.find(item => item.id === workspaceItemId && item.type === 'workspace');
        if (workspaceItem) workspaceItem.last_used_at = new Date().toISOString();
    }

    _normalizeStoredItem(item) {
        if (!item || typeof item !== 'object') return null;

        const type = ['file', 'folder', 'url', 'text', 'app', 'workspace'].includes(item.type) ? item.type : 'text';
        const appId = normalizeText(item.appId || item.app_id || (type === 'app' ? item.value : ''));
        const profileNameValue = normalizeText(item.profileName || item.profile_name);
        const value = normalizeText(item.value || item.uri || item.path || appId || profileNameValue);
        const label = normalizeText(item.label || this._labelFromValue(value) || value);
        if (!value || !label) return null;
        const rawProfileName = (type === 'app' || type === 'workspace')
            ? normalizeText(item.profileName || item.profile_name)
            : '';
        let profileName = '';
        if (type === 'app') {
            profileName = rawProfileName && this._profileContainsApp(rawProfileName, appId)
                ? rawProfileName
                : '';
        } else if (type === 'workspace') {
            profileName = rawProfileName || value;
        }

        return {
            id: normalizeText(item.id) || makeId(),
            type,
            label,
            value,
            uri: normalizeText(item.uri),
            path: normalizeText(item.path),
            appId,
            profileName,
            iconName: normalizeText(item.iconName || item.icon_name || this._iconNameForType(type)),
            contentType: normalizeText(item.contentType || item.content_type),
            attachments: type === 'app'
                ? this._normalizeAttachments(item.attachments)
                : [],
            contexts: type === 'workspace'
                ? this._normalizeWorkspaceContexts(item.contexts || item.apps)
                : [],
            collapsed: !!item.collapsed,
            created_at: normalizeText(item.created_at) || new Date().toISOString(),
            last_used_at: normalizeText(item.last_used_at) || normalizeText(item.created_at) || new Date().toISOString()
        };
    }

    _normalizeAttachments(attachments) {
        if (!Array.isArray(attachments)) return [];

        return attachments
            .map(item => this._normalizeAttachment(item))
            .filter(Boolean)
            .slice(0, MAX_ATTACHMENTS_PER_APP);
    }

    _normalizeWorkspaceContexts(contexts) {
        if (!Array.isArray(contexts)) return [];

        return contexts
            .map(item => this._normalizeWorkspaceContext(item))
            .filter(Boolean)
            .slice(0, 48);
    }

    _normalizeWorkspaceContext(item) {
        if (!item || typeof item !== 'object') return null;

        const appId = normalizeText(item.appId || item.app_id || item.value);
        if (!appId) return null;

        return {
            id: normalizeText(item.id) || makeId(),
            type: 'app',
            label: normalizeText(item.label || appId),
            value: appId,
            appId,
            iconName: normalizeText(item.iconName || item.icon_name || this._iconNameForType('app')),
            attachments: this._normalizeAttachments(item.attachments),
            collapsed: !!item.collapsed,
            created_at: normalizeText(item.created_at) || new Date().toISOString(),
            last_used_at: normalizeText(item.last_used_at) || normalizeText(item.created_at) || new Date().toISOString()
        };
    }

    _workspaceContextAttachments(context) {
        const attachments = Array.isArray(context?.attachments) ? context.attachments : [];
        return attachments
            .map(attachment => this._normalizeAttachment(attachment))
            .filter(Boolean);
    }

    _mergeAttachments(primary = [], secondary = []) {
        const merged = [];
        const seen = new Set();

        for (const attachment of [...(primary || []), ...(secondary || [])]) {
            const normalized = this._normalizeAttachment(attachment);
            if (!normalized) continue;

            const key = this._duplicateKey(normalized);
            if (seen.has(key)) continue;

            seen.add(key);
            merged.push(normalized);
            if (merged.length >= MAX_ATTACHMENTS_PER_APP) break;
        }

        return merged;
    }

    _normalizeAttachment(item) {
        if (!item || typeof item !== 'object') return null;

        const type = ['file', 'folder', 'url', 'text'].includes(item.type) ? item.type : 'text';
        const value = normalizeText(item.value || item.uri || item.path);
        const label = normalizeText(item.label || this._labelFromValue(value) || value);
        if (!value || !label) return null;

        return {
            id: normalizeText(item.id) || makeId(),
            type,
            label,
            value,
            uri: normalizeText(item.uri),
            path: normalizeText(item.path),
            iconName: normalizeText(item.iconName || item.icon_name || this._iconNameForType(type)),
            contentType: normalizeText(item.contentType || item.content_type),
            source: normalizeText(item.source),
            created_at: normalizeText(item.created_at) || new Date().toISOString(),
            last_used_at: normalizeText(item.last_used_at) || normalizeText(item.created_at) || new Date().toISOString()
        };
    }

    _itemToAttachment(item) {
        const normalized = this._normalizeStoredItem(item);
        if (!normalized || normalized.type === 'app') return null;

        return this._normalizeAttachment({
            ...normalized,
            id: makeId()
        });
    }

    _itemFromApp(appId, label = '', iconName = '', profileName = '') {
        const validProfileName = this._profileContainsApp(profileName, appId)
            ? normalizeText(profileName)
            : '';

        return {
            type: 'app',
            label: label || appId,
            value: appId,
            appId,
            iconName: iconName || 'application-x-executable-symbolic',
            profileName: validProfileName
        };
    }

    _itemFromWorkspaceContext(profileName, label = '', contexts = []) {
        const normalizedContexts = this._normalizeWorkspaceContexts(contexts);
        return {
            type: 'workspace',
            label: label || profileName,
            value: profileName,
            profileName,
            iconName: 'view-grid-symbolic',
            contexts: normalizedContexts,
            collapsed: true
        };
    }

    _profileContainsApp(profileName, appId) {
        const target = this._normalizeAppIdForMatch(appId);
        if (!profileName || !target) return false;

        try {
            const data = JSON.parse(this._settings?.get_string('profiles-saved-data') || '{}');
            const profiles = data?.version === 2 && data.profiles ? data.profiles : data;
            const entry = profiles?.[profileName];
            const windows = Array.isArray(entry)
                ? entry
                : Array.isArray(entry?.windows)
                    ? entry.windows
                    : [];
            return windows.some(config => this._normalizeAppIdForMatch(config?.app_id) === target);
        } catch (e) {
            logError(`Failed to validate shelf profile link "${profileName}": ${e.message}`);
            return false;
        }
    }

    _normalizeAppIdForMatch(appId) {
        const value = normalizeText(appId).toLowerCase();
        if (!value) return '';
        return value.endsWith('.desktop') ? value : `${value}.desktop`;
    }

    _itemFromText(value, label = '') {
        if (isUrl(value)) {
            return {
                type: 'url',
                label: label || value,
                value,
                uri: value,
                iconName: 'web-browser-symbolic'
            };
        }

        if (looksLikeFileUri(value)) {
            return this._itemFromFile(Gio.File.new_for_uri(value), label);
        }

        if (GLib.path_is_absolute(value)) {
            try {
                const file = Gio.File.new_for_path(value);
                if (file.query_exists(null)) {
                    return this._itemFromFile(file, label);
                }
            } catch (e) {
                // Keep it as text below.
            }
        }

        return {
            type: 'text',
            label: label || this._labelFromValue(value),
            value,
            iconName: 'text-x-generic-symbolic'
        };
    }

    _itemFromFile(file, label = '', iconName = '') {
        const fileType = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
        const isFolder = fileType === Gio.FileType.DIRECTORY;
        const uri = file.get_uri();
        const path = file.get_path() || '';
        const name = file.get_basename() || label || path || uri;
        const info = this._queryFileInfo(file);

        return {
            type: isFolder ? 'folder' : 'file',
            label: label || name,
            value: uri,
            uri,
            path,
            iconName: iconName || (isFolder ? 'folder-symbolic' : 'text-x-generic-symbolic'),
            contentType: this._getContentType(info)
        };
    }

    _trimToLimit() {
        const maxItems = this._maxItems();
        if (this._items.length > maxItems) {
            this._items = this._items.slice(0, maxItems);
        }
    }

    _duplicateKey(item) {
        const identity = item.type === 'workspace'
            ? (item.profileName || item.value)
            : (item.appId || item.uri || item.path || item.value);
        return `${item.type}:${identity}`.toLowerCase();
    }

    _cloneItem(item) {
        try {
            return JSON.parse(JSON.stringify(item));
        } catch (e) {
            return { ...item };
        }
    }

    _emitChanged() {
        for (const callback of this._changedHandlers.values()) {
            try {
                callback();
            } catch (e) {
                logError('Shelf change callback failed: ' + e.message);
            }
        }
    }

    _labelFromValue(value) {
        const text = normalizeText(value).replace(/\s+/g, ' ');
        if (text.length <= 60) return text;
        return `${text.slice(0, 57)}...`;
    }

    _describeItem(item) {
        if (item.type === 'workspace') {
            const contexts = Array.isArray(item.contexts) ? item.contexts : [];
            const appCount = contexts.length;
            const attachmentCount = contexts.reduce((total, context) => {
                const attachments = Array.isArray(context.attachments) ? context.attachments.length : 0;
                return total + attachments;
            }, 0);
            const appText = `${appCount} app${appCount === 1 ? '' : 's'}`;
            if (attachmentCount > 0) {
                return `${appText} · ${attachmentCount} context item${attachmentCount === 1 ? '' : 's'}`;
            }
            return `${appText} · workspace layout`;
        }

        if (item.type === 'app') {
            const attachmentCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
            if (attachmentCount > 0) {
                const noun = attachmentCount === 1 ? 'attachment' : 'attachments';
                return item.profileName
                    ? `${attachmentCount} ${noun} + ${item.profileName} layout`
                    : `${attachmentCount} ${noun}`;
            }
            return item.profileName
                ? `Launch app with layout - ${item.profileName}`
                : 'Launch app';
        }
        if (item.type === 'folder') return `Open folder - ${this._shortenHomePath(item.path || item.uri || item.value)}`;
        if (item.type === 'file') return `Open file - ${this._shortenHomePath(item.path || item.uri || item.value)}`;
        if (item.type === 'url') return `Open link - ${item.value}`;
        return 'Copy text snippet';
    }

    _shortenHomePath(path) {
        const value = String(path ?? '');
        const home = GLib.get_home_dir();

        if (value === home) return '~';
        if (value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
        return value;
    }

    _iconNameForType(type) {
        switch (type) {
            case 'workspace':
                return 'view-grid-symbolic';
            case 'app':
                return 'application-x-executable-symbolic';
            case 'folder':
                return 'folder-symbolic';
            case 'file':
                return 'text-x-generic-symbolic';
            case 'url':
                return 'web-browser-symbolic';
            default:
                return 'text-x-generic-symbolic';
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
            return normalizeText(info.get_attribute_string('thumbnail::path'));
        } catch (e) {
            return '';
        }
    }

    _getContentType(info) {
        try {
            return normalizeText(info?.get_content_type?.());
        } catch (e) {
            return '';
        }
    }

    _isImageContentType(contentType) {
        return String(contentType ?? '').startsWith('image/');
    }
}
