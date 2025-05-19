const sortWorkerLogicString = `
  const { parentPort, workerData } = require('worker_threads');

  const { chunk, column, direction, sortFnString } = workerData;

  // Reconstruct the sort function (be cautious with eval in production)
  // A safer way would be to pass only primitive comparators or have predefined sort strategies.
  let compareFn;
  if (sortFnString) {
    try {
      const dynamicallyCreatedSortFn = eval('(' + sortFnString + ')');
      compareFn = (a, b) => dynamicallyCreatedSortFn(a, b, column, direction);
    } catch (e) {
      parentPort.postMessage({ error: 'Failed to evaluate sortFnString: ' + e.message });
      return;
    }
  } else {
    // Default comparator if no custom function string is provided
    compareFn = (a, b) => {
      const aVal = a[column];
      const bVal = b[column];

      if (aVal === bVal) return 0;
      if (aVal === null || aVal === undefined) return direction === 'asc' ? -1 : 1;
      if (bVal === null || bVal === undefined) return direction === 'asc' ? 1 : -1;
      
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const comparison = String(aVal).localeCompare(String(bVal));
      return direction === 'asc' ? comparison : -comparison;
    };
  }

  try {
    chunk.sort(compareFn);
    parentPort.postMessage({ sortedChunk: chunk });
  } catch (e) {
    parentPort.postMessage({ error: 'Error during sort in worker: ' + e.message });
  }
`;