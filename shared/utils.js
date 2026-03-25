// shared/utils.js — Search, formatting, and helpers

// ─── Fuzzy search ──────────────────────────────────────────────────────────

function fuzzyScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 60;
  // Character-by-character fuzzy
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni], hi);
    if (found === -1) return 0;
    hi = found + 1;
  }
  return 30;
}

export function searchSessions(sessions, query) {
  if (!query?.trim()) {
    return Object.values(sessions).sort((a, b) => b.updated - a.updated);
  }
  const q = query.trim();
  const results = [];

  for (const session of Object.values(sessions)) {
    let maxScore = fuzzyScore(q, session.name);
    const matchingTabs = [];

    for (const group of (session.groups ?? [])) {
      maxScore = Math.max(maxScore, fuzzyScore(q, group.name ?? ''), fuzzyScore(q, group.note ?? ''));
      for (const tag of (group.tags ?? [])) {
        maxScore = Math.max(maxScore, fuzzyScore(q, tag));
      }
      for (const tab of (group.tabs ?? [])) {
        const score = Math.max(
          fuzzyScore(q, tab.title ?? ''),
          fuzzyScore(q, tab.url ?? ''),
          fuzzyScore(q, tab.note ?? ''),
          ...(tab.tags ?? []).map(t => fuzzyScore(q, t))
        );
        if (score > 0) {
          matchingTabs.push({ ...tab, _score: score, _groupName: group.name });
          maxScore = Math.max(maxScore, score);
        }
      }
    }

    for (const tab of (session.ungroupedTabs ?? [])) {
      const score = Math.max(
        fuzzyScore(q, tab.title ?? ''),
        fuzzyScore(q, tab.url ?? ''),
        fuzzyScore(q, tab.note ?? '')
      );
      if (score > 0) {
        matchingTabs.push({ ...tab, _score: score, _groupName: 'Ungrouped' });
        maxScore = Math.max(maxScore, score);
      }
    }

    if (maxScore > 0) {
      results.push({ ...session, _score: maxScore, _matchingTabs: matchingTabs });
    }
  }

  return results.sort((a, b) => b._score - a._score);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 30) return new Date(ts).toLocaleDateString();
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export function truncateUrl(url, maxLen = 48) {
  try {
    const u = new URL(url);
    const short = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    return short.length > maxLen ? short.slice(0, maxLen) + '…' : short;
  } catch {
    return url.slice(0, maxLen);
  }
}

// ─── Chrome group color map ──────────────────────────────────────────────────

export const GROUP_COLORS = {
  grey:   '#5f6368',
  blue:   '#1a73e8',
  red:    '#d93025',
  yellow: '#f29900',
  green:  '#188038',
  pink:   '#d01884',
  purple: '#a142f4',
  cyan:   '#007b83',
  orange: '#fa903e'
};

export const VALID_COLORS = Object.keys(GROUP_COLORS);

export function groupColorHex(color) {
  return GROUP_COLORS[color] ?? GROUP_COLORS.purple;
}

// ─── Download helpers ────────────────────────────────────────────────────────

export function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function sanitizeName(name) {
  return name.trim().replace(/[/\\?%*:|"<>]/g, '-') || 'tabvault-export';
}
