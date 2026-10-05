const scales = { standard: '1', large: '1.15', 'extra-large': '1.3' };
const buttons = [...document.querySelectorAll('[data-font-size]')];
const storageKey = 'month-planner-font-size';
function selectSize(value, persist = false) {
  const size = Object.hasOwn(scales, value) ? value : 'standard';
  document.documentElement.style.setProperty('--font-scale', scales[size]);
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.fontSize === size));
  if (persist) { try { localStorage.setItem(storageKey, size); } catch {} }
}
let stored = 'standard';
try { stored = localStorage.getItem(storageKey); } catch {}
selectSize(stored);
for (const button of buttons) button.addEventListener('click', () => selectSize(button.dataset.fontSize, true));
