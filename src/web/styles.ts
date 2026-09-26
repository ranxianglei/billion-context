export const WEB_STYLES = String.raw`
:root {
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
@media (prefers-color-scheme: dark) {
    :root {
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

table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
table.data th {
    text-align: left; padding: 9px 12px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--text-muted); border-bottom: 1px solid var(--border); background: var(--bg-muted);
    position: sticky; top: 52px; z-index: 2;
}
table.data td { padding: 9px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
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

.chart-wrap { width: 100%; overflow-x: auto; }
.chart-wrap svg { display: block; width: 100%; height: auto; }
.chart-legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); margin-top: 8px; flex-wrap: wrap; }
.chart-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }

.blocks-list { max-height: 420px; overflow-y: auto; }
.block-item { border-bottom: 1px solid var(--border-soft); }
.block-item:last-child { border-bottom: none; }
.block-item summary { list-style: none; cursor: pointer; padding: 9px 16px; display: flex; gap: 10px; align-items: baseline; }
.block-item summary::-webkit-details-marker { display: none; }
.block-item summary:hover { background: var(--bg-muted); }
.block-item .bid { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); min-width: 52px; }
.block-item .topic { font-weight: 600; font-size: 13px; flex: 1; }
.block-item .meta { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
.block-item .body { padding: 0 16px 12px 78px; font-size: 12.5px; color: var(--text-muted); white-space: pre-wrap; }

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
    table.data th:nth-child(n + 6), table.data td:nth-child(n + 6) { display: none; }
    main { padding: 12px; }
    .kv { grid-template-columns: 1fr; row-gap: 3px; }
    .kv .k { margin-top: 6px; }
}

[hidden] { display: none !important; }
.search { border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 13px; max-width: 280px; outline: none; }
.search:focus { border-color: var(--accent); }
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
`;
