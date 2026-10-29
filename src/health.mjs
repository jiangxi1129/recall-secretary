const STATUSES = ["selected", "rejected", "no_hit", "skipped", "failed"];

// 只汇总结构化 trace，不接触问题原文和记忆正文。
export function summarizeTraces(traces = []) {
  const summary = { total: 0, selectedItems: 0, averageMs: 0, statuses: Object.fromEntries(STATUSES.map(x => [x, 0])) };
  let latency = 0;
  for (const trace of traces) {
    if (!trace || typeof trace !== "object") continue;
    summary.total++;
    const status = STATUSES.includes(trace.status) ? trace.status : "failed";
    summary.statuses[status]++;
    summary.selectedItems += Math.max(0, Number(trace.selected) || 0);
    latency += Math.max(0, Number(trace.ms) || 0);
  }
  summary.averageMs = summary.total ? Math.round(latency / summary.total) : 0;
  return summary;
}
