// GNOME Essentials: Application install source classification

import GLib from 'gi://GLib';

/**
 * Normalizes input text by trimming trailing/leading whitespaces and handling null values.
 * @param {*} value - The raw text input.
 * @returns {string} The trimmed and safe string.
 */
function normalizeText(value) {
    return String(value ?? '').trim();
}

/**
 * Removes the `.desktop` file extension suffix from an application identifier.
 * @param {string} appId - The raw desktop file name or ID.
 * @returns {string} The ID without the desktop extension.
 */
function desktopIdWithoutSuffix(appId) {
    return normalizeText(appId).replace(/\.desktop$/i, '');
}

function pathIsInsideDirectory(filePath, directoryPath) {
    const path = normalizeText(filePath);
    const directory = normalizeText(directoryPath);
    if (!path || !directory) return false;

    const canonicalPath = GLib.canonicalize_filename(path, null);
    const canonicalDirectory = GLib.canonicalize_filename(directory, null);
    return canonicalPath === canonicalDirectory ||
        canonicalPath.startsWith(`${canonicalDirectory}/`);
}

/**
 * Extracts the snap identifier token occurring after a "snap run" command invocation.
 * @param {string} execLine - The desktop launcher execute command line.
 * @returns {string} The snap package name or an empty string.
 */
function commandTokenAfterSnapRun(execLine) {
    const match = normalizeText(execLine).match(/(?:^|\s)snap\s+run\s+([^\s]+)/);
    return match?.[1] || '';
}

/**
 * Extracts the snap identifier token from a direct `/snap/bin/` absolute path command.
 * @param {string} execLine - The desktop launcher execute command line.
 * @returns {string} The snap package name or an empty string.
 */
function commandTokenFromSnapBin(execLine) {
    const match = normalizeText(execLine).match(/\/snap\/bin\/([^\s/]+)/);
    return match?.[1] || '';
}

/**
 * Detects and resolves the primary package identifier for Snap applications by analyzing
 * metadata sources like Exec lines, file names, and paths.
 * @param {string} appId - Desktop application ID.
 * @param {string} desktopPath - File path of the desktop launcher.
 * @param {string} execLine - Execute command line argument.
 * @returns {string} The inferred Snap package identifier.
 */
function snapPackageIdFrom(appId, desktopPath, execLine) {
    const fromSnapRun = commandTokenAfterSnapRun(execLine);
    if (fromSnapRun) return fromSnapRun.split('.')[0];

    const fromSnapBin = commandTokenFromSnapBin(execLine);
    if (fromSnapBin) return fromSnapBin.split('.')[0];

    const desktopId = desktopIdWithoutSuffix(appId);
    if (desktopId.includes('_')) return desktopId.split('_')[0];

    const basename = normalizeText(desktopPath).split('/').pop() || '';
    const fileId = desktopIdWithoutSuffix(basename);
    if (fileId.includes('_')) return fileId.split('_')[0];

    return desktopId;
}

/**
 * Retrieves the command line execution string from an AppInfo object safely.
 * @param {Gio.AppInfo} appInfo - Native GNOME AppInfo instance.
 * @returns {string} The raw execution command line, or empty string if it fails.
 */
function getCommandLine(appInfo) {
    try {
        return normalizeText(appInfo?.get_commandline?.());
    } catch (e) {
        return '';
    }
}

/**
 * Checks whether an application corresponds to a Web Application or Progressive Web App (PWA)
 * by evaluating its ID, desktop file paths, and browser application flags.
 * @param {string} appId - Application ID.
 * @param {string} desktopPath - Desktop file location.
 * @param {string} execLine - Raw execution command.
 * @returns {boolean} True if classified as a web application.
 */
