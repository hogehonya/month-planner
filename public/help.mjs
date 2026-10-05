const planner = document.getElementById('planner-view');
const help = document.getElementById('help-view');
const link = document.getElementById('help-link');
let plannerScroll = 0;
function showView(initial = false) {
  const showingHelp = location.hash === '#help';
  if (showingHelp && !planner.hidden) plannerScroll = window.scrollY;
  planner.hidden = showingHelp;
  help.hidden = !showingHelp;
  if (showingHelp) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
  document.title = showingHelp ? '取説 — 月間共有プランナー' : '月間共有プランナー';
  if (showingHelp) { document.getElementById('help-heading').focus({ preventScroll: true }); window.scrollTo(0, 0); }
  else if (!initial) { link.focus({ preventScroll: true }); window.scrollTo(0, plannerScroll); }
}
window.addEventListener('hashchange', () => showView());
showView(true);
