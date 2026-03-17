type DateOnlyParts = {
  year: number;
  month: number;
  day: number;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function resolveDateOnlyWithServerTime(parts: DateOnlyParts, now: Date): string | null {
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (Number.isNaN(target.getTime())) {
    return null;
  }

  const nowKst = new Date(now.getTime() + KST_OFFSET_MS);
  const todayTime = Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate());
  const targetTime = target.getTime();

  if (targetTime >= todayTime) {
    return now.toISOString();
  }

  const { hour, minute, second, millisecond } = {
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  };

  const kstIso = buildKstIso(parts, hour, minute, second, millisecond);
  const resolved = new Date(kstIso);
  if (Number.isNaN(resolved.getTime())) {
    return null;
  }
  return resolved.toISOString();
}

function buildKstIso(parts: DateOnlyParts, hour: number, minute: number, second: number, millisecond: number): string {
  const monthText = String(parts.month).padStart(2, '0');
  const dayText = String(parts.day).padStart(2, '0');
  const hourText = String(hour).padStart(2, '0');
  const minuteText = String(minute).padStart(2, '0');
  const secondText = String(second).padStart(2, '0');
  const millisecondText = String(millisecond).padStart(3, '0');
  return `${parts.year}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${millisecondText}+09:00`;
}
