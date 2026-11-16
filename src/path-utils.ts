export type PathSegment = string | number;

const BRACKET_PATH_REGEX = /\[(.*?)\]/g;
// Repeated row mappings usually use the same small set of paths. Bound the
// cache so workloads with many unique paths cannot grow it indefinitely.
const PATH_CACHE_LIMIT = 512;
const pathCache = new Map<string, PathSegment[]>();

const normalizePath = (path: string | PathSegment[]): PathSegment[] => {
  if (Array.isArray(path)) {
    return path;
  }

  if (!path) {
    return [];
  }

  const cached = pathCache.get(path);
  if (cached) return cached;

  const segments: PathSegment[] = [];
  const dotParts = path.split('.');

  for (const part of dotParts) {
    if (part === '') {
      continue;
    }

    const base = part.replace(BRACKET_PATH_REGEX, '').trim();
    if (base) {
      segments.push(base);
    }

    BRACKET_PATH_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BRACKET_PATH_REGEX.exec(part)) !== null) {
      const raw = match[1].trim();
      if (!raw) {
        continue;
      }

      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        segments.push(raw.slice(1, -1));
        continue;
      }

      const numeric = Number(raw);
      segments.push(Number.isNaN(numeric) ? raw : numeric);
    }
  }

  if (pathCache.size >= PATH_CACHE_LIMIT) {
    const oldest = pathCache.keys().next().value;
    if (oldest !== undefined) pathCache.delete(oldest);
  }
  pathCache.set(path, segments);
  return segments;
};

export const getPathValue = (obj: any, path: string | PathSegment[]): any => {
  const segments = normalizePath(path);
  let current = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[segment as any];
  }

  return current;
};

export const setPathValue = (obj: any, path: string | PathSegment[], value: any): void => {
  const segments = normalizePath(path);
  if (segments.some(segment => segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
    throw new Error('Unsafe property path');
  }
  if (segments.length === 0) {
    return;
  }

  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const shouldBeArray = typeof nextSegment === 'number';

    if (current[segment] === undefined || current[segment] === null) {
      current[segment] = shouldBeArray ? [] : {};
    } else if (typeof current[segment] !== 'object') {
      current[segment] = shouldBeArray ? [] : {};
    }

    current = current[segment];
  }

  const lastSegment = segments[segments.length - 1];
  current[lastSegment as any] = value;
};

/** Return a shallow copy of each container on the path before changing a value. */
export const setPathValueCopy = <T extends Record<string, any>>(obj: T, path: string, value: any): T => {
  const segments = normalizePath(path);
  if (segments.some(segment => segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
    throw new Error('Unsafe property path');
  }
  const result: any = Array.isArray(obj) ? [...obj] : { ...obj };
  let current = result;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const existing = current[segment];
    const next = Array.isArray(existing) ? [...existing]
      : existing !== null && typeof existing === 'object' ? { ...existing }
      : typeof segments[i + 1] === 'number' ? [] : {};
    Object.defineProperty(current, segment, { value: next, enumerable: true, writable: true, configurable: true });
    current = next;
  }
  if (segments.length) {
    Object.defineProperty(current, segments[segments.length - 1], { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
};
