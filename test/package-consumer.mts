import CSV, { type CSVWriteOptions } from '@doeixd/csv-utils';
import { createHeaderMapFns } from '@doeixd/csv-utils/headers';
import { addColumn } from '@doeixd/csv-utils/standalone';
const options: CSVWriteOptions<{ id: string }> = { headerMap: { id: 'ID' }, stringifyOptions: { header: true } };
const result: string = CSV.fromData([{ id: '1' }]).toString(options);
const mapped: string = createHeaderMapFns<{ id: string }>({ ID: 'id' }).fromRowArr({ ID: '1' }).id;
const row: number = addColumn([{ id: '1' }], 'extra', 1)[0].extra;
void [result, mapped, row];
