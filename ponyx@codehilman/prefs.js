import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PonyxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const island = new Adw.PreferencesGroup({title: 'Island'});
        const hover = new Adw.SwitchRow({
            title: 'Open on hover',
            subtitle: 'When off, click the island to open it',
        });
        settings.bind('expand-on-hover', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        const clock = new Adw.SwitchRow({
            title: 'Move clock to the right',
            subtitle: 'Gives the island the center of the top bar',
        });
        settings.bind('move-clock', clock, 'active', Gio.SettingsBindFlags.DEFAULT);
        const islandClock = new Adw.SwitchRow({
            title: 'Show time and date',
            subtitle: 'Shown in the collapsed island, following your 12h/24h setting',
        });
        settings.bind('show-clock', islandClock, 'active', Gio.SettingsBindFlags.DEFAULT);
        const popups = new Adw.SwitchRow({
            title: 'Show pop-ups in the island',
            subtitle: 'Volume, brightness, charger and headphones, instead of the GNOME pop-up',
        });
        settings.bind('notch-popups', popups, 'active', Gio.SettingsBindFlags.DEFAULT);
        const scroll = new Adw.SwitchRow({
            title: 'Scroll to change volume',
            subtitle: 'Scroll anywhere on the island',
        });
        settings.bind('scroll-volume', scroll, 'active', Gio.SettingsBindFlags.DEFAULT);
        island.add(hover);
        island.add(islandClock);
        island.add(popups);
        island.add(scroll);
        island.add(clock);

        const claude = new Adw.PreferencesGroup({
            title: 'Claude usage',
            description: 'Read from the Claude Code sign-in in ~/.claude. Run claude if usage says the token expired.',
        });
        const refresh = Adw.SpinRow.new_with_range(1, 60, 1);
        refresh.title = 'Check every';
        refresh.subtitle = 'Minutes between usage checks';
        settings.bind('refresh-minutes', refresh, 'value', Gio.SettingsBindFlags.DEFAULT);
        const alerts = new Adw.SwitchRow({
            title: 'Usage alerts',
            subtitle: 'Notify at 75% and 90%, and pulse the ring from 90%',
        });
        settings.bind('usage-alerts', alerts, 'active', Gio.SettingsBindFlags.DEFAULT);
        claude.add(refresh);
        claude.add(alerts);

        const music = new Adw.PreferencesGroup({title: 'Music'});
        const lyrics = new Adw.SwitchRow({
            title: 'Show lyrics',
            subtitle: 'Looks up the playing track on lrclib.net',
        });
        settings.bind('show-lyrics', lyrics, 'active', Gio.SettingsBindFlags.DEFAULT);
        music.add(lyrics);

        page.add(island);
        page.add(music);
        page.add(claude);
        window.add(page);
    }
}
