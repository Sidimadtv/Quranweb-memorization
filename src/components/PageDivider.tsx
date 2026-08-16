export function PageDivider({ page }: { page: number }) {
  return (
    <li
      aria-label={`Page ${page} begins`}
      className="flex items-center gap-3 select-none my-1"
      data-page-divider={page}
    >
      <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
      <span className="text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 font-medium tabular-nums">
        Page {page}
      </span>
      <span className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
    </li>
  );
}
