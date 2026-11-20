// Each link is also an ordinary fragment link when JavaScript is unavailable.
const navigation = document.querySelector('.workspace-nav');
const views = [...document.querySelectorAll('.workspace-view')];

function showSection(scrollToDetail) {
  const target = document.getElementById(location.hash.slice(1));
  if (target?.id === 'main' && navigation.querySelector('[aria-current]')) return;
  const section = target?.closest('.workspace-view') ?? views[0];
  for (const view of views) view.hidden = view !== section;
  for (const link of navigation.querySelectorAll('a')) {
    if (link.hash === '#' + section.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  if (scrollToDetail && target && target !== section && section.contains(target)) target.scrollIntoView();
}

navigation.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (location.hash !== link.hash) history.pushState(null, '', link.hash);
  showSection(false);
});
window.addEventListener('hashchange', () => showSection(true));
showSection(true);

// The native slider handles dragging, touch, keyboard steps and assistive technology.
for (const card of document.querySelectorAll('.trend-card')) {
  const slider = card.querySelector('input[type="range"]');
  const bars = [...card.querySelectorAll('.plot-slot')];
  const detail = card.querySelector('.plot-detail b');
  let selected;

  function showDay() {
    const bar = bars[slider.valueAsNumber - 1];
    if (selected === bar) return;
    selected?.classList.remove('selected');
    bar.classList.add('selected');
    selected = bar;
    detail.textContent = bar.title;
    slider.setAttribute('aria-valuetext', bar.title);
  }
  slider.addEventListener('input', showDay);
  slider.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    const rect = slider.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left) / rect.width * bars.length);
    slider.valueAsNumber = Math.max(0, Math.min(index, bars.length - 1)) + 1;
    showDay();
  });
  slider.hidden = false;
  card.querySelector('.plot-detail span').textContent = 'Selected day';
  showDay();
}
