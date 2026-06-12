'use client'

import type { FilterValue } from '@/types'

interface FilterTabsProps {
  activeFilter: FilterValue
  counts: { all: number; junk: number; unsure: number; safe: number }
  onFilterChange: (filter: FilterValue) => void
}

const TABS: { value: FilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'junk', label: 'Junk' },
  { value: 'unsure', label: 'Unsure' },
  { value: 'safe', label: 'Safe' },
]

export default function FilterTabs({ activeFilter, counts, onFilterChange }: FilterTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Filter senders by classification"
      className="scrollbar-hide"
      style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '0 16px' }}
    >
      {TABS.map(tab => {
        const isActive = activeFilter === tab.value
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={isActive}
            onClick={() => onFilterChange(tab.value)}
            className={isActive ? 'neu-inset' : 'neu-button'}
            style={{
              padding: '10px 14px',
              fontSize: 13,
              fontWeight: 500,
              color: isActive ? '#e8e8f0' : '#8888a0',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {tab.label}
            <span
              style={{
                background: '#ffffff15',
                borderRadius: 99,
                padding: '1px 6px',
                fontSize: 11,
                color: isActive ? '#e8e8f0' : '#8888a0',
              }}
            >
              {counts[tab.value]}
            </span>
          </button>
        )
      })}
    </div>
  )
}
