(() => {
  const hash = new URLSearchParams(location.hash.slice(1));
  const submission = hash.get('s');
  if (!submission) return;
  const visibleName = decodeURIComponent((location.search.slice(1) || '').split('&')[0]);
  const target = new URL('./teacher/', location.href);
  if (visibleName) target.searchParams.set('pupil', visibleName);
  target.hash = `s=${encodeURIComponent(submission)}`;
  location.replace(target.href);
})();
