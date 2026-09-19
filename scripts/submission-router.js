(() => {
  const rawHash = location.hash.slice(1);
  const hash = new URLSearchParams(rawHash);
  const submission = hash.get('s') || (rawHash && !rawHash.includes('=') ? decodeURIComponent(rawHash) : '');
  if (!submission) return;
  const visibleName = decodeURIComponent((location.search.slice(1) || '').split('&')[0]);
  const target = new URL('./teacher/', location.href);
  if (visibleName) target.searchParams.set('p', visibleName);
  target.hash = submission;
  location.replace(target.href);
})();
