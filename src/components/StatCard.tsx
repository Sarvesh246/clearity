interface Props {
  icon: React.ReactNode
  value: number | string
  label: string
  color: string
}

export default function StatCard({ icon, value, label, color }: Props) {
  return (
    <div className="neu-card flex flex-col items-center gap-2.5 !p-4 min-w-0">
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: 44,
          height: 44,
          borderRadius: 13,
          color,
          background: '#1a1a1e',
          boxShadow: 'inset 3px 3px 6px #111116, inset -3px -3px 6px #2c2c35',
        }}
      >
        {icon}
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span
          className="text-2xl font-bold tabular-nums"
          style={{ color, letterSpacing: '-0.03em' }}
        >
          {value}
        </span>
        <span className="text-xs font-medium text-center" style={{ color: '#8888a0' }}>
          {label}
        </span>
      </div>
    </div>
  )
}
