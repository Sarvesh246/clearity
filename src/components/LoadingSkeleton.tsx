export default function LoadingSkeleton() {
  return (
    <div
      className="flex flex-col gap-3 px-4 py-4"
      role="status"
      aria-busy="true"
      aria-label="Loading senders"
    >
      <span className="sr-only">Loading senders, please wait…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="neu-card animate-pulse"
          style={{ padding: '14px 16px', minHeight: 88 }}
        >
          <div className="flex items-center gap-3">
            {/* Checkbox placeholder */}
            <div style={{ width: 20, height: 20, borderRadius: 6, background: '#2c2c35', flexShrink: 0 }} />
            {/* Avatar placeholder */}
            <div style={{ width: 40, height: 40, borderRadius: 20, background: '#2c2c35', flexShrink: 0 }} />
            {/* Text lines */}
            <div className="flex flex-col gap-2 flex-1">
              <div style={{ height: 10, borderRadius: 99, background: '#2c2c35', width: '60%' }} />
              <div style={{ height: 10, borderRadius: 99, background: '#2c2c35', width: '40%' }} />
              <div style={{ height: 10, borderRadius: 99, background: '#2c2c35', width: '30%' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
