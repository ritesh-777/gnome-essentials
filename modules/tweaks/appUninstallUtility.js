// GNOME Essentials: App Uninstallation Utility
// Author: Ritesh Seth
// License: GPL v3
//
// appUninstallUtility.js (Grid Context-Menu Package Remover)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import { classifyAppInstallSource, installSourceIconName } from './appInstallSource.js';

const DEBUG = true;

/**
 * Log a message to the console with the uninstaller prefix if DEBUG is enabled.
 * @param {string} msg - The log message.
 */
function log(msg) {
    if (DEBUG) console.log('[GnomeEssentials][UninstallUtility] ' + msg);
}

/**
 * Log an error message to the console with the uninstaller prefix.
 * @param {string} msg - The error log message.
 */
function logError(msg) {
    console.error('[GnomeEssentials][UninstallUtility] ERROR: ' + msg);
}

function installSourceCapsuleStyle(sourceType = '') {
    const palette = {
        flatpak: ['rgba(28, 113, 216, 0.28)', 'rgba(98, 160, 234, 0.52)', '#d7e8ff'],
        snap: ['rgba(145, 65, 172, 0.28)', 'rgba(192, 97, 203, 0.52)', '#f4d7ff'],
        webapp: ['rgba(38, 162, 105, 0.24)', 'rgba(87, 227, 137, 0.46)', '#d9ffe8'],
        local: ['rgba(229, 165, 10, 0.22)', 'rgba(245, 194, 17, 0.46)', '#fff0c2'],
        native: ['rgba(255, 255, 255, 0.10)', 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.86)']
    };
    const [bg, border, text] = palette[sourceType] || palette.native;

    return [
        'padding: 2px 8px',
        'border-radius: 999px',
        `background-color: ${bg}`,
        `border: 1px solid ${border}`,
        `color: ${text}`
    ].join('; ');
}

/**
 * Creates and constructs the native Modal confirmation dialog before initiating app removal.
 * Allows users to choose whether to clean cache files or purge orphans.
 * @param {string} appName - Display name of the application.
 * @param {Object} classification - Classify details of the application package type.
 * @param {Shell.App} app - Native Shell App instance.
 * @param {Function} onConfirm - Callback triggered when the user clicks 'Uninstall'.
 * @returns {ModalDialog.ModalDialog} The constructed Native Confirmation Dialog.
 */
