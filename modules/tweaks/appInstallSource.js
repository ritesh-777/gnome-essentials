// GNOME Essentials: Application install source classification

import GLib from 'gi://GLib';

function normalizeText(value) {
    return String(value ?? '').trim();
}

function desktopIdWithoutSuffix(appId) {
    return normalizeText(appId).replace(/\.desktop$/i, '');
}

function commandTokenAfterSnapRun(execLine) {
    const match = normalizeText(execLine).match(/(?:^|\s)snap\s+run\s+([^\s]+)/);
    return match?.[1] || '';
}

function commandTokenFromSnapBin(execLine) {
    const match = normalizeText(execLine).match(/\/snap\/bin\/([^\s/]+)/);
    return match?.[1] || '';
}

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

function getCommandLine(appInfo) {
    try {
        return normalizeText(appInfo?.get_commandline?.());
    } catch (e) {
        return '';
    }
}

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

export function classifyAppInstallSource(appId, desktopPath = '', appInfo = null) {
    const id = normalizeText(appId);
    const path = normalizeText(desktopPath);
    const execLine = getCommandLine(appInfo);
    const packageId = desktopIdWithoutSuffix(id);

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

    const userAppsDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
    if (path && path.startsWith(userAppsDir)) {
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
