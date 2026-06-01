export function normalizePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function replaceBrowserPath(pathname: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = normalizePath(pathname);
  if (window.location.pathname !== nextPath) {
    window.history.replaceState({}, '', nextPath);
  }
}

export function pushBrowserPath(pathname: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = normalizePath(pathname);
  if (window.location.pathname !== nextPath) {
    window.history.pushState({}, '', nextPath);
  }
}
