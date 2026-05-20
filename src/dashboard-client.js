(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AssemblyDashboard = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var lastOverviewHash = '';
  var lastDetailHash = '';

  function __resetHashes() { lastOverviewHash = ''; lastDetailHash = ''; }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeJs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function fmtCost(usd) {
    if (usd == null || usd === 0) return '$0.00';
    if (usd < 0.01) return (usd * 100).toFixed(2) + '\u00a2';
    return '$' + usd.toFixed(2);
  }

  function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var remainSec = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + (remainSec > 0 ? remainSec + 's' : '');
    var hours = Math.floor(minutes / 60);
    var remainMin = minutes % 60;
    return hours + 'h ' + (remainMin > 0 ? remainMin + 'm' : '');
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    var now = Date.now();
    var then = new Date(isoString).getTime();
    var diffMs = now - then;
    if (diffMs < 0) return 'just now';
    if (diffMs < 60000) return Math.floor(diffMs / 1000) + 's ago';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    return Math.floor(diffMs / 86400000) + 'd ago';
  }

  // Render the per-station tool-rounds subline used inside the drawer's
  // station timeline. Takes the rounds object ({ turns, tools }) and returns
  // an HTML string, or '' when the rounds field is missing / empty.
  // Tools are sorted by count descending; top 6 shown, remainder collapsed
  // into "+K more (N)".
  function renderStationRounds(rounds) {
    if (!rounds) return '';
    var turns = rounds.turns || 0;
    var tools = rounds.tools || {};
    var toolNames = Object.keys(tools);
    if (turns <= 0 && toolNames.length === 0) return '';

    var entries = [];
    for (var i = 0; i < toolNames.length; i++) {
      entries.push([toolNames[i], tools[toolNames[i]] || 0]);
    }
    entries.sort(function(a, b) { return b[1] - a[1]; });

    var parts = [];
    var hiddenCount = 0;
    var hiddenTotal = 0;
    for (var j = 0; j < entries.length; j++) {
      if (j < 6) {
        parts.push(esc(entries[j][0]) + '\u00d7' + entries[j][1]);
      } else {
        hiddenCount++;
        hiddenTotal += entries[j][1];
      }
    }
    if (hiddenCount > 0) {
      parts.push('+' + hiddenCount + ' more (' + hiddenTotal + ')');
    }

    var html = '<div class="timeline-rounds">';
    html += '<span class="timeline-rounds-turns">' + turns + ' turn' + (turns !== 1 ? 's' : '') + '</span>';
    if (parts.length > 0) {
      html += '<span class="timeline-rounds-tools"> \u00b7 ' + parts.join(', ') + '</span>';
    }
    html += '</div>';
    return html;
  }

  function metricCard(label, count, cls) {
    return '<div class="metric-card ' + cls + '">' +
      '<div class="label">' + label + '</div>' +
      '<div class="count">' + count + '</div>' +
      '</div>';
  }

  function healthIcon(state) {
    if (state === 'idle') return '\u2713';
    if (state === 'processing') return '\u21bb';
    if (state === 'queued') return '\u25b3';
    if (state === 'errors') return '\u2717';
    return '';
  }

  function buildHealthChip(health) {
    if (!health) return '';
    var label = health.state === 'idle' ? 'Idle' :
                health.state === 'processing' ? 'Processing ' + health.count :
                health.state === 'queued' ? 'Queued ' + health.count :
                health.count + ' error' + (health.count !== 1 ? 's' : '');
    return '<div class="health-chip ' + health.state + '">' +
      '<span class="health-icon">' + healthIcon(health.state) + '</span>' +
      '<span>' + esc(label) + '</span>' +
      '</div>';
  }

  function isSectionExpanded(sectionId) {
    try {
      return localStorage.getItem('assembly-dash-section-' + sectionId) === '1';
    } catch(e) {
      return false;
    }
  }

  var MORPH_OPTIONS = {
    childrenOnly: true,
    getNodeKey: function(el) {
      if (!el || el.nodeType !== 1) return undefined;
      return el.getAttribute('data-key') || el.id || undefined;
    },
    onBeforeElUpdated: function(fromEl, toEl) {
      if (fromEl.isEqualNode(toEl)) return false;
      var preserve = (fromEl.hasAttribute && fromEl.hasAttribute('data-preserve')) ||
                     (toEl && toEl.hasAttribute && toEl.hasAttribute('data-preserve'));
      if (preserve) return false;
      if (fromEl.hasAttribute && fromEl.getAttribute('data-ephemeral-class') === 'expanded') {
        if (fromEl.classList && fromEl.classList.contains('expanded')) {
          if (toEl && toEl.classList) toEl.classList.add('expanded');
        }
      }
      return true;
    },
    onNodeAdded: function(node) {
      if (node.nodeType === 1 && node.classList) {
        var rm = typeof window !== 'undefined' && window.matchMedia &&
                 window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!rm) {
          node.classList.add('just-added');
          setTimeout(function() { node.classList.remove('just-added'); }, 220);
        }
      }
    },
    onBeforeNodeDiscarded: function(node) {
      if (node.nodeType !== 1 || !node.classList) return true;
      var rm = typeof window !== 'undefined' && window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (rm) return true;
      if (node.classList.contains('just-removed')) return true;
      node.classList.add('just-removed');
      setTimeout(function() { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
      return false;
    }
  };

  function applyMorph(target, next, hashKey, newHash) {
    if (hashKey === 'overview' && newHash === lastOverviewHash) return false;
    if (hashKey === 'detail' && newHash === lastDetailHash) return false;
    if (typeof window !== 'undefined' && window.morphdom) {
      window.morphdom(target, next, MORPH_OPTIONS);
    }
    if (hashKey === 'overview') lastOverviewHash = newHash;
    else lastDetailHash = newHash;
    return true;
  }

  function historyControlsHtml(ctx) {
    var historyInclude = (ctx && ctx.historyInclude) || 'done';
    var historyLimit = (ctx && ctx.historyLimit) || 10;
    var opts = [
      { v: 'done', l: 'done only' },
      { v: 'done,error', l: 'done + errors' }
    ];
    var sel = '';
    for (var i = 0; i < opts.length; i++) {
      sel += '<option value="' + opts[i].v + '"' + (historyInclude === opts[i].v ? ' selected' : '') + '>' + opts[i].l + '</option>';
    }
    return 'source: <select onchange="setHistoryInclude(this.value)">' + sel + '</select>' +
           ' \u00a0 K: <input type="number" min="1" max="50" value="' + historyLimit + '" onchange="setHistoryLimit(this.value)" style="width:60px"/>';
  }

  function renderHistoryInner(h, ctx) {
    if (!h || !h.runs || h.runs.length === 0) {
      return '<div class="history-controls">' + historyControlsHtml(ctx) + '</div>' +
             '<div class="history-empty">No completed runs yet for the selected sources.</div>';
    }
    var seq = h.sequence || [];
    var selectedLine = (ctx && ctx.selectedLine) || '';
    var html = '<div class="history-controls">' + historyControlsHtml(ctx) + '</div>';
    html += '<div class="history-table-wrap"><table class="history-table"><thead><tr>';
    html += '<th>Run</th><th>total</th>';
    for (var si = 0; si < seq.length; si++) { html += '<th>' + esc(seq[si]) + '</th>'; }
    html += '</tr></thead><tbody>';
    for (var ri = 0; ri < h.runs.length; ri++) {
      var r = h.runs[ri];
      var rowCls = 'history-run-row source-' + r.source;
      html += '<tr class="' + rowCls + '">';
      html += '<td class="history-wp-id" onclick="openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(r.fileName) + '\')" title="' + esc(r.task) + '">' + esc(r.id) + '</td>';
      html += '<td class="history-cell-duration">' + (r.duration_ms != null ? formatDuration(r.duration_ms) : '\u2014') + '</td>';
      for (var ci = 0; ci < seq.length; ci++) {
        var cell = r.stations[seq[ci]];
        if (!cell || cell.duration_ms == null) {
          html += '<td class="history-cell-missing">\u2014</td>';
        } else {
          html += '<td class="history-cell-duration">' + formatDuration(cell.duration_ms) + '</td>';
        }
      }
      html += '</tr>';
    }
    html += '<tr class="history-stats-row"><td>avg (n=' + h.runs.length + ')</td><td>\u2014</td>';
    for (var sj = 0; sj < seq.length; sj++) {
      var st = h.perStationStats[seq[sj]];
      html += '<td>' + (st && st.avg_duration_ms != null ? formatDuration(st.avg_duration_ms) : '\u2014') + '</td>';
    }
    html += '</tr>';
    html += '<tr class="history-stats-row"><td>min / max</td><td>\u2014</td>';
    for (var sk = 0; sk < seq.length; sk++) {
      var st2 = h.perStationStats[seq[sk]];
      var mn = st2 && st2.min_duration_ms != null ? formatDuration(st2.min_duration_ms) : '\u2014';
      var mx = st2 && st2.max_duration_ms != null ? formatDuration(st2.max_duration_ms) : '\u2014';
      html += '<td>' + mn + ' / ' + mx + '</td>';
    }
    html += '</tr>';
    html += '</tbody></table></div>';
    return html;
  }

  function buildOverviewDom(gs) {
    var t = gs.totals;
    var html = '';

    // Summary bar
    html += '<div class="summary-bar">';
    html += metricCard('Lines', t.lines, '');
    html += metricCard('Running', t.linesRunning, 'running');
    html += metricCard('Inbox', t.totalInbox, 'inbox');
    html += metricCard('Done', t.totalDone, 'done');
    html += metricCard('Errors', t.totalErrors, 'error');
    html += metricCard('Review', t.totalReview || 0, 'review');
    html += metricCard('Recent Cost', fmtCost(t.totalCostUsd || 0), '');
    var tp1h = t.totalThroughput1h || 0;
    var tp24h = t.totalThroughput24h || 0;
    html += metricCard('Throughput', tp1h + '/hr \u00b7 ' + tp24h + '/day', '');
    html += '</div>';

    // Line grid
    html += '<div class="line-grid">';
    for (var li = 0; li < gs.lines.length; li++) {
      var line = gs.lines[li];
      var isError = line.status === 'error';
      html += '<div class="line-card' + (isError ? ' error-card' : '') + '" data-key="line-' + esc(line.name) + '" onclick="selectLine(\'' + escapeJs(line.name) + '\')">';
      html += '<div class="line-name">' + esc(line.name) + '</div>';
      html += '<div class="status-badge ' + line.status + '">' + line.status + '</div>';

      if (line.state && line.state.lineQueue) {
        var lq = line.state.lineQueue;
        html += '<div class="line-metrics">';
        html += 'inbox: ' + lq.inbox + ' \u00b7 done: ' + lq.done + ' \u00b7 errors: ' + (lq.errorActive != null ? lq.errorActive : lq.error) + ' \u00b7 review: ' + (lq.review || 0);
        html += '</div>';

        if (line.state.sequence && line.state.sequence.length > 0) {
          html += '<div class="pipeline-dots">';
          for (var pi = 0; pi < line.state.sequence.length; pi++) {
            var pname = line.state.sequence[pi];
            var sec = line.state.sections[pname] || { inbox: 0, processing: 0, output: 0 };
            var cls = '';
            if (sec.processing > 0) cls = ' active';
            else if (sec.inbox > 0) cls = ' queued';
            html += '<div class="pipeline-dot' + cls + '" title="' + esc(pname) + '"></div>';
            if (pi < line.state.sequence.length - 1) {
              html += '<div class="pipeline-connector"></div>';
            }
          }
          html += '</div>';
        }

        if (line.state.health) {
          html += buildHealthChip(line.state.health);
        }
      } else if (isError && line.error) {
        html += '<div class="line-metrics" style="color:#ef4444;">' + esc(line.error.slice(0, 100)) + '</div>';
      }

      html += '</div>';
    }
    html += '</div>';

    // Merged activity feed
    var allActivity = [];
    for (var ali = 0; ali < gs.lines.length; ali++) {
      var aline = gs.lines[ali];
      if (aline.state && aline.state.activity) {
        for (var aj = 0; aj < aline.state.activity.length; aj++) {
          var act = Object.assign({}, aline.state.activity[aj], { _line: aline.name });
          allActivity.push(act);
        }
      }
    }
    allActivity.sort(function(a, b) { return (b.ts || '').localeCompare(a.ts || ''); });
    var recentActivity = allActivity.slice(0, 50);

    html += '<div class="activity">';
    html += '<h2>Activity</h2>';
    if (recentActivity.length === 0) {
      html += '<div class="activity-entry"><span class="detail" style="color:#555">No activity yet.</span></div>';
    } else {
      for (var ri = 0; ri < recentActivity.length; ri++) {
        var a = recentActivity[ri];
        var time = a.ts ? new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        var evtCls = '';
        if ((a.event || '').includes('error')) evtCls = 'error';
        else if (a.event === 'task_done' || a.event === 'station_done') evtCls = 'done';
        else if (a.event === 'routed') evtCls = 'routed';
        else if ((a.event || '') === 'escalated') evtCls = 'escalated';
        else if (a.event === 'trigger_fired' || a.event === 'trigger_skipped') evtCls = 'trigger';
        var detail = a.summary || a.task || a.error || a.workpiece || (a.event === 'trigger_fired' ? (a.source || '') + ' \u2192 ' + (a.target || '') : '') || (a.event === 'trigger_skipped' ? (a.target || '') + ': ' + (a.reason || 'skipped') : '') || '';
        var station = a.station ? '[' + a.station + ']' : '';
        var actKey = 'act-ov-' + esc(a.ts) + '-' + esc(a._line) + '-' + esc(a.event) + '-' + esc(a.workpiece || a.station || '');

        html += '<div class="activity-entry ' + evtCls + '" data-key="' + actKey + '">';
        html += '<span class="time">' + time + '</span>';
        html += '<span class="line-tag">[' + esc(a._line) + ']</span>';
        html += '<span class="event">' + esc(a.event || '') + ' ' + esc(station) + '</span>';
        if (a.workpiece && a._line) {
          var owpFile = a.workpiece + '.json';
          html += '<span class="detail wp-ref" onclick="event.stopPropagation(); openDrawer(\'' + escapeJs(a._line) + '\', \'' + escapeJs(owpFile) + '\')">' + esc(String(detail).slice(0, 100)) + '</span>';
        } else {
          html += '<span class="detail">' + esc(String(detail).slice(0, 100)) + '</span>';
        }
        if (a.event === 'station_heartbeat' && a.child_live !== undefined) {
          var silentClass = a.silent_s < 90 ? 'green' : (a.silent_s < 300 ? 'yellow' : 'red');
          html += ' <span class="silent-indicator ' + silentClass + '" title="silent ' + a.silent_s + 's"></span>';
          if (!a.child_live) {
            html += ' <span style="color:var(--color-warning);font-size:10px">silent ' + a.silent_s + 's</span>';
          }
        }
        html += '</div>';
      }
    }
    html += '</div>';

    var d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }

  function buildDetailDom(state, ctx) {
    ctx = ctx || {};
    var selectedLine = ctx.selectedLine !== undefined ? ctx.selectedLine : '';
    var activityFilters = ctx.activityFilters || {};
    var historyData = ctx.historyData !== undefined ? ctx.historyData : null;
    var historyLimit = ctx.historyLimit !== undefined ? ctx.historyLimit : 10;
    var historyInclude = ctx.historyInclude !== undefined ? ctx.historyInclude : 'done';
    var inFlightIds = (typeof window !== 'undefined' && window._inFlightReleaseIds) || new Set();

    var html = '';

    // Back button
    html += '<div class="back-btn" onclick="goBack()">\u2190 All Lines</div>';

    // Header
    html += '<h1>' + esc(state.line) + '</h1>';
    if (state.description) {
      html += '<div class="subtitle" style="margin-bottom:24px">' + esc(state.description) + '</div>';
    }

    // Flow metrics row — injected between header and kanban
    var metricsData = ctx.flowMetrics !== undefined ? ctx.flowMetrics : null;
    html += '<div class="flow-metrics-row" id="flow-metrics-row" data-preserve="true">';
    html += buildMetricsRow(metricsData);
    html += '</div>';

    // Kanban board mount — populated asynchronously by loadKanban()
    html += '<div class="kanban-board" id="kanban-board" data-preserve="true"></div>';

    // History section — collapsible, fetched lazily by loadHistory().
    var historyExpanded = isSectionExpanded('history');
    var histCount = historyData && historyData.runs ? historyData.runs.length : 0;
    html += '<div class="wp-section">';
    html += '<div class="wp-section-header" onclick="toggleSection(\'history\')">';
    html += '<span class="wp-section-toggle' + (historyExpanded ? ' expanded' : '') + '" id="section-toggle-history">\u25b6</span>';
    html += '<h2>History (last ' + historyLimit + ' runs' + (histCount ? ' \u2014 ' + histCount + ' shown' : '') + ')</h2>';
    html += '</div>';
    html += '<div class="wp-section-body' + (historyExpanded ? ' expanded' : '') + '" id="section-body-history">';
    html += '<div id="history-section-body" data-preserve="true">' + (historyData ? renderHistoryInner(historyData, { historyInclude: historyInclude, historyLimit: historyLimit, selectedLine: selectedLine }) : '<div class="history-empty">Loading\u2026</div>') + '</div>';
    html += '</div></div>';

    // Build ID-to-fileName map for click handlers
    var wpFileMap = {};
    if (state.completed) {
      for (var ci = 0; ci < state.completed.length; ci++) {
        if (state.completed[ci].fileName) wpFileMap[state.completed[ci].id] = state.completed[ci].fileName;
      }
    }
    if (state.errors) {
      for (var ei = 0; ei < state.errors.length; ei++) {
        if (state.errors[ei].fileName) wpFileMap[state.errors[ei].id] = state.errors[ei].fileName;
      }
    }
    if (state.errorsDismissed) {
      for (var di = 0; di < state.errorsDismissed.length; di++) {
        if (state.errorsDismissed[di].fileName) wpFileMap[state.errorsDismissed[di].id] = state.errorsDismissed[di].fileName;
      }
    }
    if (state.reviews) {
      for (var ri2 = 0; ri2 < state.reviews.length; ri2++) {
        if (state.reviews[ri2].fileName) wpFileMap[state.reviews[ri2].id] = state.reviews[ri2].fileName;
      }
    }

    // Collapsible Held section
    var heldExpanded = isSectionExpanded('held');
    var heldList = state.held || [];
    var heldCount = heldList.length;
    html += '<div class="wp-section held-section">';
    html += '<div class="wp-section-header" onclick="toggleSection(\'held\')">';
    html += '<span class="wp-section-toggle' + (heldExpanded ? ' expanded' : '') + '" id="section-toggle-held">\u25b6</span>';
    html += '<h2>Held (' + heldCount + ')</h2>';
    if (heldCount > 0) {
      html += '<div class="wp-section-actions" onclick="event.stopPropagation()">';
      html += '<button class="release-all-btn" id="release-all-btn" onclick="onReleaseAllClick(event)" aria-label="Release all held tasks">Release all (' + heldCount + ')</button>';
      html += '<span id="release-all-confirm" class="release-confirm hidden">Release all ' + heldCount + '? <button onclick="releaseAllHeld()">Yes</button> <button onclick="cancelReleaseAll()">Cancel</button></span>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="wp-section-body' + (heldExpanded ? ' expanded' : '') + '" id="section-body-held">';
    if (heldCount === 0) {
      html += '<div class="wp-section-empty">No held tasks.</div>';
    } else {
      html += '<div class="wp-list">';
      for (var h = 0; h < heldList.length; h++) {
        var hw = heldList[h];
        var hid = (hw.fileName || '').replace(/\.json$/, '');
        var inFlight = inFlightIds.has(hw.fileName);
        var itemCls = 'wp-list-item held-card' + (inFlight ? ' in-flight' : '');
        html += '<div class="' + itemCls + '" tabindex="0" data-key="held-' + esc(hw.fileName) + '" data-held-file="' + escapeJs(hw.fileName) + '" onkeydown="onHeldCardKeydown(event, \'' + escapeJs(hw.fileName) + '\')">';
        html += '<span class="wp-id">' + esc(hid) + '</span>';
        html += '<span class="wp-task">' + esc((hw.task || '').slice(0, 80)) + '</span>';
        html += '<span class="wp-time">' + (hw.enqueued_at ? formatRelativeTime(hw.enqueued_at) : '') + '</span>';
        html += '<button class="release-btn"' + (inFlight ? ' disabled' : '') + ' aria-label="Release task ' + escapeJs(hid) + ' to inbox" onclick="event.stopPropagation(); releaseCard(\'' + escapeJs(hw.fileName) + '\')">\u25b6 Release</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';

    // Collapsible Completed section
    var completedExpanded = isSectionExpanded('completed');
    html += '<div class="wp-section">';
    html += '<div class="wp-section-header" onclick="toggleSection(\'completed\')">';
    html += '<span class="wp-section-toggle' + (completedExpanded ? ' expanded' : '') + '" id="section-toggle-completed">\u25b6</span>';
    html += '<h2>Recently Completed (' + (state.completed ? state.completed.length : 0) + ')</h2>';
    html += '</div>';
    html += '<div class="wp-section-body' + (completedExpanded ? ' expanded' : '') + '" id="section-body-completed">';
    if (state.completed && state.completed.length > 0) {
      html += '<div class="wp-list">';
      for (var c = 0; c < state.completed.length; c++) {
        var cw = state.completed[c];
        var cFile = cw.fileName || (cw.id + '.json');
        html += '<div class="wp-list-item" data-key="completed-' + esc(cw.id) + '" onclick="openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(cFile) + '\')">';
        html += '<span class="wp-id">' + esc(cw.id) + '</span>';
        if (cw.stations) {
          html += '<span class="wp-status-dots">';
          var stKeys = Object.keys(cw.stations);
          for (var si = 0; si < stKeys.length; si++) {
            var sStatus = cw.stations[stKeys[si]].status || 'done';
            var dotColor = sStatus === 'done' ? 'var(--color-success)' : sStatus === 'failed' ? 'var(--color-error)' : sStatus === 'escalated' ? 'var(--color-warning)' : 'var(--text-dim)';
            html += '<div style="width:6px;height:6px;border-radius:50%;background:' + dotColor + '" title="' + esc(stKeys[si]) + ': ' + sStatus + '"></div>';
          }
          html += '</span>';
        }
        html += '<span class="wp-duration">' + (cw.duration_ms != null ? formatDuration(cw.duration_ms) : '') + '</span>';
        html += '<span class="wp-time">' + formatRelativeTime(cw.finished_at) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="wp-section-empty">No completed workpieces yet.</div>';
    }
    html += '</div>';
    html += '</div>';

    // Collapsible Errored section
    var errorsExpanded = isSectionExpanded('errors');
    var activeErrorCount = state.errors ? state.errors.length : 0;
    var dismissedErrorCount = state.errorsDismissed ? state.errorsDismissed.length : 0;
    var errorsHeading = 'Errored (' + activeErrorCount + (dismissedErrorCount > 0 ? ' active / ' + dismissedErrorCount + ' dismissed' : '') + ')';
    html += '<div class="wp-section">';
    html += '<div class="wp-section-header" onclick="toggleSection(\'errors\')">';
    html += '<span class="wp-section-toggle' + (errorsExpanded ? ' expanded' : '') + '" id="section-toggle-errors">\u25b6</span>';
    html += '<h2>' + errorsHeading + '</h2>';
    html += '</div>';
    html += '<div class="wp-section-body' + (errorsExpanded ? ' expanded' : '') + '" id="section-body-errors">';
    if (activeErrorCount > 0) {
      html += '<div class="wp-list">';
      for (var e = 0; e < state.errors.length; e++) {
        var ew = state.errors[e];
        var eFile = ew.fileName || (ew.id + '.json');
        html += '<div class="wp-list-item" data-key="errored-' + esc(ew.id) + '" onclick="openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(eFile) + '\')">';
        html += '<span class="wp-id" style="color:var(--color-error)">' + esc(ew.id) + '</span>';
        if (ew.failed && ew.failed.length > 0) {
          html += '<span class="wp-failed-station">\u2717 ' + esc(ew.failed[0].station) + '</span>';
        }
        html += '<span class="wp-duration">' + (ew.duration_ms != null ? formatDuration(ew.duration_ms) : '') + '</span>';
        html += '<span class="wp-time">' + formatRelativeTime(ew.finished_at) + '</span>';
        html += '<button class="dismiss-btn" onclick="event.stopPropagation(); dismissErrors(\'' + escapeJs(selectedLine) + '\', [\'' + escapeJs(eFile) + '\'])" title="Dismiss">\u00d7</button>';
        html += '</div>';
      }
      html += '</div>';
    } else if (dismissedErrorCount === 0) {
      html += '<div class="wp-section-empty">No errors.</div>';
    }
    if (dismissedErrorCount > 0) {
      html += '<div class="dismissed-toggle" onclick="document.getElementById(\'dismissed-list\').classList.toggle(\'expanded\')">';
      html += 'Show ' + dismissedErrorCount + ' dismissed</div>';
      html += '<div id="dismissed-list" class="wp-list dismissed-list" data-ephemeral-class="expanded">';
      for (var d2 = 0; d2 < state.errorsDismissed.length; d2++) {
        var dw = state.errorsDismissed[d2];
        var dFile = dw.fileName || (dw.id + '.json');
        html += '<div class="wp-list-item dismissed" data-key="errored-dismissed-' + esc(dw.id) + '" onclick="openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(dFile) + '\')">';
        html += '<span class="wp-id" style="color:var(--text-dim)">' + esc(dw.id) + '</span>';
        if (dw.failed && dw.failed.length > 0) {
          html += '<span class="wp-failed-station" style="color:var(--text-dim)">\u2717 ' + esc(dw.failed[0].station) + '</span>';
        }
        html += '<span class="wp-duration" style="color:var(--text-dim)">' + (dw.duration_ms != null ? formatDuration(dw.duration_ms) : '') + '</span>';
        html += '<button class="dismiss-btn undo" onclick="event.stopPropagation(); undismissError(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(dFile) + '\')" title="Undo dismiss">\u21a9</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';

    // Collapsible Review / Escalated section
    var reviewExpanded = isSectionExpanded('review');
    var reviewList = state.reviews || [];
    var reviewCount = reviewList.length;
    html += '<div class="wp-section">';
    html += '<div class="wp-section-header" onclick="toggleSection(\'review\')">';
    html += '<span class="wp-section-toggle' + (reviewExpanded ? ' expanded' : '') + '" id="section-toggle-review">\u25b6</span>';
    html += '<h2>Review / Escalated (' + reviewCount + ')</h2>';
    html += '</div>';
    html += '<div class="wp-section-body' + (reviewExpanded ? ' expanded' : '') + '" id="section-body-review">';
    if (reviewCount > 0) {
      html += '<div class="wp-list">';
      for (var rv = 0; rv < reviewList.length; rv++) {
        var rvw = reviewList[rv];
        var rvFile = rvw.fileName || (rvw.id + '.json');
        html += '<div class="wp-list-item" data-key="review-' + esc(rvw.id) + '" onclick="openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(rvFile) + '\')">';
        html += '<span class="wp-id" style="color:var(--color-warning)">' + esc(rvw.id) + '</span>';
        if (rvw.escalated && rvw.escalated.length > 0) {
          html += '<span class="wp-failed-station" style="color:var(--color-warning)">\u26a0 ' + esc(rvw.escalated[0].station) + '</span>';
        }
        html += '<span class="wp-task">' + esc((rvw.task || '').slice(0, 80)) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    } else {
      html += '<div class="wp-section-empty">No items in review.</div>';
    }
    html += '</div>';
    html += '</div>';

    // Activity feed (full-width)
    html += '<div class="activity" style="margin-top:var(--space-lg)">';
    html += '<h2>Activity</h2>';

    var filterTypes = [
      { key: 'station_done', label: 'done' },
      { key: 'retry', label: 'retry' },
      { key: 'error', label: 'error' },
      { key: 'routed', label: 'routed' },
      { key: 'escalated', label: 'escalated' },
      { key: 'task_received', label: 'received' },
      { key: 'task_done', label: 'task done' },
      { key: 'trigger', label: 'trigger' }
    ];
    html += '<div class="activity-filters">';
    for (var fi = 0; fi < filterTypes.length; fi++) {
      var ft = filterTypes[fi];
      var isActive = activityFilters[ft.key] !== false;
      html += '<button class="activity-filter-btn' + (isActive ? ' active' : '') + '" onclick="toggleActivityFilter(\'' + ft.key + '\')">' + esc(ft.label) + '</button>';
    }
    html += '</div>';

    var entries = (state.activity || []);
    var filteredEntries = entries.filter(function(a) {
      var evt = a.event || '';
      if (activityFilters['station_done'] === false && evt === 'station_done') return false;
      if (activityFilters['task_done'] === false && evt === 'task_done') return false;
      if (activityFilters['retry'] === false && evt === 'retry') return false;
      if (activityFilters['error'] === false && (evt.includes('error') || evt === 'error_bucket')) return false;
      if (activityFilters['routed'] === false && (evt === 'routed' || evt === 'queued')) return false;
      if (activityFilters['escalated'] === false && evt === 'escalated') return false;
      if (activityFilters['task_received'] === false && evt === 'task_received') return false;
      if (activityFilters['trigger'] === false && (evt === 'trigger_fired' || evt === 'trigger_skipped')) return false;
      return true;
    });

    // Group consecutive retry entries for the same workpiece
    var groupedEntries = [];
    var retryGroupCount = 0;
    for (var gi = 0; gi < filteredEntries.length; gi++) {
      var entry = filteredEntries[gi];
      if (entry.event === 'retry') {
        var retryRun = [entry];
        while (gi + 1 < filteredEntries.length && filteredEntries[gi + 1].event === 'retry' && filteredEntries[gi + 1].workpiece === entry.workpiece) {
          gi++;
          retryRun.push(filteredEntries[gi]);
        }
        if (retryRun.length >= 2) {
          groupedEntries.push({ _type: 'retry_group', entries: retryRun, workpiece: entry.workpiece, station: entry.station, groupId: retryGroupCount++ });
        } else {
          groupedEntries.push(entry);
        }
      } else {
        groupedEntries.push(entry);
      }
    }

    if (groupedEntries.length === 0) {
      html += '<div class="activity-entry"><span class="detail" style="color:#555">No activity yet. Drop a task JSON into the inbox.</span></div>';
    } else {
      for (var ai = 0; ai < groupedEntries.length; ai++) {
        var item = groupedEntries[ai];
        if (item._type === 'retry_group') {
          var rg = item;
          var rgFirst = rg.entries[0];
          var rgTime = rgFirst.ts ? new Date(rgFirst.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          html += '<div class="retry-group-header" data-key="retry-' + rg.groupId + '" onclick="toggleRetryGroup(' + rg.groupId + ')">';
          html += '<span class="retry-toggle" id="retry-toggle-' + rg.groupId + '">\u25b6</span>';
          html += '<span class="time">' + rgTime + '</span>';
          html += '<span class="event" style="color:var(--color-warning)">retry \u00d7' + rg.entries.length + '</span>';
          if (rg.station) html += '<span class="event">[' + esc(rg.station) + ']</span>';
          if (rg.workpiece) {
            var rgWpFile = (wpFileMap && wpFileMap[rg.workpiece]) || (rg.workpiece + '.json');
            html += '<span class="wp-id-link" onclick="event.stopPropagation(); openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(rgWpFile) + '\')">' + esc(rg.workpiece) + '</span>';
          }
          html += '</div>';
          html += '<div class="retry-group-entries" id="retry-entries-' + rg.groupId + '" data-ephemeral-class="expanded">';
          for (var rri = 0; rri < rg.entries.length; rri++) {
            var re = rg.entries[rri];
            var reTime = re.ts ? new Date(re.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            html += '<div class="activity-entry error" data-key="act-retry-' + esc(re.ts) + '-' + re.attempt + '">';
            html += '<span class="time">' + reTime + '</span>';
            html += '<span class="event">' + esc(re.event) + ' [' + esc(re.station || '') + ']</span>';
            var reDetail = 'attempt ' + (re.attempt || '?');
            if (re.delay_s) reDetail += ' (backoff ' + re.delay_s + 's)';
            if (re.error) reDetail += ' \u2014 ' + String(re.error).slice(0, 80);
            html += '<span class="detail">' + esc(reDetail) + '</span>';
            html += '</div>';
          }
          html += '</div>';
        } else {
          var a2 = item;
          var time2 = a2.ts ? new Date(a2.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
          var cls2 = '';
          if ((a2.event || '').includes('error')) cls2 = 'error';
          else if (a2.event === 'task_done' || a2.event === 'station_done') cls2 = 'done';
          else if (a2.event === 'routed') cls2 = 'routed';
          else if ((a2.event || '') === 'escalated') cls2 = 'escalated';
          else if (a2.event === 'trigger_fired' || a2.event === 'trigger_skipped') cls2 = 'trigger';
          var detail2 = a2.summary || a2.task || a2.error || (a2.event === 'trigger_fired' ? (a2.source || '') + ' \u2192 ' + (a2.target || '') : '') || (a2.event === 'trigger_skipped' ? (a2.target || '') + ': ' + (a2.reason || 'skipped') : '') || '';
          var station2 = a2.station ? '[' + a2.station + ']' : '';
          var actKey2 = 'act-' + esc(a2.ts) + '-' + esc(a2.event) + '-' + esc(a2.workpiece || a2.station || '');

          html += '<div class="activity-entry ' + cls2 + '" data-key="' + actKey2 + '">';
          html += '<span class="time">' + time2 + '</span>';
          html += '<span class="event">' + esc(a2.event || '') + ' ' + esc(station2) + '</span>';
          if (a2.workpiece) {
            var wpFile2 = (wpFileMap && wpFileMap[a2.workpiece]) || (a2.workpiece + '.json');
            html += '<span class="wp-id-link" onclick="event.stopPropagation(); openDrawer(\'' + escapeJs(selectedLine) + '\', \'' + escapeJs(wpFile2) + '\')">' + esc(String(a2.workpiece).slice(0, 20)) + '</span>';
            html += '<span class="detail">' + esc(String(detail2).slice(0, 100)) + '</span>';
          } else {
            html += '<span class="detail">' + esc(String(detail2).slice(0, 100)) + '</span>';
          }
          if (a2.event === 'station_heartbeat' && a2.child_live !== undefined) {
            var silentClass2 = a2.silent_s < 90 ? 'green' : (a2.silent_s < 300 ? 'yellow' : 'red');
            html += ' <span class="silent-indicator ' + silentClass2 + '" title="silent ' + a2.silent_s + 's"></span>';
            if (!a2.child_live) {
              html += ' <span style="color:var(--color-warning);font-size:10px">silent ' + a2.silent_s + 's</span>';
            }
          }
          html += '</div>';
        }
      }
    }
    html += '</div>';

    var d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }

  // --- Backoff countdown tickers ---
  // Single setInterval loop that ticks all [data-backoff-until] elements every second.
  // Called after each kanban render (applyKanban) to start/restart the ticker.
  var _backoffTickerInterval = null;

  function startBackoffTickers() {
    if (_backoffTickerInterval) return; // already running
    _backoffTickerInterval = setInterval(function() {
      var timers = document.querySelectorAll('[data-backoff-until]');
      if (timers.length === 0) {
        clearInterval(_backoffTickerInterval);
        _backoffTickerInterval = null;
        return;
      }
      var now = Date.now();
      for (var i = 0; i < timers.length; i++) {
        var el = timers[i];
        var until = el.getAttribute('data-backoff-until');
        if (!until) continue;
        var remaining = Math.round((new Date(until).getTime() - now) / 1000);
        if (remaining > 0) {
          el.textContent = 'retry in ' + remaining + 's';
        } else {
          el.textContent = 'retrying…';
        }
      }
    }, 1000);
  }

  // --- Flow Metrics Row (Tier 4 #29) ---

  function sparklineSvg(points) {
    if (!points || points.length === 0) return '';
    var max = Math.max.apply(null, points);
    if (max === 0) max = 1; // avoid division by zero
    var width = 60;
    var height = 20;
    var pathPoints = [];
    for (var i = 0; i < points.length; i++) {
      var x = i * (width / (points.length - 1));
      var y = height - (points[i] / max * 18) - 1;
      pathPoints.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return '<svg class="metric-sparkline" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<polyline points="' + pathPoints.join(' ') + '" stroke="var(--color-info)" stroke-width="1.5" fill="none" />' +
      '</svg>';
  }

  function buildMetricsRow(metrics) {
    if (!metrics || metrics === null) {
      // Skeleton loading state
      var html = '<div class="flow-metrics-skeleton">';
      for (var i = 0; i < 5; i++) {
        html += '<div class="flow-metric-tile">';
        html += '<div class="skeleton-line" style="width: 60%; margin-bottom: 6px;"></div>';
        html += '<div class="skeleton-line large" style="margin-bottom: 8px;"></div>';
        html += '<div class="skeleton-line small"></div>';
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    if (!metrics.tiles || metrics.tiles.length === 0) {
      return '<div class="flow-metrics-empty">No data yet — metrics appear after the first workpiece completes.</div>';
    }

    var html = '';
    for (var i = 0; i < metrics.tiles.length; i++) {
      var tile = metrics.tiles[i];
      html += '<div class="flow-metric-tile" title="' + esc(tile.explanation) + '">';
      html += '<div class="metric-label">' + esc(tile.label) + '</div>';
      html += '<div class="metric-value">' + esc(tile.value) + '</div>';
      html += '<div class="metric-context">';

      // Sparkline for throughput
      if (tile.sparkline && tile.sparkline.length > 0) {
        html += sparklineSvg(tile.sparkline);
      }
      // Delta for other tiles
      else if (tile.delta !== null && tile.delta !== undefined) {
        var arrow = tile.delta > 0 ? '↑' : '↓';
        var deltaVal = Math.abs(tile.delta).toFixed(0);
        // For cycle time and wait time, negative delta (faster) is good
        // For throughput and success rate, positive delta is good
        var isGood = false;
        if (tile.label.indexOf('Cycle') >= 0 || tile.label.indexOf('Wait') >= 0) {
          isGood = tile.delta < 0;
        } else {
          isGood = tile.delta > 0;
        }
        var deltaClass = isGood ? 'metric-delta positive' : 'metric-delta negative';
        html += '<span class="' + deltaClass + '">' + arrow + deltaVal + '% vs prior 7d</span>';
      }
      // Live for in-flight
      else {
        html += '<span class="metric-context-live">live</span>';
      }

      html += '</div>';
      html += '</div>';
    }
    return html;
  }

  return { buildOverviewDom: buildOverviewDom, buildDetailDom: buildDetailDom, renderHistoryInner: renderHistoryInner, applyMorph: applyMorph, MORPH_OPTIONS: MORPH_OPTIONS, renderStationRounds: renderStationRounds, startBackoffTickers: startBackoffTickers, buildMetricsRow: buildMetricsRow, __resetHashes: __resetHashes };
});
