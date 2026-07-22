const WebSocket = require('ws');
const ws = new WebSocket('wss://plan-signal.onrender.com/ws');
ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'register', device_id: 'test-device-123', machine_id: 'test' }));
});
ws.on('message', (data) => {
  console.log('Received:', data.toString());
  process.exit(0);
});
ws.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