function createConfirmUninstallDialog(appName, classification, app, onConfirm) {
    const dialog = new ModalDialog.ModalDialog({
        styleClass: 'confirm-uninstall-dialog'
    });

    // Style the dialog box container
    dialog.contentLayout.style = 'padding: 24px; width: 380px; spacing: 12px;';
    
    // Horizontal box for App Icon + Title details
    const headerBox = new St.BoxLayout({
        style: 'spacing: 16px; margin-bottom: 8px;',
        vertical: false
    });

    const iconActor = app.create_icon_texture(64);
    if (iconActor) {
        headerBox.add_child(iconActor);
    }

    const textColumn = new St.BoxLayout({
        vertical: true,
        style: 'spacing: 4px;'
    });

    const titleLabel = new St.Label({
        text: `Uninstall ${appName}?`,
        style: 'font-size: 16pt; font-weight: bold; color: #ffffff;'
    });
    textColumn.add_child(titleLabel);

    const sourceBadge = new St.Bin({
        x_align: Clutter.ActorAlign.START,
        style: installSourceCapsuleStyle(classification.sourceType)
    });
    const sourceBadgeLabel = new St.Label({
        text: classification.sourceLabel || classification.details,
        style: 'font-size: 9.5pt; font-weight: bold; color: inherit; text-align: center;'
    });
    sourceBadge.set_child(sourceBadgeLabel);
    textColumn.add_child(sourceBadge);

    headerBox.add_child(textColumn);
    dialog.contentLayout.add_child(headerBox);

    let descText = `Are you sure you want to permanently remove ${appName}?`;
    if (classification.type === 'system') {
        descText += '\n\nNote: This is a system package and will require administrator authentication.';
    } else if (classification.type === 'flatpak' && !classification.isUser) {
        descText += '\n\nNote: This is a system-wide Flatpak and will require authentication.';
    } else if (classification.type === 'snap') {
        descText += '\n\nNote: This is a Snap package and will require authentication.';
    }
    
    const descLabel = new St.Label({
        text: descText,
        style: 'font-size: 11pt; color: #dddddd;'
    });
    descLabel.clutter_text.line_wrap = true;
    descLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
    dialog.contentLayout.add_child(descLabel);

    // Spacer widget
    const spacer = new St.Widget({ height: 8 });
    dialog.contentLayout.add_child(spacer);

    // Native Checkbox for hidden files cleanup
    const deleteDataBox = new CheckBox.CheckBox('Delete configuration and cache files');
    deleteDataBox.checked = true;
    dialog.contentLayout.add_child(deleteDataBox);

    // Conditional Native Checkbox for unused dependencies (orphans)
    let deleteDepsBox = null;
    if (classification.type === 'system') {
        deleteDepsBox = new CheckBox.CheckBox('Remove unused dependencies (orphans)');
        deleteDepsBox.checked = true;
        dialog.contentLayout.add_child(deleteDepsBox);
    }

    dialog.setButtons([{
        label: 'Cancel',
        action: () => dialog.close(),
        key: Clutter.KEY_Escape
    }, {
        label: 'Uninstall',
        action: () => {
            const deleteData = deleteDataBox.checked;
            const deleteDeps = deleteDepsBox ? deleteDepsBox.checked : false;
            dialog.close();
            onConfirm(deleteData, deleteDeps);
        },
        key: Clutter.KEY_Return
    }]);

    return dialog;
}

let originalSetApp = null;

/**
 * AppUninstallUtility class.
 * Hooks into the GNOME Shell dynamic desktop app grid right-click context menu,
 * appending an asynchronous red "Uninstall" context action supporting flatpak, snap, and system-native packages.
 */
export default class AppUninstallUtility {
    /**
     * Constructs the AppUninstallUtility instance.
     * @param {Gio.Settings} settings - The GSettings manager object.
     */
    constructor(settings) {
        this._settings = settings;
        this._active = false;
        this._AppMenuClass = null;
    }

