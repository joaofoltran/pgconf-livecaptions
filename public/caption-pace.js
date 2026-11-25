// Keep in sync with nextPacedCaption in public/overlay.js.
export function nextPacedCaption(shown, target) {
  if (target === shown) return shown;
  if (!target) return "";
  const targetWords = target.trim().split(/\s+/).filter(Boolean);
  const shownWords = shown.trim() ? shown.trim().split(/\s+/).filter(Boolean) : [];
  const key = (word) => word.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  let i = 0;
  while (
    i < shownWords.length &&
    i < targetWords.length &&
    key(shownWords[i]) === key(targetWords[i])
  ) {
    i++;
  }
  if (i < shownWords.length) return targetWords.slice(0, i).join(" ");
  if (i < targetWords.length) return targetWords.slice(0, i + 1).join(" ");
  return target;
}
