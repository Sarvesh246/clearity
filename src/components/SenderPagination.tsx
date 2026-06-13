'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

interface SenderPaginationProps {
  currentPage: number
  totalPages: number
  totalItems: number
  pageSize: number
  onPageChange: (page: number) => void
}

export default function SenderPagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: SenderPaginationProps) {
  if (totalPages <= 1) return null

  const start = (currentPage - 1) * pageSize + 1
  const end = Math.min(currentPage * pageSize, totalItems)

  return (
    <nav
      aria-label="Sender list pages"
      className="flex flex-col items-center gap-3 px-4 py-4"
      style={{ borderTop: '1px solid #2c2c35' }}
    >
      <p className="text-xs tabular-nums" style={{ color: '#8888a0' }}>
        Showing {start.toLocaleString()}–{end.toLocaleString()} of{' '}
        {totalItems.toLocaleString()} senders
      </p>
      <div className="flex items-center gap-2 w-full max-w-sm">
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="neu-button flex items-center justify-center gap-1 flex-1 min-h-[44px]"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: currentPage <= 1 ? '#555568' : '#e8e8f0',
            opacity: currentPage <= 1 ? 0.6 : 1,
          }}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Prev
        </button>
        <span
          className="neu-inset flex items-center justify-center tabular-nums shrink-0"
          style={{
            minWidth: 88,
            height: 44,
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 600,
            color: '#e8e8f0',
            padding: '0 12px',
          }}
          aria-current="page"
        >
          {currentPage} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="neu-button flex items-center justify-center gap-1 flex-1 min-h-[44px]"
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: currentPage >= totalPages ? '#555568' : '#e8e8f0',
            opacity: currentPage >= totalPages ? 0.6 : 1,
          }}
          aria-label="Next page"
        >
          Next
          <ChevronRight size={16} strokeWidth={2} />
        </button>
      </div>
    </nav>
  )
}
