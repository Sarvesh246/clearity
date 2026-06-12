import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? ''
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n)
}
