/* Pizza docs playground — in-browser search over the teaching dataset.
 *
 * Loads the wasm engine (website/static/wasm, built by `make wasm`) and the
 * teaching-dataset segments (website/static/datasets, exported by
 * `make dataset-fire`). Everything degrades gracefully: without the wasm
 * bundle or dataset segments the widget stays visible with an explanation,
 * and the page falls back to plain curl examples.
 *
 * Vanilla ES module, no dependencies. Wires two surfaces:
 *  - div.pizza-playground[data-dataset][data-dsl] blocks (the {{< playground >}}
 *    shortcode) — inline "run this example" buttons.
 *  - the #pizza-playground-app element on /docs/playground/ — full app.
 */
(function () {
  'use strict';

  // Resolve the site root from this module's own URL (/playground/app.js ->
  // site root one level up). A valid window.PIZZA_PG_BASE (set by the
  // shortcode) wins when present; template garbage or absence falls back to
  // self-resolution, so raw-HTML pages work without any inline script.
  var BASE = (function () {
    var raw = String(window.PIZZA_PG_BASE || '');
    if (raw && raw.indexOf('{') === -1) return raw.replace(/\/+$/, '');
    try { return new URL('../', import.meta.url).href.replace(/\/+$/, ''); }
    catch (e) { return ''; }
  })();
  var WASM_PATH = BASE + '/wasm/pizza_engine.js';
  var DATASETS = BASE + '/datasets/v1/';

  // Segment files are content-addressed — the file name IS its content
  // hash — so a fetched segment never changes. The host sends a short
  // HTTP cache window (GitHub Pages: max-age=600), which made every
  // visit re-download each dataset; Cache Storage keeps the immutable
  // segments across visits instead. The catalog/schema JSONs stay on the
  // HTTP cache: they are tiny and DO change between exports.
  var segmentCache = null;
  function fetchSegment(url) {
    if (typeof caches === 'undefined') return fetch(url);
    if (!segmentCache) segmentCache = caches.open('pizza-segments-v1');
    return segmentCache.then(function (cache) {
      return cache.match(url).then(function (hit) {
        if (hit) return hit;
        return fetch(url).then(function (res) {
          if (res.ok) cache.put(url, res.clone());
          return res;
        });
      });
    });
  }

  var engineModule = null;   // wasm-pack module (init + PizzaEngine)
  var catalog = null;        // dataset index.json
  var engines = {};          // collection name -> {engine, docs}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // "Powered by Pizza WebAssembly" footer badge with the brand slice
  // mark (icon.svg, extracted from the site logo, cached across every
  // widget on the site). Inline widgets link to the full playground
  // page; the playground app itself renders it unlinked.
  function makeBadge(linked) {
    var b = el(linked ? 'a' : 'span', 'pg-power');
    if (linked) b.href = BASE + '/docs/playground/';
    var img = el('img');
    img.src = BASE + '/playground/icon.svg';
    img.alt = '';
    img.width = 13;
    img.height = 14;
    b.appendChild(img);
    b.appendChild(el('span', null, 'Powered by Pizza WebAssembly'));
    return b;
  }

  function setStatus(box, msg, isError) {
    if (!box) return;
    box.textContent = msg;
    box.className = 'pg-status' + (isError ? ' pg-error' : '');
  }

  // ── JSON highlighting (editor overlay + result tree) ──────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // One pass over the raw text: string-followed-by-':' is a key, then
  // plain strings, numbers, literals. Untouched gaps are escaped as-is.
  var TOK_RE = /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;

  function highlightJson(src) {
    var out = '', last = 0, m;
    TOK_RE.lastIndex = 0;
    while ((m = TOK_RE.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1] !== undefined) {
        out += '<span class="pg-tok-key">' + esc(m[1]) + '</span>' + esc(m[0].slice(m[1].length));
      } else {
        var cls = m[0].charAt(0) === '"' ? 'str'
          : m[0] === 'true' || m[0] === 'false' ? 'bool'
          : m[0] === 'null' ? 'null' : 'num';
        out += '<span class="pg-tok-' + cls + '">' + esc(m[0]) + '</span>';
      }
      last = TOK_RE.lastIndex;
    }
    return out + esc(src.slice(last));
  }

  // ── Small toolbar icons (inline SVG, no assets) ───────────────────
  var SVG = {
    copy: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>',
    bug: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="6" width="5" height="8" rx="2.5"/><path d="M8 6V4.5"/><path d="M6.5 3.5L5.3 2.3M9.5 3.5l1.2-1.2"/><path d="M5.5 8.5H3M5.5 11H3M10.5 8.5H13M10.5 11H13"/><path d="M8 8.5v4"/></svg>',
    braces: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5C4.5 2.5 4.5 4 4.5 5s0 2.5-1.5 2.5c1.5 0 1.5 1.5 1.5 2.5s0 2.5 1.5 2.5"/><path d="M10 2.5c1.5 0 1.5 1.5 1.5 2.5s0 2.5 1.5 2.5c-1.5 0-1.5 1.5-1.5 2.5s0 2.5-1.5 2.5"/></svg>',
    fold: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5l4-4 4 4"/><path d="M4 14l4-4 4 4"/></svg>',
    unfold: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l4 4 4-4"/><path d="M4 2l4 4 4-4"/></svg>',
    table: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6.5h13M6 6.5v7"/></svg>',
    code: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4"/></svg>'
  };

  function toolBtn(cls, title, icon) {
    var b = el('button', 'pg-tool ' + cls);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    return b;
  }

  function copyToClipboard(text, btn) {
    var done = function () {
      if (!btn) return;
      var prev = btn.innerHTML;
      btn.classList.add('pg-done');
      btn.innerHTML = SVG.check;
      setTimeout(function () { btn.classList.remove('pg-done'); btn.innerHTML = prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* no-op */ }
      document.body.removeChild(ta);
      done();
    }
  }

  // ── Foldable JSON tree for the result panel ───────────────────────
  function tokSpan(v) {
    var cls = typeof v === 'string' ? 'str'
      : typeof v === 'number' ? 'num'
      : typeof v === 'boolean' ? 'bool' : 'null';
    // wasm-bindgen maps engine `None` to an EXPLICIT undefined property
    // value (JSON.stringify drops the key, but Object.keys still lists
    // it) — render those as JSON null instead of crashing esc().
    var text = v === undefined ? 'null' : JSON.stringify(v);
    return '<span class="pg-tok-' + cls + '">' + esc(text) + '</span>';
  }

  // An invisible 14px stand-in for the fold caret: container heads lead
  // with a real ▾, and lines without one reserve the same slot so every
  // field name — foldable or not — starts on the same column.
  function caretSlot() {
    return '<span class="pg-jcaret pg-jcaret-slot"></span>';
  }

  function jsonNode(key, value, plainKey) {
    // plainKey: array indices render unquoted (devtools style `0: {`)
    var keyHtml = key === null ? ''
      : plainKey
        ? '<span class="pg-tok-punct">' + esc(key) + '</span><span class="pg-tok-punct">: </span>'
        : '<span class="pg-tok-key">' + esc(JSON.stringify(key)) + '</span><span class="pg-tok-punct">: </span>';
    if (value === null || typeof value !== 'object') {
      var leaf = el('div', 'pg-jline');
      // Blank caret slot: container heads lead with a 14px ▾, so without
      // the same reserved slot here a leaf's key starts 14px left of its
      // sibling containers' keys.
      leaf.innerHTML = caretSlot() + keyHtml + tokSpan(value);
      return leaf;
    }
    var open = Array.isArray(value) ? '[' : '{';
    var close = Array.isArray(value) ? ']' : '}';
    var entries = Array.isArray(value)
      ? value.map(function (v, i) { return [String(i), v, true]; })
      : Object.keys(value).map(function (k) { return [k, value[k], false]; });
    if (!entries.length) {
      var empty = el('div', 'pg-jline');
      empty.innerHTML = caretSlot() + keyHtml + '<span class="pg-tok-punct">' + open + close + '</span>';
      return empty;
    }
    var node = el('div', 'pg-jnode');
    var head = el('div', 'pg-jline pg-jhead');
    var caret = el('span', 'pg-jcaret', '▾');
    caret.addEventListener('click', function () { node.classList.toggle('pg-folded'); });
    head.appendChild(caret);
    var headTxt = el('span');
    // The closing brace lives INSIDE the fold placeholder: unfolded the
    // head ends at the open brace (the tail line closes it), folded it
    // reads "{ … N }". A permanently-visible close here made every level
    // look prematurely terminated.
    headTxt.innerHTML = keyHtml
      + '<span class="pg-tok-punct">' + open + '</span>'
      + '<span class="pg-jell">' + esc('… ' + entries.length + ' ') + close + '</span>';
    head.appendChild(headTxt);
    node.appendChild(head);
    var kids = el('div', 'pg-jkids');
    entries.forEach(function (pair) { kids.appendChild(jsonNode(pair[0], pair[1], pair[2])); });
    node.appendChild(kids);
    var tail = el('div', 'pg-jline pg-jtail');
    tail.innerHTML = '<span class="pg-tok-punct">' + close + '</span>';
    node.appendChild(tail);
    return node;
  }

  function renderResult(panel, out) {
    panel.pgOut = out;
    drawResult(panel);
  }

  // Draw (and re-draw after a debug toggle) the result tree. Debug mode
  // keeps `parsed_query` — the engine's parsed-plan string, now including
  // aggs/sort/filters — visible; it is hidden otherwise, matching the
  // real gateway which strips it from responses.
  function drawResult(panel) {
    var out = panel.pgOut;
    var debug = !!panel.pgDebug;
    var view = out;
    if (!debug && out && typeof out === 'object' && 'parsed_query' in out) {
      view = {};
      Object.keys(out).forEach(function (k) {
        if (k !== 'parsed_query') view[k] = out[k];
      });
    }
    var raw = JSON.stringify(view, null, 2);
    panel.textContent = '';
    var tools = el('div', 'pg-tools');
    var dbgB = toolBtn('pg-t-debug', 'Debug: show parsed_query', SVG.bug);
    if (debug) dbgB.classList.add('pg-on');
    dbgB.addEventListener('click', function () {
      panel.pgDebug = !panel.pgDebug;
      drawResult(panel);
    });
    var copyB = toolBtn('pg-t-copy', 'Copy result', SVG.copy);
    copyB.addEventListener('click', function () { copyToClipboard(raw, copyB); });
    var foldB = toolBtn('pg-t-fold', 'Fold all', SVG.fold);
    foldB.addEventListener('click', function () {
      Array.prototype.forEach.call(panel.querySelectorAll('.pg-jnode'), function (n) {
        n.classList.add('pg-folded');
      });
    });
    var unfoldB = toolBtn('pg-t-unfold', 'Unfold all', SVG.unfold);
    unfoldB.addEventListener('click', function () {
      Array.prototype.forEach.call(panel.querySelectorAll('.pg-jnode'), function (n) {
        n.classList.remove('pg-folded');
      });
    });
    tools.appendChild(dbgB);
    tools.appendChild(copyB);
    tools.appendChild(foldB);
    tools.appendChild(unfoldB);
    panel.appendChild(tools);
    panel.appendChild(jsonNode(null, view));
  }

  // ── Editor: highlight overlay + folding + format/copy tools ─────────
  // The textarea stays the real editing surface (IME, undo, selection);
  // a synchronized <pre> underneath paints the tokens. Folding works as a
  // text transformation: a folded range's inner lines are replaced by an
  // inline "… }" marker in the editor itself, while the pristine body is
  // kept on the element (`pgOriginal`) — Run always executes the original,
  // and any edit re-parses from the new text.
  function foldRanges(text) {
    var out = [], stack = [], inStr = false, esc = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push({ ch: c, at: i });
      else if (c === '}' || c === ']') {
        var o = stack.pop();
        // Foldable when there is something inside (`{}` is a no-op);
        // same-line braces fold the inline span to " … }".
        if (o && i > o.at + 1) out.push({ start: o.at, end: i, close: c });
      }
    }
    return out;
  }

  function enhanceEditor(editor) {
    var wrap = el('div', 'pg-editwrap');
    editor.parentNode.insertBefore(wrap, editor);
    var hl = el('pre', 'pg-hl');
    hl.setAttribute('aria-hidden', 'true');
    wrap.appendChild(hl);
    wrap.appendChild(editor);
    editor.setAttribute('wrap', 'off');

    var reset = function () {
      editor.pgOriginal = editor.value;
      editor.pgCands = foldRanges(editor.value);
      editor.pgFolds = [];
    };
    reset();

    // Programmatic text replacement (dataset switch): .value assignment
    // fires no `input` event, so callers' dirty-tracking is preserved.
    editor.pgSetText = function (text) {
      editor.value = text;
      reset();
      sync();
    };

    function sync() {
      var orig = editor.pgOriginal;
      var folds = editor.pgFolds.slice().sort(function (a, b) { return a.start - b.start; });
      // View text: each folded range's inner span becomes " … <close>".
      var view = '', pos = 0;
      folds.forEach(function (f) {
        view += orig.slice(pos, f.start + 1) + ' … ' + f.close;
        pos = f.end + 1;
      });
      view += orig.slice(pos);

      // Caret placement: candidates inside an active fold are invisible;
      // the rest shift by the characters the folds above them elided.
      var cands = editor.pgCands.filter(function (c) {
        return !folds.some(function (f) { return c.start > f.start && c.end < f.end; });
      }).map(function (c) {
        var delta = 0;
        folds.forEach(function (f) { if (f.end < c.start) delta += (f.end - f.start) - 4; });
        return { viewStart: c.start + delta, start: c.start };
      });

    // Caret target per line: the outermost foldable range that OPENS on
    // that line (smallest start offset wins — nested ranges start later).
    var caretByLine = {};
    cands.forEach(function (c) {
      var ln = view.slice(0, c.viewStart).split('\n').length - 1;
      if (!caretByLine[ln] || c.start < caretByLine[ln].start) caretByLine[ln] = c;
    });
    var lines = view.split('\n');
    var lineIndent = {};
    var html = '';
    lines.forEach(function (text, i) {
      var caret = '';
      var c = caretByLine[i];
      if (c) {
        // Park the caret over the line's leading whitespace, ending a few
        // px short of its first non-space character — same visual slot as
        // the result tree's carets, clear of the field name, and the text
        // below stays pixel-aligned.
        var indent = text.match(/^\s*/)[0].length;
        lineIndent[i] = indent;
        var folded = editor.pgFolds.some(function (f) { return f.start === c.start; });
        caret = '<span class="pg-hcaret' + (folded ? ' pg-folded' : '') +
          '" data-pg-fold="' + c.start + '" style="left:calc(' + indent + 'ch - 18px)">▾</span>';
      }
      html += '<div class="pg-hline">' + caret + highlightJson(text) + '</div>';
    });
    hl.innerHTML = html;
    if (editor.value !== view) editor.value = view;
    var rows = Math.max(4, lines.length + 1);
    if (editor.rows !== rows) editor.rows = rows;
    hl.scrollTop = editor.scrollTop;
    hl.scrollLeft = editor.scrollLeft;
    editor.pgCaretLines = caretByLine;
    editor.pgLineIndents = lineIndent;
  }

  // Monospace char width (ch unit) in px — measured once from the overlay
  // font so click/hover hit tests can compute per-line content starts.
  if (!editor.pgCharW) {
    var probe = el('span', null, '0000000000');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    hl.appendChild(probe);
    editor.pgCharW = probe.getBoundingClientRect().width / 10;
    probe.remove();
  }

  // The textarea sits ABOVE the overlay, so real clicks can never reach
  // the caret spans — intercept clicks in each caret line's blank lead-in
  // (padding + leading whitespace, up to the first non-space character)
  // and map them to that line's fold candidate. Same hit test drives the
  // pointer cursor on hover.
  function caretAt(ev) {
    var rect = editor.getBoundingClientRect();
    var line = Math.floor((ev.clientY - rect.top + editor.scrollTop - 8) / 18);
    var c = editor.pgCaretLines && editor.pgCaretLines[line];
    if (!c) return null;
    var contentX = 26 + (editor.pgLineIndents[line] || 0) * (editor.pgCharW || 7.2);
    return ev.clientX - rect.left <= contentX ? c : null;
  }

  editor.addEventListener('click', function (ev) {
    var c = caretAt(ev);
    if (!c) return;
    for (var i = 0; i < editor.pgFolds.length; i++) {
      if (editor.pgFolds[i].start === c.start) { editor.pgFolds.splice(i, 1); sync(); return; }
    }
    var full = editor.pgCands.filter(function (r) { return r.start === c.start; })[0];
    if (full) { editor.pgFolds.push(full); sync(); }
  });

  editor.addEventListener('mousemove', function (ev) {
    editor.style.cursor = caretAt(ev) ? 'pointer' : '';
  });
  editor.addEventListener('mouseleave', function () { editor.style.cursor = ''; });

    editor.addEventListener('input', function () { reset(); sync(); });
    editor.addEventListener('scroll', function () {
      hl.scrollTop = editor.scrollTop;
      hl.scrollLeft = editor.scrollLeft;
    });

    var tools = el('div', 'pg-tools');
    var fmtB = toolBtn('pg-t-fmt', 'Format JSON', SVG.braces);
    fmtB.addEventListener('click', function () {
      try {
        editor.value = JSON.stringify(JSON.parse(editor.pgOriginal), null, 2);
        reset();
        sync();
      } catch (e) {
        fmtB.classList.add('pg-bad');
        setTimeout(function () { fmtB.classList.remove('pg-bad'); }, 900);
      }
    });
    var copyB = toolBtn('pg-t-copy', 'Copy query', SVG.copy);
    copyB.addEventListener('click', function () { copyToClipboard(editor.pgOriginal, copyB); });
    tools.appendChild(fmtB);
    tools.appendChild(copyB);
    wrap.appendChild(tools);
    sync();
  }

  function loadEngineModule() {
    if (engineModule) return engineModule;
    engineModule = import(WASM_PATH)
      .then(function (mod) { return mod.default().then(function () { return mod; }); })
      .catch(function (err) {
        engineModule = null;
        throw new Error('wasm bundle unavailable (run `make wasm`): ' + err);
      });
    return engineModule;
  }

  function loadCatalog() {
    if (catalog) return catalog;
    catalog = fetch(DATASETS + 'index.json').then(function (r) {
      if (!r.ok) throw new Error('dataset catalog unavailable (run `make dataset-fire`)');
      return r.json();
    }).catch(function (err) { catalog = null; throw err; });
    return catalog;
  }

  function engineFor(name) {
    if (engines[name]) return engines[name];
    var cat = loadCatalog().then(function (index) {
      var entry = index.collections.filter(function (c) { return c.name === name; })[0];
      if (!entry) throw new Error('unknown dataset collection: ' + name);
      return Promise.all([
        fetch(DATASETS + name + '/schema.json').then(function (r) { return r.json(); }),
        loadEngineModule()
      ]).then(function (res) {
        var creationBody = res[0], mod = res[1];
        // PizzaEngine::new takes the full collection-creation body — the
        // settings side registers the dataset's custom analyzers
        // (settings.analysis.analyzer), so fields referencing them
        // (articles.body → content_an) resolve at query time.
        var engine = new mod.PizzaEngine(JSON.stringify(creationBody));
        var docs = 0;
        // fetch all segments in parallel (each is one round trip on a
        // cache miss), then mount sequentially — mount is sync
        var p = Promise.all(entry.files.map(function (f) {
          return fetchSegment(DATASETS + name + '/' + f).then(function (r) { return r.arrayBuffer(); });
        })).then(function (bufs) {
          bufs.forEach(function (buf) { docs += engine.mount(new Uint8Array(buf)) || 0; });
        });
        return p.then(function () { return { engine: engine, docs: docs }; });
      });
    });
    engines[name] = cat;
    return cat;
  }

  // ── Dataset defaults for the playground app ───────────────────────
  // Each collection has different fields, so one canned query cannot
  // serve them all — switching the dataset swaps in a starter query
  // that actually runs against it (each showcases what the collection
  // is good for, mirroring the examples in the references).
  var DEFAULT_QUERIES = {
    sales: { query: { range: { field: 'price', gte: 45, lt: 60 } }, size: 3, track_total_hits: true },
    logs: { query: { match: { field: 'message', query: 'search' } }, size: 3, track_total_hits: true },
    products: {
      query: {
        nested: {
          path: 'variants',
          query: { bool: { must: [
            { term: { field: 'variants.color', value: 'blue' } },
            { term: { field: 'variants.size', value: 'L' } }
          ] } }
        }
      },
      size: 3, track_total_hits: true
    },
    customers: { query: { term: { field: 'tier', value: 'gold' } }, size: 3, track_total_hits: true },
    places: { query: { geo_distance: { field: 'location', lat: 39.9, lon: 116.4, distance_meters: 500000 } }, size: 3, track_total_hits: true },
    articles: { query: { match: { field: 'title', query: 'search' } }, size: 3, track_total_hits: true },
    embeddings: {
      query: { vector: { field: 'embedding', query_vector: [1, 0, 0, 0, 0, 0, 0, 0], k: 8, similarity: 'cosine' } },
      size: 8, track_total_hits: true
    }
  };

  function defaultQuery(name) {
    var o = DEFAULT_QUERIES[name] || { query: { match_all: {} }, size: 3, track_total_hits: true };
    return JSON.stringify(o, null, 2);
  }

  // ── SQL mode ──────────────────────────────────────────────────────
  // Statements run through the ENGINE's SQL frontend (feature `sql` in
  // the wasm build — the same parse/lower the /_sql gateway wire rides,
  // exposed as search_with_sql). Params are a JSON array feeding $1…
  // references. Results are raw engine output: hits carry the projected
  // fields, GROUP BY lands as the aggregations tree (the columns/rows
  // envelope shaping is gateway-side, on the roadmap).

  var DEFAULT_SQL = {
    sales: "SELECT type, price, status FROM sales WHERE price > 30 ORDER BY price DESC LIMIT 5",
    logs: "SELECT _key, level, message FROM logs WHERE message MATCH 'search' ORDER BY SCORE() DESC LIMIT 3",
    products: "SELECT title, price, stock FROM products WHERE active = TRUE ORDER BY price LIMIT 3",
    customers: "SELECT name, tier, city FROM customers ORDER BY name LIMIT 5",
    places: "SELECT name, city FROM places ORDER BY name LIMIT 5",
    articles: "SELECT title, author FROM articles WHERE body MATCH 'deep dive' ORDER BY SCORE() DESC LIMIT 3",
    embeddings: "SELECT topic, text FROM embeddings WHERE KNN(embedding, [1, 0, 0, 0, 0, 0, 0, 0], 5) ORDER BY SCORE() DESC LIMIT 5"
  };

  function defaultSql(name) {
    return DEFAULT_SQL[name] || 'SELECT * FROM ' + name + ' LIMIT 5';
  }

  // One chip per feature the dataset can showcase — statements target
  // the teaching dataset's real fields (live-verified against the
  // mounted segments).
  var SQL_EXAMPLES = {
    sales: [
      { label: 'BETWEEN + $params', params: '[30, 70]',
        sql: 'SELECT type, price, status FROM sales WHERE price BETWEEN $1 AND $2 ORDER BY price DESC LIMIT 5' },
      { label: 'GROUP BY + aggregates',
        sql: 'SELECT status, COUNT(*), AVG(amount), SUM(qty) FROM sales GROUP BY status ORDER BY status' },
      { label: 'COUNT(DISTINCT)',
        sql: 'SELECT merchant, COUNT(DISTINCT status) FROM sales GROUP BY merchant ORDER BY merchant LIMIT 5' },
      { label: 'DATE_TRUNC buckets',
        sql: "SELECT DATE_TRUNC(date, 'day'), COUNT(*), SUM(amount) FROM sales GROUP BY DATE_TRUNC(date, 'day') ORDER BY DATE_TRUNC(date, 'day')" },
      { label: 'HISTOGRAM + HAVING',
        sql: 'SELECT HISTOGRAM(price, 25), COUNT(*) FROM sales GROUP BY HISTOGRAM(price, 25) ORDER BY HISTOGRAM(price, 25)' },
      { label: 'CASE buckets',
        sql: "SELECT CASE WHEN amount < 100 THEN 'small' ELSE 'large' END, COUNT(*) FROM sales GROUP BY CASE WHEN amount < 100 THEN 'small' ELSE 'large' END" },
      { label: 'scalars + arithmetic',
        sql: 'SELECT type, price, qty, price * qty AS total FROM sales WHERE price > 50 LIMIT 3' },
      { label: 'composite cursor walk',
        sql: 'SELECT merchant, status, COUNT(*) FROM sales GROUP BY merchant, status ORDER BY merchant, status LIMIT 6' },
      { label: 'EXPLAIN the compile',
        sql: 'EXPLAIN SELECT type, price FROM sales WHERE price > 30 ORDER BY price DESC LIMIT 3' }
    ],
    logs: [
      { label: 'MATCH + SCORE()',
        sql: "SELECT _key, level, message FROM logs WHERE message MATCH 'search' ORDER BY SCORE() DESC LIMIT 3" },
      { label: 'FUZZY',
        sql: "SELECT _key, message FROM logs WHERE FUZZY(message, 'serch', 'AUTO') LIMIT 3" },
      { label: 'HIGHLIGHT',
        sql: "SELECT HIGHLIGHT(message, '<b>', '</b>') FROM logs WHERE message MATCH 'search' LIMIT 3" },
      { label: 'term + AND combo',
        sql: "SELECT _key, host, level FROM logs WHERE host = 'web-01' AND level = 'error' ORDER BY _key LIMIT 5" },
      { label: 'IN + IS NOT NULL',
        sql: "SELECT _key, host, level FROM logs WHERE level IN ('error', 'warn') AND host IS NOT NULL ORDER BY _key LIMIT 5" },
      { label: 'NOT + parens',
        sql: "SELECT _key, level FROM logs WHERE NOT (host = 'web-01') AND level = 'warn' LIMIT 5" }
    ],
    products: [
      { label: 'boolean + range',
        sql: 'SELECT title, price, stock FROM products WHERE active = TRUE AND price < $1 ORDER BY price LIMIT 3',
        params: '[50]' },
      { label: 'term + ORDER BY',
        sql: "SELECT title, price FROM products WHERE category = 'apparel' ORDER BY price DESC LIMIT 3" },
      { label: 'GROUP BY category',
        sql: 'SELECT category, COUNT(*), AVG(price) FROM products GROUP BY category ORDER BY category' },
      { label: 'IS NULL / NOT',
        sql: 'SELECT title, active FROM products WHERE NOT (active = TRUE) LIMIT 3' }
    ],
    customers: [
      { label: 'term + ORDER BY',
        sql: "SELECT name, tier, city FROM customers WHERE tier = 'gold' ORDER BY name LIMIT 5" },
      { label: 'multi-key GROUP BY',
        sql: 'SELECT city, tier, COUNT(*) FROM customers GROUP BY city, tier ORDER BY city, tier LIMIT 5' },
      { label: 'COUNT(DISTINCT) + MIN',
        sql: 'SELECT city, COUNT(DISTINCT tier), MIN(since) FROM customers GROUP BY city ORDER BY city' }
    ],
    places: [
      { label: 'keyword columns',
        sql: 'SELECT name, city FROM places WHERE city IS NOT NULL ORDER BY name LIMIT 5' }
    ],
    articles: [
      { label: 'MATCH + SCORE()',
        sql: "SELECT title, author, SCORE() FROM articles WHERE body MATCH 'deep dive' ORDER BY SCORE() DESC LIMIT 3" },
      { label: 'MATCH_PHRASE',
        sql: "SELECT title FROM articles WHERE MATCH_PHRASE(body, 'practical deep dive') LIMIT 3" },
      { label: 'HIGHLIGHT',
        sql: "SELECT HIGHLIGHT(body, '<b>', '</b>') FROM articles WHERE body MATCH 'deep dive' LIMIT 2" },
      { label: 'array field filter',
        sql: "SELECT UPPER(author), title FROM articles WHERE tags = 'search' ORDER BY title LIMIT 3" }
    ],
    embeddings: [
      { label: 'KNN + SCORE()',
        sql: 'SELECT topic, text FROM embeddings WHERE KNN(embedding, [1, 0, 0, 0, 0, 0, 0, 0], 5) ORDER BY SCORE() DESC LIMIT 5' },
      { label: 'KNN as JSON string',
        sql: "SELECT topic, text FROM embeddings WHERE KNN(embedding, '[1, 0, 0, 0, 0, 0, 0, 0]', 5) ORDER BY SCORE() DESC LIMIT 5" },
      { label: 'GROUP BY topic',
        sql: 'SELECT topic, COUNT(*) FROM embeddings GROUP BY topic ORDER BY topic' }
    ]
  };

  // The error-channel demo: statement-level DISTINCT fails closed with
  // the gateway-shaped plan error ({type, reason, position, span}) — the
  // exact member the /_sql 400 body carries. (It used to be SILENTLY
  // ignored — dup rows.) EXPLAIN, the old demo, now answers the trace.
  var SQL_ERROR_EXAMPLE = {
    label: 'a rejected statement',
    sql: 'SELECT DISTINCT type FROM sales'
  };

  // ── SQL envelope table (P3) ───────────────────────────────────────
  // The wasm binding answers the SAME frozen columns/rows/cursor envelope
  // `/_sql` answers — render it as a table (a JSON view is one click
  // away), and a non-null cursor gets a Next-page button that resubmits
  // the identical statement with it (the composite keyset walk).
  function isSqlEnvelope(out) {
    return !!(out && typeof out === 'object' && !Array.isArray(out)
      && Array.isArray(out.columns) && Array.isArray(out.rows));
  }

  function sqlTableCell(v) {
    var td = el('td');
    if (v === null || v === undefined) {
      td.className = 'pg-td-null';
      td.textContent = 'null';
      return td;
    }
    var text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    td.textContent = text;
    if (text.length > 72) {
      td.className = 'pg-td-long';
      td.title = text;
    }
    return td;
  }

  function drawSqlPanel(panel, envelope, rerun) {
    // rerun(cursorOrNull) — the Next button's resubmission path.
    var raw = JSON.stringify(envelope, null, 2);
    panel.textContent = '';
    var view = panel.pgSqlView === 'json' ? 'json' : 'table';

    var tools = el('div', 'pg-tools');
    var tabB = toolBtn('pg-t-table', 'Table view', SVG.table);
    var jsonB = toolBtn('pg-t-json', 'Raw JSON', SVG.code);
    (view === 'table' ? tabB : jsonB).classList.add('pg-on');
    tabB.addEventListener('click', function () { panel.pgSqlView = 'table'; drawSqlPanel(panel, envelope, rerun); });
    jsonB.addEventListener('click', function () { panel.pgSqlView = 'json'; drawSqlPanel(panel, envelope, rerun); });
    var copyB = toolBtn('pg-t-copy', 'Copy JSON', SVG.copy);
    copyB.addEventListener('click', function () { copyToClipboard(raw, copyB); });
    tools.appendChild(tabB);
    tools.appendChild(jsonB);
    tools.appendChild(copyB);
    panel.appendChild(tools);

    if (view === 'json') {
      panel.appendChild(jsonNode(null, envelope));
    } else {
      var table = el('table', 'pg-table');
      var thead = el('thead');
      var htr = el('tr');
      envelope.columns.forEach(function (c) {
        var th = el('th');
        th.textContent = c.name;
        var tag = el('span', 'pg-th-type', c.type || '');
        th.appendChild(tag);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);
      var tbody = el('tbody');
      envelope.rows.forEach(function (row) {
        var tr = el('tr');
        envelope.columns.forEach(function (c, i) { tr.appendChild(sqlTableCell(row[i])); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      panel.appendChild(table);
    }

    if (envelope.cursor && typeof envelope.cursor === 'object') {
      var bar = el('div', 'pg-cursorbar');
      var note = el('span', 'pg-cursor-note',
        'full page — the engine handed back a keyset cursor');
      var next = el('button', 'pg-next-btn', 'Next page →');
      next.type = 'button';
      next.addEventListener('click', function () {
        panel.pgPageDepth = (panel.pgPageDepth || 1) + 1;
        rerun(envelope.cursor);
      });
      bar.appendChild(note);
      bar.appendChild(next);
      panel.appendChild(bar);
    }
  }

  function runSql(box, dataset, sqlText, paramsRaw, resultPanel, cursor) {
    var params;
    try {
      params = paramsRaw && paramsRaw.trim() ? JSON.parse(paramsRaw) : [];
    } catch (e) {
      setStatus(box, 'params must be a JSON array, e.g. [30, 70]', true);
      return;
    }
    if (!Array.isArray(params)) {
      setStatus(box, 'params must be a JSON array, e.g. [30, 70]', true);
      return;
    }
    // A fresh (cursorless) submission restarts the page walk; a Next-page
    // click keeps the depth (status shows "page N").
    if (!cursor) resultPanel.pgPageDepth = 1;
    setStatus(box, 'loading ' + dataset + '…');
    engineFor(dataset)
      .then(function (h) {
        if (typeof h.engine.search_with_sql !== 'function') {
          throw new Error('this wasm bundle predates SQL support — rebuild with `make wasm`');
        }
        // EXPLAIN <select> never executes — it answers the lowering trace
        // (the DSL the statement compiles to) through its own binding.
        if (/^\s*EXPLAIN\s/i.test(sqlText)) {
          if (typeof h.engine.explain_with_sql !== 'function') {
            throw new Error('this wasm bundle predates EXPLAIN support — rebuild with `make wasm`');
          }
          var trace;
          try {
            trace = h.engine.explain_with_sql(sqlText, params);
          } catch (e) {
            if (e && typeof e === 'object' && e.reason) {
              renderResult(resultPanel, { error: e });
              var at = e.position ? ' at line ' + e.position.line + ', column ' + e.position.column : '';
              setStatus(box, 'plan error' + at + ' — ' + e.reason, true);
            } else {
              renderResult(resultPanel, { error: { reason: String(e && e.message ? e.message : e) } });
              setStatus(box, 'explain failed: ' + (e && e.message ? e.message : e), true);
            }
            return;
          }
          renderResult(resultPanel, trace);
          setStatus(box, 'ok — lowering trace: the compiled DSL plan, nothing executed');
          return;
        }
        var out;
        try {
          out = h.engine.search_with_sql(sqlText, params, cursor || undefined);
        } catch (e) {
          // wasm-bindgen rethrows the JsValue we rejected with: for plan
          // errors that is the gateway-shaped error object.
          if (e && typeof e === 'object' && e.reason) {
            renderResult(resultPanel, { error: e });
            var at = e.position ? ' at line ' + e.position.line + ', column ' + e.position.column : '';
            setStatus(box, 'plan error' + at + ' — ' + e.reason, true);
          } else {
            renderResult(resultPanel, { error: { reason: String(e && e.message ? e.message : e) } });
            setStatus(box, 'query failed: ' + (e && e.message ? e.message : e), true);
          }
          return;
        }
        if (isSqlEnvelope(out)) {
          var rerun = function (nextCursor) {
            runSql(box, dataset, sqlText, paramsRaw, resultPanel, nextCursor);
          };
          resultPanel.pgSqlView = resultPanel.pgSqlView || 'table';
          drawSqlPanel(resultPanel, out, rerun);
          var depth = resultPanel.pgPageDepth || 1;
          setStatus(box, depth > 1
            ? (out.rows.length
                ? 'ok — page ' + depth + ': ' + out.rows.length + ' more rows (keyset cursor)'
                : 'ok — end of the cursor walk (no more rows)')
            : 'ok — ' + out.rows.length + (out.rows.length === 1 ? ' row' : ' rows')
              + (out.cursor ? ' (cursor available)' : ''));
        } else {
          // Older bundle or unexpected shape — the JSON tree still shows it.
          renderResult(resultPanel, out);
          setStatus(box, 'ok — engine-level SQL output');
        }
      })
      .catch(function (err) {
        setStatus(box, String(err.message || err), true);
      });
  }

  // ── Dataset picker (custom dropdown) ──────────────────────────────
  // The native <select> popup ignores the page theme and sticks out
  // next to the styled editor and result panels, so the app builds a
  // small listbox instead: a button plus an absolutely-positioned menu,
  // keyboard-navigable (arrows / Enter / Escape), closing on outside
  // click. Fills `holder` in place; onPick fires on user picks only.
  function makeSelect(holder, onPick) {
    var ctl = { value: '' };
    var btn = el('button', 'pg-sel-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    var lbl = el('span', 'pg-sel-lbl', holder.textContent || 'loading…');
    var chev = el('span', 'pg-sel-chev');
    chev.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l4 4 4-4"/></svg>';
    btn.appendChild(lbl);
    btn.appendChild(chev);

    var menu = el('div', 'pg-sel-menu');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Dataset');
    menu.tabIndex = -1;

    holder.classList.add('pg-sel');
    holder.textContent = '';
    holder.appendChild(btn);
    holder.appendChild(menu);

    var opts = [];   // {value, label, hint}
    var hi = -1;     // keyboard-highlighted row while open

    function indexOfValue(v) {
      for (var i = 0; i < opts.length; i++) if (opts[i].value === v) return i;
      return -1;
    }

    function isOpen() { return holder.classList.contains('pg-open'); }

    function paintHi() {
      Array.prototype.forEach.call(menu.children, function (n, i) {
        n.classList.toggle('pg-sel-hi', i === hi);
      });
      var node = menu.children[hi];
      if (node) node.scrollIntoView({ block: 'nearest' });
    }

    function setOpen(open) {
      holder.classList.toggle('pg-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        hi = Math.max(0, indexOfValue(ctl.value));
        paintHi();
        menu.focus();
      }
    }

    function paint() {
      var i = indexOfValue(ctl.value);
      lbl.textContent = i >= 0 ? opts[i].label + ' (' + opts[i].hint + ')' : 'loading…';
    }

    function render() {
      menu.textContent = '';
      opts.forEach(function (o, idx) {
        var it = el('div', 'pg-sel-opt');
        it.setAttribute('role', 'option');
        it.setAttribute('data-value', o.value);
        if (o.value === ctl.value) {
          it.classList.add('pg-sel-on');
          it.setAttribute('aria-selected', 'true');
        }
        it.appendChild(el('span', 'pg-sel-name', o.label));
        it.appendChild(el('span', 'pg-sel-hint', o.hint));
        it.addEventListener('click', function () { pick(o.value); });
        it.addEventListener('mousemove', function () { if (hi !== idx) { hi = idx; paintHi(); } });
        menu.appendChild(it);
      });
    }

    function pick(v) {
      ctl.value = v;
      render();
      paint();
      setOpen(false);
      btn.focus();
      if (onPick) onPick(v);
    }

    btn.addEventListener('click', function () { setOpen(!isOpen()); });
    btn.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); setOpen(true); }
    });
    menu.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); setOpen(false); btn.focus(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!opts.length) return;
        hi = ev.key === 'ArrowDown' ? Math.min(opts.length - 1, hi + 1) : Math.max(0, hi - 1);
        paintHi();
      }
      else if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        hi = ev.key === 'Home' ? 0 : opts.length - 1;
        paintHi();
      }
      else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (hi >= 0 && hi < opts.length) pick(opts[hi].value);
      }
    });
    document.addEventListener('click', function (ev) {
      if (isOpen() && !holder.contains(ev.target)) setOpen(false);
    });

    ctl.setOptions = function (list) {
      opts = list;
      if (indexOfValue(ctl.value) < 0) ctl.value = list.length ? list[0].value : '';
      render();
      paint();
    };
    ctl.setValue = function (v) {
      if (indexOfValue(v) < 0) return;
      ctl.value = v;
      render();
      paint();
    };
    return ctl;
  }

  function run(box, dataset, dslText, resultPanel) {
    setStatus(box, 'loading ' + dataset + '…');
    engineFor(dataset)
      .then(function (h) {
        setStatus(box, dataset + ' ready (' + h.docs + ' docs mounted)');
        var out;
        try {
          out = h.engine.search_with_dsl(dslText);
        } catch (e) {
          throw new Error('query failed: ' + (e && e.message ? e.message : e));
        }
        renderResult(resultPanel, out);
        setStatus(box, 'ok — engine-level output (no gateway envelope)');
      })
      .catch(function (err) {
        setStatus(box, String(err.message || err), true);
      });
  }

  function wireInlineWidget(div) {
    var dataset = div.dataset.dataset || 'sales';
    var dsl = div.dataset.dsl;
    var sql = div.dataset.sql;
    var params0 = div.dataset.params || '';
    // Dual = both spellings authored: the DSL body is the default text.
    var dual = sql !== undefined && dsl !== undefined;
    var text = dual ? dsl : (sql !== undefined ? sql : (dsl || '{ "query": { "match_all": {} } }'));
    var box = el('div');
    var editor = el('textarea', 'pg-editor');
    editor.value = text;
    editor.rows = Math.max(4, text.split('\n').length + 1);
    editor.spellcheck = false;
    var btn = el('button', 'pg-run', sql !== undefined && !dual ? '▶ Try it live (SQL)' : '▶ Try it live');
    var status = el('div', 'pg-status');
    var result = el('pre', 'pg-result');
    // Params box ($1… references), rendered only on SQL widgets below.
    var paramsInput = null;
    // Dual-syntax widget: the shortcode carries BOTH a DSL body and a
    // hand-authored SQL twin. Default is DSL; the [DSL|SQL] pills beside
    // the Run button swap the editor between the two spellings (each
    // keeps its own edits), and Run follows the active lane.
    // SQL-only widgets (no DSL body) have no pills and start in the SQL
    // lane — otherwise their statement would go through the DSL parser.
    var lane = dual ? 'dsl' : (sql !== undefined ? 'sql' : 'dsl');
    var laneText = { dsl: dsl, sql: sql };
    var applyLane = function (m) {
      if (m === lane) return;
      laneText[lane] = editor.pgOriginal || editor.value;
      lane = m;
      editor.pgSetText(laneText[lane]);
      var wrap = editor.parentNode;
      if (wrap && wrap.classList && wrap.classList.contains('pg-editwrap')) {
        wrap.classList.toggle('pg-sql', m === 'sql');
      }
      dslPill.classList.toggle('pg-on', m === 'dsl');
      sqlPill.classList.toggle('pg-on', m === 'sql');
    };
    var dslPill = el('button', 'pg-mode-btn pg-on', 'DSL');
    var sqlPill = el('button', 'pg-mode-btn', 'SQL');
    dslPill.type = 'button';
    sqlPill.type = 'button';
    dslPill.addEventListener('click', function () { applyLane('dsl'); });
    sqlPill.addEventListener('click', function () { applyLane('sql'); });
    var toggle = el('div', 'pg-mode pg-inlinemode');
    toggle.appendChild(dslPill);
    toggle.appendChild(sqlPill);
    var onRun = function () {
      var t = editor.pgOriginal || editor.value;
      if (lane === 'sql') runSql(status, dataset, t, paramsInput ? paramsInput.value : '', result);
      else run(status, dataset, t, result);
    };
    btn.addEventListener('click', onRun);
    editor.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') onRun();
    });
    if (dual) {
      var runrow = el('div', 'pg-runrow');
      runrow.appendChild(btn);
      runrow.appendChild(toggle);
      div.appendChild(box).appendChild(runrow);
    } else {
      div.appendChild(box).appendChild(btn);
    }
    // SQL widgets carry a params box ($1… references) and no JSON tools.
    if (sql !== undefined && !dual) {
      var prow = el('div', 'pg-paramsrow');
      paramsInput = el('input', 'pg-params');
      paramsInput.type = 'text';
      paramsInput.spellcheck = false;
      paramsInput.value = params0;
      paramsInput.placeholder = 'params — JSON array, e.g. [30, 70]';
      paramsInput.setAttribute('aria-label', 'SQL params');
      paramsInput.addEventListener('keydown', function (ev) {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') onRun();
      });
      prow.appendChild(paramsInput);
      div.appendChild(prow);
    }
    div.appendChild(editor);
    enhanceEditor(editor);
    if (sql !== undefined && !dual) {
      var wrap = editor.parentNode;
      if (wrap && wrap.classList && wrap.classList.contains('pg-editwrap')) wrap.classList.add('pg-sql');
    }
    div.appendChild(result);
    // One footer row — status on the left, wasm badge on the right —
    // so the idle widget reads as a single compact line.
    var footer = el('div', 'pg-footer');
    footer.appendChild(status);
    footer.appendChild(makeBadge(true));
    div.appendChild(footer);
    // First interaction loads the wasm module and dataset; warm only the
    // status line so pages stay cheap until the user opts in.
    loadCatalog().then(function (i) {
      setStatus(status, 'ready — ' + dataset + ' available (' + (i.collections.map(function (c) { return c.name; }).join(', ')) + ')');
    }).catch(function (e) { setStatus(status, String(e.message || e), true); });
  }

  function wireApp(root) {
    var selHolder = root.querySelector('.pg-collections');
    var editor = root.querySelector('.pg-editor');
    var status = root.querySelector('.pg-status');
    var result = root.querySelector('.pg-result');
    var btn = root.querySelector('.pg-run');
    // dirty: the user typed in the editor since the last default was
    // loaded. Switching datasets then keeps the edited query (and says
    // so) instead of silently discarding their work.
    var dirty = false;
    editor.addEventListener('input', function () { dirty = true; });

    // ── Query mode: JSON DSL ⇄ SQL ─────────────────────────────────
    // The bar above the editor carries the toggle, per-dataset example
    // chips (SQL only) and the $1 params box. The editor's editwrap
    // gets pg-sql so the JSON-only Format tool hides in SQL mode.
    var mode = 'dsl';
    var sqlbar = el('div', 'pg-sqlbar');
    var modeRow = el('div', 'pg-mode');
    var dslB = el('button', 'pg-mode-btn', 'JSON DSL');
    var sqlB = el('button', 'pg-mode-btn', 'SQL');
    dslB.type = 'button';
    sqlB.type = 'button';
    // The resting toggle shows which mode you are in — setMode only runs
    // on clicks, so without this neither pill reads as selected at load.
    dslB.classList.add('pg-on');
    var paramsRow = el('div', 'pg-paramsrow');
    var paramsInput = el('input', 'pg-params');
    paramsInput.type = 'text';
    paramsInput.spellcheck = false;
    paramsInput.placeholder = 'params — JSON array for $1… , e.g. [30, 70]';
    paramsInput.setAttribute('aria-label', 'SQL params');
    paramsRow.appendChild(paramsInput);
    var exRow = el('div', 'pg-examples');
    function currentExamples() {
      var list = (SQL_EXAMPLES[sel.value] || []).slice();
      // The error demo lives ONLY with its own dataset's statement (the
      // rejection fires at parse time, so it technically runs anywhere —
      // but a sales statement under the logs chips reads like a mistake,
      // and one copy per dataset was noise).
      if (sel.value === 'sales') list.push(SQL_ERROR_EXAMPLE);
      return list;
    }
    function renderExamples() {
      exRow.textContent = '';
      if (mode !== 'sql') return;
      currentExamples().forEach(function (ex) {
        var chip = el('button', 'pg-chip', ex.label);
        chip.type = 'button';
        chip.title = ex.sql;
        chip.addEventListener('click', function () {
          editor.pgSetText(ex.sql);
          paramsInput.value = ex.params || '';
          dirty = false;
          setStatus(status, 'example loaded — press Run (⌘/Ctrl+Enter)');
        });
        exRow.appendChild(chip);
      });
    }
    function setMode(m) {
      mode = m;
      dslB.classList.toggle('pg-on', m === 'dsl');
      sqlB.classList.toggle('pg-on', m === 'sql');
      sqlbar.classList.toggle('pg-sql', m === 'sql');
      var wrap = editor.parentNode;
      if (wrap && wrap.classList && wrap.classList.contains('pg-editwrap')) {
        wrap.classList.toggle('pg-sql', m === 'sql');
      }
      renderExamples();
      if (!dirty) editor.pgSetText(m === 'sql' ? defaultSql(sel.value) : defaultQuery(sel.value));
      setStatus(status, m === 'sql'
        ? 'SQL mode — statements run through the engine\'s SQL frontend ($1 params in the params box)'
        : 'DSL mode — canonical JSON query body');
    }
    dslB.addEventListener('click', function () { setMode('dsl'); });
    sqlB.addEventListener('click', function () { setMode('sql'); });
    modeRow.appendChild(dslB);
    modeRow.appendChild(sqlB);
    sqlbar.appendChild(modeRow);
    sqlbar.appendChild(exRow);
    sqlbar.appendChild(paramsRow);
    editor.parentNode.insertBefore(sqlbar, editor);
    paramsInput.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') onRun();
    });

    var sel = makeSelect(selHolder, function (v) {
      if (dirty) {
        setStatus(status, 'switched to ' + v + ' — kept your edited query (fields differ per dataset)');
      } else {
        editor.pgSetText(mode === 'sql' ? defaultSql(v) : defaultQuery(v));
        setStatus(status, v + ' — starter ' + (mode === 'sql' ? 'statement' : 'query') + ' loaded, press Run');
      }
      renderExamples();
    });
    loadCatalog().then(function (index) {
      sel.setOptions(index.collections.map(function (c) {
        return { value: c.name, label: c.name, hint: (c.docs || '?') + ' docs' };
      }));
      // The static editor content is the logs starter query — match it.
      var initial = index.collections.some(function (c) { return c.name === 'logs'; }) ? 'logs' : sel.value;
      sel.setValue(initial);
      if (!dirty) editor.pgSetText(defaultQuery(initial));
      renderExamples();
      setStatus(status, 'dataset v' + index.version + ' loaded');
    }).catch(function (e) { setStatus(status, String(e.message || e), true); });
    var onRun = function () {
      var t = editor.pgOriginal || editor.value;
      if (mode === 'sql') runSql(status, sel.value, t, paramsInput.value, result);
      else run(status, sel.value, t, result);
    };
    btn.addEventListener('click', onRun);
    editor.addEventListener('keydown', function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') onRun();
    });
    enhanceEditor(editor);
    // Relocate the static status line into a footer row with the badge,
    // mirroring the inline widgets' compact single-line footer.
    var footer = el('div', 'pg-footer');
    footer.appendChild(status);
    footer.appendChild(makeBadge(false));
    root.appendChild(footer);
  }

  function boot() {
    var inline = document.querySelectorAll('.pizza-playground');
    Array.prototype.forEach.call(inline, wireInlineWidget);
    var app = document.getElementById('pizza-playground-app');
    if (app) wireApp(app);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
