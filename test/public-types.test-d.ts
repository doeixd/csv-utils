import CSV, { CSVUtils } from '../src';
import { join, merge } from '../src/standalone';
const left = [{ id: 1, left: 'one' }];
const right = [{ id: 1, right: true }];
const joined = CSV.fromData(left).join(CSV.fromData(right), { left: 'id', right: 'id', type: 'right' }).toArray()[0];
const possibleLeft: string | undefined = joined.left;
// @ts-expect-error Unmatched right rows do not necessarily contain left fields.
const definiteLeft: string = joined.left;
const selected = CSV.fromData(left).join(CSV.fromData(right), { left: 'id', right: 'id' }, (l, r) => ({ label: `${l?.left}:${r?.right}` })).toArray()[0];
const label: string = selected.label;
const standaloneJoin = join(left, right, { left: 'id', right: 'id', type: 'outer' })[0];
// @ts-expect-error An outer join can have no right value.
const definiteRight: boolean = standaloneJoin.right;
const merged = CSV.fromData(left).mergeWith(right, (a, b) => a.id === b.id, a => a).toArray()[0];
// @ts-expect-error Unmatched right rows do not have left fields.
const mergedLeft: string = merged.left;
const mergedRows = CSVUtils.mergeRows(left, right, (a, b) => a.id === b.id, a => a)[0];
// @ts-expect-error Unmatched right rows do not have left fields.
const utilLeft: string = mergedRows.left;
const standaloneMerge = merge(left, right, (a, b) => a.id === b.id, a => a)[0];
// @ts-expect-error Unmatched right rows do not have left fields.
const standaloneLeft: string = standaloneMerge.left;
void [possibleLeft, definiteLeft, label, definiteRight, mergedLeft, utilLeft, standaloneLeft];

const overwritten = CSV.fromData([{ id: 1, name: 'x' }]).addColumn('id', 'new').toArray()[0];
const overwrittenId: string = overwritten.id;
// @ts-expect-error The overwritten value is a string.
const overwrittenNumber: number = overwritten.id;
const cast = CSV.fromData([{ price: '5' }]).castColumnType('price', 'number').toArray()[0];
const price: number | null = cast.price;
// @ts-expect-error A numeric cast can fail or return a number.
const priceString: string = cast.price;
const collision = CSV.fromData([{ source: 123, target: 'old' }]).renameColumn('source', 'target').toArray()[0];
const renamed: number = collision.target;
// @ts-expect-error The old target is overwritten.
const oldTarget: string = collision.target;
const optional = CSV.fromData([] as { source?: number; target: string }[]).renameColumn('source', 'target').toArray()[0];
const optionalTarget: string | number | undefined = optional.target;
// @ts-expect-error The source may be absent, leaving the old target.
const definiteNumber: number = optional.target;
const transformed = CSV.fromData([{ name: 'x' }]).addColumn('length', row => row.name.length).toArray()[0];
const length: number = transformed.length;
void [overwrittenId, overwrittenNumber, price, priceString, renamed, oldTarget, optionalTarget, definiteNumber, length];

// @ts-expect-error Rows without a schema must match the requested type.
CSV.fromData<{ id: number }>([{ other: 'x' }]);
const partialRow = CSV.fromData([{ id: 1, name: 'A' }]).createRow({ id: 2 });
// @ts-expect-error Omitted values may be undefined.
const requiredName: string = partialRow.name;
const fillInput = CSV.fromData([] as { value?: number | null }[]);
const filled = fillInput.fillMissingValues('value', 'unknown').toArray()[0];
const filledValue: number | string = filled.value;
// @ts-expect-error A fill can introduce a different type.
const numericFill: number = filled.value;
const literalText = CSV.fromData([{ name: 'A' as const }]).normalizeText('name', 'lowercase').toArray()[0];
const widened: string = literalText.name;
// @ts-expect-error Normalization can change a literal string.
const literal: 'A' = literalText.name;
void [requiredName, filledValue, numericFill, widened, literal];

const numericHeaderMap: import('../src').HeaderMap<{ id: number }> = { id: 0 };
CSVArrayUtilsForTypes(numericHeaderMap);
function CSVArrayUtilsForTypes(map: import('../src').HeaderMap<{ id: number }>) { return map; }
const orderedHeaders: import('../src').CSVWriteOptions<{ id: number }> = { headerMap: { id: 'ID' }, stringifyOptions: { header: ['ID'] } };
void orderedHeaders;
const mappedRow = (null as unknown as ReturnType<typeof import('../src').createHeaderMapFns<{ id: string }>>).fromRowArr({ id: '1' });
const mappedId: string = mappedRow.id;
// @ts-expect-error Mapping a typed row does not create arbitrary properties.
const unknownMapped = mappedRow.notAField;
void [mappedId, unknownMapped];

const streamForTypes = null as unknown as import('../src').CSVStreamProcessor<{ score: string }>;
const typedStream = streamForTypes.addColumn('score', async row => Number(row.score)).map(row => ({ formatted: row.score.toFixed(2) }));
const collectedPromise: Promise<CSV<{ formatted: string }>> = typedStream.prepareCollect().run();
void collectedPromise;
const mappedAfterCollect: Promise<CSV<{ text: string }>> = streamForTypes.prepareCollect().map(row => ({ text: row.score })).run();
const writingInstead: Promise<void> = streamForTypes.prepareCollect().prepareToFile('file.csv').run();
// @ts-expect-error File writing does not return collected rows.
const notCollected: Promise<CSV<{ score: string }>> = streamForTypes.prepareToFile('file.csv').run();
void [mappedAfterCollect, writingInstead, notCollected];
