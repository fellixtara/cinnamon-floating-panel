const { Clutter, Gio, GLib, St } = imports.gi;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

const UUID = 'floating-panel@fellixtara';

// Inline style that takes the theme's own look off the panel, so only the
// pills show.
const BARE_PANEL = 'background-color: transparent; background-image: none; border-image: none; ' +
    'border-width: 0; box-shadow: none; border-radius: 0;';
const ZONES = ['left', 'center', 'right'];

const GTK_CSS = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'gtk.css']);
const GTK_START = '/* ' + UUID + ': start (written by the Floating Panel extension) */';
const GTK_END = '/* ' + UUID + ': end */';
const SN_WATCHER = '/usr/lib/x86_64-linux-gnu/xapps/xapp-sn-watcher';
// -x: the process name only, so no other command line can match.
const PGREP_WATCHER = ['pgrep', '-x', 'xapp-sn-watcher'];
// Tray apps with their own GTK menu (not drawn by xapp-sn-watcher): process
// name and the command that starts them again in the tray.
const TRAY_APPS = [
    { name: 'mintUpdate', command: ['/usr/lib/linuxmint/mintUpdate/mintUpdate.py'] },
    { name: 'mintreport-tray', command: ['/usr/lib/linuxmint/mintreport/tray.py'] },
];

const TINT_EFFECT = 'floating-panel-tint';

let floating = null;

// Floating panels: the panel actor still spans the screen edge (so windows
// keep out of it), the margins are empty space inside it, and the visible
// part is drawn by "pills" laid behind the applets.
class FloatingPanel {
    constructor() {
        this.settings = new Settings.ExtensionSettings(this, UUID);
        for (let key of ['separate', 'gap', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
            'radius', 'padding', 'background', 'transparency'])
            this.settings.bind(key, key.replace(/-/g, '_'), () => this._refresh(key.startsWith('margin')));
        for (let key of ['menu-custom', 'menu-background', 'menu-transparency', 'menu-text',
            'submenu-background', 'submenu-transparency', 'submenu-text'])
            this.settings.bind(key, key.replace(/-/g, '_'), () => {
                this._loadMenuStyle();
                this._queueGtkMenus();
            });
        this.settings.bind('gtk-menus', 'gtk_menus', () => this._queueGtkMenus());
        this.settings.bind('icon-tint', 'icon_tint', () => this._tintIcons(true));
        this.settings.bind('icon-color', 'icon_color', () => this._tintIcons(true));
        // A new theme drops the stylesheets loaded into the old one.
        this._themeSetId = Main.themeManager.connect('theme-set', () => {
            this._menuStylesheet = null;
            this._loadMenuStyle();
        });
        this._loadMenuStyle();
        if (this._writeGtkMenus(false))
            this._restartTrayService();

        this._originals = {};
        let self = this;
        let proto = Panel.Panel.prototype;
        this._patch(proto, '_getScaledPanelHeight', function (original) {
            if (!self._applies(this))
                return original.call(this);
            // Called while a panel is built too: new panels get their pills
            // here.
            self._decorate(this);
            return original.call(this) + self._extraHeight();
        });
        // The applets size their icons from the panel height: they get the
        // height without the margins.
        this._patch(proto, '_setPanelHeight', function (original) {
            if (!self._applies(this))
                return original.call(this);
            let height = Panel.setHeightForPanel(this) - self._extraHeight();
            if (height < 20)
                height = 20;
            if (height === this.height)
                return;
            this.height = height;
            this._onPanelZoneSizesChanged();
            this.emit('size-changed', height);
        });
        // Each panel connected its own _allocate when it was built, so the
        // layout is corrected by a handler that runs after it.
        this._allocateOriginal = proto._allocate;

        this._refresh(true);
        this._tintIcons(true);
    }

