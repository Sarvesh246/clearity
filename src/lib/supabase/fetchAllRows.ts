/**
 * Fetch every row of a query by paginating in fixed-size ranges.
 *
 * Supabase/PostgREST silently caps any select at 1000 rows — for inboxes with
 * thousands of senders a plain `.select()` truncates the list and corrupts
 * every count derived from it. Pass a factory because builders are single-use.
 */
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}