    /**
     * Hooks GNOME's dynamic AppMenu system and patches context menus on active AppIcons.
     * @returns {void}
     */
    enable() {
        if (this._active) return;
        log('Enabling App Uninstallation Utility...');

        import('resource:///org/gnome/shell/ui/appMenu.js').then(AppMenuModule => {
            if (AppMenuModule.AppMenu) {
                this._AppMenuClass = AppMenuModule.AppMenu;

                if (!originalSetApp) {
                    originalSetApp = this._AppMenuClass.prototype.setApp;
                    const self = this;

                    this._AppMenuClass.prototype.setApp = function(app) {
                        const appChanged = this._app !== app;

                        // Call standard menu creation
                        originalSetApp.call(this, app);

                        if (!app) return;

                        // If the app did not change, the original setApp returned early,
                        // so we should also return early to prevent duplicates.
                        if (!appChanged) return;

                        const appId = app.get_id();
                        if (!appId) return;

                        // Protect core shell components from accidental deletion
                        if (appId.startsWith('org.gnome.Shell') || appId === 'gnome-shell.desktop') return;

                        const appInfo = app.get_app_info?.();
                        const classification = self._classifyApp(
                            appId,
                            appInfo?.get_filename?.() || '',
                            appInfo
                        );

                        // Add visual separator
                        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                        const sourceItem = new PopupMenu.PopupBaseMenuItem({
                            reactive: false,
                            can_focus: false
                        });
                        sourceItem.add_child(new St.Icon({
                            icon_name: installSourceIconName(classification.sourceType),
                            icon_size: 16
                        }));
                        sourceItem.add_child(new St.Label({
                            text: 'Install source',
                            y_align: Clutter.ActorAlign.CENTER,
                            style: 'font-size: 10pt; color: rgba(255, 255, 255, 0.72);'
                        }));
                        const sourceCapsule = new St.Bin({
                            y_align: Clutter.ActorAlign.CENTER,
                            style: installSourceCapsuleStyle(classification.sourceType)
                        });
                        sourceCapsule.set_child(new St.Label({
                            text: classification.sourceLabel || classification.details,
                            style: 'font-size: 9.5pt; font-weight: bold; color: inherit; text-align: center;'
                        }));
                        sourceItem.add_child(sourceCapsule);
                        this.addMenuItem(sourceItem);

                        // Add "Uninstall" menu option
                        const item = new PopupMenu.PopupImageMenuItem(
                            `Uninstall (${classification.sourceLabel || 'App'})`,
                            'user-trash-symbolic'
                        );
                        
                        // Color it red to denote a destructive/permanent operation
                        item.actor.add_style_class_name('uninstall-menu-item');
                        item.actor.style = 'color: #ff5555;';

                        item.connect('activate', () => {
                            self._confirmAndUninstall(app);
                        });

                        this.addMenuItem(item);
                    };
                }
                
                // Clear cached menus once patched so they rebuild with the uninstall option
                this._clearAllCachedMenus();
            }
        }).catch(err => {
            logError(`Failed to hook AppMenu: ${err.message}`);
        });

        this._active = true;
        log('App Uninstallation Utility successfully hooked.');
    }

    /**
     * Restores context menus to original unpatched behaviors and destroys cached references.
     * @returns {void}
     */
    disable() {
        if (!this._active) return;
        log('Disabling App Uninstallation Utility...');

        if (originalSetApp && this._AppMenuClass) {
            this._AppMenuClass.prototype.setApp = originalSetApp;
            originalSetApp = null;
        }
        this._AppMenuClass = null;

        // Clear cached menus so they rebuild without the uninstall option immediately
        this._clearAllCachedMenus();

        this._active = false;
        log('App Uninstallation Utility successfully restored.');
    }

    /**
     * Walks the global stage layout recursively to find and destroy active AppIcon cached menus,
     * ensuring immediate UI changes when toggling the uninstaller setting.
     * @private
     * @returns {void}
     */
    _clearAllCachedMenus() {
        const findAllAppIcons = (parent) => {
            let results = [];
            if (!parent) return results;

            let children = typeof parent.get_children === 'function' ? parent.get_children() : [];
            for (let child of children) {
                if (child && child.constructor && child.constructor.name === 'AppIcon') {
                    results.push(child);
                }
                results = results.concat(findAllAppIcons(child));
            }
            return results;
        };

        try {
            const icons = findAllAppIcons(global.stage);
            log(`Clearing cached menus on ${icons.length} AppIcon instances`);
            for (const icon of icons) {
                if (icon && icon._menu) {
                    try {
                        icon._menu.destroy();
                    } catch (e) {}
                    icon._menu = null;
                }
            }
        } catch (e) {
            logError(`Failed to clear cached menus: ${e.message}`);
        }
    }

    /**
     * Classification entry point that resolves package kind and triggers confirmation prompt.
     * @private
     * @param {Shell.App} app - Native Shell App instance.
     * @returns {void}
     */
    _confirmAndUninstall(app) {
        const appId = app.get_id();
        const appName = app.get_name();
        const appInfo = app.get_app_info();
        if (!appInfo) {
            Main.notify("Error", `Could not read application details for ${appName}`);
            return;
        }

        const desktopPath = appInfo.get_filename();
        const classification = this._classifyApp(appId, desktopPath, appInfo);

        // Spawn Native Confirmation Box with Checkbox
        const dialog = createConfirmUninstallDialog(appName, classification, app, (deleteData, deleteDeps) => {
            this._executeUninstall(appId, appName, classification, deleteData, deleteDeps);
        });
        dialog.open();
    }

