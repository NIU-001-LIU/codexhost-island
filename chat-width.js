define({
  async activate(api) {
    // ========== 1. Shared layout and saved width ==========
    const minWidth = 480;
    const widthProperty = "--thread-content-max-width";
    const settings = await api.storage.get().catch(() => ({}));
    if (api.signal.aborted) return;

    let width = Number.isFinite(settings.width) && settings.width >= minWidth ? settings.width : null;
    let timeline;
    let backdrop;
    let surface;
    let drag;
    let frame;
    let save = Promise.resolve();

    const sheet = new CSSStyleSheet();
    sheet.replaceSync("[data-cx-codexhost-chat-width-timeline] {}");
    const layout = sheet.cssRules[0].style;
    const maxWidth = () => Math.max(minWidth, timeline.clientWidth - 32);
    const clamp = (value) => Math.min(maxWidth(), Math.max(minWidth, Math.round(value)));

    function update() {
      const value = timeline && width !== null ? `${clamp(width)}px` : "";
      if (layout.getPropertyValue(widthProperty) !== value) layout.setProperty(widthProperty, value);
      if (!timeline) return;
      const bounds = backdrop.getBoundingClientRect();
      const pane = surface.getBoundingClientRect();
      const track = timeline.getBoundingClientRect();
      const origin = pane.left + surface.clientLeft;
      const positions = [bounds.left + 7, bounds.right - 7];
      const maximum = maxWidth();
      const current = clamp(backdrop.offsetWidth);
      for (const [index, handle] of handles.entries()) {
        handle.style.left = `${positions[index] - origin}px`;
        handle.style.top = `${track.top - pane.top - surface.clientTop}px`;
        handle.style.height = `${track.height}px`;
        handle.hidden = maximum === minWidth;
        handle.toggleAttribute("data-dragging", Boolean(drag));
        handle.setAttribute("aria-valuemax", String(maximum));
        handle.setAttribute("aria-valuenow", String(current));
      }
    }

    function persist(patch) {
      const pending = save.then(async () => {
        if (api.signal.aborted) return;
        const current = await api.storage.get();
        if (!api.signal.aborted) return api.storage.set({ ...current, ...patch });
      });
      save = pending.catch((error) => console.warn("Codex UI Enhancements could not save settings", error));
      return pending;
    }

    // ========== 2. Drag handles ==========
    function positionLines(event) {
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
      for (const handle of handles) handle.style.setProperty("--cx-chat-width-pointer-y", `${y}px`);
    }

    const chinese = (document.documentElement.lang || navigator.language).startsWith("zh");
    const label = chinese ? "调整对话宽度" : "Resize conversation";
    const handles = ["left", "right"].map((edge) => {
      const direction = edge === "left" ? -1 : 1;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "cx-chat-width-handle";
      handle.title = chinese ? "拖动调整对话宽度，双击恢复默认" : "Drag to resize, double-click to reset";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", label);
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-valuemin", String(minWidth));

      handle.addEventListener("pointerenter", positionLines);
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        positionLines(event);
        drag = { id: event.pointerId, x: event.clientX, start: backdrop.offsetWidth, previous: width };
        update();
      });
      handle.addEventListener("pointermove", (event) => {
        positionLines(event);
        if (drag?.id !== event.pointerId || event.clientX === drag.x && width === drag.previous) return;
        width = clamp(drag.start + (event.clientX - drag.x) * direction * 2);
        update();
      });
      handle.addEventListener("pointerup", (event) => {
        if (drag?.id !== event.pointerId) return;
        if (width !== drag.previous) persist({ width });
        drag = undefined;
        update();
      });
      handle.addEventListener("lostpointercapture", (event) => {
        if (drag?.id !== event.pointerId) return;
        width = drag.previous;
        drag = undefined;
        update();
      });
      handle.addEventListener("dblclick", () => {
        width = null;
        update();
        persist({ width });
      });
      handle.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -32 : 32;
        width = event.key === "Home" ? null : clamp(backdrop.offsetWidth + delta * direction);
        update();
        persist({ width });
      });
      return handle;
    });

    // ========== 3. Follow the active view ==========
    function sync() {
      frame = undefined;
      const next = [...document.querySelectorAll("[data-thread-composer-backdrop]")].find((node) =>
        node.offsetWidth && node.closest("[data-app-shell-main-surface]") &&
        node.closest("[data-app-action-timeline-scroll]"));
      const nextSurface = next?.closest("[data-app-shell-main-surface]");
      if (next !== backdrop || (nextSurface && !nextSurface.contains(handles[0]))) {
        const nextTimeline = next?.closest("[data-app-action-timeline-scroll]");
        if (drag && nextTimeline !== timeline) {
          width = drag.previous;
          drag = undefined;
        }
        if (nextTimeline !== timeline) {
          if (timeline) api.dom.unmark(timeline, "timeline");
          timeline = nextTimeline;
          if (timeline) api.dom.mark(timeline, "timeline");
        }
        backdrop = next;
        surface = nextSurface;
        resize.disconnect();
        if (timeline) {
          resize.observe(timeline);
          resize.observe(backdrop);
          resize.observe(surface);
        }
        for (const handle of handles) {
          if (surface && handle.parentElement !== surface) api.dom.mount(handle, surface);
          if (!surface) handle.remove();
        }
      }
      update();
      syncAppearance();
    }

    function schedule() {
      if (frame === undefined) frame = requestAnimationFrame(sync);
    }

    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver((changes) => {
      if (appearanceMode === "macos" && changes.some((change) => change.attributeName === "data-theme")) {
        refreshFrostedColors();
      }
      schedule();
    });
    api.track(() => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet);
    });
    // ========== 4. Independent window and panel colors ==========
    const panels = [
      {
        key: "windowColor",
        label: { en: "Window background", "zh-CN": "窗口底色" },
        description: "Set the background behind the menu bar and navigation rail",
        selector: "[data-app-shell-frame]",
      },
      {
        key: "sidebarColor",
        label: { en: "Conversation list", "zh-CN": "左侧会话栏" },
        description: "Set the background behind conversations and projects",
        selector: "[data-sidebar-navigation-root] [data-slate-sidebar-content]",
      },
      {
        key: "conversationColor",
        label: { en: "Conversation", "zh-CN": "中间对话区" },
        description: "Set the background around messages and the composer",
        selector: "[data-app-shell-main-content-layout]",
      },
      {
        key: "rightPanelColor",
        label: { en: "Right panel", "zh-CN": "右侧面板" },
        description: "Set the background of the tabs on the right",
        selector: "[data-app-shell-tabs]",
      },
    ].map((panel) => {
      const index = sheet.insertRule(`${panel.selector} {}`, sheet.cssRules.length);
      return { ...panel, style: sheet.cssRules[index].style };
    });
    const windowNavigation = sheet.insertRule(`
      [data-app-shell-frame] > :has(> [role="menubar"]),
      [data-app-shell-frame] [data-app-navigation-rail] {}
    `, sheet.cssRules.length);
    const windowNavigationStyle = sheet.cssRules[windowNavigation].style;
    const systemTheme = matchMedia("(prefers-color-scheme: dark)");
    const titlebar = navigator.windowControlsOverlay;
    const normalizeColor = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value.toLowerCase()
      : null;
    let panelSettings = settings;
    let appearanceMode;

    const hexChannels = (color) => color.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255);

    function luminance(color) {
      const [red, green, blue] = hexChannels(color).map((channel) =>
        channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return .2126 * red + .7152 * green + .0722 * blue;
    }

    function nativeScheme() {
      const scheme = document.documentElement.dataset.theme;
      if (scheme === "light" || scheme === "dark") return scheme;
      return systemTheme.matches ? "dark" : "light";
    }

    function panelColorKey(key) {
      return appearanceMode === "macos" ? `macos.${nativeScheme()}.${key}` : key;
    }

    function panelColor(values, key) {
      const storedKey = panelColorKey(key);
      if (storedKey === key || Object.hasOwn(values, storedKey)) return normalizeColor(values[storedKey]);
      const legacy = normalizeColor(values[key]);
      if (!legacy) return null;
      // Saved colors from before this theme had separate palettes follow their original brightness.
      const legacyScheme = luminance(legacy) < .18 ? "dark" : "light";
      return legacyScheme === nativeScheme() ? legacy : null;
    }

    const readableText = (color) => `
      --color-text-primary: contrast-color(${color});
      --color-text-secondary: color-mix(in srgb, var(--color-text-primary) 90%, transparent);
      --color-text-tertiary: var(--color-text-secondary);
      --color-text-secondary-ghost: var(--color-text-tertiary);
      color: var(--color-text-primary);
    `;

    function applyPanelColors(values) {
      panelSettings = values;
      const mode = values.macosMode === true ? "macos" : undefined;
      if (mode !== appearanceMode) {
        if (appearanceMode) api.dom.unmark(document.documentElement, appearanceMode);
        appearanceMode = mode;
        if (mode) api.dom.mark(document.documentElement, mode);
      }
      themeChoice.setAttribute("aria-checked", String(mode === "macos"));
      const windowColor = panelColor(values, "windowColor");
      const windowFill = mode
        ? (windowColor ? `oklch(from ${windowColor} l 0 0)` : "var(--cx-macos-window)")
        : windowColor;
      let keepControlBackdrop = false;
      if (windowColor && titlebar?.visible) {
        const background = luminance(windowColor);
        const symbol = luminance(systemTheme.matches ? "#ffffff" : "#1f1f1f");
        keepControlBackdrop = (Math.max(background, symbol) + .05) / (Math.min(background, symbol) + .05) < 3;
      }
      const navigationColor = keepControlBackdrop || mode ? "transparent" : windowColor;
      windowNavigationStyle.cssText = windowColor ? `background-color: ${navigationColor}; ${readableText(windowFill)}` : "";
      for (const { key, style } of panels) {
        const color = panelColor(values, key);
        if (key !== "windowColor") {
          const readableColor = mode ? `var(--cx-macos-material, ${color})` : color;
          const fill = mode ? `--cx-macos-${key}: ${color};` : `
            background-color: ${color};
            --app-shell-panel-background: ${color};
          `;
          style.cssText = color ? `
            ${fill}
            --color-surface: ${color};
            ${readableText(readableColor)}
          ` : "";
          continue;
        }
        // The native caption buttons keep their system-colored symbols.
        if (keepControlBackdrop) {
          const fill = `linear-gradient(${windowFill}, ${windowFill})`;
          style.cssText = `
            background-color: transparent;
            ${mode ? "--cx-island-frame-image" : "background-image"}: ${fill}, ${fill};
            background-repeat: no-repeat;
            background-position: env(titlebar-area-x, 0px) top, left bottom;
            background-size: env(titlebar-area-width, 100%) env(titlebar-area-height, 0px),
              100% calc(100% - env(titlebar-area-height, 0px));
          `;
          continue;
        }
        style.cssText = windowFill ? `background-color: ${windowFill};` : "";
      }
    }

    // ========== 5. Color palette ==========
    const local = (zh, en) => chinese ? zh : en;
    const clampUnit = (value) => Math.min(1, Math.max(0, value));

    function hexToHsv(hex) {
      const [red, green, blue] = hexChannels(hex);
      const max = Math.max(red, green, blue);
      const range = max - Math.min(red, green, blue);
      let hue = 0;
      if (range) {
        if (max === red) hue = (green - blue) / range;
        else if (max === green) hue = 2 + (blue - red) / range;
        else hue = 4 + (red - green) / range;
      }
      return [(hue * 60 + 360) % 360, max ? range / max : 0, max];
    }

    function hsvToHex([hue, saturation, value]) {
      const chroma = value * saturation;
      const sector = hue / 60;
      const second = chroma * (1 - Math.abs(sector % 2 - 1));
      const channels = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second],
        [0, second, chroma], [second, 0, chroma], [chroma, 0, second]][Math.floor(sector) % 6];
      return `#${channels.map((channel) => Math.round((channel + value - chroma) * 255)
        .toString(16).padStart(2, "0")).join("")}`;
    }

    function createPalette(trigger, preview, commit) {
      const popup = document.createElement("div");
      popup.className = "cx-color-palette";
      popup.popover = "auto";
      popup.setAttribute("role", "group");
      popup.setAttribute("aria-label", local("选色", "Color picker"));
      trigger.popoverTargetElement = popup;
      let hsv = [0, 0, 0];
      let drag;

      function paint() {
        const [hue, saturation, value] = hsv;
        const color = hsvToHex(hsv);
        popup.style.setProperty("--cx-palette-hue", `hsl(${hue} 100% 50%)`);
        popup.style.setProperty("--cx-palette-color", color);
        popup.style.setProperty("--cx-palette-x", `${saturation * 100}%`);
        popup.style.setProperty("--cx-palette-y", `${(1 - value) * 100}%`);
        popup.style.setProperty("--cx-palette-hue-x", `${hue / 3.6}%`);
        const level = Math.round(saturation * 100);
        const light = Math.round(value * 100);
        area.setAttribute("aria-valuenow", String(level));
        area.setAttribute("aria-valuetext", local(`饱和度 ${level}%，亮度 ${light}%`, `Saturation ${level}%, brightness ${light}%`));
        strip.setAttribute("aria-valuenow", String(Math.round(hue)));
        return color;
      }

      function cancel(event) {
        if (!drag || (event.pointerId !== undefined && drag.id !== event.pointerId)) return;
        hsv = drag.previous;
        drag = undefined;
        preview(paint());
      }

      function control(className, label, maximum, move, step) {
        const element = document.createElement("div");
        element.className = className;
        element.tabIndex = 0;
        element.setAttribute("role", "slider");
        element.setAttribute("aria-label", label);
        element.setAttribute("aria-valuemin", "0");
        element.setAttribute("aria-valuemax", String(maximum));

        function track(event) {
          const rect = element.getBoundingClientRect();
          const x = clampUnit((event.clientX - rect.left) / rect.width);
          const y = clampUnit((event.clientY - rect.top) / element.clientHeight);
          move(x, y);
          const color = paint();
          preview(color);
          return color;
        }

        element.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || trigger.disabled || drag) return;
          drag = { id: event.pointerId, previous: [...hsv] };
          element.setPointerCapture(event.pointerId);
          track(event);
        });
        element.addEventListener("pointermove", (event) => {
          if (drag?.id === event.pointerId) track(event);
        });
        element.addEventListener("pointerup", (event) => {
          if (drag?.id !== event.pointerId) return;
          const color = track(event);
          const previous = hsvToHex(drag.previous);
          drag = undefined;
          if (previous !== color) commit(color);
        });
        element.addEventListener("lostpointercapture", cancel);
        element.addEventListener("keydown", (event) => {
          const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
          if (!direction || trigger.disabled || drag) return;
          event.preventDefault();
          event.stopPropagation();
          const previous = hsvToHex(hsv);
          step(...direction);
          const color = paint();
          preview(color);
          if (previous !== color) commit(color);
        });
        return element;
      }

      const area = control("cx-color-palette__area", local("饱和度和亮度", "Saturation and brightness"), 100,
        (saturation, y) => { hsv[1] = saturation; hsv[2] = 1 - y; },
        (x, y) => { hsv[1] = clampUnit(hsv[1] + x * .05); hsv[2] = clampUnit(hsv[2] + y * .05); });
      const strip = control("cx-color-palette__hue", local("色相", "Hue"), 360,
        (x) => { hsv[0] = x * 360; },
        (x, y) => { hsv[0] = Math.min(360, Math.max(0, hsv[0] + (x + y) * 5)); });
      popup.append(area, strip);
      popup.addEventListener("beforetoggle", (event) => { if (event.newState === "closed") cancel(event); });

      return {
        popup,
        setColor(color) {
          if (hsvToHex(hsv) !== color) hsv = hexToHsv(color);
          paint();
        },
        isDragging: () => Boolean(drag),
      };
    }

    // ========== 6. Native Appearance settings ==========
    function createAppearanceRow(key, name, description, control) {
      const row = document.createElement("div");
      const labelArea = document.createElement("div");
      const labelText = document.createElement("div");
      const caption = document.createElement("label");
      caption.textContent = name;
      const help = document.createElement("div");
      help.id = `cx-ui-${key}-description`;
      help.textContent = description;
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      labelText.append(caption, help, status);
      labelArea.append(labelText);
      control.id = `cx-ui-${key}`;
      control.setAttribute("aria-describedby", help.id);
      caption.htmlFor = control.id;
      const controls = document.createElement("div");
      row.append(labelArea, controls);

      function matchRow(reference) {
        const [nativeLabel, nativeControls] = reference.children;
        const nativeText = nativeLabel?.firstElementChild;
        row.className = `cx-panel-colors__row ${reference.className}`;
        labelArea.className = nativeLabel?.className ?? "";
        labelText.className = nativeText?.className ?? "";
        caption.className = nativeText?.firstElementChild?.className ?? "";
        help.className = status.className = nativeText?.children[1]?.className ?? "";
        controls.className = nativeControls?.className ?? "";
        return nativeControls;
      }

      return { row, controls, status, help, matchRow };
    }

    const language = chinese ? "zh-CN" : "en";
    const fields = panels.map(({ key, label, description }) => {
      const name = label[language];
      const picker = document.createElement("button");
      picker.type = "button";
      picker.className = "cx-panel-colors__trigger";
      const { row, controls, status, help, matchRow } = createAppearanceRow(key, name, description, picker);
      const swatch = document.createElement("span");
      swatch.className = "cx-panel-colors__swatch";
      swatch.setAttribute("aria-hidden", "true");

      const hex = document.createElement("input");
      hex.type = "text";
      hex.maxLength = 7;
      hex.spellcheck = false;
      if (key === "windowColor") hex.placeholder = local("默认", "Default");
      hex.setAttribute("aria-label", local(`${name}的十六进制颜色`, `${name} hex color`));
      hex.setAttribute("aria-describedby", help.id);
      const colorField = document.createElement("div");
      colorField.className = "cx-panel-colors__field";
      const palette = createPalette(picker, showColor, updateColor);
      colorField.append(picker, swatch, hex, palette.popup);

      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "cx-panel-colors__reset";
      reset.textContent = local("恢复默认", "Reset to default");
      reset.setAttribute("aria-label", local(`恢复${name}的默认颜色`, `Reset ${name} color`));
      let saving = false;

      function showColor(color) {
        picker.value = hex.value = color;
        swatch.style.backgroundColor = color;
      }

      function refresh() {
        if (saving || palette.isDragging()) return;
        const color = panelColor(panelSettings, key);
        const theme = getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim();
        showColor(color ?? normalizeColor(theme) ?? "#808080");
        palette.setColor(picker.value);
        if (key === "windowColor" && color === null) hex.value = "";
        picker.disabled = hex.disabled = reset.disabled = false;
        reset.hidden = color === null;
      }

      async function updateColor(color) {
        saving = picker.disabled = hex.disabled = reset.disabled = true;
        status.textContent = "";
        try {
          const values = await persist({ [panelColorKey(key)]: color });
          if (values && !api.signal.aborted) applyPanelColors(values);
        } catch {
          status.textContent = local("颜色保存失败，请重试。", "Could not save the color. Try again.");
        } finally {
          saving = false;
          refresh();
        }
      }

      hex.addEventListener("change", () => {
        const color = normalizeColor(`#${hex.value.trim().replace(/^#/, "")}`);
        if (color && color !== panelColor(panelSettings, key)) {
          updateColor(color);
        } else {
          refresh();
          status.textContent = color ? "" : local("请输入六位十六进制颜色。", "Enter a six-digit hex color.");
        }
      });
      hex.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        hex.blur();
      });
      reset.addEventListener("click", () => updateColor(null));
      controls.append(reset, colorField);

      function matchLayout(reference) {
        const nativeControls = matchRow(reference);
        colorField.className = `cx-panel-colors__field ${nativeControls?.firstElementChild?.className ?? ""}`;
        hex.className = nativeControls?.querySelector("input")?.className ?? "";
      }

      return { row, refresh, matchLayout };
    });

    // ========== 7. Custom themes in the native theme picker ==========
    async function selectIsland(enabled) {
      const values = await persist({ macosMode: enabled });
      if (values && !api.signal.aborted) applyPanelColors(values);
    }

    const themeName = "island 毛玻璃";
    const themeChoice = document.createElement("button");
    const themeDisplay = document.createElement("span");
    themeDisplay.textContent = themeName;
    const customThemes = document.createElement("div");
    customThemes.setAttribute("role", "none");
    const themeGroup = document.createElement("button");
    const themePopup = document.createElement("div");
    const themeStatus = document.createElement("div");
    themeStatus.className = "cx-theme-status";
    themeStatus.setAttribute("role", "status");
    themeGroup.id = "cx-custom-themes";
    themeGroup.setAttribute("aria-haspopup", "menu");
    themeGroup.setAttribute("aria-controls", "cx-custom-theme-menu");
    themeGroup.setAttribute("aria-expanded", "false");
    themePopup.id = "cx-custom-theme-menu";
    themePopup.setAttribute("popover", "manual");
    themePopup.setAttribute("role", "menu");
    themePopup.setAttribute("aria-labelledby", themeGroup.id);
    themeGroup.className = "cx-theme-option cx-theme-group";
    for (const [button, role, label, adornment] of [
      [themeGroup, "menuitem", local("自定义主题", "Custom themes"), "›"],
      [themeChoice, "menuitemradio", themeName, "✓"],
    ]) {
      button.type = "button";
      button.tabIndex = -1;
      button.setAttribute("role", role);
      const badge = document.createElement("span");
      const text = document.createElement("span");
      const trailing = document.createElement("span");
      badge.className = "cx-theme-badge";
      badge.textContent = "Aa";
      badge.setAttribute("aria-hidden", "true");
      text.textContent = label;
      trailing.className = "cx-theme-trailing";
      trailing.textContent = adornment;
      trailing.setAttribute("aria-hidden", "true");
      button.append(badge, text, trailing);
    }
    themePopup.append(themeChoice, themeStatus);
    customThemes.append(themeGroup, themePopup);

    let themeMenu;
    let nativeThemeLabel;
    let selectingTheme = false;
    const markedThemeMenus = new Set();
    const visibleMenuItems = (menu) => [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
      .filter((item) => item.closest('[role="menu"]') === menu && item !== themeGroup &&
        item.getAttribute("aria-disabled") !== "true" && item.getClientRects().length);
    const inThemeMenu = (menu) => menu && themeMenu && (menu === themeMenu ||
      themeMenu.contains(document.getElementById(menu.getAttribute("aria-labelledby") ?? "")));
    const sendMenuKey = (menu, key) => menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    function closeCustomThemes() {
      if (themePopup.matches(":popover-open")) themePopup.hidePopover();
      themeGroup.setAttribute("aria-expanded", "false");
    }

    function openCustomThemes(focusChoice) {
      for (const menu of markedThemeMenus) {
        if (menu !== themeMenu && menu.isConnected) {
          sendMenuKey(menu, themeMenu.dir === "rtl" ? "ArrowRight" : "ArrowLeft");
        }
      }
      if (!themePopup.matches(":popover-open")) themePopup.showPopover();
      themeGroup.setAttribute("aria-expanded", "true");
      (focusChoice ? themeChoice : themeGroup).focus({ preventScroll: true });
    }
    themeGroup.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") openCustomThemes(false);
    });
    themeGroup.addEventListener("click", () => openCustomThemes(true));
    themeChoice.addEventListener("click", async () => {
      if (selectingTheme) return;
      selectingTheme = true;
      themeStatus.textContent = "";
      try {
        if (appearanceMode !== "macos") await selectIsland(true);
        closeCustomThemes();
        if (themeMenu?.isConnected) sendMenuKey(themeMenu, "Escape");
      } catch {
        themeStatus.textContent = local("主题保存失败，请重试。", "Could not save the theme. Try again.");
      } finally {
        selectingTheme = false;
      }
    });

    document.addEventListener("pointerover", (event) => {
      if (!themeMenu?.contains(event.target) || customThemes.contains(event.target)) return;
      if (event.target.closest('[role="menuitem"], [role="menuitemradio"]')) closeCustomThemes();
    }, { signal: api.signal });
    document.addEventListener("menu.itemSelect", (event) => {
      if ((appearanceMode || selectingTheme) && event.target.matches('[role="menuitemradio"]') &&
          !themePopup.contains(event.target) && inThemeMenu(event.target.closest('[role="menu"]'))) {
        selectIsland(false).catch((error) => console.warn("Could not switch appearance theme", error));
      }
    }, { capture: true, signal: api.signal });
    document.addEventListener("keydown", (event) => {
      if (!themeMenu?.contains(event.target)) return;
      const items = visibleMenuItems(themeMenu);
      const item = event.target.closest('[role="menuitem"], [role="menuitemradio"]');
      const openKey = themeMenu.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
      const closeKey = openKey === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
      let next;
      if (item === themeGroup) {
        if (event.key === openKey || event.key === "Enter" || event.key === " ") next = () => openCustomThemes(true);
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          next = () => {
            closeCustomThemes();
            (event.key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
          };
        }
      } else if (themePopup.contains(event.target)) {
        if (event.key === closeKey || event.key === "Escape") {
          next = () => { closeCustomThemes(); themeGroup.focus(); };
        }
        if (event.key === "Enter" || event.key === " ") next = () => item?.click();
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) next = () => themeChoice.focus();
      } else if (item?.closest('[role="menu"]') === themeMenu &&
                 ((item === items.at(-1) && event.key === "ArrowDown") || event.key === "End")) {
        next = () => themeGroup.focus();
      }
      if (next) {
        event.preventDefault();
        event.stopImmediatePropagation();
        next();
      }
    }, { capture: true, signal: api.signal });

    function syncThemeChooser(visible) {
      const trigger = visible ? document.querySelector('[data-settings-search-entry="appearance-theme"] button[aria-haspopup="menu"]') : null;
      const label = trigger?.querySelector(".truncate") ?? null;
      if (label !== nativeThemeLabel) {
        if (nativeThemeLabel) api.dom.unmark(nativeThemeLabel, "native-theme-label");
        themeDisplay.remove();
        nativeThemeLabel = label;
        if (label) {
          themeDisplay.className = `cx-theme-display ${label.className}`;
          api.dom.mark(label, "native-theme-label");
          api.dom.mount(themeDisplay, label, "after");
        }
      }
      const menu = trigger && document.getElementById(trigger.getAttribute("aria-controls") ?? "");
      if (menu !== themeMenu) {
        closeCustomThemes();
        customThemes.remove();
        themeMenu = menu;
      }
      if (themeMenu && !customThemes.isConnected) {
        const codexGroup = visibleMenuItems(themeMenu).find((item) => item.getAttribute("aria-haspopup") === "menu");
        if (!codexGroup) return;
        themeGroup.className = `${codexGroup.className} cx-theme-option cx-theme-group`;
        const radio = visibleMenuItems(themeMenu).find((item) => item.getAttribute("role") === "menuitemradio");
        const { fontSize, lineHeight } = getComputedStyle(radio?.querySelector(".truncate") ?? radio ?? codexGroup);
        for (const button of [themeGroup, themeChoice]) {
          button.style.fontSize = fontSize;
          button.style.lineHeight = lineHeight;
        }
        themeChoice.className = `${radio?.className ?? ""} cx-theme-option cx-theme-choice`;
        themePopup.className = `${themeMenu.className} cx-theme-popup`;
        api.dom.mount(customThemes, codexGroup, "after");
      }
      for (const menu of markedThemeMenus) {
        if (!menu.isConnected || !inThemeMenu(menu)) {
          api.dom.unmark(menu, "native-theme-menu");
          markedThemeMenus.delete(menu);
        }
      }
      if (themeMenu) {
        for (const menu of document.querySelectorAll('[data-radix-menu-content][role="menu"]')) {
          if (menu !== themePopup && inThemeMenu(menu) && !markedThemeMenus.has(menu)) {
            api.dom.mark(menu, "native-theme-menu");
            markedThemeMenus.add(menu);
          }
        }
      }
    }

    function syncAppearance() {
      const foreground = [...document.querySelectorAll('[data-settings-panel] [data-settings-search-entry="appearance-foreground-color"]')]
        .find((row) => row.getClientRects().length);
      syncThemeChooser(Boolean(foreground));
      if (!foreground) {
        for (const { row } of fields) row.remove();
        return;
      }
      const rowHeight = `${foreground.offsetHeight}px`;
      let anchor = foreground;
      for (const { row, refresh, matchLayout } of fields) {
        if (row.previousElementSibling !== anchor) {
          matchLayout(foreground);
          api.dom.mount(row, anchor, "after");
          refresh();
        }
        if (row.style.minBlockSize !== rowHeight) row.style.minBlockSize = rowHeight;
        anchor = row;
      }
    }

    applyPanelColors(settings);
    const refreshWindow = () => applyPanelColors(panelSettings);
    function refreshFrostedColors() {
      refreshWindow();
      if (appearanceMode === "macos") {
        for (const { row, refresh } of fields) if (row.isConnected) refresh();
      }
    }
    systemTheme.addEventListener("change", refreshFrostedColors, { signal: api.signal });
    titlebar?.addEventListener("geometrychange", refreshWindow, { signal: api.signal });
    api.storage.onChange((values) => {
      applyPanelColors(values);
      for (const { row, refresh } of fields) if (row.isConnected) refresh();
    });
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-settings-search-entry"],
    });
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    sync();
  },
});
