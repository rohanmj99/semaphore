export function ProgressRing({
  value,
  children,
}: {
  value: number;
  children?: React.ReactNode;
}) {
  const R = 62;
  const CIRC = 2 * Math.PI * R;
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div className="ringwrap" aria-hidden="true">
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle className="ringbg" cx="84" cy="84" r={R} />
        <circle
          className="ringfg"
          cx="84"
          cy="84"
          r={R}
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - clamped)}
        />
      </svg>
      {children ? <div className="ringcenter">{children}</div> : null}
    </div>
  );
}