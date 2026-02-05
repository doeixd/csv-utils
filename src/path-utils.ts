export type PathSegment = string | number;

const BRACKET_PATH_REGEX = /\[(.*?)\]/g;

const normalizePath = (path: string | PathSegment[]): PathSegment[] => {
  if (Array.isArray(path)) {
    return path;
  }

  if (!path) {
    return [];
  }

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