function isWebAppLauncher(appId, desktopPath, execLine) {
    const id = normalizeText(appId).toLowerCase();
    const path = normalizeText(desktopPath).toLowerCase();
    const exec = normalizeText(execLine).toLowerCase();

    return exec.includes('--app-id=') ||
        exec.includes('--app=') ||
        exec.includes('webapp-manager') ||
        exec.includes('epiphany --application-mode') ||
        /(^|\/)(chrome|chromium|brave|vivaldi|microsoft-edge|msedge)[^ ]*\s+.*--app/.test(exec) ||
        /^(chrome|chromium|brave|vivaldi|microsoft-edge|msedge)-.+\.desktop$/.test(id) ||
        path.includes('/applications/chrome-') ||
        path.includes('/applications/brave-') ||
        path.includes('/applications/msedge-');
}

/**
 * Maps a standardized install package source string to its corresponding GNOME Symbolic Icon Name.
 * @param {string} sourceType - The parsed source type (e.g. flatpak, snap, webapp, local, native).
 * @returns {string} A valid GNOME symbolic icon resource name.
 */
export function installSourceIconName(sourceType) {
    switch (sourceType) {
        case 'flatpak':
            return 'package-x-generic-symbolic';
        case 'snap':
            return 'package-x-generic-symbolic';
        case 'webapp':
            return 'web-browser-symbolic';
        case 'local':
            return 'text-x-generic-symbolic';
        case 'native':
            return 'application-x-executable-symbolic';
        default:
            return 'dialog-question-symbolic';
    }
}

/**
 * Performs heuristic analyses on desktop paths, execution strings, and file targets
 * to classify applications into their specific packaging system (Flatpak, Snap, PWA, or native).
 * @export
 * @param {string} appId - The .desktop ID of the application.
 * @param {string} [desktopPath=''] - The file system path to the desktop file.
 * @param {Gio.AppInfo} [appInfo=null] - Gio.AppInfo object, if available.
 * @returns {Object} Structured classification data describing package origin and details.
 */
export function classifyAppInstallSource(appId, desktopPath = '', appInfo = null) {
    const id = normalizeText(appId);
    const path = normalizeText(desktopPath);
    const execLine = getCommandLine(appInfo);
    const packageId = desktopIdWithoutSuffix(id);

    // Heuristics for Flatpak packages
    if (path.includes('/flatpak/') || path.includes('/exports/share/applications/')) {
        const isUser = path.includes('/.local/share/flatpak/');
        return {
            type: 'flatpak',
            sourceType: 'flatpak',
            sourceLabel: 'Flatpak',
            isUser,
            appId: packageId,
            path,
            exec: execLine,
            details: isUser ? 'User Flatpak package' : 'System Flatpak package'
        };
    }

    // Heuristics for Snap packages
    if (path.includes('/snapd/') || path.includes('/snap/') || execLine.includes('/snap/bin/') || /^snap\s+run\b/.test(execLine)) {
        return {
            type: 'snap',
            sourceType: 'snap',
            sourceLabel: 'Snap',
            appId: snapPackageIdFrom(id, path, execLine),
            desktopId: packageId,
            path,
            exec: execLine,
            details: 'Snap package'
        };
    }

    // Heuristics for local user shortcuts and Progressive Web Apps (PWAs)
    const userAppsDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
    if (pathIsInsideDirectory(path, userAppsDir)) {
        const isWebApp = isWebAppLauncher(id, path, execLine);
        return {
            type: 'local',
            sourceType: isWebApp ? 'webapp' : 'local',
            sourceLabel: isWebApp ? 'Web app' : 'Local desktop file',
            isPWA: isWebApp,
            appId: packageId,
            path,
            exec: execLine,
            details: isWebApp ? 'Web app launcher' : 'Local desktop file'
        };
    }

    // Default classification: System native package manager (APT, DNF, Pacman, etc.)
    return {
        type: 'system',
        sourceType: 'native',
        sourceLabel: 'Native package',
        appId: id,
        path,
        exec: execLine,
        details: 'Native system package'
    };
}
