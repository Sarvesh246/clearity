interface Props {
  icon: React.ReactNode
  value: number | string
  label: string
  color: string
}

export default function StatCard({ icon, value, label, color }: Props) {
  return (
    <div className="neu-card flex flex-col items-center gap-2 !p-3 min-w-0">
      <div
        className="neu-inset flex items-center justify-center flex-shrink-0"
        style={{ width: 40, height: 40, borderRadius: 12, color }}
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
