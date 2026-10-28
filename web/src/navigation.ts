export function routeHash(name: string, search = ""): string {
  return `#${name}${search}`
}

export function goTo(name: string, search = ""): void {
  const next = routeHash(name, search)
  if (location.hash !== next) location.hash = next.slice(1)
}

export function replaceRoute(name: string, search = ""): void {
  history.replaceState(null, "", routeHash(name, search))
}
