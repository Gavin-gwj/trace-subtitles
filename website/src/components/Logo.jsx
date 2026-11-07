export function Logo({ compact = false }) {
  return (
    <a className="brand" href="#top" aria-label="Trace 首页">
      <span className="brand-mark" aria-hidden="true">
        T
      </span>
      <span className="brand-word">TRACE</span>
      {!compact && <span className="brand-caption">字幕翻译</span>}
    </a>
  );
}
