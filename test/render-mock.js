// Renders the mock Figma node tree back to DOM so imports can be compared
// visually with the source page. Derives CSS from *Figma* properties only
// (e.g. inverts gradientTransform) to validate the conversion math.
(function () {
  const hex = (c, a) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a == null ? 1 : a})`;

  function gradientCss(p, w, h) {
    const stops = (pos) => p.gradientStops.map((s) => `${hex(s.color, s.color.a * (p.opacity == null ? 1 : p.opacity))} ${pos(s.position)}%`).join(', ');
    const T = p.gradientTransform;
    if (p.type === 'GRADIENT_LINEAR') {
      const gx = T[0][0] / w, gy = T[0][1] / h;
      const theta = Math.atan2(gx, -gy);
      const sAt = (x, y) => T[0][0] * (x / w) + T[0][1] * (y / h) + T[0][2];
      const corners = [sAt(0, 0), sAt(w, 0), sAt(0, h), sAt(w, h)];
      const lo = Math.min(...corners), hi = Math.max(...corners);
      return `linear-gradient(${(theta * 180) / Math.PI}deg, ${stops((pp) => ((pp - lo) / (hi - lo || 1)) * 100)})`;
    }
    const k = 1 / T[0][0];
    return `radial-gradient(${(k * w) / 2}px ${(k * h) / 2}px at 50% 50%, ${stops((pp) => pp * 100)})`;
  }

  function backgrounds(paints, w, h) {
    const layers = [];
    const sizes = [];
    for (const p of paints || []) {
      if (p.visible === false) continue;
      if (p.type === 'SOLID') {
        const c = hex(p.color, p.opacity == null ? 1 : p.opacity);
        layers.push(`linear-gradient(${c}, ${c})`); sizes.push('100% 100%');
      } else if (p.type.startsWith('GRADIENT')) {
        layers.push(gradientCss(p, w, h)); sizes.push('100% 100%');
      } else if (p.type === 'IMAGE') {
        const img = window.__mock.images.get(p.imageHash);
        layers.push(`url(data:${img.mime};base64,${img.b64})`);
        sizes.push(p.scaleMode === 'FIT' ? 'contain' : 'cover');
      }
    }
    // Figma: last paint on top. CSS: first layer on top.
    return { image: layers.reverse().join(', '), size: sizes.reverse().join(', ') };
  }

  function shadows(effects, isText) {
    return (effects || []).filter((e) => e.type.endsWith('SHADOW')).reverse().map((e) =>
      isText ? `${e.offset.x}px ${e.offset.y}px ${e.radius}px ${hex(e.color, e.color.a)}`
        : `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread || 0}px ${hex(e.color, e.color.a)}`
    ).join(', ');
  }

  function weightOf(style) {
    const st = style.toLowerCase();
    return /thin/.test(st) ? 100 : /extra ?light/.test(st) ? 200 : /semi ?bold/.test(st) ? 600 : /extra ?bold/.test(st) ? 800 : /black/.test(st) ? 900 : /light/.test(st) ? 300 : /medium/.test(st) ? 500 : /bold/.test(st) ? 700 : 400;
  }

  const isAuto = (n) => n && n.layoutMode && n.layoutMode !== 'NONE';
  const ALIGN = { MIN: 'flex-start', MAX: 'flex-end', CENTER: 'center', SPACE_BETWEEN: 'space-between', BASELINE: 'baseline' };

  function render(n, parent) {
    const el = document.createElement('div');
    el.dataset.figmaId = n.id;
    el.title = n.name;
    const s = el.style;
    const parentAuto = isAuto(parent) && n.layoutPositioning !== 'ABSOLUTE';
    s.boxSizing = 'border-box';
    if (parentAuto) {
      s.position = 'relative';
      s.flex = 'none';
      const horiz = parent.layoutMode === 'HORIZONTAL';
      const fill = (axis) => (axis === 'h' ? n.layoutSizingHorizontal : n.layoutSizingVertical) === 'FILL';
      const hug = (axis) => (axis === 'h' ? n.layoutSizingHorizontal : n.layoutSizingVertical) === 'HUG';
      if (fill('h')) { if (horiz) s.flex = '1 1 0'; else s.alignSelf = 'stretch'; } else if (!hug('h')) s.width = n.width + 'px';
      if (fill('v')) { if (!horiz) s.flex = '1 1 0'; else s.alignSelf = 'stretch'; } else if (!hug('v')) s.height = n.height + 'px';
      if (n.type === 'TEXT' && !fill('h') && n.textAutoResize === 'WIDTH_AND_HEIGHT') s.width = 'max-content';
      if (n.type === 'TEXT' && fill('h')) s.minWidth = '0';
      if (n.layoutGrow) s.flex = '1 1 0';
    } else {
      s.position = 'absolute';
      s.left = n.x + 'px';
      s.top = n.y + 'px';
      s.width = n.width + 'px';
      s.height = n.type === 'LINE' ? '0px' : n.height + 'px';
      if (n.type === 'TEXT' && n.textAutoResize === 'WIDTH_AND_HEIGHT') { s.width = 'max-content'; s.height = 'auto'; }
      if (n.type === 'TEXT' && n.textAutoResize === 'HEIGHT') s.height = 'auto';
    }
    if (!n.visible) s.display = 'none';
    if (n.opacity < 1) s.opacity = n.opacity;
    if (n.rotation) s.transform = `rotate(${-n.rotation}deg)`;

    if (n.type === 'TEXT') {
      const f = n.fontName;
      s.fontFamily = `"${f.family}", system-ui, sans-serif`;
      s.fontWeight = weightOf(f.style);
      s.fontStyle = /italic/i.test(f.style) ? 'italic' : 'normal';
      s.fontSize = n.fontSize + 'px';
      const lh = n.lineHeight;
      s.lineHeight = lh.unit === 'PIXELS' ? lh.value + 'px' : lh.unit === 'PERCENT' ? lh.value / 100 : '1.21';
      s.letterSpacing = n.letterSpacing.unit === 'PIXELS' ? n.letterSpacing.value + 'px' : n.letterSpacing.value / 100 + 'em';
      s.whiteSpace = n.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap';
      s.textAlign = n.textAlignHorizontal.toLowerCase().replace('justified', 'justify');
      s.textTransform = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[n.textCase] || 'none';
      s.textDecoration = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[n.textDecoration] || 'none';
      const fill = n.fills.find((p) => p.type === 'SOLID');
      s.color = fill ? hex(fill.color, fill.opacity == null ? 1 : fill.opacity) : 'transparent';
      if (n.textTruncation === 'ENDING') {
        s.overflow = 'hidden'; s.textOverflow = 'ellipsis'; s.whiteSpace = 'nowrap';
      } else if (n.textAlignVertical !== 'TOP' && n.textAutoResize === 'NONE') {
        s.display = 'flex'; s.flexDirection = 'column';
        s.justifyContent = n.textAlignVertical === 'CENTER' ? 'center' : 'flex-end';
      }
      if (n.textTruncation !== 'ENDING') s.overflow = 'visible';
      const ts = shadows(n.effects, true);
      if (ts) s.textShadow = ts;
      if (n._ranges && n._ranges.length) {
        const cuts = [...new Set([0, n.characters.length, ...n._ranges.flatMap((r) => [r.s, r.e])])].sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) {
          const span = document.createElement('span');
          span.textContent = n.characters.slice(cuts[i], cuts[i + 1]);
          for (const r of n._ranges) {
            if (r.s > cuts[i] || r.e < cuts[i + 1]) continue;
            if (r.fontName) { span.style.fontFamily = `"${r.fontName.family}", system-ui, sans-serif`; span.style.fontWeight = weightOf(r.fontName.style); span.style.fontStyle = /italic/i.test(r.fontName.style) ? 'italic' : 'normal'; }
            if (r.fontSize) span.style.fontSize = r.fontSize + 'px';
            if (r.fills) { const f = r.fills.find((p) => p.type === 'SOLID'); if (f) span.style.color = hex(f.color, f.opacity == null ? 1 : f.opacity); }
            if (r.textDecoration) span.style.textDecoration = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[r.textDecoration] || 'none';
            if (r.textCase) span.style.textTransform = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[r.textCase] || 'none';
            if (r.letterSpacing) span.style.letterSpacing = r.letterSpacing.value + 'px';
          }
          el.appendChild(span);
        }
      } else el.textContent = n.characters;
      parent && parent.__el.appendChild(el);
      return el;
    }

    if (n._svg) {
      el.innerHTML = n._svg;
      const svg = el.firstElementChild;
      svg.setAttribute('width', n.width); svg.setAttribute('height', n.height);
      svg.style.display = 'block';
    } else {
      const bg = backgrounds(n.fills, n.width, n.height);
      if (bg.image) { s.backgroundImage = bg.image; s.backgroundSize = bg.size; s.backgroundPosition = 'center'; s.backgroundRepeat = 'no-repeat'; }
    }

    if (n.type === 'LINE') {
      const st = n.strokes[0];
      if (st) s.borderTop = `${n.strokeWeight}px ${n.dashPattern && n.dashPattern.length ? 'dashed' : 'solid'} ${hex(st.color, st.opacity == null ? 1 : st.opacity)}`;
      if (!parentAuto) s.top = n.y - n.strokeWeight / 2 + 'px';
    } else if (n.strokes && n.strokes.length) {
      const st = n.strokes[0];
      const col = st.type === 'SOLID' ? hex(st.color, st.opacity == null ? 1 : st.opacity) : '#000';
      const style = n.dashPattern && n.dashPattern.length ? (n.dashPattern[0] <= (n.strokeWeight || 1) ? 'dotted' : 'dashed') : 'solid';
      if (n._sw && (n._sw.t !== n.strokeWeight || n._sw.r !== n.strokeWeight || n._sw.b !== n.strokeWeight || n._sw.l !== n.strokeWeight)) {
        s.borderTop = `${n._sw.t}px ${style} ${col}`; s.borderRight = `${n._sw.r}px ${style} ${col}`;
        s.borderBottom = `${n._sw.b}px ${style} ${col}`; s.borderLeft = `${n._sw.l}px ${style} ${col}`;
      } else s.border = `${n.strokeWeight}px ${style} ${col}`;
    }
    if (n.type === 'ELLIPSE') s.borderRadius = '50%';
    else if ('topLeftRadius' in n) s.borderRadius = `${n.topLeftRadius}px ${n.topRightRadius}px ${n.bottomRightRadius}px ${n.bottomLeftRadius}px`;
    const sh = shadows(n.effects, false);
    if (sh) s.boxShadow = sh;
    const lb = (n.effects || []).find((e) => e.type === 'LAYER_BLUR');
    if (lb) s.filter = `blur(${lb.radius}px)`;
    const bb = (n.effects || []).find((e) => e.type === 'BACKGROUND_BLUR');
    if (bb) s.backdropFilter = `blur(${bb.radius}px)`;
    if (n.clipsContent) s.overflow = 'hidden';

    if (isAuto(n)) {
      s.display = 'flex';
      s.flexDirection = n.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
      if (n.layoutWrap === 'WRAP') { s.flexWrap = 'wrap'; s.rowGap = n.counterAxisSpacing + 'px'; }
      s.columnGap = n.layoutMode === 'HORIZONTAL' ? n.itemSpacing + 'px' : '';
      s.rowGap = n.layoutMode === 'VERTICAL' ? n.itemSpacing + 'px' : s.rowGap;
      s.padding = `${n.paddingTop}px ${n.paddingRight}px ${n.paddingBottom}px ${n.paddingLeft}px`;
      s.justifyContent = ALIGN[n.primaryAxisAlignItems];
      s.alignItems = ALIGN[n.counterAxisAlignItems];
      if (n.layoutSizingHorizontal === 'HUG') s.width = parentAuto ? 'max-content' : 'max-content';
      if (n.layoutSizingVertical === 'HUG') s.height = 'auto';
    }
    n.__el = el;
    if (parent && parent.__el) parent.__el.appendChild(el);
    if (!n._svg) (n.children || []).forEach((c) => render(c, n));
    return el;
  }

  window.__renderMock = function (nodes, offsetX, offsetY) {
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    document.body.style.position = 'relative';
    let bottom = 0;
    for (const n of nodes) {
      bottom = Math.max(bottom, n.y - (offsetY || 0) + n.height);
      const el = render(n, null);
      el.style.left = n.x - (offsetX || 0) + 'px';
      el.style.top = n.y - (offsetY || 0) + 'px';
      document.body.appendChild(el);
    }
    document.body.style.height = bottom + 'px';
  };
})();
