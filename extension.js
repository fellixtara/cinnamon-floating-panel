const { Clutter, GdkPixbuf, Gio, GLib, GObject, St } = imports.gi;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

const UUID = 'floating-panel@fellixtara';
let extensionDir = null;

// Tray icons replaced by the extension's own SVGs (in icons/): the tray
// icon's name (or, for apps that give none, the id of their tray item), the
// icon for normal use and the logo alone for one-colour mode.
// `notice`: how the app marks unread messages on its own picture; the icon
// then gets a notice dot, at `noticeAt` unless the settings move it:
//   'red'     -> a red badge (a muted chat's grey badge does not count);
//   'outside' -> a badge that sticks out of the round icon;
//   'colour'  -> a coloured dot, drawn in the app's colour (Slack: blue for
//                unread messages, pink for mentions).
const NOTICE_RED = '#F23B36';
const CUSTOM_ICONS = [
    { name: 'tray_linux_release', title: '9Router', color: '9router.svg', symbolic: '9router-symbolic.svg' },
    { name: 'telegramdesktop', title: 'Telegram', color: 'telegram.svg', symbolic: 'telegram-symbolic.svg',
        notice: 'red', noticeAt: 'top' },
    { name: 'zapfast', title: 'WhatsApp (zapfast)', color: 'whatsapp.svg', symbolic: 'whatsapp-symbolic.svg',
        notice: 'outside', noticeAt: 'top' },
    { id: /^Slack/, title: 'Slack', color: 'slack.svg', symbolic: 'slack-symbolic.svg',
        notice: 'colour', noticeAt: 'bottom' },
];

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

// The fragment shaders that redraw an icon in the colour (tr, tg, tb).
//  flat:     every pixel takes the colour (texts).
//  badge:    the same, but coloured dots keep their colours (theme icons).
//  glyph:    a light shape on a dark outline (Slack): the outline goes, the
//            shape takes the colour, coloured dots (notification badges)
//            keep their own colours.
//  knockout: a light shape on a coloured tile (9Router): the tile takes the
//            colour and the shape becomes a hole, like a symbolic icon.
// `ta` dims the result: theme icons and texts are drawn with the panel's
// text opacity already, pictures from apps are not, so they get it here.
const SHADER_HEAD = 'uniform sampler2D tex;\n' +
    'uniform float tr;\n' +
    'uniform float tg;\n' +
    'uniform float tb;\n' +
    'uniform float ta;\n' +
    'void main() {\n' +
    '    vec3 tint = vec3(tr, tg, tb);\n' +
    '    vec4 c = texture2D(tex, cogl_tex_coord_in[0].st);\n' +
    '    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);\n' +
    '    float hi = max(rgb.r, max(rgb.g, rgb.b));\n' +
    '    float lo = min(rgb.r, min(rgb.g, rgb.b));\n' +
    '    float sat = hi > 0.0 ? (hi - lo) / hi : 0.0;\n' +
    '    float lum = dot(rgb, vec3(0.299, 0.587, 0.114));\n';
const KEEP_BADGE = '    if (sat > 0.35 && hi > 0.3) {\n' +
    '        cogl_color_out = c;\n' +
    '        return;\n' +
    '    }\n';
const SHADERS = {
    flat: SHADER_HEAD +
        '    cogl_color_out = vec4(tint * c.a, c.a) * ta;\n}\n',
    badge: SHADER_HEAD + KEEP_BADGE +
        '    cogl_color_out = vec4(tint * c.a, c.a) * ta;\n}\n',
    glyph: SHADER_HEAD + KEEP_BADGE +
        '    float k = c.a * smoothstep(0.2, 0.55, lum);\n' +
        '    cogl_color_out = vec4(tint * k, k) * ta;\n}\n',
    knockout: SHADER_HEAD +
        '    float white = (1.0 - sat) * lum;\n' +
        '    float k = c.a * (1.0 - smoothstep(0.55, 0.85, white)) * smoothstep(0.1, 0.3, hi);\n' +
        '    cogl_color_out = vec4(tint * k, k) * ta;\n}\n',
};

