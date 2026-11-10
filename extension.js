const { Clutter, St } = imports.gi;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const Settings = imports.ui.settings;

const UUID = 'floating-panel@fellixtara';

// Inline style that takes the theme's own look off the panel, so only the
// pills show.
const BARE_PANEL = 'background-color: transparent; background-image: none; border-image: none; ' +
    'border-width: 0; box-shadow: none; border-radius: 0;';
const ZONES = ['left', 'center', 'right'];

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

    _pillStyle() {
        let color = String(this.background || 'rgb(30,30,36)');
        let match = color.match(/rgba?\(([^)]+)\)/);
        let [r, g, b, a] = match ? match[1].split(',').map(Number) : [30, 30, 36, 1];
        if (isNaN(a))
            a = 1;
        let alpha = a * (1 - Math.max(0, Math.min(100, Number(this.transparency) || 0)) / 100);
        return 'background-color: rgba(' + [r, g, b, alpha.toFixed(3)].join(', ') + '); border-radius: ' +
            Math.round((Number(this.radius) || 0) * global.ui_scale) + 'px;';
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
