// 时间窗：人类说了「5 月」「2025 年 3 月」「去年」这种明确时间，就只看 key 里日期落在这段时间的记忆。
// 「3 个月」「几个月大」是时长不是时间，不认；「3 月份的工资」算时间（说的就是三月）。
// 线上踩过的坑：系统自己加在消息前的时间戳（[2026-10-17 14:30]）会被当成人类说的时间 —— 先剥掉信封再认；
// 筛完一条都不剩时退回不筛，并在 trace 里写明（不能悄悄变成「没有记忆」）。

const KEY_DATE = /(\d{4})-(\d{2})(?:-(\d{2}))?/;

export function parseTimeWindow(text, now = new Date()) {
  const t = String(text || "");
  const year = now.getFullYear();
  let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月(?![个龄])/);
  if (m) return monthRange(+m[1], +m[2]);
  m = t.match(/(\d{4})\s*年/);
  if (m && !/\d{4}\s*年\s*\d/.test(t)) return { from: `${m[1]}-01`, to: `${m[1]}-12`, said: m[0] };
  m = t.match(/(去年|前年)\s*(\d{1,2})\s*月(?![个龄])/);
  if (m) return monthRange(year - (m[1] === "去年" ? 1 : 2), +m[2]);
  if (/去年/.test(t)) return { from: `${year - 1}-01`, to: `${year - 1}-12`, said: "去年" };
  m = t.match(/(?<![\d年第几])(\d{1,2})\s*月(?![个龄])/);
  if (m) {
    const mon = +m[1];
    const y = mon > now.getMonth() + 1 ? year - 1 : year;      // 说的月份还没到，多半是去年
    return monthRange(y, mon);
  }
  return null;
}

function monthRange(y, mon) {
  if (!(mon >= 1 && mon <= 12)) return null;   // 「13 月」不是时间
  const mm = String(mon).padStart(2, "0");
  return { from: `${y}-${mm}`, to: `${y}-${mm}`, said: `${y}-${mm}` };
}

export function inWindow(key, win) {
  const m = String(key || "").match(KEY_DATE);
  if (!m) return false;
  const ym = `${m[1]}-${m[2]}`;
  return ym >= win.from && ym <= win.to;
}
