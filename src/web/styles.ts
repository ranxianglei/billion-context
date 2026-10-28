export const WEB_STYLES = String.raw`
:root {
    /* #2473: bind the document canvas to the SAME signal that drives the
       palette (prefers-color-scheme). Without this the canvas stays white no
       matter the scheme, so the embed face (--bg: transparent) painted its
       light-scheme text on a white ground in dark mode → unreadable stats. */
    color-scheme: light dark;
    --bg: #ffffff;
    --bg-elev: #f6f8fa;
    --bg-muted: #f0f2f5;
    --border: #d8dee4;
    --border-soft: #e8ecf0;
    --text: #1f2328;
    --text-muted: #656d76;
    --text-faint: #8b949e;
    --accent: #2185d0;
    --accent-soft: rgba(33, 133, 208, 0.1);
    --green: #1a7f37;
    --green-soft: rgba(26, 127, 55, 0.1);
    --red: #cf222e;
    --red-soft: rgba(207, 34, 46, 0.08);
    --amber: #9a6700;
    --amber-soft: rgba(154, 103, 0, 0.1);
    --purple: #8250df;
    --shadow: 0 1px 3px rgba(31, 35, 40, 0.06), 0 1px 2px rgba(31, 35, 40, 0.04);
    --radius: 10px;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
/* #2559: an embedding host can pin the face explicitly (?theme=light|dark →
   <html data-theme=…>) because a host APP-level theme is invisible to the
   framed document's prefers-color-scheme. An explicit pin outranks the OS
   signal, so the media query below is narrowed to documents WITHOUT one;
   the pinned palette repeats the same list (CSS cannot share declarations
   across media boundaries — keep the two lists in sync). */
@media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
        --bg: #0d1117;
        --bg-elev: #161b22;
        --bg-muted: #1c2129;
        --border: #30363d;
        --border-soft: #21262d;
        --text: #e6edf3;
        --text-muted: #8b949e;
        --text-faint: #6e7681;
        --accent: #4493f8;
        --accent-soft: rgba(68, 147, 248, 0.14);
        --green: #3fb950;
        --green-soft: rgba(63, 185, 80, 0.14);
        --red: #f85149;
        --red-soft: rgba(248, 81, 73, 0.12);
        --amber: #d29922;
        --amber-soft: rgba(210, 153, 34, 0.14);
        --purple: #a371f7;
        --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }
}
:root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-muted: #1c2129;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-faint: #6e7681;
    --accent: #4493f8;
    --accent-soft: rgba(68, 147, 248, 0.14);
    --green: #3fb950;
    --green-soft: rgba(63, 185, 80, 0.14);
    --red: #f85149;
    --red-soft: rgba(248, 81, 73, 0.12);
    --amber: #d29922;
    --amber-soft: rgba(210, 153, 34, 0.14);
    --purple: #a371f7;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
:root[data-theme="light"] {
    color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
    font-size: 14px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
}
.mono { font-family: var(--mono); font-size: 0.92em; }
.dim { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.small { font-size: 12px; }

.topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 16px;
    padding: 0 20px; height: 52px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: 8px; font-weight: 650; font-size: 15px; white-space: nowrap; }
.brand .logo { font-size: 17px; }
.brand .ver { font-weight: 400; font-size: 11px; color: var(--text-faint); font-family: var(--mono); }
.nav { display: flex; gap: 2px; flex: 1; overflow-x: auto; }
.nav a {
    padding: 6px 12px; border-radius: 8px; text-decoration: none;
    color: var(--text-muted); font-size: 13.5px; white-space: nowrap;
}
.nav a:hover { background: var(--bg-muted); color: var(--text); }
.nav a.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.topbar .actions { display: flex; gap: 8px; align-items: center; }
.fork-link { font-size: 12px; color: var(--text-muted); text-decoration: none; white-space: nowrap; }
.fork-link:hover { color: var(--accent); }
.lang-btn {
    border: 1px solid var(--border); background: var(--bg); color: var(--text-muted);
    border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.lang-btn:hover { border-color: var(--accent); color: var(--accent); }

.banner { display: none; margin: 14px 20px 0; padding: 10px 14px; border-radius: var(--radius); font-size: 13px; border: 1px solid; }
.banner.show { display: block; }
.banner.warn { background: var(--amber-soft); border-color: var(--amber); color: var(--amber); }
.banner.err { background: var(--red-soft); border-color: var(--red); color: var(--red); }
.banner.info { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.banner .banner-title { font-weight: 600; margin-bottom: 6px; }
.banner .banner-upgrade-now { display: block; margin-top: 8px; padding: 4px 12px; border: 1px solid currentColor; border-radius: var(--radius); background: transparent; color: inherit; font-size: 12.5px; cursor: pointer; }
.banner .banner-upgrade-now:disabled { opacity: 0.55; cursor: default; }
.banner .alert-row, .card .alert-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.banner .alert-row > span, .card .alert-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }

main { max-width: 1200px; margin: 0 auto; padding: 20px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h1 { font-size: 19px; margin: 0; font-weight: 650; }
.page-head .sub { font-size: 12.5px; color: var(--text-muted); margin-top: 2px; }

.card {
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    margin-bottom: 16px;
    overflow: hidden;
}
.card-h {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid var(--border-soft);
    font-weight: 650; font-size: 13.5px;
}
.card-h .hint { font-weight: 400; font-size: 12px; color: var(--text-muted); }
.card-b { padding: 16px; }
.card-b.flush { padding: 0; }

.grid { display: grid; gap: 16px; }
.grid.cols-2 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.grid.cols-4 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }

.stat { background: var(--bg-elev); border: 1px solid var(--border-soft); border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow); }
.stat .k { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.stat .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.stat .v small { font-size: 12px; font-weight: 400; color: var(--text-muted); margin-left: 4px; }
.stat .s { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; }
.stat.good .v { color: var(--green); }
.stat.bad .v { color: var(--red); }

table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
table.data th {
    text-align: left; padding: 7px 9px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--text-muted); border-bottom: 1px solid var(--border); background: var(--bg-muted);
    white-space: nowrap;
}
table.data td { padding: 7px 9px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
table.data tr:last-child td { border-bottom: none; }
table.data tbody tr { cursor: pointer; }
table.data tbody tr:hover { background: var(--bg-muted); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12px; }

.badge {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    border: 1px solid transparent; white-space: nowrap;
}
.badge.live { background: var(--green-soft); color: var(--green); border-color: var(--green); }
.badge.disk { background: var(--bg-muted); color: var(--text-muted); border-color: var(--border); }
.badge.proto { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-family: var(--mono); font-weight: 500; }
.badge.ext { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-family: var(--mono); font-weight: 500; }
.badge.warn { background: var(--amber-soft); color: var(--amber); border-color: var(--amber); }
.badge.ok { background: var(--green-soft); color: var(--green); border-color: var(--green); }

.bar-track { height: 6px; border-radius: 3px; background: var(--bg-muted); overflow: hidden; min-width: 70px; }
.bar-fill { height: 100%; border-radius: 3px; background: var(--accent); }
.bar-fill.good { background: var(--green); }
.bar-fill.warn { background: var(--amber); }
.bar-fill.bad { background: var(--red); }

.btn {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
    border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer;
    text-decoration: none;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { filter: brightness(1.08); color: #fff; }
.btn.busy { opacity: 0.55; pointer-events: none; }
.btn.sm { padding: 3px 8px; font-size: 11.5px; border-radius: 6px; }

.kv { display: grid; grid-template-columns: 170px 1fr; row-gap: 7px; column-gap: 16px; font-size: 13px; }
.kv .k { color: var(--text-muted); }
.kv .v { word-break: break-all; }

.codebox {
    background: var(--bg-muted); border: 1px solid var(--border-soft); border-radius: 8px;
    padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6;
    white-space: pre-wrap; word-break: break-all; margin: 0;
}
.copy-row { display: flex; gap: 8px; align-items: flex-start; }
.copy-row .codebox { flex: 1; }

.section-label { font-size: 12px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin: 18px 0 8px; }
.section-label:first-child { margin-top: 0; }

.chart-wrap { width: 100%; overflow-x: auto; position: relative; }
.chart-wrap svg { display: block; width: 100%; height: auto; }
#traj-chart { cursor: crosshair; user-select: none; }
.chart-status { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.chart-status[hidden] { display: none; }
.chart-brush { position: absolute; background: rgba(9, 105, 218, 0.15); border-left: 1px solid #0969da; border-right: 1px solid #0969da; pointer-events: none; }
.chart-legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-top: 8px; flex-wrap: wrap; }
.chart-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }

.blocks-list { max-height: 420px; overflow-y: auto; }
.block-item .body.md p, .bd-panel .body.md p { margin: 6px 0; }

/* Changelog section (#3719): collapsible releases inside the overview card */
.cl-card summary { list-style: none; cursor: pointer; padding: 12px 16px; font-weight: 600; font-size: 13px; display: flex; gap: 8px; align-items: center; }
.cl-card summary::-webkit-details-marker { display: none; }
.cl-card summary::before { content: "\25B8"; color: var(--text-muted); font-size: 11px; transition: transform .12s; }
.cl-card[open] summary::before { transform: rotate(90deg); }
.cl-card summary:hover { background: var(--bg-muted); }
.cl-item { border-bottom: 1px solid var(--border-soft); }
.cl-item:last-of-type { border-bottom: none; }
.cl-item summary { list-style: none; cursor: pointer; padding: 8px 16px; font-family: var(--mono); font-size: 12px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.cl-item summary::-webkit-details-marker { display: none; }
/* #3719 phase 2: 更新/Updates tab — pushed-notice rows + tier badges */
.ntc-item { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 7px 0; border-bottom: 1px solid var(--border-soft); }
.ntc-item:last-child { border-bottom: none; padding-bottom: 0; }
.badge.ntc-critical { background: var(--red-soft); color: var(--red); border-color: var(--red); }
.badge.ntc-recommended { background: var(--amber-soft); color: var(--amber); border-color: var(--amber); }
.cl-item summary:hover { background: var(--bg-muted); }
.cl-item > div { white-space: normal; overflow-wrap: anywhere; }
.cl-item .cl-tag { font-weight: 700; }
.badge.cl-latest { background: var(--green-soft); color: var(--green); border-color: var(--green); }
.cl-body { padding: 12px 16px 4px 32px; font-size: 12.5px; line-height: 1.65; color: var(--text-soft, var(--text-muted)); }
.cl-body .cl-h { font-size: 13px; font-weight: 700; color: var(--text); margin: 12px 0 4px; padding-bottom: 3px; border-bottom: 1px solid var(--border-soft); }
.cl-body .cl-p { margin: 5px 0; }
.cl-body .cl-li { margin: 3px 0; padding-left: 15px; position: relative; }
.cl-body .cl-li::before { content: "\2022"; position: absolute; left: 3px; color: var(--text-muted); font-weight: 700; }
.cl-foot { margin: 10px 0 2px; }
.cl-cat { display: flex; gap: 8px; align-items: baseline; margin: 12px 0 3px; padding-top: 8px; border-top: 1px solid var(--border-soft); font-weight: 700; font-size: 12.5px; color: var(--text); }
.cl-body .cl-cat:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.cl-cat .dim { font-weight: 400; font-size: 11.5px; }
.cl-actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
details.cl-item.cl-flash { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--accent-soft); transition: background .4s ease-out; }
.block-item .body.md h2, .bd-panel .body.md h2, .block-item .body.md h3, .bd-panel .body.md h3, .block-item .body.md h4, .bd-panel .body.md h4 { margin: 12px 0 6px; line-height: 1.35; color: var(--text); }
.block-item .body.md h2, .bd-panel .body.md h2 { font-size: 13.5px; } .block-item .body.md h3, .bd-panel .body.md h3 { font-size: 13px; } .block-item .body.md h4, .bd-panel .body.md h4 { font-size: 12.5px; }
.block-item .body.md ul, .bd-panel .body.md ul, .block-item .body.md ol, .bd-panel .body.md ol { margin: 6px 0; padding-left: 22px; }
.block-item .body.md li, .bd-panel .body.md li { margin: 2px 0; }
.block-item .body.md pre, .bd-panel .body.md pre { background: var(--bg-muted); border: 1px solid var(--border-soft); border-radius: 8px; padding: 8px 10px; overflow-x: auto; font-size: 11.5px; white-space: pre; max-height: 320px; }
.block-item .body.md code, .bd-panel .body.md code { font-family: var(--mono); font-size: 0.92em; background: var(--bg-muted); padding: 1px 5px; border-radius: 5px; }
.block-item .body.md pre code, .bd-panel .body.md pre code { background: none; padding: 0; }
.block-item .body.md blockquote, .bd-panel .body.md blockquote { margin: 6px 0; padding: 5px 10px; border-left: 3px solid var(--border); background: var(--bg-muted); border-radius: 0 8px 8px 0; }
.block-item .body.md hr, .bd-panel .body.md hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
.block-item .body.md strong, .bd-panel .body.md strong { color: var(--text); }

/* #3917: detail-page panes + compression tree */
.det-tabs { display: flex; gap: 4px; margin: 16px 0 0; border-bottom: 1px solid var(--border); }
.det-tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 14px; font-size: 13px; font-weight: 600; color: var(--text-muted); cursor: pointer; }
.det-tab:hover { color: var(--text); }
.det-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.det-tab .hint { font-weight: 400; }
.det-pane { margin-top: 16px; }
.tree-stats { display: flex; gap: 16px; flex-wrap: wrap; padding: 2px 0 10px; color: var(--text-muted); }
.tree-actions { display: flex; gap: 8px; margin: 0 0 10px; flex-wrap: wrap; }
/* #3917: list ⇄ graph switch for the compression pane, plus the graph itself
   (layered block boxes on a light canvas, tier-tinted borders). */
.tree-modes { display: flex; gap: 6px; margin: 0 0 10px; align-items: center; }
.tree-modes .hint { flex: 1; font-size: 11px; color: var(--text-muted); }
.tree-mode { color: var(--text-muted); }
.tree-mode.active { color: var(--accent); border-color: var(--accent); background: var(--bg-muted); }
.g-svg { display: block; max-width: 100%; height: auto; }
/* #4173 review: the live map flows WITH the page — no inner scroll box, so a
   long session reads as one continuous document (drawing on top, list below).
   The drawing keeps full-size fonts unless it is the compact map. */
.tm-view { position: relative; }
/* zoom resizes .tm-inner; the browser scales the svg uniformly to fill it. */
.tm-inner { position: relative; margin: 0 auto; }
.g-edge { stroke: var(--accent); stroke-width: 1.6; opacity: .5; }
.g-node { cursor: pointer; }
.g-node rect { fill: #fff; stroke: var(--border-soft); stroke-width: 1.4; }
.g-node.tier-1 rect { stroke: var(--accent); fill: #f2f7ff; }
.g-node.tier-2 rect { stroke: #7a5af8; fill: #f6f3ff; }
.g-node.tier-3 rect { stroke: #bf8700; fill: #fffaf0; }
.g-node.tier-n rect { stroke: #8a8f99; fill: #f7f8fa; }
.g-node.inactive rect { stroke: var(--border-soft); fill: var(--bg-muted); stroke-dasharray: 4 3; }
.g-node.inactive text { opacity: .5; }
.g-node:hover rect { stroke-width: 2.4; }
.g-id { font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--text); }
.g-meta { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--text-muted); }
.blk-sum.clamp { display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.blk-sum-toggle { margin-top: 6px; }
.blk-content-meta { color: var(--text-muted); margin-bottom: 6px; }
.blk-msgs { list-style: none; margin: 0 16px 10px 70px; padding: 0; border-left: 1px dashed var(--border-soft); }
.blk-msgs li { margin: 0; }
.msg-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 0; border-radius: 6px; padding: 4px 6px; cursor: pointer; color: var(--text-muted); font: inherit; }
.msg-row:hover { background: var(--bg-muted); color: var(--text); }
.msg-row.missing { cursor: default; opacity: .65; }
.msg-row.missing:hover { background: none; color: var(--text-muted); }
.msg-row .mref { color: var(--text); font-size: 12px; flex: none; }
.msg-row .mprev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 12px; }
.msg-row .badge { flex: none; }
.blk-msgs .msg-body { margin: 0 6px 8px 8px; }
.blk-msgs .msg-body .blk-content-pre { max-height: 320px; }
.blk-content-pre { background: var(--bg-muted); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 12px; overflow: auto; max-height: 420px; white-space: pre-wrap; word-break: break-word; }
.blk-content-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 4px; }
.blk-content { margin-bottom: 12px; }
.warn-text { color: #bf8700; }

/* #4608: master-detail compression pane — the collapsible tree (default)
   or the classic folded-block list on the left; in tree mode the
   selected block rides the sticky right pane. */
.fd-grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 14px; align-items: start; margin-top: 2px; }
@media (max-width: 1180px) { .fd-grid { grid-template-columns: 1fr; } }
.fd-grid.list-mode { grid-template-columns: minmax(0, 1fr); }
.fd-left { border: 1px solid var(--border-soft); border-radius: 10px; background: var(--bg-elev); overflow: auto; max-height: calc(100vh - 240px); padding: 8px; }
.g-node.fsel rect { stroke: var(--accent); stroke-width: 2.6; }
.g-topic { font-size: 11.5px; font-weight: 600; fill: var(--text); }
.tchip { cursor: pointer; }
.tchip rect { fill: var(--bg-muted); stroke: var(--border-soft); }
.tchip:hover rect { stroke: var(--accent); }
.tchip text { font-size: 10px; font-weight: 700; fill: var(--text-muted); text-anchor: middle; }
.fd-side { min-width: 0; }
.bd-card { border: 1px solid var(--border-soft); border-radius: 10px; position: sticky; top: 12px; max-height: calc(100vh - 240px); overflow-y: auto; }
.bd-panel { padding-bottom: 14px; }
.bd-panel .bd-head { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.bd-panel .bd-head .mono { color: var(--text-faint, var(--text-muted)); font-size: 12px; }
.bd-panel .topic { font-weight: 600; font-size: 13.5px; margin: 8px 0 2px; color: var(--text); }
.bd-panel .meta { color: var(--text-muted); font-size: 11.5px; margin-bottom: 4px; }
.bd-panel .body.md { white-space: normal; font-size: 12.5px; color: var(--text-muted); }
.bd-panel .blk-msgs { margin-left: 16px; }
.handoff { font-size: 13.5px; line-height: 1.65; }
.handoff h1, .handoff h2, .handoff h3, .handoff h4 { margin: 18px 0 8px; line-height: 1.3; }
.handoff h1 { font-size: 17px; } .handoff h2 { font-size: 15.5px; } .handoff h3 { font-size: 14px; }
.handoff p { margin: 8px 0; }
.handoff pre { background: var(--bg-muted); border: 1px solid var(--border-soft); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12px; }
.handoff code { font-family: var(--mono); font-size: 0.92em; background: var(--bg-muted); padding: 1px 5px; border-radius: 5px; }
.handoff pre code { background: none; padding: 0; }
.handoff ul, .handoff ol { margin: 8px 0; padding-left: 22px; }
.handoff li { margin: 3px 0; }
.handoff blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--border); color: var(--text-muted); background: var(--bg-muted); border-radius: 0 8px 8px 0; }
.handoff hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
/* #1426: message-role dividers in the handoff doc (### user / assistant / tool) */
.handoff h3.msg-role { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; margin: 20px 0 4px; padding-top: 12px; border-top: 1px solid var(--border); }
.handoff h3.msg-role::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
.handoff h3.msg-role.user::before { background: #1a7f37; }
.handoff h3.msg-role.tool::before { background: #bf8700; }
.handoff pre { max-height: 340px; }
.handoff a { color: var(--accent); }

.empty { text-align: center; color: var(--text-muted); padding: 48px 16px; font-size: 13.5px; }
.empty .big { font-size: 34px; margin-bottom: 10px; }

.toast-host { position: fixed; bottom: 18px; right: 18px; display: flex; flex-direction: column; gap: 8px; z-index: 100; }
.toast {
    background: var(--bg-elev); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 9px 14px; font-size: 12.5px; box-shadow: var(--shadow);
    animation: toast-in 0.18s ease-out; max-width: 380px;
}
.toast.ok { border-left-color: var(--green); }
.toast.err { border-left-color: var(--red); }
@keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }

.spin { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 720px) {
    .topbar { flex-wrap: wrap; height: auto; min-height: 52px; padding: 10px 12px; gap: 10px; }
    .topbar .actions { margin-left: auto; }
    .fork-link { display: none; }
    .nav { order: 3; flex: 1 1 100%; min-width: 0; }
    table.data th:nth-child(n + 6), table.data td:nth-child(n + 6) { display: none; }
    /* hiding TDs frees nothing under table-layout: fixed — the <col> tracks of
       the hidden columns still claim their px, so the SESSION column (the only
       auto track) collapses to a sliver and its nowrap title overflows onto the
       adjacent cells (double-exposed rows). Zero the hidden tracks so the freed
       space lands on the title column again. */
    table.data colgroup col:nth-child(n + 6) { width: 0 !important; }
    main { padding: 12px; }
    .kv { grid-template-columns: 1fr; row-gap: 3px; }
    .kv .k { margin-top: 6px; }
}

[hidden] { display: none !important; }
.search { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; max-width: 280px; outline: none; }
.search:focus { border-color: var(--accent); }
.ses-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.ses-filter { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 8px; font-size: 12.5px; max-width: 190px; outline: none; }
.ses-filter:focus { border-color: var(--accent); }
.ses-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: -6px 0 10px; }
.ses-pager { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 10px; }
.ses-pager #ses-page-label { min-width: 110px; text-align: center; font-variant-numeric: tabular-nums; }
.ses-pager button:disabled { opacity: 0.45; cursor: default; }
@media (max-width: 720px) {
    .ses-toolbar { justify-content: flex-start; }
    .ses-toolbar .search { flex: 1 1 220px; max-width: none; }
    .ses-filter { flex: 1 1 140px; max-width: none; }
}
.route-block { padding: 10px 0; border-bottom: 1px solid var(--border); }
.route-block:last-child { border-bottom: none; padding-bottom: 0; }
.route-key { font-weight: 600; font-size: 13px; margin-bottom: 6px; word-break: break-all; }
table.mini { width: 100%; border-collapse: collapse; margin: 2px 0 6px; font-size: 12px; }
table.mini th, table.mini td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); }
table.mini th { color: var(--text-muted); font-weight: 500; }
table.mini tr:last-child td { border-bottom: none; }
.good-num { color: var(--green); }
.row-title { font-weight: 500; max-width: 340px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
tr[title] { cursor: pointer; }
.chart-svg { width: 100%; height: auto; display: block; }
.chart-empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
.stat .s { font-size: 11px; color: var(--text-muted); }
.bar-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
.bar-fill.warn { background: #d29922; }
.bar-fill.danger { background: #cf222e; }
pre.small-pre { max-height: 220px; overflow: auto; }
.modes { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 10px; }
.modes label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); cursor: pointer; user-select: none; }
.field-input { width: 100%; border: 1px solid var(--border); background: var(--bg-muted); color: var(--text); border-radius: 8px; padding: 7px 10px; font-size: 13px; outline: none; }
.field-input:focus { border-color: var(--accent); }
.editor { width: 100%; min-height: 240px; resize: vertical; border: 1px solid var(--border); background: var(--bg-muted); color: var(--text); border-radius: 8px; padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.55; tab-size: 2; white-space: pre; overflow: auto; outline: none; }
.editor:focus { border-color: var(--accent); }
.editor:disabled { opacity: 0.6; cursor: not-allowed; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid var(--border); background: var(--bg-muted); border-radius: 999px; padding: 4px 12px; font-size: 12px; color: var(--text-muted); }
.slink { display: block; color: inherit; text-decoration: none; }
.slink:hover .row-title { color: var(--accent); text-decoration: underline; }
.row-id { display: block; margin-top: 3px; font-family: var(--mono); font-size: 11px; color: var(--text-faint); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-row { display: flex; align-items: center; gap: 10px; }

/* #1426 handoff structured rendering */
.msg-think { margin: 8px 0; }
.msg-think summary { cursor: pointer; font-size: 12.5px; color: var(--text-muted); font-weight: 600; }
.think-box { margin-top: 6px; padding: 8px 12px; border-left: 3px solid rgba(130, 80, 223, 0.45); background: var(--bg-elev); border-radius: 0 8px 8px 0; font-size: 12.5px; line-height: 1.55; color: var(--text-muted); word-break: break-word; white-space: normal; }
.msg-out { margin: 8px 0; font-size: 13px; line-height: 1.55; word-break: break-word; }
.msg-tool, .msg-result { margin: 8px 0; padding: 8px 10px; background: var(--bg-elev); border: 1px solid var(--border-soft); border-radius: 8px; }
.tool-chip { display: inline-flex; align-items: center; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--bg-muted); color: var(--text-muted); margin-right: 8px; font-family: var(--mono); }
.tool-chip.t-shell { background: #1f2328; color: #ffffff; }
.tool-chip.t-file { background: #ddf4ff; color: #0969da; }
.tool-chip.t-seek { background: #dafbe1; color: #1a7f37; }
.tool-chip.t-fold { background: #fbefff; color: #8250df; }
.tool-cid { font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); }
pre.tool-args, pre.tool-out { margin: 6px 0 0; padding: 8px; background: var(--bg-muted); border-radius: 6px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
.fold-scroll { max-height: 400px; overflow: auto; border: 1px solid var(--border-soft); border-radius: 8px; padding: 2px 8px 8px; }
.seam-ev { border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--bg-elev); box-shadow: var(--shadow); overflow: hidden; }
.seam-ev summary { list-style: none; cursor: pointer; padding: 12px 16px; font-size: 13.5px; font-weight: 650; display: flex; align-items: baseline; gap: 8px; }
.seam-ev summary::-webkit-details-marker { display: none; }
.seam-ev[open] summary { border-bottom: 1px solid var(--border-soft); }
table:is(.event-table, .fold-table) { min-width: 38rem; table-layout: fixed; }
table:is(.event-table, .fold-table) th, table:is(.event-table, .fold-table) td { padding: 8px 14px; white-space: nowrap; text-align: center; }
table:is(.event-table, .fold-table) th:first-child, table:is(.event-table, .fold-table) td:first-child { width: 8%; text-align: left; }
table:is(.event-table, .fold-table) th:nth-child(2) { width: 20%; }
table.event-table th:nth-child(3), table.event-table th:nth-child(4) { width: 14%; }
table:is(.event-table, .fold-table) th:last-child, table:is(.event-table, .fold-table) td:last-child { text-align: right; }
table.event-table td:last-child { white-space: normal; overflow-wrap: anywhere; }
table:is(.event-table, .fold-table) tbody tr { cursor: default; }
table.data.fold-table th, table.data.fold-table td { display: table-cell; }
.qmark { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 5px; border-radius: 50%; background: var(--bg-muted); color: var(--text-faint); font-size: 10px; line-height: 1; cursor: pointer; user-select: none; vertical-align: -2px; flex: none; }
.qmark:hover { color: var(--accent); }
.qtip { position: fixed; z-index: 60; max-width: 380px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15); padding: 10px 12px; font-size: 12.5px; line-height: 1.55; color: var(--text-muted); }
.twrap { overflow-x: auto; }
.tproc table.data { min-width: 520px; }
.twide table.data { min-width: 940px; table-layout: fixed; }
.hitc { font-size: 11px; letter-spacing: -0.2px; }
.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.client-cell { min-width: 0; }
.w-client { display: inline-block; max-width: 100%; vertical-align: bottom; }
.w-title { display: inline-block; max-width: 230px; vertical-align: bottom; }
.w-up { display: inline-block; max-width: 128px; vertical-align: bottom; }
.copy-btn.copied, .btn.copied { border-color: var(--green); color: var(--green); background: var(--green-soft); }
.tproc th.num, .tproc td.num { text-align: center; }
.copied-hint { position: fixed; z-index: 60; transform: translate(-50%, 4px); background: var(--bg); border: 1px solid var(--border); color: var(--green); font-size: 12px; line-height: 1; padding: 5px 11px; border-radius: 14px; box-shadow: 0 4px 14px rgba(0, 0, 0, .12); pointer-events: none; white-space: nowrap; animation: copied-pop 1.4s ease forwards; }
@keyframes copied-pop {
    0% { opacity: 0; transform: translate(-50%, 4px); }
    12% { opacity: 1; transform: translate(-50%, 0); }
    78% { opacity: 1; transform: translate(-50%, 0); }
    100% { opacity: 0; transform: translate(-50%, -3px); }
}
.twide table.data th, .twide table.data td { padding-left: 7px; padding-right: 7px; }
.twide .w-title { max-width: 200px; }
.twide .w-up { max-width: 112px; }
.twide .badge { white-space: normal; }
.logbox { font-family: var(--mono); font-size: 11.5px; line-height: 1.5; padding: 12px 14px; max-height: 72vh; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--bg-muted); border-radius: 0 0 8px 8px; margin: 0; color: var(--text); }
/* Log view rows (filtered mode): actual hits vs context / time-window lines. */
.lm-ctx { opacity: 0.55; }
.lm-hit { background: rgba(94, 164, 255, 0.14); border-radius: 3px; }
#summary-settings { margin-top: 16px; }
.summary-target { min-width: 0; margin: 14px 0; padding: 12px; border: 1px solid var(--border); border-radius: 4px; }
.summary-target legend { max-width: 100%; overflow-wrap: anywhere; font-size: 13px; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; margin-bottom: 12px; }
.summary-grid label { display: grid; gap: 5px; min-width: 0; font-size: 12px; }
#summary-settings .field-input { width: 100%; min-width: 0; box-sizing: border-box; }
.summary-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
.summary-creds { margin: 14px 0; }
.summary-creds h4 { margin: 0 0 8px; font-size: 13px; }
.summary-actions label:has(input[type="password"]) { display: grid; gap: 5px; flex: 1 1 200px; min-width: 0; font-size: 12px; }
.summary-actions .btn { min-height: 32px; }

/* #2321: embeddable face (?embed=1) — framed inside a host settings page
   (dsh). The host draws its own chrome and tab bar, so ours hides; tokens
   flatten toward dsh-like values: transparent ground, translucent gray
   borders, no shadow, 8px radius. Text colors keep following the scheme. */
.embed .topbar { display: none; }
.embed {
    --shadow: none;
    --radius: 8px;
    --bg: transparent;
    --bg-elev: rgba(127, 127, 127, 0.05);
    --bg-muted: rgba(127, 127, 127, 0.09);
    --border: rgba(127, 127, 127, 0.4);
    --border-soft: rgba(127, 127, 127, 0.22);
}
/* #2448: the embed face lives in a NARROW host panel (a dsh settings
   column), never a full browser tab — reuse the phone-compact column set
   (cols 6+ hidden, same as the ≤720px rule) at ANY width and drop the
   standalone-page min-widths so the tables fit the panel instead of
   scrolling sideways. */
.embed .tproc table.data { min-width: 0; }
.embed .twide table.data { min-width: 0; }
.embed table.data th:nth-child(n + 6), .embed table.data td:nth-child(n + 6) { display: none; }
/* same fixed-layout trap as the ≤720px rule above — the hidden
   columns' <col> tracks must release their widths or the title column
   collapses and rows render double-exposed. */
.embed table.data colgroup col:nth-child(n + 6) { width: 0 !important; }
/* #4362: except the fold-detail table — its six numeric columns are the
   payload of the session detail view, so they stay visible on the narrow
   embed face too (horizontal scroll inside .fold-scroll instead). */
.embed table.data.fold-table th:nth-child(n + 6), .embed table.data.fold-table td:nth-child(n + 6) { display: table-cell; }
.embed .twide table.data th, .embed .twide table.data td { padding-left: 5px; padding-right: 5px; }
/* #2560: the frame hugs its edges hard at narrow panel widths — give the
   embed face a little breathing room instead of zero gutter. */
.embed main { max-width: none; padding: 8px 10px 16px; }
.embed .banner { margin: 8px 0 0; }


/* #4587: panel-embedded blog & article view (#/blog index + #/blog/<slug> pages) */
.bl-row { display: flex; align-items: baseline; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border-soft); text-decoration: none; color: inherit; }
.bl-row:last-child { border-bottom: none; }
.bl-row:hover .bl-title { color: var(--accent); }
.bl-date { color: var(--text-faint); font-size: 12px; }
.bl-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl-title-alt { color: var(--text-faint); font-weight: 400; }
.bl-arrow { color: var(--text-faint); font-size: 12px; }
.bl-back { color: var(--accent); text-decoration: none; font-size: 12px; }
.bl-back:hover { text-decoration: underline; }
.bl-h { margin: 10px 0 0; font-size: 20px; line-height: 1.35; }
.post-body p { line-height: 1.7; }
.post-body pre { background: var(--bg-elev); border: 1px solid var(--border-soft); border-radius: 8px; padding: 12px; overflow-x: auto; }
.post-body code { font-family: var(--mono); font-size: 0.92em; background: var(--bg-elev); padding: 1px 5px; border-radius: 4px; }
.post-body pre code { background: none; padding: 0; }
.post-body blockquote { border-left: 3px solid var(--accent); margin: 12px 0; padding: 4px 14px; color: var(--text-muted); background: var(--bg-elev); border-radius: 0 8px 8px 0; }
.post-body h2 { margin-top: 22px; }
.post-body .md-img { max-width: 100%; border-radius: 8px; border: 1px solid var(--border-soft); }

/* #4608: classic folded-block list — the #3917 rows came back next to
   the tree reading (owner decision: keep the master-folded list, drop
   the flame chart). Rules sit after the shared .block-item typography
   on purpose: .block-node overrides must win the cascade. */
.block-item { border-bottom: 1px solid var(--border-soft); }
.block-item:last-child { border-bottom: none; }
.block-item summary { list-style: none; cursor: pointer; padding: 9px 16px; display: flex; gap: 10px; align-items: baseline; }
.block-item summary::-webkit-details-marker { display: none; }
.block-item summary:hover { background: var(--bg-muted); }
.block-item .bid { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); min-width: 52px; }
.block-item .topic { font-weight: 600; font-size: 13px; flex: 1; }
.block-item .meta { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
.block-item .body { padding: 0 16px 12px 78px; font-size: 12.5px; color: var(--text-muted); white-space: pre-wrap; }
.block-item .body.md { white-space: normal; }
.tier-1 summary .bid { color: var(--accent); }
.block-tree { max-height: 70vh; overflow-y: auto; border-top: 1px solid var(--border-soft); }
.block-node.flash { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
.block-node .block-node { margin-left: 18px; border-left: 2px solid var(--border-soft); }
.block-node summary { align-items: center; flex-wrap: wrap; row-gap: 4px; }
.block-node summary .blk-copy { margin-left: auto; flex: none; }
.block-node summary .meta { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.block-node .topic { flex: 1 1 140px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.block-node .body { padding: 0 16px 10px 70px; }
.block-node .blk-content-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 0 16px 8px 70px; }
.block-node .blk-content { margin: 0 16px 12px 70px; }
`;
