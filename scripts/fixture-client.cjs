'use strict';
const http = require('node:http');
const req = http.get({ host: '127.0.0.1', port: Number(process.argv[2]), path: `http://${process.argv[3]}/file`, headers: { Host: process.argv[3], ...(process.argv[4] === 'long' ? { 'x-fixture-long': '1' } : {}) } }, res => {
  let bytes = 0; res.on('data', b => { bytes += b.length; });
  res.on('end', () => { console.log(JSON.stringify({ provider: res.headers['x-provider'], bytes, status: res.statusCode })); process.exit(0); });
  res.on('aborted',()=>{console.error('fixture connection closed');process.exit(2);});
  res.on('error',()=>{console.error('fixture response interrupted');process.exit(2);});
});
req.setTimeout(15000, () => req.destroy(Error('fixture timeout')));
req.on('error', e => { console.error(e.message); process.exit(1); });