// One effect class per shader: Clutter compiles a class's shader once and
// shares it between all its effects. A GType name can be registered only
// once per Cinnamon session, so reloading the extension needs new names.
// 1 as a float: whole numbers would reach the shaders as integers.
const FULL = 1 - 1e-7;
// The uniforms live in that shared shader, so effects with different
// values must not share a class: theme icons and texts (`ta` 1) and
// pictures (`ta` the text opacity) get a class each ("<mode>" and
// "<mode>-picture").
const TINT_CLASSES = {};
const TYPE_SUFFIX = String(Date.now());
for (let mode in SHADERS) {
    for (let kind of ['', '-picture']) {
        let source = SHADERS[mode];
        TINT_CLASSES[mode + kind] = GObject.registerClass(
            { GTypeName: 'FloatingPanelTint_' + mode + kind.replace('-', '_') + '_' + TYPE_SUFFIX },
            class extends Clutter.ShaderEffect {
                vfunc_get_static_shader_source() {
                    return source;
                }
            });
    }
}

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
        this.settings.bind('custom-icons', 'custom_icons', () => this._tintIcons(true));
        this.settings.bind('notice-position', 'notice_position', () => this._tintIcons(true));
        this.settings.bind('notice-custom', 'notice_custom', () => this._tintIcons(true));
        this.settings.bind('notice-color', 'notice_color', () => this._tintIcons(true));
        this._itemIdsActive = true;
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
    // How to recolour a picture icon, from its pixels:
    //  mostly coloured           -> a tile (knockout),
    //  mostly dark (apart from coloured dots) -> a dark shape meant for
    //                                light panels, its holes being the
    //                                details; dots keep their colours (badge),
    //  otherwise                  -> a light shape, maybe outlined (glyph).
    // Cached per file and version: apps write a new file whenever their
    // icon changes, and the tray reuses file names for other apps.
    _pictureMode(path) {
        let key = path;
        try {
            let info = Gio.File.new_for_path(path).query_info('time::modified,time::modified-usec,standard::size',
                Gio.FileQueryInfoFlags.NONE, null);
            key += ':' + info.get_attribute_uint64('time::modified') + '.' +
                info.get_attribute_uint32('time::modified-usec') + ':' + info.get_size();
        } catch (e) {
        }
        this._modeCache = this._modeCache || new Map();
        if (this._modeCache.has(key))
            return this._modeCache.get(key);
        let mode = 'glyph';
        try {
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
            if (pixbuf.get_has_alpha() && pixbuf.get_n_channels() === 4) {
                let pixels = pixbuf.get_pixels(), stride = pixbuf.get_rowstride();
                let solid = 0, coloured = 0, dark = 0;
                for (let y = 0; y < pixbuf.get_height(); y++) {
                    for (let x = 0; x < pixbuf.get_width(); x++) {
                        let o = y * stride + x * 4;
                        if (pixels[o + 3] < 128)
                            continue;
                        solid++;
                        let r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
                        let hi = Math.max(r, g, b), lo = Math.min(r, g, b);
                        if (hi > 76 && (hi - lo) / hi > 0.4)
                            coloured++;
                        else if (0.299 * r + 0.587 * g + 0.114 * b < 90)
                            dark++;
                    }
                }
                if (solid && coloured / solid > 0.5)
                    mode = 'knockout';
                else if (solid > coloured && dark / (solid - coloured) > 0.85)
                    mode = 'badge';
            }
        } catch (e) {
        }
        if (this._modeCache.size > 50)
            this._modeCache.clear();
        this._modeCache.set(key, mode);
        return mode;
    }

    // The tray icons of xapp-status (one object per icon).
    _statusIcons() {
        let icons = [];
        for (let applet of imports.ui.appletManager.getRunningInstancesForUuid('xapp-status@cinnamon.org') || [])
            for (let key in applet.statusIcons || {})
                icons.push(applet.statusIcons[key]);
        return icons;
    }

    // Puts the extension's icon in place of the app's, and keeps it there
    // when the app sends a new icon. `off` gives the app its icon back.
    _customIcons(off) {
        for (let icon of this._statusIcons()) {
            let custom = !off && this.custom_icons && icon.proxy && this._customEntry(icon.proxy.name);
            if (!custom) {
                if (icon._floatingCustom) {
                    icon.setIconName = icon._floatingSetIconName;
                    icon._onImageLoaded = icon._floatingOnImageLoaded;
                    delete icon._floatingSetIconName;
                    delete icon._floatingOnImageLoaded;
                    delete icon._floatingCustom;
                    icon.icon_loader_handle = null;
                    icon.setIconName(icon.proxy.icon_name);
                }
                continue;
            }
            if (!icon._floatingCustom) {
                icon._floatingSetIconName = icon.setIconName;
                icon._floatingOnImageLoaded = icon._onImageLoaded;
                let self = this;
                // The app's own icon is still loaded (the icon size and
                // the "out of sync" check depend on it), then replaced.
                icon.setIconName = function (name) {
                    this._floatingSetIconName.call(this, name);
                    self._showCustomIcon(this);
                };
                icon._onImageLoaded = function (...args) {
                    this._floatingOnImageLoaded.apply(this, args);
                    self._showCustomIcon(this);
                };
            }
            icon._floatingCustom = custom;
            this._showCustomIcon(icon);
        }
    }

    // The CUSTOM_ICONS entry of a tray icon. Apps whose tray item has no
    // title show up under their bus name (":1.91"); their item's id is
    // looked up once, and the icons are checked again when it arrives.
    _customEntry(name) {
        if (!name)
            return null;
        let id = name;
        if (name.startsWith(':')) {
            this._itemIds = this._itemIds || new Map();
            if (!this._itemIds.has(name)) {
                this._itemIds.set(name, null);
                Gio.DBus.session.call(name, '/StatusNotifierItem', 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', ['org.kde.StatusNotifierItem', 'Id']), null,
                    Gio.DBusCallFlags.NONE, 2000, null, (connection, result) => {
                        try {
                            let value = connection.call_finish(result).deep_unpack()[0].deep_unpack();
                            this._itemIds.set(name, String(value));
                            if (this._itemIdsActive)
                                this._customIcons(false);
                        } catch (e) {
                        }
                    });
            }
            id = this._itemIds.get(name);
            if (!id)
                return null;
        }
        return CUSTOM_ICONS.find(entry => entry.id ? entry.id.test(id) : entry.name === id) || null;
    }

    _showCustomIcon(icon) {
        let custom = icon._floatingCustom;
        if (!custom)
            return;
        let base = this.icon_tint ? custom.symbolic : custom.color;
        let file = extensionDir.get_child('icons').get_child(base);
        let notice = custom.notice ? this._notice(icon.proxy.icon_name, custom.notice) : null;
        if (notice) {
            let at = this.notice_position === 'top' || this.notice_position === 'bottom' ?
                this.notice_position : custom.noticeAt;
            let color = this.notice_custom ? this._hexColor(this.notice_color) : notice;
            file = this._noticeFile(base, at, color) || file;
        }
        let key = file.get_path();
        let child = icon.icon_holder.child;
        if (child && child._floatingFile === key && child.icon_size === icon.iconSize)
            return;
        let actor = new St.Icon({
            gicon: new Gio.FileIcon({ file }),
            icon_size: icon.iconSize || 16,
            icon_type: St.IconType.FULLCOLOR,
        });
        actor._floatingFile = key;
        icon.icon_holder.child = actor;
        icon.icon_holder.show();
        // The new icon gets its colour right away, not at the next check.
        if (this.icon_tint && !this._tintIdle) {
            this._tintIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._tintIdle = 0;
                if (this._itemIdsActive)
                    this._tintIcons(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // The notice dot's colour when the app's picture shows unread messages
    // (see CUSTOM_ICONS), otherwise null. Cached per file and version.
    _notice(path, kind) {
        if (!path || !path.startsWith('/'))
            return null;
        let key = kind + ':' + path;
        try {
            let info = Gio.File.new_for_path(path).query_info('time::modified,time::modified-usec,standard::size',
                Gio.FileQueryInfoFlags.NONE, null);
            key += ':' + info.get_attribute_uint64('time::modified') + '.' +
                info.get_attribute_uint32('time::modified-usec') + ':' + info.get_size();
        } catch (e) {
        }
        this._noticeCache = this._noticeCache || new Map();
        if (this._noticeCache.has(key))
            return this._noticeCache.get(key);
        let notice = null;
        try {
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
            if (pixbuf.get_n_channels() === 4) {
                let pixels = pixbuf.get_pixels(), stride = pixbuf.get_rowstride();
                let width = pixbuf.get_width(), height = pixbuf.get_height();
                let radius = Math.min(width, height) / 2;
                let solid = 0, found = 0, sum = [0, 0, 0];
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        let o = y * stride + x * 4;
                        if (pixels[o + 3] < 128)
                            continue;
                        solid++;
                        let r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
                        let hi = Math.max(r, g, b), lo = Math.min(r, g, b);
                        let hit = kind === 'red' ? r > 180 && g < 110 && b < 110
                            : kind === 'outside' ? Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > radius + 0.5
                            : hi > 76 && (hi - lo) / hi > 0.4;
                        if (hit) {
                            found++;
                            sum[0] += r;
                            sum[1] += g;
                            sum[2] += b;
                        }
                    }
                }
                let share = solid ? found / solid : 0;
                if (share > (kind === 'outside' ? 0.02 : 0.05))
                    notice = kind === 'colour' ?
                        this._hexColor('rgb(' + sum.map(v => Math.round(v / found)).join(',') + ')') : NOTICE_RED;
            }
        } catch (e) {
        }
        if (this._noticeCache.size > 50)
            this._noticeCache.clear();
        this._noticeCache.set(key, notice);
        return notice;
    }

    _hexColor(css) {
        let match = String(css || '').match(/rgba?\(([^)]+)\)/);
        let rgb = match ? match[1].split(',').map(Number).slice(0, 3) : [242, 59, 54];
        return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0')).join('');
    }

    // The icon with a notice dot at the top or bottom right, cut out of the
    // logo with a thin gap; written once per icon, place and colour.
    _noticeFile(base, at, color) {
        let dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), UUID, 'notice']);
        let file = Gio.File.new_for_path(GLib.build_filenamev([dir,
            base.replace(/\.svg$/, '') + '-' + at + '-' + color.slice(1) + '.svg']));
        if (file.query_exists(null))
            return file;
        try {
            let [, bytes] = extensionDir.get_child('icons').get_child(base).load_contents(null);
            let text = imports.byteArray.toString(bytes);
            let open = text.match(/<svg[^>]*>/)[0];
            let box = (open.match(/viewBox="([^"]+)"/) || [null, '0 0 600 600'])[1].split(/[\s,]+/).map(Number);
            let inner = text.slice(text.indexOf(open) + open.length, text.lastIndexOf('</svg>'));
            let size = Math.min(box[2], box[3]);
            let cx = box[0] + box[2] - size * 0.17;
            let cy = at === 'top' ? box[1] + size * 0.17 : box[1] + box[3] - size * 0.17;
            let svg = open + '\n  <defs><mask id="floating-notice">' +
                `<rect x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" fill="#fff"/>` +
                `<circle cx="${cx}" cy="${cy}" r="${size * 0.215}" fill="#000"/></mask></defs>\n` +
                `  <g mask="url(#floating-notice)">${inner}</g>\n` +
                `  <circle cx="${cx}" cy="${cy}" r="${size * 0.16}" fill="${color}"/>\n</svg>\n`;
            GLib.mkdir_with_parents(dir, 0o700);
            file.replace_contents(svg, null, false, Gio.FileCreateFlags.NONE, null);
            return file;
        } catch (e) {
            global.logError(UUID + ': could not draw the notice dot: ' + e);
            return null;
        }
    }

    _pictureFiles() {
        let files = new Map();
        for (let applet of imports.ui.appletManager.getRunningInstancesForUuid('xapp-status@cinnamon.org') || []) {
            for (let key in applet.statusIcons || {}) {
                let icon = applet.statusIcons[key];
                let name = icon.proxy ? icon.proxy.icon_name : null;
                if (name && name.startsWith('/'))
                    files.set(icon.actor, name);
            }
        }
        return files;
    }

    // Icons, texts and pictures (tray icons sent as pixmaps) of the
    // applets in the right zone of each panel, with how to recolour each.
    _tintTargets(actor, list, files, file = null) {
        if (files.has(actor))
            file = files.get(actor);
        if (actor instanceof St.Label || actor instanceof St.Icon) {
            list.push([actor, actor instanceof St.Icon ? 'badge' : 'flat']);
            return list;
        }
        if (actor.constructor === Clutter.Actor && actor.get_content()) {
            list.push([actor, file ? this._pictureMode(file) : 'glyph']);
            return list;
        }
        for (let child of actor.get_children())
            this._tintTargets(child, list, files, file);
        return list;
    }

    // The colour as three floats for the shaders' uniforms (a tiny offset
    // keeps whole numbers from being passed as integers).
    _tintColor() {
        let match = String(this.icon_color || '').match(/rgba?\(([^)]+)\)/);
        let rgb = match ? match[1].split(',').map(Number).slice(0, 3) : [255, 255, 255];
        return rgb.map(v => Math.max(0, Math.min(255, v || 0)) / 255 * 0.999999 + 1e-7);
    }

    // A theme icon drawn with its own colours: not a symbolic icon (those
    // are drawn in the text colour, opacity included).
    _fullColourIcon(actor) {
        if (!(actor instanceof St.Icon) || actor.get_icon_type() === St.IconType.SYMBOLIC)
            return false;
        let name = actor.icon_name;
        if (!name && actor.gicon) {
            try {
                name = actor.gicon.to_string();
            } catch (e) {
            }
        }
        return !/-symbolic(\.svg)?$/.test(String(name || ''));
    }

    // 1 for symbolic icons and texts; for a picture or a full-colour icon,
    // the opacity of the panel's
    // text colour (the theme draws symbolic icons and texts with it).
    _tintOpacity(actor) {
        if (actor instanceof St.Widget && !this._fullColourIcon(actor))
            return FULL;
        for (let parent = actor.get_parent(); parent; parent = parent.get_parent()) {
            if (parent instanceof St.Widget) {
                try {
                    let alpha = parent.get_theme_node().get_foreground_color().alpha;
                    return Math.max(1, alpha) / 255 * 0.999999 + 1e-7;
                } catch (e) {
                    return FULL;
                }
            }
        }
        return FULL;
    }

    // `reset`: the colour changed or the option was switched; `off`: removes
    // every effect (extension disabled). Applets add and replace icons at
    // any time, so the zone is checked again every two seconds while the
    // option is on.
    _tintIcons(reset, off = false) {
        let on = this.icon_tint && !off;
        this._customIcons(off);
        let color = this._tintColor();
        let files = on ? this._pictureFiles() : new Map();
        for (let panel of this._panels()) {
            if (!panel._rightBox)
                continue;
            for (let [actor, shape] of this._tintTargets(panel._rightBox, [], files)) {
                let mode = actor instanceof St.Widget && !this._fullColourIcon(actor) ? shape : shape + '-picture';
                let effect = actor.get_effect(TINT_EFFECT);
                if (effect && (!on || !(effect instanceof TINT_CLASSES[mode]))) {
                    actor.remove_effect(effect);
                    effect = null;
                }
                if (!on)
                    continue;
                let opacity = this._tintOpacity(actor);
                if (!effect) {
                    effect = new TINT_CLASSES[mode]();
                    effect.set_uniform_value('tex', 0);
                    actor.add_effect_with_name(TINT_EFFECT, effect);
                } else if (!reset && effect._floatingOpacity === opacity) {
                    continue;
                }
                effect.set_uniform_value('tr', color[0]);
                effect.set_uniform_value('tg', color[1]);
                effect.set_uniform_value('tb', color[2]);
                effect._floatingOpacity = opacity;
                effect.set_uniform_value('ta', effect._floatingOpacity);
                actor.queue_redraw();
            }
        }
        // Tray icons come and go (an app starts, the tray service restarts).
        let watch = on || (this.custom_icons && !off);
        if (watch && !this._tintTimeout) {
            this._tintTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._tintIcons(false);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!watch && this._tintTimeout) {
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
        this._itemIdsActive = false;
        if (this._tintIdle) {
            GLib.source_remove(this._tintIdle);
            this._tintIdle = 0;
        }
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
    extensionDir = Gio.File.new_for_path(metadata.path);
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
