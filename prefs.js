// GNOME Essentials: Sleek, Modular Desktop Utilities
// Author: Ritesh Seth
// License: GPL v3
//
// prefs.js (Modern GTK4 / Libadwaita Preferences Dashboard)

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * GnomeEssentialsPreferences class.
 * Modern GTK4 / Libadwaita Preferences Dashboard for GNOME Essentials.
 * Renders the multi-tab layout preferences control panel, allowing users
 * to dynamically adjust focus layers, customize Pomodoro timers, trigger profile saves,
 * and toggle desktop tweaks.
 * @extends ExtensionPreferences
 */
export default class GnomeEssentialsPreferences extends ExtensionPreferences {
    /**
     * Entry point to populate the preferences window with UI elements.
     * Binds sliders, entries, and switches directly to GSettings properties.
     * @param {Adw.PreferencesWindow} window - Active Libadwaita preferences window.
     * @returns {void}
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlerIds = [];
        const connectSetting = (key, callback) => {
            const id = settings.connect(key, callback);
            handlerIds.push(id);
            return id;
        };

        let profileStatusRow = null;
        const operationId = () => `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const setProfileStatus = (message, isError = false) => {
            if (!profileStatusRow) return;

            profileStatusRow.set_visible(true);
            profileStatusRow.set_title(isError ? 'Action Failed' : 'Action Complete');
            profileStatusRow.set_subtitle(message);
            if (isError) {
                profileStatusRow.add_css_class('error');
            } else {
                profileStatusRow.remove_css_class('error');
            }
        };

        const buildIdentityKey = (appId, wmClass, title) => [appId || '', (wmClass || '').toLowerCase(), title || ''].join('|');
        const cloneWindowConfigs = (windows) => {
            if (!Array.isArray(windows)) return [];

            const cloned = windows.map(config => ({
                ...config,
                identity_key: config?.identity_key || buildIdentityKey(config?.app_id, config?.wm_class, config?.title),
                rect: config?.rect ? { ...config.rect } : null
            }));

            const sorted = [...cloned].sort((a, b) => {
                const keyA = a.identity_key || buildIdentityKey(a.app_id, a.wm_class, a.title);
                const keyB = b.identity_key || buildIdentityKey(b.app_id, b.wm_class, b.title);
                if (keyA !== keyB) return keyA < keyB ? -1 : 1;

                const workspaceDiff = (a.workspace ?? 0) - (b.workspace ?? 0);
                if (workspaceDiff !== 0) return workspaceDiff;

                const monitorDiff = (a.monitor ?? 0) - (b.monitor ?? 0);
                if (monitorDiff !== 0) return monitorDiff;

                const rectA = a.rect || {};
                const rectB = b.rect || {};
                return (rectA.x ?? 0) - (rectB.x ?? 0) ||
                    (rectA.y ?? 0) - (rectB.y ?? 0) ||
                    (rectA.width ?? 0) - (rectB.width ?? 0) ||
                    (rectA.height ?? 0) - (rectB.height ?? 0) ||
                    (a.stable_sequence ?? 0) - (b.stable_sequence ?? 0);
            });

            const counts = new Map();
            for (const config of sorted) {
                const key = config.identity_key || buildIdentityKey(config.app_id, config.wm_class, config.title);
                const index = counts.get(key) || 0;
                config.identity_key = key;
                config.identity_index = index;
                counts.set(key, index + 1);
            }

            return cloned;
        };

        const normalizeProfilesData = (data) => {
            const normalized = { version: 2, profiles: {}, safety_snapshot: null };
            if (!data || typeof data !== 'object') return normalized;

            const source = data.version === 2 && data.profiles ? data.profiles : data;
            for (const [name, entry] of Object.entries(source)) {
                if (!name || name === 'version' || name === 'profiles' || name === 'safety_snapshot') continue;

                if (Array.isArray(entry)) {
                    normalized.profiles[name] = {
                        name,
                        created_at: null,
                        updated_at: null,
                        windows: cloneWindowConfigs(entry)
                    };
                } else if (entry && typeof entry === 'object' && Array.isArray(entry.windows)) {
                    normalized.profiles[name] = {
                        name: entry.name || name,
                        created_at: entry.created_at || null,
                        updated_at: entry.updated_at || null,
                        windows: cloneWindowConfigs(entry.windows)
                    };
                }
            }

            if (data.safety_snapshot &&
                typeof data.safety_snapshot === 'object' &&
                Array.isArray(data.safety_snapshot.windows)) {
                const windows = cloneWindowConfigs(data.safety_snapshot.windows);
                normalized.safety_snapshot = windows.length > 0 ? {
                    reason: data.safety_snapshot.reason || 'unknown',
                    source: data.safety_snapshot.source || 'capture',
                    created_at: data.safety_snapshot.created_at || null,
                    monitor_signature: data.safety_snapshot.monitor_signature || '',
                    windows
                } : null;
            }

            return normalized;
        };

        const readProfilesData = () => {
            try {
                return normalizeProfilesData(JSON.parse(settings.get_string('profiles-saved-data') || '{}'));
            } catch (e) {
                setProfileStatus(`Could not read saved profiles: ${e.message}`, true);
                return { version: 2, profiles: {}, safety_snapshot: null };
            }
        };

        const writeProfilesData = (data, action, message) => {
            const normalized = normalizeProfilesData(data);
            settings.set_string('profiles-saved-data', JSON.stringify(normalized));
            settings.set_string('profiles-last-operation', JSON.stringify({
                id: operationId(),
                status: 'success',
                action,
                message,
                source: 'prefs',
                timestamp: new Date().toISOString()
            }));
            setProfileStatus(message);
        };

        const confirmAction = (heading, body, responseLabel, responseStyle, callback) => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading,
                body
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('confirm', responseLabel);
            dialog.set_default_response('cancel');
            dialog.set_close_response('cancel');
            dialog.set_response_appearance('confirm', responseStyle);
            dialog.connect('response', (_dialog, response) => {
                if (response === 'confirm') callback();
                dialog.destroy();
            });
            dialog.present();
        };

        const requestSaveProfile = (name, overwrite = true, operation = 'save') => {
            const request = {
                id: operationId(),
                name,
                overwrite,
                source: 'prefs',
                operation
            };

            settings.set_string('profiles-trigger-save', JSON.stringify(request));
            settings.set_boolean('profiles-enabled', true);
            setProfileStatus(`${operation === 'modify' ? 'Modifying' : 'Saving'} "${name}"...`);
        };

        const requestApplyProfile = (name) => {
            settings.set_boolean('profiles-enabled', true);
            if (settings.get_string('profiles-active-profile') === name) {
                settings.set_string('profiles-active-profile', '');
            }

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                settings.set_string('profiles-active-profile', name);
                return GLib.SOURCE_REMOVE;
            });
            setProfileStatus(`Applying "${name}"...`);
        };

        const renameProfile = (oldName, newName) => {
            newName = newName.trim();
            if (!newName) {
                setProfileStatus('Profile name cannot be empty.', true);
                return;
            }
            if (oldName === newName) return;

            const data = readProfilesData();
            if (!data.profiles[oldName]) {
                setProfileStatus(`Profile "${oldName}" no longer exists.`, true);
                return;
            }
            if (data.profiles[newName]) {
                setProfileStatus(`A profile named "${newName}" already exists.`, true);
                return;
            }

            data.profiles[newName] = {
                ...data.profiles[oldName],
                name: newName,
                updated_at: new Date().toISOString()
            };
            delete data.profiles[oldName];

            if (settings.get_string('profiles-active-profile') === oldName) {
                settings.set_string('profiles-active-profile', newName);
            }

            writeProfilesData(data, 'rename', `Renamed "${oldName}" to "${newName}".`);
        };

        const showRenameDialog = (oldName) => {
            const dialog = new Gtk.Dialog({
                title: 'Rename Profile',
                transient_for: window,
                modal: true
            });
            dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
            dialog.add_button('Rename', Gtk.ResponseType.ACCEPT);

            const entry = new Gtk.Entry({
                text: oldName,
                hexpand: true,
                margin_top: 18,
                margin_bottom: 18,
                margin_start: 18,
                margin_end: 18
            });
            dialog.get_content_area().append(entry);
            dialog.connect('response', (_dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    renameProfile(oldName, entry.get_text());
                }
                dialog.destroy();
            });
            dialog.present();
        };

        // Ensure window has custom styling
        window.set_default_size(720, 580);
        window.set_title('GNOME Essentials Settings');

        // ========================================================
        // PAGE 1: 🧘 DEEP WORK FOCUS MODE (FLAGSHIP MODULE)
        // ========================================================
        const deepWorkPage = new Adw.PreferencesPage({
            title: 'Deep Work Focus',
            icon_name: 'alarm-symbolic'
        });
        window.add(deepWorkPage);

        // --- Group 1: Core System Activation ---
        const coreGroup = new Adw.PreferencesGroup({
            title: 'Focus Activation',
            description: 'Instantly enter a distraction-free deep work zone.'
        });
        deepWorkPage.add(coreGroup);

        const enableSwitch = new Adw.SwitchRow({
            title: 'Enable Deep Work Focus Mode',
            subtitle: 'Hides panels, docks, silences notifications, and dims background elements.',
        });
        settings.bind('deepwork-enabled', enableSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        coreGroup.add(enableSwitch);

        // --- Group 2: Shell Visual Suppression ---
        const suppressionGroup = new Adw.PreferencesGroup({
            title: 'System Visual Suppression',
            description: 'Configure which interface elements to hide when entering focus mode.'
        });
        deepWorkPage.add(suppressionGroup);

        const snoozeLevelRow = new Adw.ComboRow({
            title: 'Visual Suppression Severity',
            subtitle: 'Choose how deeply the system shell should be cleared.',
            model: new Gtk.StringList({
                strings: [
                    'Level 1 (Hide Dock and Silence Notification banners)',
                    'Level 2 (Hide Top Panel, Dock and Notification banners)',
                    'Level 3 (True Ambient Dimming behind focused window)'
                ]
            })
        });
        
        // Settings bind for ComboRow (0-indexed)
        settings.bind('deepwork-snooze-level', snoozeLevelRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        suppressionGroup.add(snoozeLevelRow);

        const hideDockRow = new Adw.SwitchRow({
            title: 'Hide Dock/Taskbar',
            subtitle: 'Slide out and hide external docks like Dash to Dock or Dash to Panel.',
        });
        settings.bind('deepwork-hide-dock', hideDockRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        suppressionGroup.add(hideDockRow);

        const hidePanelRow = new Adw.SwitchRow({
            title: 'Hide Top Panel',
            subtitle: 'Hides GNOME\'s top status panel when entering Level 2 focus mode.',
        });
        settings.bind('deepwork-hide-panel', hidePanelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        suppressionGroup.add(hidePanelRow);

        const hidePanelInOverviewRow = new Adw.SwitchRow({
            title: 'Hide Top Panel in Overview',
            subtitle: 'Controls whether the top panel is hidden while the Activities overview is open.',
        });
        settings.bind('deepwork-hide-panel-in-overview', hidePanelInOverviewRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        suppressionGroup.add(hidePanelInOverviewRow);

        // Dynamic sensitivity: panel controls only apply to Level 2.
        const updatePanelControlSensitivity = () => {
            const isLevel2 = settings.get_int('deepwork-snooze-level') >= 1;
            hidePanelRow.set_sensitive(isLevel2);
            hidePanelInOverviewRow.set_sensitive(isLevel2);
        };
        updatePanelControlSensitivity();
        connectSetting('changed::deepwork-snooze-level', updatePanelControlSensitivity);

        const muteNotificationsRow = new Adw.SwitchRow({
            title: 'Silence Notification Banners',
            subtitle: 'Native Do Not Disturb integration that silences pop-up notification banners.',
        });
        settings.bind('deepwork-mute-notifications', muteNotificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        suppressionGroup.add(muteNotificationsRow);

        // --- Group 3: Ambient Dimming and Aesthetics ---
        const dimmingGroup = new Adw.PreferencesGroup({
            title: 'Ambient Dimming and Backdrop Aesthetics',
            description: 'Apply glassmorphic filters to draw visual focus exclusively to your active editor.'
        });
        deepWorkPage.add(dimmingGroup);

        const ambientDimRow = new Adw.SwitchRow({
            title: 'Ambient Window Dimming',
            subtitle: 'Fades out all background windows to highly customizable opacity settings.',
        });
        settings.bind('deepwork-ambient-dim', ambientDimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dimmingGroup.add(ambientDimRow);

        // Color Hex Entry Row
        const ambientColorRow = new Adw.EntryRow({
            title: 'Ambient Dimming Overlay Color',
            text: settings.get_string('deepwork-ambient-color')
        });
        const applyColorButton = new Gtk.Button({
            icon_name: 'emblem-ok-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            tooltip_text: 'Apply Color'
        });
        const applyColor = () => {
            settings.set_string('deepwork-ambient-color', ambientColorRow.get_text());
        };
        applyColorButton.connect('clicked', applyColor);
        ambientColorRow.connect('entry-activated', applyColor);
        ambientColorRow.add_suffix(applyColorButton);
        dimmingGroup.add(ambientColorRow);

        // Opacity Scale Slider
        const opacityAdjustment = new Gtk.Adjustment({
            value: settings.get_double('deepwork-ambient-dim-opacity'),
            lower: 0.1,
            upper: 1.0,
            step_increment: 0.05,
            page_increment: 0.1
        });
        settings.bind('deepwork-ambient-dim-opacity', opacityAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        
        const opacityScale = new Gtk.Scale({
            adjustment: opacityAdjustment,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200
        });

        const opacityActionRow = new Adw.ActionRow({
            title: 'Ambient Dimming Opacity',
            subtitle: 'Adjust transparency level of non-focused desktop windows (0.1 = extremely dark, 0.9 = light).'
        });
        opacityActionRow.add_suffix(opacityScale);
        dimmingGroup.add(opacityActionRow);

        const dimLevel3Row = new Adw.SwitchRow({
            title: 'Keep Background Window Dim Active on Level 3',
            subtitle: 'Applies individual window dimming under the True Ambient scrim in Level 3 focus mode.',
        });
        settings.bind('deepwork-ambient-dim-level3', dimLevel3Row, 'active', Gio.SettingsBindFlags.DEFAULT);
        dimmingGroup.add(dimLevel3Row);

        // Blur Scale Slider
        const blurAdjustment = new Gtk.Adjustment({
            value: settings.get_double('deepwork-ambient-blur-intensity'),
            lower: 0.0,
            upper: 1.0,
            step_increment: 0.1,
            page_increment: 0.2
        });
        settings.bind('deepwork-ambient-blur-intensity', blurAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const blurScale = new Gtk.Scale({
            adjustment: blurAdjustment,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200
        });

        const blurActionRow = new Adw.ActionRow({
            title: 'Ambient Blur Intensity',
            subtitle: 'Control background clutter visual blur (0.0 = zero blur, 1.0 = heavy frost glass).',
        });
        blurActionRow.add_suffix(blurScale);
        dimmingGroup.add(blurActionRow);

        const blurLevel3Row = new Adw.SwitchRow({
            title: 'Keep Background Window Blur Active on Level 3',
            subtitle: 'Applies individual window blur under the True Ambient scrim in Level 3 focus mode.',
        });
        settings.bind('deepwork-ambient-blur-level3', blurLevel3Row, 'active', Gio.SettingsBindFlags.DEFAULT);
        dimmingGroup.add(blurLevel3Row);

        const trueAmbientAdjustment = new Gtk.Adjustment({
            value: settings.get_double('deepwork-true-ambient-opacity'),
            lower: 0.1,
            upper: 0.95,
            step_increment: 0.05,
            page_increment: 0.1
        });
        settings.bind('deepwork-true-ambient-opacity', trueAmbientAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const trueAmbientScale = new Gtk.Scale({
            adjustment: trueAmbientAdjustment,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200
        });

        const trueAmbientActionRow = new Adw.ActionRow({
            title: 'True Ambient Overlay Opacity',
            subtitle: 'Controls the Level 3 black overlay behind the focused window; minimum is 10%.',
        });
        trueAmbientActionRow.add_suffix(trueAmbientScale);
        dimmingGroup.add(trueAmbientActionRow);

        // --- Group 4: Integrated Pomodoro Timer ---
        const pomodoroGroup = new Adw.PreferencesGroup({
            title: 'Integrated Pomodoro Timer',
            description: 'Configure standard productivity sprints and break intervals.'
        });
        deepWorkPage.add(pomodoroGroup);

        const enablePomodoroRow = new Adw.SwitchRow({
            title: 'Enable Pomodoro Focus Timer',
            subtitle: 'Renders a beautiful alarm clock icon and monospace countdown in the top bar.',
        });
        settings.bind('deepwork-pomodoro-timer-enabled', enablePomodoroRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(enablePomodoroRow);

        const updateDeepWorkSwitchSensitivity = () => {
            const timerControlsDeepWork = settings.get_boolean('deepwork-pomodoro-timer-enabled');
            enableSwitch.set_sensitive(!timerControlsDeepWork);
            enableSwitch.set_subtitle(timerControlsDeepWork
                ? 'Controlled by the Pomodoro timer while timer mode is enabled.'
                : 'Hides panels, docks, silences notifications, and dims background elements.');
        };
        updateDeepWorkSwitchSensitivity();
        connectSetting('changed::deepwork-pomodoro-timer-enabled', updateDeepWorkSwitchSensitivity);

        const panelPeekAdjustment = new Gtk.Adjustment({
            value: settings.get_int('deepwork-pomodoro-panel-peek-duration'),
            lower: 2,
            upper: 30,
            step_increment: 1,
            page_increment: 5
        });
        settings.bind('deepwork-pomodoro-panel-peek-duration', panelPeekAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const panelPeekSpin = new Gtk.SpinButton({
            adjustment: panelPeekAdjustment,
            numeric: true,
            climb_rate: 1,
            valign: Gtk.Align.CENTER,
            width_request: 90
        });

        const panelPeekRow = new Adw.ActionRow({
            title: 'Top Panel Peek Duration',
            subtitle: 'Set how long the real GNOME top panel stays visible from the floating timer.'
        });
        panelPeekRow.add_suffix(panelPeekSpin);
        panelPeekRow.activatable_widget = panelPeekSpin;
        pomodoroGroup.add(panelPeekRow);

        // Indefinite Focus Toggle Row
        const infiniteFocusRow = new Adw.SwitchRow({
            title: 'Indefinite Focus Sprint',
            subtitle: 'When enabled, the focus session runs indefinitely as a count-up timer.',
        });
        settings.bind('deepwork-pomodoro-focus-infinite', infiniteFocusRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(infiniteFocusRow);

        // Focus Block Slider
        const focusAdjustment = new Gtk.Adjustment({
            value: settings.get_int('deepwork-pomodoro-focus-time'),
            lower: 10,
            upper: 300,
            step_increment: 5,
            page_increment: 10
        });
        settings.bind('deepwork-pomodoro-focus-time', focusAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const focusScale = new Gtk.Scale({
            adjustment: focusAdjustment,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200,
            digits: 0
        });

        try {
            focusScale.set_format_value_func((scale, value) => {
                return `${value} min`;
            });
        } catch (e) {
            // Fallback for older GTK versions
        }

        const focusActionRow = new Adw.ActionRow({
            title: 'Focus Sprint Block Duration'
        });

        // Rest Block Slider
        const restAdjustment = new Gtk.Adjustment({
            value: settings.get_int('deepwork-pomodoro-rest-time'),
            lower: 5,
            upper: 180,
            step_increment: 1,
            page_increment: 10
        });
        settings.bind('deepwork-pomodoro-rest-time', restAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const restScale = new Gtk.Scale({
            adjustment: restAdjustment,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 200,
            digits: 0
        });

        try {
            restScale.set_format_value_func((scale, value) => {
                const isInfinite = settings.get_boolean('deepwork-pomodoro-focus-infinite');
                if (isInfinite) return "0 min";
                return `${value} min`;
            });
        } catch (e) {
            // Fallback for older GTK versions
        }

        const restActionRow = new Adw.ActionRow({
            title: 'Rest Recovery Block Duration'
        });

        const updateFocusSubtitle = () => {
            const isInfinite = settings.get_boolean('deepwork-pomodoro-focus-infinite');
            focusActionRow.set_sensitive(!isInfinite);
            restActionRow.set_sensitive(!isInfinite);
            if (isInfinite) {
                focusActionRow.set_subtitle('Focus duration slider is disabled during Indefinite Focus sprints.');
                restActionRow.set_subtitle('Rest recovery duration configuration is disabled during Indefinite Focus sprints.');
            } else {
                const val = focusAdjustment.value;
                focusActionRow.set_subtitle(`Set length of dedicated active coding blocks (${val} minutes, default: 25).`);
                const restVal = restAdjustment.value;
                restActionRow.set_subtitle(`Set length of dedicated active break block (${restVal} minutes, default: 5 minutes).`);
            }
            try {
                restScale.queue_draw();
            } catch (e) {}
        };
        focusAdjustment.connect('value-changed', updateFocusSubtitle);
        restAdjustment.connect('value-changed', updateFocusSubtitle);
        connectSetting('changed::deepwork-pomodoro-focus-infinite', updateFocusSubtitle);
        updateFocusSubtitle();

        focusActionRow.add_suffix(focusScale);
        pomodoroGroup.add(focusActionRow);

        restActionRow.add_suffix(restScale);
        pomodoroGroup.add(restActionRow);

        const verticalFloatingRow = new Adw.SwitchRow({
            title: 'Vertical Floating Panel Layout',
            subtitle: 'Changes the orientation of the floating timer panel to vertical (displays a capsule dock).',
        });
        settings.bind('deepwork-pomodoro-floating-vertical', verticalFloatingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(verticalFloatingRow);

        const floatingShowTimeRow = new Adw.SwitchRow({
            title: 'Display Timer on Floating Panel',
            subtitle: 'Show the remaining countdown timer readout in the floating widget.',
        });
        settings.bind('deepwork-pomodoro-floating-show-time', floatingShowTimeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(floatingShowTimeRow);

        const floatingShowClockRow = new Adw.SwitchRow({
            title: 'Display System Clock on Floating Panel',
            subtitle: 'Show the current system wall-clock time on the floating widget.',
        });
        settings.bind('deepwork-pomodoro-floating-show-clock', floatingShowClockRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(floatingShowClockRow);

        const floatingCollapsedRow = new Adw.SwitchRow({
            title: 'Collapse Floating Panel Layout',
            subtitle: 'Minimize the floating widget to only show the timer/status icon and expand chevron.',
        });
        settings.bind('deepwork-pomodoro-floating-collapsed', floatingCollapsedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(floatingCollapsedRow);

        const clockEnabledRow = new Adw.SwitchRow({
            title: 'Auto Stop Clock',
            subtitle: 'Reset the timer and disable Deep Work when the system clock reaches the selected time.',
        });
        settings.bind('deepwork-pomodoro-clock-enabled', clockEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(clockEnabledRow);

        const clockHourAdjustment = new Gtk.Adjustment({
            value: settings.get_int('deepwork-pomodoro-clock-hour'),
            lower: 0,
            upper: 23,
            step_increment: 1,
            page_increment: 3
        });
        settings.bind('deepwork-pomodoro-clock-hour', clockHourAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clockMinuteAdjustment = new Gtk.Adjustment({
            value: settings.get_int('deepwork-pomodoro-clock-minute'),
            lower: 0,
            upper: 59,
            step_increment: 5,
            page_increment: 15
        });
        settings.bind('deepwork-pomodoro-clock-minute', clockMinuteAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clockTimeBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER
        });
        const clockHourSpin = new Gtk.SpinButton({
            adjustment: clockHourAdjustment,
            numeric: true,
            wrap: true,
            valign: Gtk.Align.CENTER,
            width_request: 72
        });
        const clockMinuteSpin = new Gtk.SpinButton({
            adjustment: clockMinuteAdjustment,
            numeric: true,
            wrap: true,
            valign: Gtk.Align.CENTER,
            width_request: 72
        });
        clockTimeBox.append(clockHourSpin);
        clockTimeBox.append(new Gtk.Label({ label: ':' }));
        clockTimeBox.append(clockMinuteSpin);

        const clockTimeRow = new Adw.ActionRow({
            title: 'Auto Stop Time',
            subtitle: 'Uses 24-hour system time.'
        });
        clockTimeRow.add_suffix(clockTimeBox);
        pomodoroGroup.add(clockTimeRow);

        const updateClockTimeSensitivity = () => {
            clockTimeRow.set_sensitive(settings.get_boolean('deepwork-pomodoro-clock-enabled'));
        };
        updateClockTimeSensitivity();
        connectSetting('changed::deepwork-pomodoro-clock-enabled', updateClockTimeSensitivity);

        const notificationSummaryRow = new Adw.SwitchRow({
            title: 'Focus Notification Summary',
            subtitle: 'After focus ends, show a second summary if notification banners were silenced and notifications arrived.',
        });
        settings.bind('deepwork-focus-notification-summary-enabled', notificationSummaryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(notificationSummaryRow);

        const notificationCountRow = new Adw.SwitchRow({
            title: 'Show Focus Notification Count',
            subtitle: 'Shows the count of silenced focus notifications beside the timer.',
        });
        settings.bind('deepwork-pomodoro-show-notification-count', notificationCountRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pomodoroGroup.add(notificationCountRow);

        // ========================================================
        // PAGE 2: ESSENTIAL TWEAKS
        // ========================================================
        const tweaksPage = new Adw.PreferencesPage({
            title: 'Essential Tweaks',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(tweaksPage);

        const batteryHealthGroup = new Adw.PreferencesGroup({
            title: 'Battery Health Sound',
            description: 'Play a reminder when charging reaches a healthy upper limit or discharging reaches a low limit.'
        });
        tweaksPage.add(batteryHealthGroup);

        const batteryHealthEnabledRow = new Adw.SwitchRow({
            title: 'Enable Battery Health Sound',
            subtitle: 'Use sound and optional notifications for battery charge thresholds.',
        });
        settings.bind('tweaks-battery-health-sound-enabled', batteryHealthEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(batteryHealthEnabledRow);

        const upperBatteryAdjustment = new Gtk.Adjustment({
            value: settings.get_int('tweaks-battery-health-sound-upper-threshold'),
            lower: 50,
            upper: 100,
            step_increment: 5,
            page_increment: 10
        });
        settings.bind('tweaks-battery-health-sound-upper-threshold', upperBatteryAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const upperBatterySpin = new Gtk.SpinButton({
            adjustment: upperBatteryAdjustment,
            numeric: true,
            climb_rate: 1,
            valign: Gtk.Align.CENTER,
            width_request: 90
        });

        const upperBatteryRow = new Adw.ActionRow({
            title: 'Upper Charge Reminder',
            subtitle: 'Alert when charging reaches this percentage.'
        });
        upperBatteryRow.add_suffix(upperBatterySpin);
        upperBatteryRow.activatable_widget = upperBatterySpin;
        batteryHealthGroup.add(upperBatteryRow);

        const lowerBatteryAdjustment = new Gtk.Adjustment({
            value: settings.get_int('tweaks-battery-health-sound-lower-threshold'),
            lower: 5,
            upper: 50,
            step_increment: 5,
            page_increment: 10
        });
        settings.bind('tweaks-battery-health-sound-lower-threshold', lowerBatteryAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const lowerBatterySpin = new Gtk.SpinButton({
            adjustment: lowerBatteryAdjustment,
            numeric: true,
            climb_rate: 1,
            valign: Gtk.Align.CENTER,
            width_request: 90
        });

        const lowerBatteryRow = new Adw.ActionRow({
            title: 'Low Battery Reminder',
            subtitle: 'Alert when discharging drops to this percentage.'
        });
        lowerBatteryRow.add_suffix(lowerBatterySpin);
        lowerBatteryRow.activatable_widget = lowerBatterySpin;
        batteryHealthGroup.add(lowerBatteryRow);

        const fullChargeRow = new Adw.SwitchRow({
            title: 'Full Charge Reminder',
            subtitle: 'Alert when charging reaches 100%.',
        });
        settings.bind('tweaks-battery-health-sound-full-charge-enabled', fullChargeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(fullChargeRow);

        const criticalChargeRow = new Adw.SwitchRow({
            title: 'Critical Charge Reminder',
            subtitle: 'Alert when discharging drops to 10%.',
        });
        settings.bind('tweaks-battery-health-sound-critical-charge-enabled', criticalChargeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(criticalChargeRow);

        const batteryPlaySoundRow = new Adw.SwitchRow({
            title: 'Play Alert Sound',
            subtitle: 'Use the current desktop sound theme for battery health reminders.',
        });
        settings.bind('tweaks-battery-health-sound-play-sound', batteryPlaySoundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(batteryPlaySoundRow);

        const batteryRespectDNDRow = new Adw.SwitchRow({
            title: 'Respect Do Not Disturb',
            subtitle: 'Do not play battery health sounds while Do Not Disturb is active.',
        });
        settings.bind('tweaks-battery-health-sound-respect-dnd', batteryRespectDNDRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(batteryRespectDNDRow);

        const batteryNotificationRow = new Adw.SwitchRow({
            title: 'Show Alert Notification',
            subtitle: 'Show a notification alongside the sound.',
        });
        settings.bind('tweaks-battery-health-sound-show-notification', batteryNotificationRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryHealthGroup.add(batteryNotificationRow);

        const updateBatteryHealthSensitivity = () => {
            const enabled = settings.get_boolean('tweaks-battery-health-sound-enabled');
            upperBatteryRow.set_sensitive(enabled);
            lowerBatteryRow.set_sensitive(enabled);
            fullChargeRow.set_sensitive(enabled);
            criticalChargeRow.set_sensitive(enabled);
            batteryPlaySoundRow.set_sensitive(enabled);
            batteryRespectDNDRow.set_sensitive(enabled && settings.get_boolean('tweaks-battery-health-sound-play-sound'));
            batteryNotificationRow.set_sensitive(enabled);
        };
        updateBatteryHealthSensitivity();
        connectSetting('changed::tweaks-battery-health-sound-enabled', updateBatteryHealthSensitivity);
        connectSetting('changed::tweaks-battery-health-sound-play-sound', updateBatteryHealthSensitivity);

        const essentialMenuGroup = new Adw.PreferencesGroup({
            title: 'Essential Menu',
            description: 'Open a centered floating application launcher from the top panel.'
        });
        tweaksPage.add(essentialMenuGroup);

        const essentialMenuEnabledRow = new Adw.SwitchRow({
            title: 'Enable Essential Menu',
            subtitle: 'Use a fast GNOME-style floating app launcher.',
        });
        settings.bind('tweaks-essential-menu-enabled', essentialMenuEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialMenuGroup.add(essentialMenuEnabledRow);

        const essentialMenuPanelIconRow = new Adw.SwitchRow({
            title: 'Show Panel Icon',
            subtitle: 'Add an app launcher button to the top panel.',
        });
        settings.bind('tweaks-essential-menu-show-panel-icon', essentialMenuPanelIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialMenuGroup.add(essentialMenuPanelIconRow);

        const panelPlacementValues = ['before-workspaces', 'after-workspaces'];
        const essentialMenuPanelPlacementRow = new Adw.ComboRow({
            title: 'Panel Icon Placement',
            subtitle: 'Choose the side of the workspace switcher for the top-panel icon.',
            model: new Gtk.StringList({
                strings: ['Before Workspace Switcher', 'After Workspace Switcher']
            })
        });
        const syncPanelPlacementRow = () => {
            const placement = settings.get_string('tweaks-essential-menu-panel-icon-placement') || 'before-workspaces';
            const index = panelPlacementValues.indexOf(placement);
            essentialMenuPanelPlacementRow.selected = index >= 0 ? index : 0;
        };
        syncPanelPlacementRow();
        essentialMenuPanelPlacementRow.connect('notify::selected', () => {
            const index = essentialMenuPanelPlacementRow.selected;
            if (index >= 0 && index < panelPlacementValues.length) {
                settings.set_string('tweaks-essential-menu-panel-icon-placement', panelPlacementValues[index]);
            }
        });
        essentialMenuGroup.add(essentialMenuPanelPlacementRow);
        connectSetting('changed::tweaks-essential-menu-panel-icon-placement', syncPanelPlacementRow);

        const essentialMenuShortcutRow = new Adw.SwitchRow({
            title: 'Super+Space Shortcut',
            subtitle: 'Open the floating app menu with Super+Space.',
        });
        settings.bind('tweaks-essential-menu-shortcut-enabled', essentialMenuShortcutRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialMenuGroup.add(essentialMenuShortcutRow);

        const essentialMenuAnimationsRow = new Adw.SwitchRow({
            title: 'Enable Menu Animations',
            subtitle: 'Show slide and fade transitions when opening or searching.',
        });
        settings.bind('tweaks-essential-menu-animations-enabled', essentialMenuAnimationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialMenuGroup.add(essentialMenuAnimationsRow);

        const essentialMenuBackdropDimRow = new Adw.SwitchRow({
            title: 'Enable Backdrop Dim',
            subtitle: 'Dim the screen background when the quick launcher pops open.',
        });
        settings.bind('tweaks-essential-menu-backdrop-dim-enabled', essentialMenuBackdropDimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialMenuGroup.add(essentialMenuBackdropDimRow);

        const conflictWarningRow = new Adw.ActionRow({
            title: 'Shortcut Conflict Detected',
            subtitle: 'Super+Space is currently claimed by GNOME\'s "Switch Input Source" shortcut.',
            visible: false
        });
        const warningIcon = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER
        });
        conflictWarningRow.add_prefix(warningIcon);
        const resolveButton = new Gtk.Button({
            label: 'Resolve Conflict',
            valign: Gtk.Align.CENTER
        });
        resolveButton.add_css_class('suggested-action');
        resolveButton.add_css_class('pill');
        conflictWarningRow.add_suffix(resolveButton);
        essentialMenuGroup.add(conflictWarningRow);

        const checkShortcutConflict = () => {
            const menuEnabled = settings.get_boolean('tweaks-essential-menu-enabled');
            const shortcutEnabled = settings.get_boolean('tweaks-essential-menu-shortcut-enabled');
            
            if (!menuEnabled || !shortcutEnabled) {
                conflictWarningRow.visible = false;
                return;
            }
            
            try {
                const wmSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
                const bindings = wmSettings.get_strv('switch-input-source');
                const hasConflict = bindings.some(b => b.toLowerCase() === '<super>space');
                conflictWarningRow.visible = hasConflict;
            } catch (e) {
                conflictWarningRow.visible = false;
            }
        };

        const restoreSystemShortcut = () => {
            try {
                const wmSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
                const currentBindings = wmSettings.get_strv('switch-input-source');
                const hasSuperSpace = currentBindings.some(b => b.toLowerCase() === '<super>space');
                if (!hasSuperSpace) {
                    currentBindings.push('<Super>space');
                    wmSettings.set_strv('switch-input-source', currentBindings);
                }
            } catch (e) {
                console.error('[GnomeEssentials][Prefs] Failed to restore system shortcut: ' + e.message);
            }
        };

        const handleShortcutStateChange = () => {
            const menuEnabled = settings.get_boolean('tweaks-essential-menu-enabled');
            const shortcutEnabled = settings.get_boolean('tweaks-essential-menu-shortcut-enabled');
            
            if (!menuEnabled || !shortcutEnabled) {
                restoreSystemShortcut();
            }
            checkShortcutConflict();
        };

        resolveButton.connect('clicked', () => {
            try {
                const wmSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
                const currentBindings = wmSettings.get_strv('switch-input-source');
                const updated = currentBindings.filter(b => b.toLowerCase() !== '<super>space');
                wmSettings.set_strv('switch-input-source', updated);
                conflictWarningRow.visible = false;
            } catch (e) {
                console.error('[GnomeEssentials][Prefs] Failed to resolve keybinding conflict: ' + e.message);
            }
        });

        connectSetting('changed::tweaks-essential-menu-shortcut-enabled', handleShortcutStateChange);

        const searchEngineRow = new Adw.ComboRow({
            title: 'Default Search Engine',
            subtitle: 'Choose your default web search engine.',
            model: new Gtk.StringList({
                strings: ['DuckDuckGo', 'Google', 'Bing']
            })
        });
        const engines = ['duckduckgo', 'google', 'bing'];
        const currentEngine = settings.get_string('tweaks-essential-menu-default-search-engine') || 'duckduckgo';
        const engineIndex = engines.indexOf(currentEngine);
        if (engineIndex !== -1) {
            searchEngineRow.selected = engineIndex;
        }
        searchEngineRow.connect('notify::selected', () => {
            const index = searchEngineRow.selected;
            if (index >= 0 && index < engines.length) {
                settings.set_string('tweaks-essential-menu-default-search-engine', engines[index]);
            }
        });
        essentialMenuGroup.add(searchEngineRow);

        const essentialMenuOpenButton = new Gtk.Button({
            icon_name: 'view-app-grid-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Open Essential Menu'
        });
        essentialMenuOpenButton.add_css_class('flat');
        essentialMenuOpenButton.connect('clicked', () => {
            settings.set_string('tweaks-essential-menu-trigger', operationId());
        });

        const essentialMenuOpenRow = new Adw.ActionRow({
            title: 'Open Menu',
            subtitle: 'Launch the floating app menu from this settings page.'
        });
        essentialMenuOpenRow.add_suffix(essentialMenuOpenButton);
        essentialMenuOpenRow.activatable_widget = essentialMenuOpenButton;
        essentialMenuGroup.add(essentialMenuOpenRow);

        const updateEssentialMenuSensitivity = () => {
            const enabled = settings.get_boolean('tweaks-essential-menu-enabled');
            const panelIconEnabled = settings.get_boolean('tweaks-essential-menu-show-panel-icon');
            essentialMenuPanelIconRow.set_sensitive(enabled);
            essentialMenuPanelPlacementRow.set_sensitive(enabled && panelIconEnabled);
            essentialMenuShortcutRow.set_sensitive(enabled);
            essentialMenuAnimationsRow.set_sensitive(enabled);
            essentialMenuBackdropDimRow.set_sensitive(enabled);
            searchEngineRow.set_sensitive(enabled);
            essentialMenuOpenRow.set_sensitive(enabled);
            handleShortcutStateChange();
        };
        updateEssentialMenuSensitivity();
        connectSetting('changed::tweaks-essential-menu-enabled', updateEssentialMenuSensitivity);
        connectSetting('changed::tweaks-essential-menu-show-panel-icon', updateEssentialMenuSensitivity);

        const shelfNautilusScriptName = 'Send to Essential Shelf';
        const shelfNautilusScriptsDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'nautilus', 'scripts']);
        const shelfNautilusScriptPath = GLib.build_filenamev([shelfNautilusScriptsDir, shelfNautilusScriptName]);
        const shelfNautilusScript = `#!/bin/sh
set -eu

DATA_DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/gnome-essentials"
INBOX="$DATA_DIR/shelf-inbox.jsonl"

mkdir -p "$DATA_DIR"

selection="\${NAUTILUS_SCRIPT_SELECTED_URIS:-}"
if [ -z "$selection" ]; then
    selection="\${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-}"
fi

if [ -z "$selection" ]; then
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "GNOME Essentials" "No selected files to send to Shelf."
    fi
    exit 0
fi

printf '%s\\n' "$selection" | while IFS= read -r item; do
    [ -z "$item" ] && continue
    printf '%s\\n' "$item" >> "$INBOX"
done

count=$(printf '%s\\n' "$selection" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
if command -v notify-send >/dev/null 2>&1; then
    notify-send "GNOME Essentials" "Sent $count item(s) to Essential Shelf."
fi
`;

        const isShelfNautilusScriptInstalled = () => Gio.File.new_for_path(shelfNautilusScriptPath).query_exists(null);

        const installShelfNautilusScript = () => {
            const dir = Gio.File.new_for_path(shelfNautilusScriptsDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            const file = Gio.File.new_for_path(shelfNautilusScriptPath);
            file.replace_contents(
                shelfNautilusScript,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            if (typeof GLib.chmod === 'function') {
                GLib.chmod(shelfNautilusScriptPath, 0o755);
            } else {
                file.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
            }
        };

        const removeShelfNautilusScript = () => {
            const file = Gio.File.new_for_path(shelfNautilusScriptPath);
            if (file.query_exists(null)) {
                file.delete(null);
            }
        };

        const essentialShelfGroup = new Adw.PreferencesGroup({
            title: 'Essential Shelf',
            description: 'Keep selected files, folders, links, and text snippets nearby inside Essential Menu.'
        });
        tweaksPage.add(essentialShelfGroup);

        const essentialShelfEnabledRow = new Adw.SwitchRow({
            title: 'Enable Essential Shelf',
            subtitle: 'Keep selected files, folders, links, and snippets close from Essential Menu.',
        });
        settings.bind('tweaks-essential-shelf-enabled', essentialShelfEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialShelfGroup.add(essentialShelfEnabledRow);

        const essentialShelfShowInMenuRow = new Adw.SwitchRow({
            title: 'Show in Essential Menu',
            subtitle: 'Use # to view kept items and add typed links, paths, or snippets.',
        });
        settings.bind('tweaks-essential-shelf-show-in-menu', essentialShelfShowInMenuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialShelfGroup.add(essentialShelfShowInMenuRow);

        const essentialShelfNotificationsRow = new Adw.SwitchRow({
            title: 'Show Notifications',
            subtitle: 'Show desktop notifications when Shelf items are added, attached, restored, or removed.',
        });
        settings.bind('tweaks-essential-shelf-show-notifications', essentialShelfNotificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialShelfGroup.add(essentialShelfNotificationsRow);

        const essentialShelfPersistRow = new Adw.SwitchRow({
            title: 'Persist After Restart',
            subtitle: 'Keep shelf items after logging out or restarting GNOME Shell.',
        });
        settings.bind('tweaks-essential-shelf-persist', essentialShelfPersistRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        essentialShelfGroup.add(essentialShelfPersistRow);

        const shelfMaxAdjustment = new Gtk.Adjustment({
            value: settings.get_int('tweaks-essential-shelf-max-items'),
            lower: 4,
            upper: 80,
            step_increment: 1,
            page_increment: 8
        });
        settings.bind('tweaks-essential-shelf-max-items', shelfMaxAdjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const shelfMaxSpin = new Gtk.SpinButton({
            adjustment: shelfMaxAdjustment,
            numeric: true,
            climb_rate: 1,
            valign: Gtk.Align.CENTER,
            width_request: 90
        });

        const shelfMaxRow = new Adw.ActionRow({
            title: 'Maximum Items',
            subtitle: 'Older shelf items are removed when this limit is reached.'
        });
        shelfMaxRow.add_suffix(shelfMaxSpin);
        shelfMaxRow.activatable_widget = shelfMaxSpin;
        essentialShelfGroup.add(shelfMaxRow);

        let shelfNautilusScriptError = '';
        const installShelfScriptButton = new Gtk.Button({
            icon_name: 'document-save-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Install Files script'
        });
        const removeShelfScriptButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove Files script'
        });
        removeShelfScriptButton.add_css_class('destructive-action');

        const shelfNautilusScriptRow = new Adw.ActionRow({
            title: 'Files Send-to-Shelf Action',
            subtitle: 'Install a Nautilus script for right-clicking selected files and sending them to Essential Shelf.'
        });
        shelfNautilusScriptRow.add_suffix(installShelfScriptButton);
        shelfNautilusScriptRow.add_suffix(removeShelfScriptButton);
        essentialShelfGroup.add(shelfNautilusScriptRow);

        const updateShelfNautilusScriptRow = () => {
            const installed = isShelfNautilusScriptInstalled();
            shelfNautilusScriptRow.set_subtitle(shelfNautilusScriptError ||
                (installed
                    ? `Installed in Files scripts as "${shelfNautilusScriptName}".`
                    : 'Install a Nautilus script for right-clicking selected files and sending them to Essential Shelf.'));
            installShelfScriptButton.set_sensitive(!installed);
            removeShelfScriptButton.set_sensitive(installed);
        };

        installShelfScriptButton.connect('clicked', () => {
            try {
                installShelfNautilusScript();
                shelfNautilusScriptError = '';
            } catch (e) {
                shelfNautilusScriptError = `Install failed: ${e.message}`;
            }
            updateShelfNautilusScriptRow();
        });

        removeShelfScriptButton.connect('clicked', () => {
            confirmAction(
                'Remove Files Script?',
                'Remove the Nautilus script that sends selected files to Essential Shelf?',
                'Remove',
                Adw.ResponseAppearance.DESTRUCTIVE,
                () => {
                    try {
                        removeShelfNautilusScript();
                        shelfNautilusScriptError = '';
                    } catch (e) {
                        shelfNautilusScriptError = `Remove failed: ${e.message}`;
                    }
                    updateShelfNautilusScriptRow();
                }
            );
        });
        updateShelfNautilusScriptRow();

        const clearShelfButton = new Gtk.Button({
            icon_name: 'edit-clear-all-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Clear Essential Shelf'
        });
        clearShelfButton.add_css_class('destructive-action');
        clearShelfButton.connect('clicked', () => {
            confirmAction(
                'Clear Essential Shelf?',
                'Remove all temporary shelf items? This does not delete the original files.',
                'Clear',
                Adw.ResponseAppearance.DESTRUCTIVE,
                () => settings.set_string('tweaks-essential-shelf-trigger-clear', operationId())
            );
        });

        const clearShelfRow = new Adw.ActionRow({
            title: 'Clear Shelf',
            subtitle: 'Remove every item currently stored in Essential Shelf.'
        });
        clearShelfRow.add_suffix(clearShelfButton);
        clearShelfRow.activatable_widget = clearShelfButton;
        essentialShelfGroup.add(clearShelfRow);

        const updateEssentialShelfSensitivity = () => {
            const shelfEnabled = settings.get_boolean('tweaks-essential-shelf-enabled');
            const menuEnabled = settings.get_boolean('tweaks-essential-menu-enabled');
            essentialShelfShowInMenuRow.set_sensitive(shelfEnabled && menuEnabled);
            essentialShelfNotificationsRow.set_sensitive(shelfEnabled);
            essentialShelfPersistRow.set_sensitive(shelfEnabled);
            shelfMaxRow.set_sensitive(shelfEnabled);
            shelfNautilusScriptRow.set_sensitive(shelfEnabled);
            clearShelfRow.set_sensitive(shelfEnabled);
            updateShelfNautilusScriptRow();
        };
        updateEssentialShelfSensitivity();
        connectSetting('changed::tweaks-essential-shelf-enabled', updateEssentialShelfSensitivity);
        connectSetting('changed::tweaks-essential-menu-enabled', updateEssentialShelfSensitivity);

        const uninstallUtilityGroup = new Adw.PreferencesGroup({
            title: 'App Uninstallation Utility',
            description: 'Quickly uninstall any application directly from the GNOME App Grid right-click menu.'
        });
        tweaksPage.add(uninstallUtilityGroup);

        const uninstallEnabledRow = new Adw.SwitchRow({
            title: 'Enable App Uninstallation',
            subtitle: 'Add an "Uninstall" option to the right-click context menu of icons in the App Grid.',
        });
        settings.bind('tweaks-essential-uninstall-enabled', uninstallEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uninstallUtilityGroup.add(uninstallEnabledRow);

        const uninstallInMenuRow = new Adw.SwitchRow({
            title: 'Show Uninstall in Essential Menu',
            subtitle: 'Add an "Uninstall" button to application search results in the Essential Menu launcher.',
        });
        settings.bind('tweaks-essential-uninstall-in-menu', uninstallInMenuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uninstallUtilityGroup.add(uninstallInMenuRow);

        const updateUninstallUtilitySensitivity = () => {
            const uninstallEnabled = settings.get_boolean('tweaks-essential-uninstall-enabled');
            const menuEnabled = settings.get_boolean('tweaks-essential-menu-enabled');
            uninstallInMenuRow.set_sensitive(uninstallEnabled && menuEnabled);
        };
        updateUninstallUtilitySensitivity();
        connectSetting('changed::tweaks-essential-uninstall-enabled', updateUninstallUtilitySensitivity);
        connectSetting('changed::tweaks-essential-menu-enabled', updateUninstallUtilitySensitivity);


        // ========================================================
        // PAGE 3: 🎛️ WORKSPACE PROFILES (ACTIVE MODULE)
        // ========================================================
        const profilesPage = new Adw.PreferencesPage({
            title: 'Workspace Profiles',
            icon_name: 'view-fullscreen-symbolic'
        });
        window.add(profilesPage);

        // --- Group 1: General Options ---
        const profilesGeneralGroup = new Adw.PreferencesGroup({
            title: 'Workspace Session Restorer',
            description: 'Save open application states and workspaces, allowing instant session recovery.'
        });
        profilesPage.add(profilesGeneralGroup);

        const profilesEnableRow = new Adw.SwitchRow({
            title: 'Enable Workspace Profiles',
            subtitle: 'Spawns a top bar status menu dropdown to switch saved layouts in 1 click.',
        });
        settings.bind('profiles-enabled', profilesEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        profilesGeneralGroup.add(profilesEnableRow);

        const profilesRestoreRow = new Adw.SwitchRow({
            title: 'Auto-Spawn Applications on Switch',
            subtitle: 'Automatically triggers flatpak or native binaries if applications are not running when applying a layout.',
        });
        settings.bind('profiles-auto-launch', profilesRestoreRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        profilesGeneralGroup.add(profilesRestoreRow);

        const profilesNotificationsRow = new Adw.SwitchRow({
            title: 'Show Switch Notifications',
            subtitle: 'Show standard desktop notifications when saving, applying, or modifying profiles.',
        });
        settings.bind('profiles-show-notifications', profilesNotificationsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        profilesGeneralGroup.add(profilesNotificationsRow);

        // --- Group 2: Capture Current Layout ---
        const saveGroup = new Adw.PreferencesGroup({
            title: 'Capture Current Layout',
            description: 'Capture all open application windows and coordinates across workspaces.'
        });
        profilesPage.add(saveGroup);

        const profileNameEntry = new Adw.EntryRow({
            title: 'Profile Name'
        });
        const saveProfileButton = new Gtk.Button({
            icon_name: 'document-save-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            tooltip_text: 'Save Current Layout'
        });
        const saveProfile = () => {
            const name = profileNameEntry.get_text().trim();
            if (!name) {
                setProfileStatus('Type a profile name before saving.', true);
                return;
            }

            const data = readProfilesData();
            const save = () => {
                requestSaveProfile(name, true);
                profileNameEntry.set_text('');
            };

            if (data.profiles[name]) {
                confirmAction(
                    'Overwrite Profile?',
                    `A profile named "${name}" already exists. Replace it with the current window layout?`,
                    'Overwrite',
                    Adw.ResponseAppearance.DESTRUCTIVE,
                    save
                );
            } else {
                save();
            }
        };
        saveProfileButton.connect('clicked', saveProfile);
        profileNameEntry.connect('entry-activated', saveProfile);
        profileNameEntry.add_suffix(saveProfileButton);
        saveGroup.add(profileNameEntry);

        profileStatusRow = new Adw.ActionRow({
            title: 'Ready',
            subtitle: 'Save, apply, rename, or delete a profile to see status here.'
        });
        profileStatusRow.set_visible(false);
        saveGroup.add(profileStatusRow);

        // --- Group 3: Saved Layout Profiles ---
        const listGroup = new Adw.PreferencesGroup({
            title: 'Saved Profiles',
            description: 'Switch or manage your captured workspace sessions.'
        });
        profilesPage.add(listGroup);

        const listContainer = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE
        });
        listContainer.add_css_class('boxed-list');
        listGroup.add(listContainer);

        // Helper function to build profile rows dynamically
        const rebuildProfilesList = () => {
            // Remove existing rows in listContainer
            let child;
            while ((child = listContainer.get_first_child())) {
                listContainer.remove(child);
            }

            try {
                const data = readProfilesData();
                const profileNames = Object.keys(data.profiles);

                if (profileNames.length === 0) {
                    const noProfilesRow = new Adw.ActionRow({
                        title: 'No profiles saved yet',
                        subtitle: 'Type a name in the entry above and click save to capture your layout.'
                    });
                    listContainer.append(noProfilesRow);
                } else {
                    for (const name of profileNames) {
                        const profile = data.profiles[name];
                        const windowCount = profile.windows.length;
                        const windowWord = windowCount === 1 ? 'window' : 'windows';
                        const updatedAt = profile.updated_at ? ` · Updated ${new Date(profile.updated_at).toLocaleString()}` : '';
                        const row = new Adw.ActionRow({
                            title: name,
                            subtitle: `${windowCount} captured ${windowWord}${updatedAt}`
                        });

                        // 1. Add Apply Button
                        const applyButton = new Gtk.Button({
                            icon_name: 'view-grid-symbolic',
                            valign: Gtk.Align.CENTER,
                            tooltip_text: 'Apply Profile'
                        });
                        applyButton.add_css_class('suggested-action');
                        applyButton.connect('clicked', () => {
                            requestApplyProfile(name);
                        });

                        // 2. Add Rename Button
                        const renameButton = new Gtk.Button({
                            icon_name: 'document-edit-symbolic',
                            valign: Gtk.Align.CENTER,
                            tooltip_text: 'Rename Profile'
                        });
                        renameButton.connect('clicked', () => {
                            showRenameDialog(name);
                        });

                        // 3. Add Modify Button
                        const modifyButton = new Gtk.Button({
                            icon_name: 'document-save-symbolic',
                            valign: Gtk.Align.CENTER,
                            tooltip_text: 'Modify Profile with Current Layout'
                        });
                        modifyButton.connect('clicked', () => {
                            confirmAction(
                                'Modify Profile?',
                                `Replace "${name}" with the current window layout?`,
                                'Modify',
                                Adw.ResponseAppearance.SUGGESTED,
                                () => requestSaveProfile(name, true, 'modify')
                            );
                        });

                        // 4. Add Delete Button
                        const deleteButton = new Gtk.Button({
                            icon_name: 'user-trash-symbolic',
                            valign: Gtk.Align.CENTER,
                            tooltip_text: 'Delete Profile'
                        });
                        deleteButton.add_css_class('destructive-action');
                        deleteButton.connect('clicked', () => {
                            confirmAction(
                                'Delete Profile?',
                                `Delete "${name}" permanently? This cannot be undone.`,
                                'Delete',
                                Adw.ResponseAppearance.DESTRUCTIVE,
                                () => {
                                    const currentData = readProfilesData();
                                    delete currentData.profiles[name];
                                    if (settings.get_string('profiles-active-profile') === name) {
                                        settings.set_string('profiles-active-profile', '');
                                    }
                                    writeProfilesData(currentData, 'delete', `Deleted "${name}".`);
                                }
                            );
                        });

                        // Add suffix buttons with margins
                        const buttonBox = new Gtk.Box({
                            spacing: 8,
                            orientation: Gtk.Orientation.HORIZONTAL
                        });
                        buttonBox.append(applyButton);
                        buttonBox.append(renameButton);
                        buttonBox.append(modifyButton);
                        buttonBox.append(deleteButton);

                        row.add_suffix(buttonBox);
                        listContainer.append(row);
                    }
                }
            } catch (e) {
                setProfileStatus(`Could not rebuild profiles list: ${e.message}`, true);
            }
        };

        // Layout captured via saveProfileButton suffix inside entry

        // Listen to settings changes to rebuild list live
        connectSetting('changed::profiles-saved-data', () => {
            rebuildProfilesList();
        });

        connectSetting('changed::profiles-last-operation', () => {
            try {
                const raw = settings.get_string('profiles-last-operation') || '';
                if (!raw) return;

                const operation = JSON.parse(raw);
                if (operation && operation.message) {
                    setProfileStatus(operation.message, operation.status === 'error');
                }
            } catch (e) {
                setProfileStatus(`Could not read profile operation status: ${e.message}`, true);
            }
            rebuildProfilesList();
        });

        // Initialize list
        rebuildProfilesList();

        // Clean up settings connections when window is destroyed to prevent memory leaks
        window.connect('destroy', () => {
            for (const id of handlerIds) {
                settings.disconnect(id);
            }
        });
    }
}