    /**
     * Inspects desktop paths, Exec configurations, and file systems to classify packages
     * into User-Flatpak, System-Flatpak, Snap, PWA, or Native System.
     * @private
     * @param {string} appId - The ID of the desktop file.
     * @param {string} desktopPath - The filename path of the desktop launcher.
     * @param {Gio.AppInfo} appInfo - Native AppInfo properties.
     * @returns {Object} Package classification details.
     */
    _classifyApp(appId, desktopPath, appInfo) {
        return classifyAppInstallSource(appId, desktopPath, appInfo);
    }

    /**
     * Executes the uninstallation processes asynchronously based on package type, and cleans user caches.
     * @private
     * @async
     * @param {string} appId - App ID.
     * @param {string} appName - Display name.
     * @param {Object} classification - Classify details of the package.
     * @param {boolean} deleteData - True if configuration folders should be pruned.
     * @param {boolean} deleteDeps - True if orphan package removal should be requested (apt/dnf/pacman).
     * @returns {Promise<void>}
     */
    async _executeUninstall(appId, appName, classification, deleteData, deleteDeps) {
        log(`Executing uninstallation of ${appName} (${classification.type}), deleteData = ${deleteData}, deleteDeps = ${deleteDeps}...`);
        Main.notify("Uninstalling", `Removing ${appName}...`);

        try {
            let success = false;

            if (classification.type === 'flatpak') {
                success = await this._uninstallFlatpak(classification, deleteData);
            } else if (classification.type === 'snap') {
                success = await this._uninstallSnap(classification, deleteData);
            } else if (classification.type === 'local') {
                success = await this._uninstallLocal(classification, deleteData);
            } else if (classification.type === 'system') {
                success = await this._uninstallSystem(classification, deleteData, deleteDeps);
            }

            if (success) {
                // Perform deep cleanup of user configs/caches if requested
                if (deleteData) {
                    this._deleteUserData(classification, appId, appName);
                }

                Main.notify("Success", `${appName} has been uninstalled successfully.`);
                // Request Shell refresh
                if (typeof Shell.AppSystem.get_default()._rebuildAppIndex === 'function') {
                    Shell.AppSystem.get_default()._rebuildAppIndex();
                }
            } else {
                Main.notify("Failed to Uninstall", `Could not remove ${appName}. Check logs for details.`);
            }
        } catch (e) {
            logError(`Error uninstalling app: ${e.message}`);
            Main.notify("Error", `An error occurred: ${e.message}`);
        }
    }

    /**
     * Asynchronously executes flatpak uninstallation routines.
     * @private
     * @async
     * @param {Object} classification - Package details.
     * @param {boolean} deleteData - Purge flatpak sandbox files.
     * @returns {Promise<boolean>} Success status.
     */
    async _uninstallFlatpak(classification, deleteData) {
        const args = [];
        if (classification.isUser) {
            args.push('flatpak', 'uninstall');
            if (deleteData) args.push('--delete-data');
            args.push('-y', '--user', classification.appId);
        } else {
            args.push('pkexec', 'flatpak', 'uninstall');
            if (deleteData) args.push('--delete-data');
            args.push('-y', '--system', classification.appId);
        }

        return await this._runCommandAsync(args);
    }

    /**
     * Asynchronously executes snap uninstallation routines.
     * @private
     * @async
     * @param {Object} classification - Package details.
     * @param {boolean} deleteData - Purge snap config states.
     * @returns {Promise<boolean>} Success status.
     */
    async _uninstallSnap(classification, deleteData) {
        const args = ['pkexec', 'snap', 'remove'];
        if (deleteData) {
            args.push('--purge');
        }
        args.push(classification.appId);
        return await this._runCommandAsync(args);
    }

