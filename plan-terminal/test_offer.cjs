const WebSocket = require('ws');
const ws = new WebSocket('wss://plan-signal.onrender.com/ws');
ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'register', device_id: 'test-viewer', machine_id: 'test' }));
  setTimeout(() => {
    console.log('Sending offer to 000-000-007');
    ws.send(JSON.stringify({
      type: 'offer',
      target: '000-000-007',
      sdp: 'dummy-sdp'
    }));
  }, 1000);
});
ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
