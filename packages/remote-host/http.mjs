export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function body(request, max = 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function sendBounded(socket, message) {
  if (socket.readyState !== 1) return false;
  if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Slow consumer; reconnect for replay'); return false; }
  socket.send(JSON.stringify(message)); return true;
}
