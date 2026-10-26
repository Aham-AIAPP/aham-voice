// .page-loading — skeleton scaffold for initial page load. The Aham CSS
// ships `.page-loading__bar` with shimmer + size modifiers (--title,
// --subtitle, --row, --card) and expects the page to compose them. We mimic
// the geometry of `.page-head` + a table-shaped body.
export function PageLoading() {
  return (
    <div className="page-loading" aria-busy="true" aria-live="polite">
      <div className="page-loading__bar page-loading__bar--title" />
      <div className="page-loading__bar page-loading__bar--subtitle" />
      <div className="page-loading__bar page-loading__bar--row" />
      <div className="page-loading__bar page-loading__bar--row" />
      <div className="page-loading__bar page-loading__bar--row" />
    </div>
  );
}
