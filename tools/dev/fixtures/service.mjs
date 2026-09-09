import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.end('ready');
  if (req.url === '/fail') setImmediate(() => process.exit(17));
});
server.listen(Number(process.env.TEST_PORT), '127.0.0.1');
process.stdin.resume();
process.stdin.once('end', () => server.close(() => process.exit(0)));
