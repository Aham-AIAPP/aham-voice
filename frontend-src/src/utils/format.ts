// Small formatting helpers shared across pages. Aham rules:
// - dates use system locale (zh-CN here)
// - mono-tabular numbers wherever they appear in dense rows
// - "—" is the canonical em-dash placeholder for missing values

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  // Backend returns "YYYY-MM-DD HH:MM:SS" in local time
  return value;
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = parseLocalDateTime(value);
  if (!parsed) return value;
  const diff = Date.now() - parsed.getTime();
  if (diff < 0) return value;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return value.slice(0, 10);
}

export function parseLocalDateTime(value: string): Date | null {
  // The backend's strings are local — append a "T" so Date treats them as local.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const iso = value.replace(" ", "T");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function initials(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "—";
  // Chinese names: last (given) char reads as identity
  const first = Array.from(trimmed)[0];
  return first ?? "—";
}
