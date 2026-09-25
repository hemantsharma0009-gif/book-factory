/**
 * Charts, built with the DOM. No library, no build step — the same constraint
 * as the rest of this page.
 *
 * Two rules run through everything here:
 *
 * 1. TITLES ARE USER DATA. Every label is written with textContent or an SVG
 *    text node, never innerHTML. A book title arrives from an imported sales
 *    report, so treating it as markup is script execution one import away.
 *
 * 2. A CHART OF ZERO IS A LIE. An empty dataset renders an explanation, not a
 *    flat bar or an empty ring. A reader glancing at a chart assumes the shape
 *    means something; drawing nothing-shaped-like-something is worse than
 *    drawing nothing.
 *
 * The categorical palette is three hues plus a neutral for "Other", validated
 * for colour-blind separation against both this page's surfaces. Three is the
 * documented cap for a form where any two marks can be compared — a pie is
 * exactly that — so the fourth storefront folds into the neutral slot, which is
 * also what it is called.
 */
(function (global) {
  "use strict";

  var SVG = "http://www.w3.org/2000/svg";

  function el(name, attrs) {
    var node = document.createElementNS(SVG, name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  /** An SVG text node. Always textContent: see rule 1. */
  function text(value, attrs) {
    var node = el("text", attrs);
    node.textContent = String(value == null ? "" : value);
    return node;
  }

  function money(value) {
    var n = Number(value) || 0;
    return "$" + n.toFixed(2);
  }

  function emptyState(host, message) {
    host.textContent = "";
    var p = document.createElement("p");
    p.className = "chart-empty";
    p.textContent = message;
    host.appendChild(p);
  }

  /* ------------------------------------------------------------ tooltip */

  var tip = null;

  function tooltip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.setAttribute("role", "status");
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function showTip(event, lines) {
    var node = tooltip();
    node.textContent = "";
    lines.forEach(function (line, i) {
      var row = document.createElement("div");
      row.className = i === 0 ? "chart-tip-title" : "chart-tip-row";
      row.textContent = line;
      node.appendChild(row);
    });
    node.hidden = false;
    moveTip(event);
  }

  function moveTip(event) {
    var node = tooltip();
    if (node.hidden) return;
    var pad = 14;
    var box = node.getBoundingClientRect();
    var x = event.clientX + pad;
    var y = event.clientY + pad;
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    node.style.transform = "translate(" + Math.max(8, x) + "px," + Math.max(8, y) + "px)";
  }

  function hideTip() {
    if (tip) tip.hidden = true;
  }

  /** Hover, focus and touch all reach the same tooltip; keyboard included. */
  function bindHover(node, lines) {
    node.addEventListener("mouseenter", function (e) { showTip(e, lines); });
    node.addEventListener("mousemove", moveTip);
    node.addEventListener("mouseleave", hideTip);
    node.addEventListener("focus", function () {
      var box = node.getBoundingClientRect();
      showTip({ clientX: box.left + box.width / 2, clientY: box.top }, lines);
    });
    node.addEventListener("blur", hideTip);
  }

  /* --------------------------------------------------------------- donut */

  /**
   * Part-to-whole across a handful of categories, with the total in the middle.
   *
   * A 2px gap of surface colour sits between segments so two adjacent colours
   * are never judged against each other directly, and every segment carries a
   * legend entry with its own number — identity is never colour alone.
   */
  function donut(host, options) {
    var slices = (options.slices || []).filter(function (s) { return s.value > 0; });
    host.textContent = "";

    if (!slices.length) {
      emptyState(host, options.empty || "Nothing to chart yet.");
      return;
    }

    var total = slices.reduce(function (sum, s) { return sum + s.value; }, 0);
    var size = 220;
    var stroke = 26;
    var radius = (size - stroke) / 2 - 2;
    var centre = size / 2;
    var circumference = 2 * Math.PI * radius;

    var wrap = document.createElement("div");
    wrap.className = "chart-donut";

    var svg = el("svg", {
      viewBox: "0 0 " + size + " " + size,
      width: size,
      height: size,
      role: "img",
      "aria-label": options.label || "Share by category",
    });

    // A single segment would draw as a gapped ring with a seam in it; draw the
    // whole circle instead, which is what 100% actually looks like.
    var offset = 0;
    slices.forEach(function (slice) {
      var fraction = slice.value / total;
      var length = circumference * fraction;
      var gap = slices.length > 1 ? 2 : 0;

      var arc = el("circle", {
        cx: centre,
        cy: centre,
        r: radius,
        fill: "none",
        stroke: slice.color,
        "stroke-width": stroke,
        "stroke-dasharray": Math.max(0, length - gap) + " " + (circumference - Math.max(0, length - gap)),
        "stroke-dashoffset": -offset,
        transform: "rotate(-90 " + centre + " " + centre + ")",
        tabindex: "0",
        role: "listitem",
      });
      arc.setAttribute("aria-label", slice.label + ": " + money(slice.value));
      bindHover(arc, [
        slice.label,
        money(slice.value),
        Math.round(fraction * 100) + "% of " + money(total),
      ]);
      svg.appendChild(arc);
      offset += length;
    });

    svg.appendChild(text(money(total), {
      x: centre, y: centre - 2, "text-anchor": "middle", class: "chart-hero",
    }));
    svg.appendChild(text(options.totalLabel || "total", {
      x: centre, y: centre + 18, "text-anchor": "middle", class: "chart-hero-sub",
    }));

    wrap.appendChild(svg);

    var legend = document.createElement("ul");
    legend.className = "chart-legend";
    slices.forEach(function (slice) {
      var item = document.createElement("li");

      var swatch = document.createElement("span");
      swatch.className = "chart-swatch";
      swatch.style.background = slice.color;

      var name = document.createElement("span");
      name.className = "chart-legend-name";
      name.textContent = slice.label;

      var value = document.createElement("span");
      value.className = "chart-legend-value";
      value.textContent = money(slice.value) + "  ·  " + Math.round((slice.value / total) * 100) + "%";

      item.appendChild(swatch);
      item.appendChild(name);
      item.appendChild(value);
      legend.appendChild(item);
    });

    wrap.appendChild(legend);
    host.appendChild(wrap);
  }

  /* ---------------------------------------------------------------- bars */

  /**
   * Two measures per row, one shared axis.
   *
   * Revenue and profit are both dollars, so they belong on the same scale —
   * and a second axis would let the smaller number be drawn as the larger bar,
   * which is the fastest way to make a chart lie.
   */
  function bars(host, options) {
    var rows = (options.rows || []).filter(function (row) {
      return row.values.some(function (v) { return v.value > 0; });
    });
    host.textContent = "";

    if (!rows.length) {
      emptyState(host, options.empty || "Nothing to chart yet.");
      return;
    }

    var series = options.series || [];
    var max = rows.reduce(function (hi, row) {
      return row.values.reduce(function (h, v) { return Math.max(h, v.value); }, hi);
    }, 0) || 1;

    var wrap = document.createElement("div");
    wrap.className = "chart-bars";

    if (series.length > 1) {
      var legend = document.createElement("ul");
      legend.className = "chart-legend chart-legend-inline";
      series.forEach(function (s) {
        var item = document.createElement("li");
        var swatch = document.createElement("span");
        swatch.className = "chart-swatch";
        swatch.style.background = s.color;
        var name = document.createElement("span");
        name.className = "chart-legend-name";
        name.textContent = s.label;
        item.appendChild(swatch);
        item.appendChild(name);
        legend.appendChild(item);
      });
      wrap.appendChild(legend);
    }

    var list = document.createElement("div");
    list.className = "chart-bar-rows";

    rows.forEach(function (row) {
      var line = document.createElement("div");
      line.className = "chart-bar-row";

      var label = document.createElement("span");
      label.className = "chart-bar-label";
      label.textContent = row.label;
      label.title = row.label;

      var track = document.createElement("span");
      track.className = "chart-bar-track";

      row.values.forEach(function (value) {
        var bar = document.createElement("span");
        bar.className = "chart-bar";
        bar.style.background = value.color;
        bar.style.width = Math.max(value.value > 0 ? 2 : 0, (value.value / max) * 100) + "%";
        bar.tabIndex = 0;
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", row.label + " — " + value.label + " " + money(value.value));
        bindHover(bar, [row.label, value.label + "  " + money(value.value)]);
        track.appendChild(bar);
      });

      var figure = document.createElement("span");
      figure.className = "chart-bar-value";
      figure.textContent = money(row.values[0].value);

      line.appendChild(label);
      line.appendChild(track);
      line.appendChild(figure);
      list.appendChild(line);
    });

    wrap.appendChild(list);
    host.appendChild(wrap);
  }

  global.BookFactoryCharts = { donut: donut, bars: bars, money: money };
})(window);