    /**
     * Asynchronously removes custom shortcuts / PWA launchers.
     * @private
     * @async
     * @param {Object} classification - Package details.
     * @param {boolean} _deleteData - Unused parameter.
     * @returns {Promise<boolean>} Success status.
     */
    async _uninstallLocal(classification, _deleteData) {
        try {
            const file = Gio.File.new_for_path(classification.path);
            if (file.query_exists(null)) {
                file.delete(null);
            }
            return true;
        } catch (e) {
            logError(`Failed to delete local desktop file: ${e.message}`);
            return false;
        }
    }

    /**
     * Asynchronously removes native system packages (Apt/Dnf/Pacman/Zypper/Gentoo Emerge)
     * using pkexec shell executors.
     * @private
     * @async
     * @param {Object} classification - Package details.
     * @param {boolean} _deleteData - Unused parameter.
     * @param {boolean} deleteDeps - Purge unused orphaned packages.
     * @returns {Promise<boolean>} Success status.
     */
    async _uninstallSystem(classification, _deleteData, deleteDeps) {
        const desktopPath = classification.path;
        if (!desktopPath) return false;

        // Distro-aware execution script resolving symlinks and sanitizing package queries
        const resolveAndRemoveCmd = `
DELETE_DEPS="$1"
REAL_PATH=$(realpath "${desktopPath}")
if [ -z "$REAL_PATH" ] || [ ! -f "$REAL_PATH" ]; then
    REAL_PATH="${desktopPath}"
fi

if command -v pacman >/dev/null; then
    # Arch Linux (AUR & Native)
    PKG=$(pacman -Qo "$REAL_PATH" | awk '{print $5}')
    if [ -n "$PKG" ]; then
        if [ "$DELETE_DEPS" = "true" ]; then
            pkexec pacman -Rs --noconfirm "$PKG"
        else
            pkexec pacman -R --noconfirm "$PKG"
        fi
    else
        echo "No package owns file $REAL_PATH" >&2
        exit 2
    fi
elif command -v rpm >/dev/null; then
    # Fedora / openSUSE
    PKG=$(rpm -qf "$REAL_PATH" --qf "%{NAME}")
    if [ -n "$PKG" ]; then
        if command -v dnf >/dev/null; then
            if dnf --version | grep -q "dnf5"; then
                if [ "$DELETE_DEPS" = "true" ]; then
                    pkexec dnf remove -y "$PKG"
                else
                    pkexec dnf remove --no-autoremove -y "$PKG"
                fi
            else
                if [ "$DELETE_DEPS" = "true" ]; then
                    pkexec sh -c "dnf remove -y '$PKG' && dnf autoremove -y"
                else
                    pkexec dnf remove -y "$PKG"
                fi
            fi
        elif command -v zypper >/dev/null; then
            if [ "$DELETE_DEPS" = "true" ]; then
                pkexec zypper rm -u -y "$PKG"
            else
                pkexec zypper rm -y "$PKG"
            fi
        else
            echo "No supported package manager found (dnf/zypper)" >&2
            exit 3
        fi
    else
        echo "No package owns file $REAL_PATH" >&2
        exit 2
    fi
elif command -v dpkg-query >/dev/null; then
    # Debian / Ubuntu (resolves shared files securely)
    PKG=$(dpkg-query -S "$REAL_PATH" | cut -d: -f1 | awk -F, '{print $1}' | awk '{print $1}')
    if [ -n "$PKG" ]; then
        if [ "$DELETE_DEPS" = "true" ]; then
            pkexec apt-get purge --auto-remove -y "$PKG"
        else
            pkexec apt-get purge -y "$PKG"
        fi
    else
        echo "No package owns file $REAL_PATH" >&2
        exit 2
    fi
elif command -v emerge >/dev/null; then
    # Gentoo
    if command -v qfile >/dev/null; then
        PKG=$(qfile -q "$REAL_PATH" | head -n1)
    fi
    if [ -z "$PKG" ]; then
        PKG=$(basename "$REAL_PATH" .desktop)
    fi
    if [ -n "$PKG" ]; then
        if [ "$DELETE_DEPS" = "true" ]; then
            pkexec emerge --depclean "$PKG"
        else
            pkexec emerge --unmerge "$PKG"
        fi
    else
        echo "No package owns file $REAL_PATH" >&2
        exit 2
    fi
else
    exit 1
fi
`;
        const args = ['bash', '-c', resolveAndRemoveCmd, 'sh', deleteDeps ? 'true' : 'false'];
        return await this._runCommandAsync(args);
    }

