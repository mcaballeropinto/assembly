export type DashboardSearch = {
  wp?: string
  wpline?: string
} & Record<string, unknown>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function normalizeDashboardSearch(
  search: Record<string, unknown>,
): DashboardSearch {
  const next: DashboardSearch = { ...search }

  if (isNonEmptyString(search.wp)) {
    next.wp = search.wp
  } else {
    delete next.wp
  }

  if (isNonEmptyString(search.wpline)) {
    next.wpline = search.wpline
  } else {
    delete next.wpline
  }

  return next
}

export function openWorkpieceSearch(
  search: DashboardSearch,
  fileName: string,
  lineName?: string,
): DashboardSearch {
  const next: DashboardSearch = {
    ...search,
    wp: fileName,
  }

  if (lineName) {
    next.wpline = lineName
  } else {
    delete next.wpline
  }

  return next
}

export function closeWorkpieceSearch(search: DashboardSearch): DashboardSearch {
  const next: DashboardSearch = { ...search }
  delete next.wp
  delete next.wpline
  return next
}
