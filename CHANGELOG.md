# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [3.0.0](https://github.com/doeixd/csv-utils/compare/v2.3.4...v3.0.0) (2026-11-16)

### Breaking changes

* `writeToFile` always completes synchronously. Its `streaming` and `streamingThreshold` options are deprecated; use `writeToFileAsync` for streaming output.
* Async reductions using the legacy `mapreduce` strategy now run sequentially to preserve the semantics of row reducers and nonzero initial values.
* Column schemas run before row schemas. Async validation uses bounded concurrency and defaults to async schema handling in async readers.
* Readers recognize UTF-8 BOMs by default; set `csvOptions.bom` to `false` to retain one. File reads preserve boundary whitespace. Parser options `from`, `from_line`, and `to_line` retain their distinct record and line semantics.
* Deduplication compares values by type using SameValueZero and compares objects and arrays by identity. Unpivoting with no value columns returns no rows.
* TypeScript return types now reflect overwritten and cast columns, missing join and merge fields, partial base rows, and stream terminal actions. Some callers may need to handle optional values or update annotations.
* Unsafe nested property paths containing `__proto__`, `constructor`, or `prototype` are rejected.

### Fixes and improvements

* Fix mapped header values being empty in synchronous, asynchronous, and streamed CSV output, including nested paths and array mappings.
* Apply mappings, casts, empty-value checks, and schema validation in streaming reads; propagate stream errors and respect cancellation and pipe options.
* Fix BOM placement with additional headers and support ordered headers, explicit parser columns, and headerless indexed mappings.
* Preserve sparse-row fields, prevent validation from mutating input rows, and improve worker sorting and async batch handling.
* Improve performance for nested path mapping, best-match lookup, small async sorts, wide array mappings, and selective casting.
* Update dependencies and provide ESM package metadata for supported Node.js versions.

### [2.3.4](https://github.com/doeixd/csv-utils/compare/v2.3.3...v2.3.4) (2026-02-05)

### [2.3.3](https://github.com/doeixd/csv-utils/compare/v2.3.2...v2.3.3) (2025-10-10)


### Bug Fixes

* ensure columnIssues is properly initialized in CSV validation and skip integration tests for file operations ([5c8328a](https://github.com/doeixd/csv-utils/commit/5c8328a84c544153b3383efc57491bacf1b4f9d6))
* update keywords in package.json for better discoverability and clarity ([d9b0497](https://github.com/doeixd/csv-utils/commit/d9b04976b87c13120ed9346ee0d6dfad96969c8b))

### [2.3.2](https://github.com/doeixd/csv-utils/compare/v2.3.1...v2.3.2) (2025-10-10)


### Bug Fixes

* ensure columnIssues is initialized before assignment in CSV validation ([e327998](https://github.com/doeixd/csv-utils/commit/e327998e550172b38a01558ef1e081dba5c2804e))

### [2.3.1](https://github.com/doeixd/csv-utils/compare/v2.3.0...v2.3.1) (2025-10-10)

## [2.3.0](https://github.com/doeixd/csv-utils/compare/v2.2.0...v2.3.0) (2025-05-19)


### Features

* :sparkles: Updated clone(), and made fromData support validation ([e56c063](https://github.com/doeixd/csv-utils/commit/e56c063a278fe16823999d165d0977196de9cd4a))

## [2.2.0](https://github.com/doeixd/csv-utils/compare/v2.1.1...v2.2.0) (2025-05-19)


### Features

* :sparkles: Implemented sortByAsync ([0dcf457](https://github.com/doeixd/csv-utils/commit/0dcf457b83081c3137eed29490de8bab36133583))

### [2.1.1](https://github.com/doeixd/csv-utils/compare/v2.1.0...v2.1.1) (2025-05-16)


### Bug Fixes

* :bug: Improved consisitancy in the From functions ([ee9a9d1](https://github.com/doeixd/csv-utils/commit/ee9a9d15b884f6269aabbfcc32df9650a2b67c90))

## [2.1.0](https://github.com/doeixd/csv-utils/compare/v2.0.1...v2.1.0) (2025-05-16)


### Features

* :sparkles: Improved header mapping ([4a42bb6](https://github.com/doeixd/csv-utils/commit/4a42bb60b8871d7c6144fe2a3b0edb602b8b9911))

### [2.0.1](https://github.com/doeixd/csv-utils/compare/v2.0.0...v2.0.1) (2025-05-16)

## [2.0.0](https://github.com/doeixd/csv-utils/compare/v0.0.12...v2.0.0) (2025-05-16)


### Features

* :sparkles: Added casting, more streaming tools, standard schema support, prelude detection, and some additional functions ([13cddfb](https://github.com/doeixd/csv-utils/commit/13cddfb8df5d5d531005975f030b2229298be747))

## [1.0.0](https://github.com/doeixd/csv-utils/compare/v0.0.12...v1.0.0) (2025-05-16)


### Features

* :sparkles: Added casting, more streaming tools, standard schema support, prelude detection, and some additional functions ([13cddfb](https://github.com/doeixd/csv-utils/commit/13cddfb8df5d5d531005975f030b2229298be747))

### [0.0.12](https://github.com/doeixd/csv-utils/compare/v0.0.11...v0.0.12) (2025-05-15)


### Bug Fixes

* :bug: Fixed columns not being picked up when a custom option is set ([d86a585](https://github.com/doeixd/csv-utils/commit/d86a5850367d07fb3a56348956ce4761d53285ee))

### [0.0.11](https://github.com/doeixd/csv-utils/compare/v0.0.10...v0.0.11) (2025-05-15)


### Features

* :arrow_down: Removed unenv ([a5e53a4](https://github.com/doeixd/csv-utils/commit/a5e53a4885ef721f142309e3928e96f4065c7041))

### [0.0.10](https://github.com/doeixd/csv-utils/compare/v0.0.9...v0.0.10) (2025-05-15)

### [0.0.9](https://github.com/doeixd/csv-utils/compare/v0.0.8...v0.0.9) (2025-05-15)

### [0.0.8](https://github.com/doeixd/csv-utils/compare/v0.0.7...v0.0.8) (2025-05-15)

### [0.0.7](https://github.com/doeixd/csv-utils/compare/v0.0.6...v0.0.7) (2025-05-15)

### [0.0.6](https://github.com/doeixd/csv-utils/compare/v0.0.5...v0.0.6) (2025-05-15)


### Features

* :arrow_up: Upgraded unenv ([be1e986](https://github.com/doeixd/csv-utils/commit/be1e9869b27f3b954b36d8add58812b8e44b17c6))

### [0.0.5](https://github.com/doeixd/csv-utils/compare/v0.0.4...v0.0.5) (2025-05-15)


### Bug Fixes

* :bug: Fixed circular dependency issue ([0aa8935](https://github.com/doeixd/csv-utils/commit/0aa893506762bd2f7117e65a52ebeede2c2a64e7))

### [0.0.4](https://github.com/doeixd/csv-utils/compare/v0.0.3...v0.0.4) (2025-03-03)

### [0.0.3](https://github.com/doeixd/csv-utils/compare/v0.0.2...v0.0.3) (2025-02-28)

### 0.0.2 (2025-02-26)


### Features

* Initial ([74b24b1](https://github.com/doeixd/csv-utils/commit/74b24b17d30854e1d890769a0c63ea10166e37df))
