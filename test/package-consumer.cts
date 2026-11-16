import CSV = require('@doeixd/csv-utils');
import Headers = require('@doeixd/csv-utils/headers');
import Standalone = require('@doeixd/csv-utils/standalone');
const value: string = CSV.default.fromData([{ id: '1' }]).toString({ headerMap: { id: 'ID' } });
const mapped: string = Headers.createHeaderMapFns<{ id: string }>({ ID: 'id' }).fromRowArr({ ID: '1' }).id;
const extra: number = Standalone.addColumn([{ id: 1 }], 'extra', 2)[0].extra;
void [value, mapped, extra];