    /**
     * Scans and deep-prunes config, cache, and build directories matching the application's clean name
     * to completely clear user profiles and state directories.
     * @private
     * @param {Object} classification - Package details.
     * @param {string} appId - App ID.
     * @param {string} appName - App name.
     * @returns {void}
     */
    _deleteUserData(classification, appId, appName) {
        try {
            const home = GLib.get_home_dir();
            const configBase = GLib.get_user_config_dir();
            const cacheBase = GLib.get_user_cache_dir();
            
            const cleanId = appId.replace(/\.desktop$/, '').toLowerCase();
            const cleanName = appName.toLowerCase().replace(/\s+/g, '');
            
            const probableDirs = new Set([
                cleanId,
                cleanName,
                cleanId.split('.').pop()
            ]);

            // Add standard configuration structures
            if (cleanId.includes('firefox')) {
                probableDirs.add('.mozilla');
            }
            if (cleanId.includes('chrome') || cleanId.includes('chromium')) {
                probableDirs.add('.config/google-chrome');
                probableDirs.add('.config/chromium');
            }

            // Clean up AUR helper build caches (yay, paru) for Arch Linux packages
            probableDirs.add(`yay/${cleanId}`);
            probableDirs.add(`yay/${cleanName}`);
            probableDirs.add(`paru/clone/${cleanId}`);
            probableDirs.add(`paru/clone/${cleanName}`);

            const trashDir = (base, folderName) => {
                const dirPath = folderName.startsWith('.') 
                    ? GLib.build_filenamev([home, folderName])
                    : GLib.build_filenamev([base, folderName]);
                    
                const file = Gio.File.new_for_path(dirPath);
                if (file.query_exists(null)) {
                    // Critical safety checks: Never recursively delete base system user directories
                    if (dirPath === home || dirPath === configBase || dirPath === cacheBase || folderName.length < 3) {
                        logError(`Refusing to delete critical directory path: ${dirPath}`);
                        return;
                    }
                    log(`Cleaning up leftover configuration folder asynchronously: ${dirPath}`);
                    this._runCommandAsync(['rm', '-rf', dirPath]);
                }
            };

            for (const folder of probableDirs) {
                trashDir(configBase, folder);
                trashDir(cacheBase, folder);
            }
        } catch (e) {
            logError(`Failed to clean up leftover user data: ${e.message}`);
        }
    }

    /**
     * Executes external process commands asynchronously as a Promise wrapper over Gio.Subprocess.
     * @private
     * @param {Array<string>} args - Command line arguments list.
     * @returns {Promise<boolean>} Status indicating if the command exited with success code.
     */
    _runCommandAsync(args) {
        return new Promise((resolve) => {
            try {
                const proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
                proc.wait_async(null, (_proc, result) => {
                    try {
                        _proc.wait_finish(result);
                        resolve(_proc.get_successful());
                    } catch (e) {
                        logError(`Subprocess wait failed: ${e.message}`);
                        resolve(false);
                    }
                });
            } catch (e) {
                logError(`Failed to spawn subprocess: ${e.message}`);
                resolve(false);
            }
        });
    }
}