    // The fragment shader that draws an icon as a flat shape of one colour.
    _tintSource() {
        let match = String(this.icon_color || '').match(/rgba?\(([^)]+)\)/);
        let [r, g, b] = match ? match[1].split(',').map(Number) : [255, 255, 255];
        let rgb = [r, g, b].map(v => (Math.max(0, Math.min(255, v || 0)) / 255).toFixed(4)).join(', ');
        return 'uniform sampler2D tex;\n' +
            'void main() {\n' +
            '    vec4 c = texture2D(tex, cogl_tex_coord_in[0].st);\n' +
            '    cogl_color_out = vec4(vec3(' + rgb + ') * c.a, c.a);\n' +
            '}\n';
    }

    // Icons, texts and pictures (tray icons sent as pixmaps) of the
    // applets in the right zone of each panel.
    _tintTargets(actor, list) {
        if (actor instanceof St.Icon || actor instanceof St.Label ||
            (actor.constructor === Clutter.Actor && actor.get_content())) {
            list.push(actor);
            return list;
        }
        for (let child of actor.get_children())
            this._tintTargets(child, list);
        return list;
    }

    // `reset`: the colour changed or the option was switched, so existing
    // effects are replaced; `off`: removes them all (extension disabled). Applets add and replace icons at any time, so
    // the zone is checked again every two seconds while the option is on.
    _tintIcons(reset, off = false) {
        let source = this.icon_tint && !off ? this._tintSource() : null;
        for (let panel of this._panels()) {
            if (!panel._rightBox)
                continue;
            for (let actor of this._tintTargets(panel._rightBox, [])) {
                let effect = actor.get_effect(TINT_EFFECT);
                if (effect && (reset || !source)) {
                    actor.remove_effect(effect);
                    effect = null;
                }
                if (source && !effect) {
                    effect = new Clutter.ShaderEffect({ shader_type: Clutter.ShaderType.FRAGMENT_SHADER });
                    effect.set_shader_source(source);
                    effect.set_uniform_value('tex', 0);
                    actor.add_effect_with_name(TINT_EFFECT, effect);
                }
            }
        }
        if (source && !this._tintTimeout) {
            this._tintTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._tintIcons(false);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!source && this._tintTimeout) {
            GLib.source_remove(this._tintTimeout);
            this._tintTimeout = 0;
        }
    }

    _patch(proto, name, wrapper) {
        let original = proto[name];
        this._originals[name] = original;
        proto[name] = function (...args) {
            return wrapper.call(this, original, ...args);
        };
    }

    // Vertical panels are left as they are.
    _applies(panel) {
        return !panel._destroyed && (panel.panelPosition === Panel.PanelLoc.top ||
            panel.panelPosition === Panel.PanelLoc.bottom);
    }

    _extraHeight() {
        return ((Number(this.margin_top) || 0) + (Number(this.margin_bottom) || 0)) * global.ui_scale;
    }

    _panels() {
        return (Main.panelManager ? Main.panelManager.getPanels() : []).filter(p => p);
    }

    // Applies the settings to every panel; `resize` when the height changes.
    _refresh(resize) {
        for (let panel of this._panels()) {
            if (!this._applies(panel))
                continue;
            this._decorate(panel);
            if (resize) {
                panel._moveResizePanel();
                panel._setPanelHeight();
            }
            panel.actor.queue_relayout();
        }
    }

    // A colour setting as rgba(), made more transparent by `transparency` %.
    _rgba(color, transparency, fallback) {
        let match = String(color || fallback).match(/rgba?\(([^)]+)\)/) || fallback.match(/rgba?\(([^)]+)\)/);
        let [r, g, b, a] = match[1].split(',').map(Number);
        if (isNaN(a))
            a = 1;
        let alpha = a * (1 - Math.max(0, Math.min(100, Number(transparency) || 0)) / 100);
        return 'rgba(' + [r, g, b, alpha.toFixed(3)].join(', ') + ')';
    }

    _pillStyle() {
        return 'background-color: ' + this._rgba(this.background, this.transparency, 'rgb(30,30,36)') +
            '; border-radius: ' + Math.round((Number(this.radius) || 0) * global.ui_scale) + 'px;';
    }

    // The menus are styled by a generated stylesheet laid over the theme's.
    _menuCss() {
        // Each class twice: these rules are then more specific than the
        // theme's.
        let menus = ['.menu.menu', '.popup-menu.popup-menu', '.popup-combo-menu.popup-combo-menu'];
        let sub = menus.map(m => m + ' .popup-sub-menu.popup-sub-menu');
        let all = (list, suffix) => list.map(m => m + suffix).join(',\n');
        let bg = this._rgba(this.menu_background, this.menu_transparency, 'rgb(33,33,33)');
        let text = this._rgba(this.menu_text, 0, 'rgb(255,255,255)');
        let subBg = this._rgba(this.submenu_background, this.submenu_transparency, 'rgb(48,48,52)');
        let subText = this._rgba(this.submenu_text, 0, 'rgb(235,235,235)');
        return all(menus, '') + ' {\n  background-color: ' + bg + ';\n  color: ' + text + ';\n  border: none;\n}\n' +
            all(menus, ' .popup-menu-item') + ' {\n  color: ' + text + ';\n}\n' +
            all(sub, '') + ' {\n  background-color: ' + subBg + ';\n  color: ' + subText + ';\n  border: none;\n}\n' +
            all(sub, ' .popup-menu-item') + ',\n' + all(sub, ' .popup-menu-item:hover') + ',\n' +
            all(sub, ' .popup-menu-item:active') + ' {\n  color: ' + subText + ';\n}\n' +
            all(sub, ' .popup-menu-item:hover') + ',\n' + all(sub, ' .popup-menu-item:active') +
            ' {\n  background-color: rgba(255, 255, 255, 0.1);\n}\n' +
            // The music player card of the sound applet.
            '.sound-player.sound-player {\n  background-color: ' + subBg + ';\n  color: ' + subText + ';\n}\n' +
            '.sound-player.sound-player > StBoxLayout:first-child StButton:small:hover {\n' +
            '  background-color: rgba(255, 255, 255, 0.12);\n}\n';
    }

    // Menus that already exist keep their old style when a stylesheet is
    // only added to the theme: the stylesheets go into a new theme, which
    // restyles everything.
    _swapStylesheet(remove, add) {
        let context = St.ThemeContext.get_for_stage(global.stage);
        let old = context.get_theme();
        let fallback = old.fallback_stylesheet;
        let theme = new St.Theme({ fallback_stylesheet: fallback && fallback.get_path ? fallback.get_path() : fallback });
        for (let sheet of old.get_custom_stylesheets()) {
            let path = sheet.get_path ? sheet.get_path() : String(sheet);
            if (path !== remove && path !== add)
                theme.load_stylesheet(path);
        }
        if (add)
            theme.load_stylesheet(add);
        context.set_theme(theme);
    }

    // Tray icons (xapp-status) show GTK menus drawn by the apps themselves,
    // styled by a block in the user's gtk.css.
    _gtkCss() {
        let bg = this._rgba(this.menu_background, this.menu_transparency, 'rgb(33,33,33)');
        let text = this._rgba(this.menu_text, 0, 'rgb(255,255,255)');
        let dim = text.replace(/[\d.]+\)$/, '0.5)');
        return GTK_START + '\n' +
            'menu, .menu, .context-menu, window.popup menu, window.background.popup menu,\n' +
            '.csd menu, .csd .menu, .csd .context-menu, combobox menu, combobox window.popup menu {\n' +
            '  background-color: ' + bg + ';\n  color: ' + text + ';\n  border: none;\n}\n' +
            '.csd.popup decoration, window.popup decoration, window.background.popup decoration, .popup decoration {\n' +
            '  border: none;\n}\n' +
            'menu menuitem, menu menuitem label, menu menuitem accelerator, menu menuitem arrow,\n' +
            '.context-menu menuitem, .context-menu menuitem label,\n' +
            'menu menuitem:not(:hover):not(:selected), menu menuitem:not(:hover):not(:selected) label,\n' +
            '.context-menu menuitem:not(:hover):not(:selected), .context-menu menuitem:not(:hover):not(:selected) label {\n' +
            '  color: ' + text + ';\n}\n' +
            'menu menuitem:disabled, menu menuitem:disabled label {\n  color: ' + dim + ';\n}\n' +
            GTK_END + '\n';
    }

    // Writes (or removes) the block; returns whether the file changed.
    _writeGtkMenus(remove) {
        let file = Gio.File.new_for_path(GTK_CSS);
        let old = '';
        try {
            let [, contents] = file.load_contents(null);
            old = imports.byteArray.toString(contents);
        } catch (e) {
        }
        let start = old.indexOf(GTK_START), end = old.indexOf(GTK_END);
        let rest = start >= 0 && end > start
            ? old.slice(0, start) + old.slice(end + GTK_END.length).replace(/^\n/, '') : old;
        let text = !remove && this.menu_custom && this.gtk_menus
            ? (rest && !rest.endsWith('\n') ? rest + '\n' : rest) + this._gtkCss() : rest;
        if (text === old)
            return false;
        try {
            if (!text.trim() && old.trim() === old.slice(start, end + GTK_END.length).trim()) {
                file.delete(null);
            } else {
                GLib.mkdir_with_parents(GLib.path_get_dirname(GTK_CSS), 0o755);
                file.replace_contents(text, null, false, Gio.FileCreateFlags.NONE, null);
            }
        } catch (e) {
            global.logError(UUID + ': could not write ' + GTK_CSS + ': ' + e);
            return false;
        }
        return true;
    }

    // GTK reads gtk.css when an app starts: the tray service, which draws
    // the menus of most tray icons, is restarted (the icons come back on
    // their own). Waits for the settings to stop changing first.
    _queueGtkMenus() {
        if (this._gtkTimeout)
            GLib.source_remove(this._gtkTimeout);
        this._gtkTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._gtkTimeout = 0;
            if (this._writeGtkMenus(false))
                this._restartTrayService();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restartTrayService() {
        Util.spawnCommandLineAsyncIO('', (stdout) => {
            for (let pid of stdout.split(/\s+/).filter(pid => /^\d+$/.test(pid)))
                Util.spawn(['kill', pid]);
            // Usually started again by D-Bus as soon as an app asks for it.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                Util.spawnCommandLineAsyncIO('', (out) => {
                    if (!out.trim())
                        Util.spawn([SN_WATCHER]);
                }, { argv: PGREP_WATCHER });
                return GLib.SOURCE_REMOVE;
            });
        }, { argv: PGREP_WATCHER });
        for (let app of TRAY_APPS)
            this._restartTrayApp(app);
    }

    // Tray apps that draw their own menu. One that is busy (it has child
    // processes, e.g. an update running) is left alone.
    _restartTrayApp(app) {
        Util.spawnCommandLineAsyncIO('', (stdout) => {
            let pids = stdout.split(/\s+/).filter(pid => /^\d+$/.test(pid));
            if (!pids.length)
                return;
            Util.spawnCommandLineAsyncIO('', (children) => {
                if (children.trim())
                    return;
                for (let pid of pids)
                    Util.spawn(['kill', pid]);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    Util.spawn(app.command);
                    return GLib.SOURCE_REMOVE;
                });
            }, { argv: ['pgrep', '-P', pids.join(',')] });
        }, { argv: ['pgrep', '-x', app.name] });
    }

    _unloadMenuStyle() {
        if (!this._menuStylesheet)
            return;
        try {
            this._swapStylesheet(this._menuStylesheet.get_path(), null);
        } catch (e) {
        }
        try {
            this._menuStylesheet.delete(null);
        } catch (e) {
        }
        this._menuStylesheet = null;
    }

    _loadMenuStyle() {
        this._unloadMenuStyle();
        if (!this.menu_custom)
            return;
        // A new file each time: the theme caches stylesheets by file.
        let dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), UUID]);
        GLib.mkdir_with_parents(dir, 0o700);
        this._menuCount = (this._menuCount || 0) + 1;
        let file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'menus-' + this._menuCount + '.css']));
        try {
            file.replace_contents(this._menuCss(), null, false, Gio.FileCreateFlags.NONE, null);
            this._swapStylesheet(null, file.get_path());
            this._menuStylesheet = file;
        } catch (e) {
            global.logError(UUID + ': could not load the menu colours: ' + e);
        }
    }

    // The pills of a panel, created the first time: one for the whole panel
    // and one per zone, all behind the applets.
    _decorate(panel) {
        if (!panel._floatingPills) {
            panel._floatingPills = {};
            for (let name of ['whole'].concat(ZONES)) {
                let pill = new St.Widget({ visible: false });
                panel.actor.insert_child_at_index(pill, 0);
                panel._floatingPills[name] = pill;
            }
            panel._floatingStyle = panel.actor.get_style();
            panel._floatingAllocateId = panel.actor.connect('allocate', (actor, box, flags) => {
                if (this._applies(panel))
                    this._allocate(panel, this._allocateOriginal, actor, box, flags);
            });
        }
        panel.actor.set_style(BARE_PANEL);
        let style = this._pillStyle();
        for (let name in panel._floatingPills)
            panel._floatingPills[name].set_style(style);
    }

    _undecorate(panel) {
        if (!panel._floatingPills)
            return;
        panel.actor.disconnect(panel._floatingAllocateId);
        delete panel._floatingAllocateId;
        for (let name in panel._floatingPills)
            panel._floatingPills[name].destroy();
        delete panel._floatingPills;
        panel.actor.set_style(panel._floatingStyle || null);
        delete panel._floatingStyle;
    }

    _allocate(panel, original, actor, box, flags) {
        if (!panel._floatingPills)
            this._decorate(panel);
        let pills = panel._floatingPills;
        let scale = global.ui_scale;
        let separate = !!this.separate;
        let padding = Math.round((Number(this.padding) || 0) * scale);

        // The pills' area: the panel minus the margins.
        let area = box.copy();
        area.x1 += Math.round((Number(this.margin_left) || 0) * scale);
        area.x2 -= Math.round((Number(this.margin_right) || 0) * scale);
        area.y1 += Math.round((Number(this.margin_top) || 0) * scale);
        area.y2 -= Math.round((Number(this.margin_bottom) || 0) * scale);
        if (area.x2 < area.x1 + 10)
            area.x2 = area.x1 + 10;
        if (area.y2 < area.y1 + 10)
            area.y2 = area.y1 + 10;

        // The applets sit inside the pills, away from their edges.
        let content = area.copy();
        content.x1 += padding;
        content.x2 -= padding;
        original.call(panel, actor, content, flags);

        pills.whole.visible = !separate;
        if (!separate) {
            pills.whole.allocate(area, flags);
            for (let name of ZONES)
                pills[name].visible = false;
            return;
        }

        let boxes = { left: panel._leftBox, center: panel._centerBox, right: panel._rightBox };
        let rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        let spans = {};
        for (let name of ZONES) {
            let zone = boxes[name];
            let hasApplets = zone.get_children().some(child => child.visible);
            let [, natural] = zone.get_preferred_width(-1);
            if (!hasApplets || natural <= 0) {
                spans[name] = null;
                continue;
            }
            let alloc = zone.get_allocation_box();
            let width = Math.min(natural, alloc.x2 - alloc.x1);
            let start = (name === 'left') !== rtl ? alloc.x1
                : name === 'center' ? Math.round((alloc.x1 + alloc.x2 - width) / 2)
                    : alloc.x2 - width;
            spans[name] = [start - padding, start + width + padding];
        }

        // Two pills closer than the gap give up the space between them
        // equally.
        let gap = Math.round((Number(this.gap) || 0) * scale);
        let order = ZONES.filter(name => spans[name]).sort((a, b) => spans[a][0] - spans[b][0]);
        for (let i = 1; i < order.length; i++) {
            let before = spans[order[i - 1]], after = spans[order[i]];
            let overlap = before[1] + gap - after[0];
            if (overlap > 0) {
                before[1] -= Math.ceil(overlap / 2);
                after[0] += Math.floor(overlap / 2);
            }
        }

        for (let name of ZONES) {
            let pill = pills[name];
            pill.visible = !!spans[name];
            if (!spans[name])
                continue;
            let pillBox = area.copy();
            pillBox.x1 = Math.max(area.x1, spans[name][0]);
            pillBox.x2 = Math.min(area.x2, Math.max(pillBox.x1 + 1, spans[name][1]));
            pill.allocate(pillBox, flags);
        }
    }

    destroy() {
        let proto = Panel.Panel.prototype;
        for (let name in this._originals)
            proto[name] = this._originals[name];
        this._originals = {};
        for (let panel of this._panels()) {
            this._undecorate(panel);
            panel._moveResizePanel();
            panel._setPanelHeight();
            panel.actor.queue_relayout();
        }
        Main.themeManager.disconnect(this._themeSetId);
        this._tintIcons(true, true);
        if (this._gtkTimeout)
            GLib.source_remove(this._gtkTimeout);
        // Turning the extension off keeps the tray menus' colours until the
        // next login instead of restarting the tray service.
        this._writeGtkMenus(true);
        this._unloadMenuStyle();
        this.settings.finalize();
    }
}

function init(metadata) {
}

function enable() {
    floating = new FloatingPanel();
}

function disable() {
    if (floating) {
        floating.destroy();
        floating = null;
    }
}
