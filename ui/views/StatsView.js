// ui/views/StatsView.js — Dashboard de estadísticas (Fase 9.1).
// KPIs on-demand desde el store (sin segunda copia). Cálculo puro en core/stats.js

import { computeStats } from '../../core/stats.js';
import { Icon } from '../components/Icon.js';
import { escapeHtml } from '../render.js';

export const StatsView = {
  deps: (/** @type {any} */ state) => [state.sessions, state.trash, state.now],

  /** @param {any} state */
  render(state) {
    const stats = computeStats(state.sessions ?? {}, state.trash ?? {}, state.now);
    const totalTabs = stats.tabCount;
    const totalSessions = stats.sessionCount;
    const hasData = totalSessions > 0;

    if (!hasData) {
      return `
      <div class="empty-state">
        ${Icon('grid', 44, 'class="empty-icon" stroke-width="1.2"')}
        <h4>No stats yet</h4>
        <p>Save a few sessions to see your vault in numbers.</p>
      </div>`;
    }

    return `
    <div class="stats-view">
      <h3 class="stats-title">Vault stats</h3>
      <div class="stats-kpis">
        ${kpiCard('Sessions', String(totalSessions), Icon('grid', 14))}
        ${kpiCard('Tabs saved', String(totalTabs), Icon('rows', 14))}
        ${kpiCard('Domains', String(stats.domainCount), Icon('globe', 14))}
        ${kpiCard('Streak', `${stats.streak}d`, Icon('flame', 14))}
        ${kpiCard('Trash', String(stats.trashCount), Icon('trash', 14))}
        ${kpiCard('Storage', `${Math.max(1, Math.round(stats.storageBytes / 1024))} KB`, Icon('hardDrive', 14))}
      </div>
      ${topDomainsSection(stats.top)}
      ${activitySection(stats.activity)}
      ${repeatedSection(stats.repeated)}
    </div>`;
  },
};

/** @param {string} label @param {string} value @param {string} icon */
function kpiCard(label, value, icon) {
  return `
  <div class="stat-card">
    <div class="stat-icon">${icon}</div>
    <div class="stat-value">${escapeHtml(value)}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
  </div>`;
}

/** @param {{ host:string, count:number }[]} top */
function topDomainsSection(top) {
  if (!top.length) return '';
  const max = Math.max(...top.map((d) => d.count), 1);
  return `
  <div class="stats-section">
    <h4 class="stats-section-title">${Icon('barChart', 12)} Top domains</h4>
    <div class="stats-bars">
      ${top
        .map(
          (d) => `
        <div class="stats-bar-row">
          <span class="stats-bar-label" title="${escapeHtml(d.host)}">${escapeHtml(d.host)}</span>
          <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${Math.round((d.count / max) * 100)}%"></div></div>
          <span class="stats-bar-count">${d.count}</span>
        </div>`
        )
        .join('')}
    </div>
  </div>`;
}

/** @param {number[]} activity */
function activitySection(activity) {
  if (!activity || activity.every((n) => n === 0)) return '';
  const max = Math.max(...activity, 1);
  // sparkline as inline div bars
  const bars = activity
    .map((n) => {
      const h = Math.max(4, Math.round((n / max) * 28));
      return `<span class="spark-bar" style="height:${h}px" title="${n} sessions"></span>`;
    })
    .join('');
  return `
  <div class="stats-section">
    <h4 class="stats-section-title">${Icon('activity', 12)} Last 30 days</h4>
    <div class="sparkline" aria-label="Activity last 30 days">${bars}</div>
  </div>`;
}

/** @param {{ url:string, title:string, count:number }[]} repeated */
function repeatedSection(repeated) {
  if (!repeated.length) return '';
  return `
  <div class="stats-section">
    <h4 class="stats-section-title">${Icon('copy', 12)} Most repeated tabs</h4>
    <div class="stats-list">
      ${repeated
        .map(
          (r) => `
        <div class="stats-list-row">
          <span class="stats-list-title" title="${escapeHtml(r.url)}">${escapeHtml(r.title)}</span>
          <span class="stats-list-count">×${r.count}</span>
        </div>`
        )
        .join('')}
    </div>
  </div>`;
}
